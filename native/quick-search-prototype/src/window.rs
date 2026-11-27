use std::cell::RefCell;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::path::Path;
use std::ptr::null;
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Condvar, Mutex};
use std::thread;

use serde_json::{json, Value};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{GetStockObject, InvalidateRect, COLOR_WINDOW, DEFAULT_GUI_FONT},
    System::LibraryLoader::GetModuleHandleW,
    UI::{Controls::*, Input::KeyboardAndMouse::{EnableWindow, SetFocus}, WindowsAndMessaging::*},
};

use crate::engine::{send_host_event, Config, ContentStatus, Engine, Hit, HostMessage, Page, SearchMode};
use crate::filters;

mod actions;
use actions::{Action, ActionResult, Bookmark, BookmarkCommand, FileAction, SavedDate};

const SEARCH_TIMER: usize = 1;
const REFRESH_TIMER: usize = 2;
const WORKER_EVENT: u32 = WM_APP + 1;
const PAGE_SIZE: usize = 120;
const QUERY: usize = 100;
const SCOPE: usize = 101;
const EXTENSIONS: usize = 102;
const KIND: usize = 103;
const MODE: usize = 104;
const SORT: usize = 105;
const MATCH_PATH: usize = 106;
const CASE: usize = 107;
const PREVIOUS: usize = 108;
const NEXT: usize = 109;
const SEARCH_NOW: usize = 110;
const RESULTS: usize = 111;
const SEARCH_TYPE: usize = 112;
const BUILD_CONTENT: usize = 113;
const CANCEL: usize = 114;
const ADDITIONAL: usize = 115;
const MIN_SIZE: usize = 116;
const MAX_SIZE: usize = 117;
const MODIFIED_FROM: usize = 118;
const MODIFIED_TO: usize = 119;
const CATEGORY: usize = 120;
const STATUS: usize = 121;
const SORT_DIRECTION: usize = 122;
const BOOKMARKS: usize = 123;
const FILE_ACTIONS: usize = 124;
const FULL_SEARCH: usize = 125;
const NAME_MODES: &[&str] = &["普通匹配", "完整词", "模糊", "正则"];
const CONTENT_MODES: &[&str] = &["全文关键词", "全文正则"];
const SORT_LABELS: &[&str] = &["相关度", "名称", "路径", "大小", "修改时间", "扩展名"];
const SORT_FIELDS: &[&str] = &["relevance", "name", "path", "size", "modified", "type"];
const CATEGORIES: &[(&str, &str)] = &[
    ("folder", "文件夹"), ("document", "文档"), ("image", "图片"), ("video", "视频"),
    ("audio", "音频"), ("archive", "压缩包"), ("executable", "可执行文件"), ("code", "代码"),
    ("other", "其他"),
];

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

pub fn show_error(error: &str) {
    unsafe {
        MessageBoxW(0, wide(error).as_ptr(), wide("CDriveShiftAI native search").as_ptr(), MB_ICONERROR);
    }
}

#[derive(Clone, Copy)]
enum Navigation { First, Previous, Next }

struct Job {
    revision: u64,
    mode: SearchMode,
    navigation: Navigation,
    cursor: Option<String>,
    filters: Value,
}

enum Event {
    Ready,
    Failed(String),
    Page { job: Job, result: Result<Page, String> },
    BuildStarted { canonical: String },
    BuildFailed(String),
    Action { opens_bookmarks: bool, result: Result<ActionResult, String> },
    ContentStatus(ContentStatus),
    Host(HostMessage),
}

struct Build {
    scope: String,
    canonical: Option<String>,
}

enum Work {
    Search(Job),
    Build(String),
    Action(Action),
}

#[derive(Default)]
struct Pending {
    search: Option<Job>,
    build: Option<String>,
    actions: VecDeque<Action>,
}

#[derive(Default)]
struct Mailbox {
    pending: Mutex<Pending>,
    changed: Condvar,
    stop: Arc<AtomicBool>,
}

impl Mailbox {
    fn submit(&self, job: Job) {
        self.pending.lock().unwrap_or_else(|error| error.into_inner()).search = Some(job);
        self.changed.notify_one();
    }

    fn build(&self, scope: String) {
        self.pending.lock().unwrap_or_else(|error| error.into_inner()).build = Some(scope);
        self.changed.notify_one();
    }

    fn action(&self, action: Action) -> bool {
        let mut pending = self.pending.lock().unwrap_or_else(|error| error.into_inner());
        if pending.actions.len() >= 8 || self.stop.load(Ordering::Acquire) {
            return false;
        }
        pending.actions.push_back(action);
        self.changed.notify_one();
        true
    }

    fn cancel_search(&self) {
        self.pending.lock().unwrap_or_else(|error| error.into_inner()).search.take();
    }

    fn take(&self) -> Option<Work> {
        let slot = self.pending.lock().unwrap_or_else(|error| error.into_inner());
        let mut slot = self.changed.wait_while(slot, |jobs| {
            jobs.search.is_none() && jobs.build.is_none() && jobs.actions.is_empty()
                && !self.stop.load(Ordering::Acquire)
        }).unwrap_or_else(|error| error.into_inner());
        if self.stop.load(Ordering::Acquire) {
            return None;
        }
        slot.actions.pop_front().map(Work::Action)
            .or_else(|| slot.build.take().map(Work::Build))
            .or_else(|| slot.search.take().map(Work::Search))
    }

    fn close(&self) {
        // Synchronize with the waiting worker before waking it.
        let _slot = self.pending.lock().unwrap_or_else(|error| error.into_inner());
        self.stop.store(true, Ordering::Release);
        self.changed.notify_one();
    }
}

#[derive(Default)]
struct Controls {
    query: HWND, scope: HWND, extensions: HWND, kind: HWND, mode: HWND,
    sort: HWND, sort_direction: HWND, match_path: HWND, case: HWND, previous: HWND, next: HWND,
    search_now: HWND, label: HWND, list: HWND,
    search_type: HWND, category: HWND, build: HWND, cancel: HWND,
    additional: HWND, min_size: HWND, max_size: HWND, modified_from: HWND, modified_to: HWND,
    additional_caption: HWND, scope_caption: HWND, size_caption: HWND, date_caption: HWND,
    bookmarks: HWND, file_actions: HWND, full_search: HWND,
}

struct State {
    controls: Controls,
    mailbox: Arc<Mailbox>,
    events: mpsc::Receiver<Event>,
    revision: u64,
    ready: bool,
    stopped: bool,
    busy: bool,
    cancelled: bool,
    category_mask: u16,
    search_mode: SearchMode,
    name_matching_mode: usize,
    content_matching_mode: usize,
    build: Option<Build>,
    rows: Vec<Hit>,
    cursor: Option<String>,
    next_cursor: Option<String>,
    previous: Vec<Option<String>>,
    hosted: bool,
    host_ready: bool,
    visible: Option<bool>,
    host_index_ready: bool,
    refresh_on_show: bool,
    selected_bookmark: Option<Bookmark>,
    restored_dates: [Option<SavedDate>; 2],
    bookmark_menu_pending: bool,
}

impl State {
    unsafe fn controls(&mut self, window: HWND) -> Result<(), String> {
        let edit = |caption: &str, id| control(window, "EDIT", caption, id, ES_AUTOHSCROLL as u32 | WS_TABSTOP, WS_EX_CLIENTEDGE);
        let lines = |caption: &str, id| control(window, "EDIT", caption, id,
            (ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN) as u32 | WS_VSCROLL | WS_TABSTOP, WS_EX_CLIENTEDGE);
        let button = |caption: &str, id| control(window, "BUTTON", caption, id, WS_TABSTOP, 0);
        let check = |caption: &str, id| control(window, "BUTTON", caption, id, BS_AUTOCHECKBOX as u32 | WS_TABSTOP, 0);
        let caption = |text| control(window, "STATIC", text, 0, 0, 0);
        self.controls = Controls {
            query: edit("", QUERY)?,
            scope: lines("*", SCOPE)?,
            extensions: edit("", EXTENSIONS)?,
            kind: combo(window, KIND, &["全部类型", "文件", "文件夹"])?,
            mode: combo(window, MODE, NAME_MODES)?,
            sort: combo(window, SORT, SORT_LABELS)?,
            sort_direction: combo(window, SORT_DIRECTION, &["降序", "升序"])?,
            match_path: check("匹配路径", MATCH_PATH)?,
            case: check("区分大小写", CASE)?,
            previous: button("上一页", PREVIOUS)?,
            next: button("下一页", NEXT)?,
            search_now: button("搜索", SEARCH_NOW)?,
            label: control(window, "STATIC", "正在载入索引…", STATUS, 0, 0)?,
            list: control(window, "SysListView32", "", RESULTS,
                LVS_REPORT | LVS_OWNERDATA | LVS_SHOWSELALWAYS | WS_TABSTOP, WS_EX_CLIENTEDGE)?,
            search_type: combo(window, SEARCH_TYPE, &["名称搜索", "全文搜索"])?,
            category: button("全部类别 ▾", CATEGORY)?,
            build: button("建立全文索引", BUILD_CONTENT)?,
            cancel: button("取消搜索", CANCEL)?,
            additional: lines("", ADDITIONAL)?,
            min_size: edit("", MIN_SIZE)?,
            max_size: edit("", MAX_SIZE)?,
            modified_from: edit("", MODIFIED_FROM)?,
            modified_to: edit("", MODIFIED_TO)?,
            additional_caption: caption("附加词（逐行）")?,
            scope_caption: caption("目录（逐行）")?,
            size_caption: caption("大小（字节）")?,
            date_caption: caption("修改日期")?,
            bookmarks: if self.hosted { button("书签 ▾", BOOKMARKS)? } else { 0 },
            file_actions: if self.hosted { button("文件操作 ▾", FILE_ACTIONS)? } else { 0 },
            full_search: if self.hosted { button("完整搜索…", FULL_SEARCH)? } else { 0 },
        };
        for (edit, prompt) in [
            (self.controls.query, "文件名或关键词"),
            (self.controls.scope, "搜索范围，* 表示整个索引"),
            (self.controls.extensions, "扩展名，例如 txt,rs"),
            (self.controls.min_size, "最小"),
            (self.controls.max_size, "最大"),
            (self.controls.modified_from, "起始 YYYY-MM-DD"),
            (self.controls.modified_to, "结束 YYYY-MM-DD"),
        ] {
            SendMessageW(edit, EM_SETCUEBANNER, 1, wide(prompt).as_ptr() as LPARAM);
        }
        let list = self.controls.list;
        SendMessageW(list, LVM_SETUNICODEFORMAT, 1, 0);
        SendMessageW(list, LVM_SETEXTENDEDLISTVIEWSTYLE, 0, (LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER) as LPARAM);
        for (index, (name, width)) in [("名称", 270), ("完整路径", 460), ("大小", 95), ("命中预览", 0)].into_iter().enumerate() {
            let mut name = wide(name);
            let column = LVCOLUMNW { mask: LVCF_TEXT | LVCF_WIDTH, pszText: name.as_mut_ptr(), cx: width, ..zeroed() };
            SendMessageW(list, LVM_INSERTCOLUMNW, index, &column as *const _ as LPARAM);
        }
        self.mode_controls();
        self.layout(window);
        Ok(())
    }

    unsafe fn layout(&self, window: HWND) {
        let mut bounds: RECT = zeroed();
        GetClientRect(window, &mut bounds);
        let width = (bounds.right - bounds.left).max(840);
        let height = (bounds.bottom - bounds.top).max(340);
        let c = &self.controls;
        let toolbar_height = if self.hosted { 34 } else { 0 };
        let positions = [
            (c.query, 12, 12, width - 210, 27),
            (c.search_now, width - 184, 12, 79, 27),
            (c.cancel, width - 98, 12, 86, 27),
            (c.additional_caption, 12, 55, 92, 23),
            (c.additional, 104, 48, width - 116, 45),
            (c.scope_caption, 12, 106, 92, 23),
            (c.scope, 104, 101, width - 300, 45),
            (c.extensions, width - 184, 101, 172, 26),
            (c.search_type, 12, 157, 100, 220),
            (c.kind, 120, 157, 94, 220),
            (c.category, 222, 157, 95, 25),
            (c.mode, 325, 157, 105, 220),
            (c.sort, 438, 157, 101, 220),
            (c.sort_direction, 547, 157, 67, 120),
            (c.match_path, 626, 157, 98, 25),
            (c.case, 733, 157, 100, 25),
            (c.size_caption, 12, 200, 90, 23),
            (c.min_size, 103, 194, 81, 26),
            (c.max_size, 192, 194, 81, 26),
            (c.date_caption, 293, 200, 62, 23),
            (c.modified_from, 355, 194, 137, 26),
            (c.modified_to, 500, 194, 137, 26),
            (c.build, width - 148, 193, 136, 27),
            (c.bookmarks, 12, 230, 79, 27),
            (c.file_actions, 99, 230, 100, 27),
            (c.full_search, 207, 230, 100, 27),
            (c.list, 12, 234 + toolbar_height, width - 24, height - 276 - toolbar_height),
            (c.label, 12, height - 33, width - 205, 22),
            (c.previous, width - 179, height - 35, 79, 24),
            (c.next, width - 91, height - 35, 79, 24),
        ];
        let mut deferred = BeginDeferWindowPos(positions.len() as i32);
        for (hwnd, x, y, w, h) in positions {
            if deferred == 0 { break; }
            if hwnd != 0 {
                deferred = DeferWindowPos(deferred, hwnd, 0, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
        if deferred == 0 || EndDeferWindowPos(deferred) == 0 {
            for (hwnd, x, y, w, h) in positions {
                if hwnd != 0 { MoveWindow(hwnd, x, y, w, h, 1); }
            }
        }
        let preview = if self.search_mode == SearchMode::Content { width / 3 } else { 0 };
        for (column, width) in [(1, width - 386 - preview), (3, preview)] {
            if SendMessageW(c.list, LVM_GETCOLUMNWIDTH, column, 0) != width as LRESULT {
                SendMessageW(c.list, LVM_SETCOLUMNWIDTH, column, width as LPARAM);
            }
        }
    }

    unsafe fn reset_results(&mut self) {
        self.rows.clear();
        self.previous.clear();
        self.cursor = None;
        self.next_cursor = None;
        SendMessageW(self.controls.list, LVM_SETITEMCOUNT, 0, 0);
    }

    unsafe fn modified(&self, index: usize, field: HWND) -> Result<Option<u64>, String> {
        let text = control_text(field);
        if let Some(saved) = self.restored_dates[index].as_ref().filter(|saved| saved.day == text) {
            return Ok(Some(saved.timestamp));
        }
        filters::modified(&text, index == 1)
    }

    unsafe fn filters(&self, cursor: &Option<String>) -> Result<Option<Value>, String> {
        let c = &self.controls;
        let query = control_text(c.query);
        let additional = control_text(c.additional);
        let keywords = filters::keywords(&additional, &query)?;
        let Some(first_keyword) = keywords.first() else { return Ok(None) };
        let effective_query;
        let query = if self.hosted {
            effective_query = keywords.join(" ");
            effective_query.as_str()
        } else if query.trim().is_empty() {
            first_keyword
        } else {
            query.trim()
        };
        let scope = control_text(c.scope);
        let extensions = control_text(c.extensions);
        let scopes: Vec<_> = scope.lines().map(str::trim).filter(|value| !value.is_empty()).collect();
        let kind = ["all", "file", "folder"][selection(c.kind).min(2)];
        let mode = selection(c.mode);
        let sort = SORT_FIELDS[selection(c.sort).min(SORT_FIELDS.len() - 1)];
        let direction = if selection(c.sort_direction) == 1 { "asc" } else { "desc" };
        let min_size = filters::bytes(&control_text(c.min_size))?;
        let max_size = filters::bytes(&control_text(c.max_size))?;
        let modified_from = self.modified(0, c.modified_from)?;
        let modified_to = self.modified(1, c.modified_to)?;
        filters::range(min_size, max_size, "大小")?;
        filters::range(modified_from, modified_to, "修改日期")?;
        let content = self.search_mode == SearchMode::Content;
        let mut filter = json!({
            "query": query,
            "keywords": keywords,
            "keywordMatch": "any",
            "caseSensitive": SendMessageW(c.case, BM_GETCHECK, 0, 0) == BST_CHECKED as LRESULT,
            "regex": if content { mode == 1 } else { mode == 3 },
            "sortBy": sort, "sortDirection": direction, "cursor": cursor,
            "limit": if content { 80 } else { PAGE_SIZE },
            "minSize": min_size, "maxSize": max_size,
            "modifiedAfterMs": modified_from, "modifiedBeforeMs": modified_to,
        });
        if content {
            filter["scope"] = json!(content_scope(&scope)?);
        } else {
            filter["scopes"] = json!(if scopes.is_empty() { vec!["*"] } else { scopes });
            filter["kind"] = json!(kind);
            filter["categories"] = json!(CATEGORIES.iter().enumerate()
                .filter(|(index, _)| self.category_mask & (1 << index) != 0)
                .map(|(_, (id, _))| *id).collect::<Vec<_>>());
            filter["extensions"] = json!(filters::extensions(&extensions));
            filter["matchPath"] = json!(SendMessageW(c.match_path, BM_GETCHECK, 0, 0) == BST_CHECKED as LRESULT);
            filter["wholeWord"] = json!(mode == 1);
            filter["fuzzy"] = json!(mode == 2);
        }
        Ok(Some(filter))
    }

    unsafe fn search(&mut self, navigation: Navigation) {
        if self.stopped { return; }
        let cursor = match navigation {
            Navigation::First => {
                self.reset_results();
                None
            }
            Navigation::Previous if !self.busy => {
                let Some(cursor) = self.previous.last() else { return };
                cursor.clone()
            }
            Navigation::Next if !self.busy => {
                let Some(cursor) = &self.next_cursor else { return };
                Some(cursor.clone())
            }
            _ => return,
        };
        let filters = match self.filters(&cursor) {
            Ok(Some(filters)) => filters,
            Ok(None) => {
                self.busy = false;
                self.buttons();
                self.label(if self.ready { "输入关键词开始搜索" } else { "正在载入索引…" });
                return;
            }
            Err(error) => {
                self.busy = false;
                self.buttons();
                self.label(&error);
                return;
            }
        };
        self.busy = true;
        self.buttons();
        if self.search_mode == SearchMode::Content
            && self.build.as_ref().is_some_and(|build| filters["scope"] == build.scope)
        {
            self.label("正在为所选目录建立全文索引…");
            return;
        }
        self.label(if self.ready { "正在搜索…" } else { "索引载入后将开始搜索…" });
        self.mailbox.submit(Job { revision: self.revision, mode: self.search_mode, navigation, cursor, filters });
    }

    unsafe fn change_mode(&mut self, window: HWND) {
        if self.sync_mode(window) {
            self.invalidate_pending(false);
            self.search(Navigation::First);
        }
    }

    unsafe fn action(&self, action: Action) {
        if !self.mailbox.action(action) {
            self.label("正在处理其他操作，请稍后重试");
        }
    }

    unsafe fn request_bookmarks(&mut self) {
        if !self.bookmark_menu_pending && !self.stopped && self.mailbox.action(Action::Bookmarks) {
            self.bookmark_menu_pending = true;
            self.buttons();
        }
    }

    unsafe fn search_snapshot(&self) -> Result<Option<Value>, String> {
        let Some(filters) = self.filters(&None)? else { return Ok(None) };
        let mut snapshot = actions::search_snapshot(
            &filters,
            &control_text(self.controls.query),
            &control_text(self.controls.extensions),
            self.search_mode == SearchMode::Content,
        );
        if let Some(bookmark) = &self.selected_bookmark {
            let original_dates = [actions::saved_date(&bookmark.filters["modifiedAfter"]),
                actions::saved_date(&bookmark.filters["modifiedBefore"])];
            if original_dates.iter().zip(&self.restored_dates).all(|(original, current)| {
                original.as_ref().map(|date| date.timestamp) == current.as_ref().map(|date| date.timestamp)
            }) && (snapshot["filters"]["modifiedAfter"] == bookmark.filters["modifiedAfter"])
                && (snapshot["filters"]["modifiedBefore"] == bookmark.filters["modifiedBefore"])
                && !bookmark.date_preset.is_empty()
            {
                snapshot["datePreset"] = json!(bookmark.date_preset);
            }
        }
        Ok(Some(snapshot))
    }

    unsafe fn apply_bookmark(&mut self, window: HWND, bookmark: Bookmark) {
        let filters = &bookmark.filters;
        let content = bookmark.mode == "content";
        let c = &self.controls;
        SendMessageW(c.search_type, CB_SETCURSEL, usize::from(content), 0);
        self.sync_mode(window);

        let mut draft = bookmark.query.as_str();
        let mut additional = strings(&filters["keywords"]);
        let regex = filters["regex"] == true;
        if filters["keywords"].is_null() && !content && !regex {
            let mut words = draft.split_whitespace();
            draft = words.next_back().unwrap_or("");
            additional = words.map(str::to_owned).collect();
        }
        let c = &self.controls;
        set_text(c.query, draft);
        set_text(c.additional, &additional.join("\r\n"));
        let scope = if content {
            bookmark.content_scope.clone()
        } else {
            let scopes = strings(&filters["scopes"]);
            if scopes.is_empty() { filters["scope"].as_str().unwrap_or("*").to_owned() }
            else { scopes.join("\r\n") }
        };
        set_text(c.scope, &scope);
        set_text(c.extensions, &strings(&filters["extensions"]).join(","));
        let kind = match filters["kind"].as_str() {
            Some("file") => 1, Some("folder") => 2, _ => 0,
        };
        SendMessageW(c.kind, CB_SETCURSEL, kind, 0);
        let mode = if content { usize::from(regex) }
            else if regex { 3 }
            else if filters["fuzzy"] == true { 2 }
            else if filters["wholeWord"] == true { 1 }
            else { 0 };
        SendMessageW(c.mode, CB_SETCURSEL, mode, 0);
        for (field, key) in [(c.case, "caseSensitive"), (c.match_path, "matchPath")] {
            SendMessageW(field, BM_SETCHECK, if filters[key] == true { BST_CHECKED } else { BST_UNCHECKED } as WPARAM, 0);
        }
        for (field, key) in [(c.min_size, "minSize"), (c.max_size, "maxSize")] {
            let value = filters[key].as_u64().map_or_else(String::new, |size| size.to_string());
            set_text(field, &value);
        }
        self.restored_dates = [actions::saved_date(&filters["modifiedAfter"]),
            actions::saved_date(&filters["modifiedBefore"])];
        for (index, field) in [c.modified_from, c.modified_to].into_iter().enumerate() {
            set_text(field, self.restored_dates[index].as_ref().map_or("", |date| date.day.as_str()));
        }
        self.restore_categories(&strings(&filters["categories"]));
        self.restore_sort(filters["sortBy"].as_str().unwrap_or("relevance"),
            filters["sortDirection"].as_str().unwrap_or("desc"));
        self.selected_bookmark = Some(bookmark);
        KillTimer(window, SEARCH_TIMER);
        self.invalidate_pending(false);
        self.search(Navigation::First);
    }

    unsafe fn action_result(&mut self, window: HWND, opens_bookmarks: bool, result: Result<ActionResult, String>) {
        if opens_bookmarks {
            self.bookmark_menu_pending = false;
            self.buttons();
        }
        match result {
            Ok(ActionResult::Bookmarks(mut bookmarks, folders)) => {
                if let Some(selected) = self.selected_bookmark.as_ref() {
                    if !bookmarks.iter().any(|bookmark| bookmark.id == selected.id) {
                        self.selected_bookmark = None;
                    }
                }
                if IsWindowVisible(window) == 0 || IsIconic(window) != 0 { return; }
                let snapshot = self.search_snapshot();
                let command = actions::bookmark_menu(window, self.controls.bookmarks, &bookmarks,
                    &folders, self.selected_bookmark.as_ref(), matches!(snapshot, Ok(Some(_))));
                match command {
                    Some(BookmarkCommand::Save) => {
                        if let Ok(Some(mut value)) = snapshot {
                            value["name"] = json!(actions::bookmark_name(&value, &bookmarks));
                            if let Some(folder_id) = self.selected_bookmark.as_ref().and_then(|bookmark| bookmark.folder_id.as_ref()) {
                                value["folderId"] = json!(folder_id);
                            }
                            self.action(Action::SaveBookmark(value));
                        }
                    }
                    Some(BookmarkCommand::Delete) => {
                        if let Some(bookmark) = &self.selected_bookmark {
                            if actions::confirm_delete(window, bookmark) {
                                self.action(Action::DeleteBookmark(bookmark.id.clone()));
                            }
                            PostMessageW(window, WORKER_EVENT, 0, 0);
                        }
                    }
                    Some(BookmarkCommand::FullSearch) => self.open_full_search(),
                    Some(BookmarkCommand::Apply(index)) => self.apply_bookmark(window, bookmarks.swap_remove(index)),
                    None => {}
                }
            }
            Ok(ActionResult::Saved(bookmark)) => {
                self.label(&format!("搜索已保存为「{}」", bookmark.name));
                self.selected_bookmark = Some(bookmark);
            }
            Ok(ActionResult::Deleted(id)) => {
                if self.selected_bookmark.as_ref().is_some_and(|bookmark| bookmark.id == id) {
                    self.selected_bookmark = None;
                }
                self.label("已删除搜索书签");
            }
            Ok(ActionResult::Notice(message)) => self.label(&message),
            Err(error) => self.label(&error),
        }
    }

    unsafe fn open_full_search(&self) {
        self.action(Action::FullSearch(self.search_snapshot().ok().flatten()));
    }

    unsafe fn file_action(&self, action: FileAction, index: usize) {
        if !self.busy {
            if let Some(hit) = self.rows.get(index) {
                self.action(Action::File(action, hit.path.clone()));
            }
        }
    }

    unsafe fn file_menu(&self, window: HWND, screen: Option<POINT>) {
        if let Some((action, row)) = actions::result_menu(window, self.controls.list, screen) {
            self.file_action(action, row);
        } else if screen.is_none() && actions::selected_row(self.controls.list).is_none() {
            self.label("请先选择一个搜索结果");
        }
    }

    unsafe fn sync_mode(&mut self, window: HWND) -> bool {
        let content = selection(self.controls.search_type) == 1;
        let new_mode = if content { SearchMode::Content } else { SearchMode::Name };
        if self.search_mode == new_mode { return false; }
        let prior = selection(self.controls.mode);
        match self.search_mode {
            SearchMode::Name => self.name_matching_mode = prior,
            SearchMode::Content => self.content_matching_mode = prior,
        }
        self.search_mode = new_mode;
        if content {
            replace_choices(self.controls.mode, CONTENT_MODES, self.content_matching_mode);
        } else {
            replace_choices(self.controls.mode, NAME_MODES, self.name_matching_mode);
        }
        self.mode_controls();
        self.layout(window);
        true
    }

    unsafe fn restore_categories(&mut self, categories: &[String]) {
        self.category_mask = CATEGORIES.iter().enumerate()
            .filter(|(_, (id, _))| categories.iter().any(|category| category == id))
            .fold(0, |mask, (index, _)| mask | (1 << index));
        self.update_categories_label();
    }

    unsafe fn restore_sort(&self, field: &str, direction: &str) {
        let field = SORT_FIELDS.iter().position(|item| *item == field).unwrap_or(0);
        SendMessageW(self.controls.sort, CB_SETCURSEL, field, 0);
        SendMessageW(self.controls.sort_direction, CB_SETCURSEL, usize::from(direction == "asc"), 0);
    }

    unsafe fn update_categories_label(&self) {
        let caption = match self.category_mask.count_ones() {
            0 => "全部类别 ▾".into(),
            1 => format!("{} ▾", CATEGORIES[self.category_mask.trailing_zeros() as usize].1),
            count => format!("{count} 个类别 ▾"),
        };
        SetWindowTextW(self.controls.category, wide(&caption).as_ptr());
    }

    unsafe fn select_categories(&mut self, window: HWND) -> bool {
        let menu = CreatePopupMenu();
        if menu == 0 { return false; }
        let checked = |selected| if selected { MF_CHECKED } else { MF_UNCHECKED };
        AppendMenuW(menu, checked(self.category_mask == 0), 1, wide("全部类别").as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, null());
        for (index, (_, name)) in CATEGORIES.iter().enumerate() {
            AppendMenuW(menu, checked(self.category_mask & (1 << index) != 0), index + 2, wide(name).as_ptr());
        }
        let mut bounds: RECT = zeroed();
        GetWindowRect(self.controls.category, &mut bounds);
        let choice = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY, bounds.left, bounds.bottom, 0, window, null());
        DestroyMenu(menu);
        // The menu may have received a worker wake while State was borrowed.
        PostMessageW(window, WORKER_EVENT, 0, 0);
        let before = self.category_mask;
        match choice {
            1 => self.category_mask = 0,
            value if value >= 2 && (value as usize) < CATEGORIES.len() + 2 => self.category_mask ^= 1 << (value - 2),
            _ => {}
        }
        self.update_categories_label();
        self.category_mask != before
    }

    unsafe fn mode_controls(&self) {
        let content = self.search_mode == SearchMode::Content;
        for control in [self.controls.extensions, self.controls.kind, self.controls.category, self.controls.match_path] {
            EnableWindow(control, (!content) as i32);
        }
        self.buttons();
    }

    unsafe fn build_content(&mut self) {
        if self.search_mode != SearchMode::Content || self.build.is_some() || !self.ready { return; }
        let scope_text = control_text(self.controls.scope);
        let scope = match content_scope(&scope_text) {
            Ok(scope) => scope.to_owned(),
            Err(error) => { self.label(&error); return; }
        };
        self.invalidate_pending(false);
        self.busy = true;
        self.reset_results();
        self.label("正在为所选目录建立全文索引…");
        self.build = Some(Build { scope: scope.clone(), canonical: None });
        self.buttons();
        self.mailbox.build(scope);
    }

    fn invalidate_pending(&mut self, cancelled: bool) {
        self.revision = self.revision.wrapping_add(1);
        self.cancelled = cancelled;
        self.mailbox.cancel_search();
    }

    unsafe fn cancel(&mut self, window: HWND) {
        KillTimer(window, SEARCH_TIMER);
        self.invalidate_pending(true);
        self.busy = false;
        self.reset_results();
        self.buttons();
        if self.build.is_some() && self.search_mode == SearchMode::Content {
            self.label("已取消搜索；目录索引将在后台完成");
        } else {
            self.label("已取消搜索");
        }
    }

    unsafe fn building_selected_scope(&self) -> bool {
        self.build.as_ref().is_some_and(|build| {
            self.search_mode == SearchMode::Content
                && content_scope(&control_text(self.controls.scope)).is_ok_and(|scope| scope == build.scope)
        })
    }

    unsafe fn apply_content_status(&mut self, status: ContentStatus) {
        let matches_pending = self.build.as_ref().and_then(|build| build.canonical.as_deref())
            .is_some_and(|scope| scope == status.root);
        if !matches_pending { return; }
        let selected = self.building_selected_scope();
        self.build = None;
        if selected {
            self.busy = false;
            if status.state == "ready" && !self.cancelled {
                self.search(Navigation::First);
                if !self.busy {
                    self.label(&format!("全文索引已建立，已索引 {} 个文件", status.files_indexed));
                }
            } else if status.state == "error" {
                self.label(&status.message);
            } else {
                self.label("全文索引已建立；搜索保持取消");
            }
        }
        self.buttons();
    }

    unsafe fn report_visibility(&mut self, window: HWND, visible: bool) {
        if self.hosted && self.host_ready && self.visible != Some(visible) {
            self.visible = Some(visible);
            let _ = send_host_event(&json!({ "event": "visibility", "visible": visible }));
            if visible && std::mem::take(&mut self.refresh_on_show) && self.can_refresh_names() {
                self.refresh_names(window);
            }
        }
    }

    unsafe fn can_refresh_names(&self) -> bool {
        self.search_mode == SearchMode::Name
            && !self.cancelled
            && (!control_text(self.controls.query).trim().is_empty()
                || !control_text(self.controls.additional).trim().is_empty())
    }

    unsafe fn refresh_names(&mut self, window: HWND) {
        KillTimer(window, SEARCH_TIMER);
        KillTimer(window, REFRESH_TIMER);
        self.invalidate_pending(false);
        self.search(Navigation::First);
    }

    unsafe fn worker_events(&mut self, window: HWND) {
        while let Ok(event) = self.events.try_recv() {
            match event {
                Event::Ready => {
                    self.ready = true;
                    if !self.busy { self.label("输入关键词开始搜索"); }
                    self.buttons();
                }
                Event::Failed(error) => {
                    self.busy = false;
                    self.stopped = true;
                    self.label(&error);
                    EnableWindow(self.controls.search_now, 0);
                    self.buttons();
                }
                Event::Page { job, result } if job.revision == self.revision => {
                    self.busy = false;
                    match result {
                        Ok(page) => self.page(job, page),
                        Err(error) => self.label(&error),
                    }
                    self.buttons();
                }
                Event::BuildStarted { canonical } => {
                    if let Some(build) = &mut self.build { build.canonical = Some(canonical); }
                }
                Event::BuildFailed(error) => {
                    let selected = self.building_selected_scope();
                    self.build = None;
                    if selected {
                        self.busy = false;
                        self.label(&error);
                    }
                    self.buttons();
                }
                Event::ContentStatus(status) => self.apply_content_status(status),
                Event::Action { opens_bookmarks, result } => self.action_result(window, opens_bookmarks, result),
                Event::Host(HostMessage::Show) => {
                    show_and_focus(window, self.controls.query);
                    self.report_visibility(window, IsWindowVisible(window) != 0 && IsIconic(window) == 0);
                }
                Event::Host(HostMessage::Hide) => {
                    ShowWindow(window, SW_HIDE);
                    self.report_visibility(window, false);
                }
                Event::Host(HostMessage::Shutdown) => {
                    // Defer closing until this mutable State borrow ends.
                    PostMessageW(window, WM_CLOSE, 0, 0);
                }
                Event::Host(HostMessage::IndexStatus { state, message }) => {
                    let became_ready = state == "ready" && !self.host_index_ready;
                    self.host_index_ready = state == "ready";
                    if became_ready && self.can_refresh_names() {
                        if self.visible == Some(true) {
                            self.refresh_names(window);
                        } else {
                            self.refresh_on_show = true;
                        }
                    } else if !self.busy && self.rows.is_empty() && self.search_mode == SearchMode::Name
                        && !message.is_empty()
                    {
                        self.label(&message);
                    }
                }
                Event::Host(HostMessage::IndexChanged) => {
                    if self.visible == Some(true) && self.host_index_ready
                        && !self.busy && self.previous.is_empty() && self.can_refresh_names()
                    {
                        SetTimer(window, REFRESH_TIMER, 240, None);
                    }
                }
                _ => {}
            }
        }
    }

    unsafe fn page(&mut self, job: Job, page: Page) {
        if page.cursor_reset {
            self.previous.clear();
            self.cursor = None;
        } else {
            match job.navigation {
                Navigation::First => self.previous.clear(),
                Navigation::Previous => { self.previous.pop(); }
                Navigation::Next => self.previous.push(self.cursor.clone()),
            }
            self.cursor = job.cursor;
        }
        self.rows = page.results;
        self.next_cursor = page.next_cursor.filter(|_| page.has_more);
        let list = self.controls.list;
        SendMessageW(list, LVM_SETITEMCOUNT, self.rows.len(), 0);
        if !self.rows.is_empty() { SendMessageW(list, LVM_ENSUREVISIBLE, 0, 0); }
        InvalidateRect(list, null(), 0);
        if page.partial == Some(true) {
            self.label(&format!("当前显示 {} 条实时扫描结果，完整索引就绪后自动刷新", self.rows.len()));
            return;
        }
        let count = page.total_matches
            .map(|total| format!("{total} 个匹配结果"))
            .unwrap_or_else(|| "匹配结果".to_string());
        self.label(&format!("{count} · 第 {} 页 · 本页 {} 条", self.previous.len() + 1, self.rows.len()));
    }

    unsafe fn label(&self, text: &str) {
        SetWindowTextW(self.controls.label, wide(text).as_ptr());
    }

    unsafe fn buttons(&self) {
        EnableWindow(self.controls.previous, (!self.busy && !self.previous.is_empty()) as i32);
        EnableWindow(self.controls.next, (!self.busy && self.next_cursor.is_some()) as i32);
        EnableWindow(self.controls.cancel, self.busy as i32);
        EnableWindow(self.controls.build, (self.search_mode == SearchMode::Content && self.ready && self.build.is_none() && !self.stopped) as i32);
        if self.hosted {
            EnableWindow(self.controls.bookmarks, (!self.stopped && !self.bookmark_menu_pending) as i32);
            EnableWindow(self.controls.file_actions, (!self.busy && !self.rows.is_empty() && !self.stopped) as i32);
            EnableWindow(self.controls.full_search, (!self.stopped) as i32);
        }
    }

    unsafe fn list_text(&self, notification: *mut NMLVDISPINFOW) {
        let item = &mut (*notification).item;
        if item.mask & LVIF_TEXT == 0 || item.cchTextMax < 1 || item.pszText.is_null() { return; }
        let Some(hit) = self.rows.get(item.iItem as usize) else { return };
        let size;
        let text = match item.iSubItem {
            0 => &hit.name,
            1 => &hit.path,
            2 if hit.is_directory != Some(true) => { size = hit.size.to_string(); &size }
            3 => hit.preview.as_deref().unwrap_or(""),
            _ => "",
        };
        let max = item.cchTextMax as usize - 1;
        for (index, ch) in text.encode_utf16().take(max).chain([0]).enumerate() {
            item.pszText.add(index).write(ch);
        }
    }
}

unsafe fn show_and_focus(window: HWND, input: HWND) {
    let show = if IsIconic(window) != 0 { SW_RESTORE } else { SW_SHOW };
    ShowWindow(window, show);
    // A launcher can override the first ShowWindow call with SW_HIDE.
    if IsWindowVisible(window) == 0 { ShowWindow(window, show); }
    SetForegroundWindow(window);
    SetFocus(input);
}

unsafe fn control(parent: HWND, class: &str, name: &str, id: usize, style: u32, ex_style: u32) -> Result<HWND, String> {
    let child = CreateWindowExW(
        ex_style, wide(class).as_ptr(), wide(name).as_ptr(), WS_CHILD | WS_VISIBLE | style,
        0, 0, 0, 0, parent, id as isize, GetModuleHandleW(null()), null(),
    );
    if child == 0 { return Err(format!("Cannot create {class} control")); }
    SendMessageW(child, WM_SETFONT, GetStockObject(DEFAULT_GUI_FONT) as WPARAM, 0);
    Ok(child)
}

unsafe fn combo(parent: HWND, id: usize, names: &[&str]) -> Result<HWND, String> {
    let handle = control(parent, "COMBOBOX", "", id, CBS_DROPDOWNLIST as u32 | WS_TABSTOP | WS_VSCROLL, 0)?;
    replace_choices(handle, names, 0);
    Ok(handle)
}

unsafe fn replace_choices(handle: HWND, names: &[&str], selected: usize) {
    SendMessageW(handle, CB_RESETCONTENT, 0, 0);
    for name in names {
        SendMessageW(handle, CB_ADDSTRING, 0, wide(name).as_ptr() as LPARAM);
    }
    SendMessageW(handle, CB_SETCURSEL, selected.min(names.len() - 1), 0);
}

unsafe fn selection(handle: HWND) -> usize {
    SendMessageW(handle, CB_GETCURSEL, 0, 0).max(0) as usize
}

unsafe fn control_text(handle: HWND) -> String {
    let mut buffer = vec![0; GetWindowTextLengthW(handle).clamp(0, 32_767) as usize + 1];
    let length = GetWindowTextW(handle, buffer.as_mut_ptr(), buffer.len() as i32);
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

unsafe fn set_text(handle: HWND, text: &str) {
    SetWindowTextW(handle, wide(text).as_ptr());
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

fn content_scope(scope: &str) -> Result<&str, String> {
    let mut lines = scope.lines().map(str::trim).filter(|item| !item.is_empty());
    if let Some(directory) = lines.next() {
        if lines.next().is_none() && Path::new(directory).is_absolute() {
            return Ok(directory);
        }
    }
    Err("全文搜索请选择一个绝对目录；点击「建立全文索引」".into())
}

unsafe extern "system" fn procedure(window: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == WM_GETMINMAXINFO {
        let size = &mut *(l as *mut MINMAXINFO);
        size.ptMinTrackSize.x = 860;
        size.ptMinTrackSize.y = 420;
        return 0;
    }
    if message == WM_NCCREATE {
        let creation = &*(l as *const CREATESTRUCTW);
        SetWindowLongPtrW(window, GWLP_USERDATA, creation.lpCreateParams as isize);
        return 1;
    }
    let pointer = GetWindowLongPtrW(window, GWLP_USERDATA) as *const RefCell<State>;
    // Win32 control operations can synchronously reenter the parent. RefCell
    // keeps those paths from aliasing a mutable State reference.
    if let Some(state) = pointer.as_ref() {
        if let Ok(mut state) = state.try_borrow_mut() {
            match message {
                WM_CREATE => return if state.controls(window).is_ok() { 0 } else { -1 },
                WM_SHOWWINDOW => {
                    state.report_visibility(window, w != 0 && IsIconic(window) == 0);
                }
                WM_SIZE => {
                    state.report_visibility(window, w != SIZE_MINIMIZED as usize && IsWindowVisible(window) != 0);
                    if w != SIZE_MINIMIZED as usize { state.layout(window); }
                    return 0;
                }
                WM_COMMAND => {
                    let id = w & 0xFFFF;
                    let notification = (w >> 16) as u32;
                    if id == PREVIOUS || id == NEXT {
                        state.search(if id == PREVIOUS { Navigation::Previous } else { Navigation::Next });
                    } else if id == SEARCH_TYPE && notification == CBN_SELCHANGE {
                        KillTimer(window, SEARCH_TIMER);
                        state.change_mode(window);
                    } else if id == BUILD_CONTENT {
                        KillTimer(window, SEARCH_TIMER);
                        state.build_content();
                    } else if id == CANCEL {
                        state.cancel(window);
                    } else if state.hosted && id == BOOKMARKS {
                        state.request_bookmarks();
                    } else if state.hosted && id == FILE_ACTIONS {
                        state.file_menu(window, None);
                    } else if state.hosted && id == FULL_SEARCH {
                        state.open_full_search();
                    } else if id == SEARCH_NOW {
                        KillTimer(window, SEARCH_TIMER);
                        state.invalidate_pending(false);
                        state.search(Navigation::First);
                    } else if matches!(id, QUERY | SCOPE | EXTENSIONS | ADDITIONAL | MIN_SIZE | MAX_SIZE | MODIFIED_FROM | MODIFIED_TO) && notification == EN_CHANGE
                        || matches!(id, KIND | MODE | SORT | SORT_DIRECTION) && notification == CBN_SELCHANGE
                        || matches!(id, MATCH_PATH | CASE) && notification == BN_CLICKED
                        || id == CATEGORY && notification == BN_CLICKED && state.select_categories(window)
                    {
                        if id == MODIFIED_FROM { state.restored_dates[0] = None; }
                        if id == MODIFIED_TO { state.restored_dates[1] = None; }
                        state.invalidate_pending(false);
                        state.busy = true;
                        state.buttons();
                        SetTimer(window, SEARCH_TIMER, 140, None);
                    }
                }
                WM_TIMER if w == SEARCH_TIMER => {
                    KillTimer(window, SEARCH_TIMER);
                    state.search(Navigation::First);
                    return 0;
                }
                WM_TIMER if w == REFRESH_TIMER => {
                    KillTimer(window, REFRESH_TIMER);
                    if state.visible == Some(true) && !state.busy
                        && state.previous.is_empty() && state.can_refresh_names()
                    {
                        state.invalidate_pending(false);
                        state.search(Navigation::First);
                    }
                    return 0;
                }
                WM_NOTIFY if l != 0 => {
                    let header = &*(l as *const NMHDR);
                    if header.hwndFrom == state.controls.list {
                        if header.code == LVN_GETDISPINFOW {
                            state.list_text(l as *mut NMLVDISPINFOW);
                            return 0;
                        }
                        if state.hosted && header.code == LVN_ITEMACTIVATE {
                            let activation = &*(l as *const NMITEMACTIVATE);
                            if let Ok(row) = usize::try_from(activation.iItem) {
                                state.file_action(FileAction::Open, row);
                            }
                            return 0;
                        }
                    }
                }
                WM_CONTEXTMENU if state.hosted && !state.busy && w as HWND == state.controls.list => {
                    let screen = (l != -1).then(|| POINT { x: l as i16 as i32, y: (l >> 16) as i16 as i32 });
                    state.file_menu(window, screen);
                    return 0;
                }
                WORKER_EVENT => { state.worker_events(window); return 0; }
                WM_DESTROY => {
                    state.report_visibility(window, false);
                    state.mailbox.close();
                    PostQuitMessage(0);
                    return 0;
                }
                WM_NCDESTROY => { SetWindowLongPtrW(window, GWLP_USERDATA, 0); }
                _ => {}
            }
        }
    }
    DefWindowProcW(window, message, w, l)
}

pub fn show(config: Config) -> Result<(), String> {
    let hosted = config.is_hosted();
    let mailbox = Arc::new(Mailbox::default());
    let (sender, events) = mpsc::channel();
    let state = Box::new(RefCell::new(State {
        controls: Controls::default(), mailbox: mailbox.clone(), events, revision: 0,
        ready: false, stopped: false, busy: false, cancelled: false, category_mask: 0, search_mode: SearchMode::Name,
        name_matching_mode: 0, content_matching_mode: 0, build: None, rows: Vec::new(), cursor: None,
        next_cursor: None, previous: Vec::new(),
        hosted, host_ready: false, visible: None, host_index_ready: false, refresh_on_show: false,
        selected_bookmark: None, restored_dates: [None, None], bookmark_menu_pending: false,
    }));
    let window = unsafe {
        let classes = INITCOMMONCONTROLSEX { dwSize: size_of::<INITCOMMONCONTROLSEX>() as u32, dwICC: ICC_LISTVIEW_CLASSES };
        if InitCommonControlsEx(&classes) == 0 { return Err("Cannot initialize the native result list".into()); }
        let class_name = wide("CShiftQuickSearchPrototype");
        let class = WNDCLASSW {
            lpfnWndProc: Some(procedure), hInstance: GetModuleHandleW(null()),
            hCursor: LoadCursorW(0, IDC_ARROW), hbrBackground: (COLOR_WINDOW + 1) as isize,
            lpszClassName: class_name.as_ptr(), ..zeroed()
        };
        if RegisterClassW(&class) == 0 { return Err("Cannot register the search window".into()); }
        let title = wide(if hosted { "CDriveShiftAI · 文件搜索" } else { "CDriveShiftAI · 原生文件搜索原型" });
        let window = CreateWindowExW(
            0, class_name.as_ptr(), title.as_ptr(), WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT, CW_USEDEFAULT, 1060, 700, 0, 0, class.hInstance,
            &*state as *const RefCell<State> as *const c_void,
        );
        if window == 0 { return Err("Cannot create the search window".into()); }
        if hosted {
            if let Err(error) = send_host_event(&json!({ "event": "ready", "protocol": 1 })) {
                DestroyWindow(window);
                return Err(error);
            }
            state.borrow_mut().host_ready = true;
        }
        let (query, scope) = {
            let state = state.borrow();
            (state.controls.query, state.controls.scope)
        };
        if config.root != "*" {
            SetWindowTextW(scope, wide(&config.root).as_ptr());
        }
        show_and_focus(window, query);
        state.borrow_mut().report_visibility(window, IsWindowVisible(window) != 0 && IsIconic(window) == 0);
        window
    };
    let worker_mailbox = mailbox.clone();
    let worker = thread::spawn(move || {
        let send = |event| publish(&sender, &worker_mailbox.stop, window, event);
        let content_sender = sender.clone();
        let content_stop = worker_mailbox.stop.clone();
        let content_callback = move |status| publish(&content_sender, &content_stop, window, Event::ContentStatus(status));
        let host_sender = sender.clone();
        let host_stop = worker_mailbox.stop.clone();
        let host_callback = hosted.then(|| {
            Box::new(move |command| publish(&host_sender, &host_stop, window, Event::Host(command)))
                as Box<dyn Fn(HostMessage) + Send>
        });
        let mut engine = match Engine::start(
            &config, worker_mailbox.stop.clone(), Some(Box::new(content_callback)), host_callback
        ) {
            Ok(engine) => engine,
            Err(error) => { send(Event::Failed(error)); return; }
        };
        send(Event::Ready);
        while let Some(work) = worker_mailbox.take() {
            match work {
                Work::Search(mut job) => {
                    let result = engine.query(job.mode, std::mem::take(&mut job.filters));
                    send(Event::Page { job, result });
                }
                Work::Build(scope) => {
                    let result = (|| {
                        let path = std::fs::canonicalize(scope)
                            .map_err(|error| format!("无法访问内容索引目录：{error}"))?;
                        let canonical = path.to_string_lossy().into_owned();
                        send(Event::BuildStarted { canonical: canonical.clone() });
                        engine.index_content(&canonical)
                    })();
                    if let Err(error) = result { send(Event::BuildFailed(error)); }
                }
                Work::Action(action) => {
                    let opens_bookmarks = matches!(&action, Action::Bookmarks);
                    send(Event::Action { opens_bookmarks, result: action.run(&mut engine) });
                }
            }
        }
    });

    let result = unsafe {
        let mut message: MSG = zeroed();
        loop {
            let active = GetMessageW(&mut message, 0, 0, 0);
            if active == 0 { break Ok(()); }
            if active < 0 { break Err("The native window message loop failed".into()); }
            if message.message == WM_KEYDOWN && message.wParam == 13
                && message.hwnd == state.borrow().controls.query
            {
                SendMessageW(window, WM_COMMAND, SEARCH_NOW, 0);
            } else if IsDialogMessageW(window, &message) == 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    };
    mailbox.close();
    let _ = worker.join();
    result
}

fn publish(sender: &mpsc::Sender<Event>, stop: &AtomicBool, window: HWND, event: Event) {
    if !stop.load(Ordering::Acquire) && sender.send(event).is_ok() {
        // Ownership stays with the channel. The message only wakes UI.
        unsafe { PostMessageW(window, WORKER_EVENT, 0, 0); }
    }
}
