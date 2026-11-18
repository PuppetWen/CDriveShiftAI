use std::mem::zeroed;
use std::ptr::null;

use serde::Deserialize;
use serde_json::{json, Value};
use windows_sys::Win32::{
    Foundation::{FILETIME, HWND, LPARAM, POINT, RECT, SYSTEMTIME},
    Graphics::Gdi::ScreenToClient,
    System::Time::{FileTimeToSystemTime, SystemTimeToFileTime, SystemTimeToTzSpecificLocalTimeEx},
    UI::{Controls::*, WindowsAndMessaging::*},
};

use super::{wide, WORKER_EVENT};
use crate::engine::Engine;

const FIELDS: &[&str] = &[
    "keywords", "keywordMatch", "kind", "scopes", "categories", "extensions", "minSize",
    "maxSize", "caseSensitive", "wholeWord", "fuzzy", "matchPath", "regex", "sortBy",
    "sortDirection",
];
const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Bookmark {
    pub id: String,
    pub name: String,
    pub folder_id: Option<String>,
    pub mode: String,
    pub query: String,
    pub filters: Value,
    pub content_scope: String,
    #[serde(default)]
    pub date_preset: String,
}

#[derive(Deserialize)]
pub(super) struct BookmarkFolder {
    pub id: String,
    pub name: String,
}

pub(super) enum Action {
    Bookmarks,
    SaveBookmark(Value),
    DeleteBookmark(String),
    File(FileAction, String),
    FullSearch(Option<Value>),
}

#[derive(Clone, Copy)]
pub(super) enum FileAction {
    Open,
    Reveal,
    CopyPath,
    All,
    ForceDelete,
}

pub(super) enum ActionResult {
    Bookmarks(Vec<Bookmark>, Vec<BookmarkFolder>),
    Saved(Bookmark),
    Deleted(String),
    Notice(String),
}

impl Action {
    pub(super) fn run(self, engine: &mut Engine) -> Result<ActionResult, String> {
        let result = |value: &mut Value, name: &str| {
            value.get_mut(name).map(Value::take).ok_or_else(|| format!("缺少 {name} 响应"))
        };
        match self {
            Self::Bookmarks => {
                let mut saved = engine.hosted_action("bookmarksList", json!({}))?;
                let mut groups = engine.hosted_action("bookmarkFoldersList", json!({}))?;
                let saved = serde_json::from_value(result(&mut saved, "bookmarks")?)
                    .map_err(|_| "书签数据无效".to_owned())?;
                let groups = serde_json::from_value(result(&mut groups, "folders")?)
                    .map_err(|_| "书签文件夹数据无效".to_owned())?;
                Ok(ActionResult::Bookmarks(saved, groups))
            }
            Self::SaveBookmark(value) => {
                let mut response = engine.hosted_action("bookmarkSave", json!({ "value": value }))?;
                serde_json::from_value(result(&mut response, "bookmark")?)
                    .map(ActionResult::Saved)
                    .map_err(|_| "书签保存响应无效".to_owned())
            }
            Self::DeleteBookmark(id) => {
                let response = engine.hosted_action("bookmarkDelete", json!({ "bookmarkId": id }))?;
                if response["deleted"] == true {
                    Ok(ActionResult::Deleted(id))
                } else {
                    Err("书签已不存在".into())
                }
            }
            Self::File(action, path) => {
                let (verb, message) = match action {
                    FileAction::Open => ("open", "已打开"),
                    FileAction::Reveal => ("reveal", "已在资源管理器中定位"),
                    FileAction::CopyPath => ("copyPath", "已复制完整路径"),
                    FileAction::All => ("menu", "已打开完整文件操作"),
                    FileAction::ForceDelete => ("forceDelete", "已打开强制删除确认")
                };
                let response = engine.hosted_action("fileAction", json!({ "action": verb, "path": path }))?;
                Ok(ActionResult::Notice(response["message"].as_str().unwrap_or(message).to_owned()))
            }
            Self::FullSearch(value) => {
                let fields = value.map_or_else(|| json!({}), |value| json!({ "value": value }));
                engine.hosted_action("openFullSearch", fields)?;
                Ok(ActionResult::Notice("已打开完整搜索界面".into()))
            }
        }
    }
}

struct Popup(HMENU);

impl Popup {
    unsafe fn new() -> Option<Self> {
        let handle = CreatePopupMenu();
        (handle != 0).then_some(Self(handle))
    }

    unsafe fn item(&self, id: usize, label: &str, enabled: bool) {
        let flags = if enabled { MF_STRING } else { MF_STRING | MF_GRAYED };
        // Ampersands in filenames or bookmark names are literal text.
        AppendMenuW(self.0, flags, id, wide(&label.replace('&', "&&")).as_ptr());
    }

    unsafe fn include(&self, child: Self, label: &str) {
        if AppendMenuW(self.0, MF_POPUP, child.0 as usize, wide(&label.replace('&', "&&")).as_ptr()) != 0 {
            // The parent owns the submenu on success.
            std::mem::forget(child);
        }
    }

    unsafe fn divider(&self) {
        AppendMenuW(self.0, MF_SEPARATOR, 0, null());
    }

    unsafe fn choose(&self, owner: HWND, point: POINT) -> i32 {
        let command = TrackPopupMenu(self.0, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
            point.x, point.y, 0, owner, null());
        // A modal native menu may dispatch a wake message while State is
        // borrowed. Retry dispatch once the outer window handler returns.
        PostMessageW(owner, WORKER_EVENT, 0, 0);
        command
    }
}

impl Drop for Popup {
    fn drop(&mut self) {
        unsafe { DestroyMenu(self.0); }
    }
}

unsafe fn anchor(control: HWND) -> POINT {
    let mut bounds: RECT = zeroed();
    GetWindowRect(control, &mut bounds);
    POINT { x: bounds.left, y: bounds.bottom }
}

pub(super) enum BookmarkCommand {
    Save,
    Delete,
    FullSearch,
    Apply(usize),
}

pub(super) unsafe fn bookmark_menu(
    window: HWND,
    button: HWND,
    bookmarks: &[Bookmark],
    folders: &[BookmarkFolder],
    selected: Option<&Bookmark>,
    can_save: bool,
) -> Option<BookmarkCommand> {
    let menu = Popup::new()?;
    menu.item(1, "添加当前搜索", can_save);
    if let Some(bookmark) = selected {
        menu.item(2, &format!("删除已应用的书签「{}」…", bookmark.name), true);
    }
    menu.divider();
    const BASE: usize = 100;
    let mut shown = vec![false; bookmarks.len()];
    for folder in folders {
        let group = Popup::new()?;
        let mut count = 0;
        for (index, bookmark) in bookmarks.iter().enumerate() {
            if bookmark.folder_id.as_deref() == Some(folder.id.as_str()) {
                group.item(BASE + index, &bookmark.name, true);
                shown[index] = true;
                count += 1;
            }
        }
        if count > 0 {
            menu.include(group, &folder.name);
        }
    }
    for (index, bookmark) in bookmarks.iter().enumerate() {
        if !shown[index] { menu.item(BASE + index, &bookmark.name, true); }
    }
    if bookmarks.is_empty() { menu.item(0, "还没有搜索书签", false); }
    menu.divider();
    menu.item(3, "在完整界面管理书签", true);
    match menu.choose(window, anchor(button)) {
        1 => Some(BookmarkCommand::Save),
        2 => Some(BookmarkCommand::Delete),
        3 => Some(BookmarkCommand::FullSearch),
        selection if (selection as usize) >= BASE && (selection as usize) < BASE + bookmarks.len() => {
            Some(BookmarkCommand::Apply(selection as usize - BASE))
        }
        _ => None,
    }
}

pub(super) unsafe fn confirm_delete(window: HWND, bookmark: &Bookmark) -> bool {
    let question = wide(&format!("删除搜索书签「{}」？此操作不会删除任何文件。", bookmark.name));
    let title = wide("CDriveShiftAI");
    MessageBoxW(window, question.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) == IDYES
}

pub(super) unsafe fn selected_row(list: HWND) -> Option<usize> {
    usize::try_from(SendMessageW(list, LVM_GETNEXTITEM, usize::MAX, LVNI_SELECTED as LPARAM)).ok()
}

pub(super) unsafe fn result_menu(
    window: HWND,
    list: HWND,
    screen: Option<POINT>,
) -> Option<(FileAction, usize)> {
    let (point, row) = if let Some(point) = screen {
        let mut hit = LVHITTESTINFO { pt: point, ..zeroed() };
        if ScreenToClient(list, &mut hit.pt) == 0 { return None; }
        let row = usize::try_from(SendMessageW(list, LVM_HITTEST, 0, &mut hit as *mut _ as LPARAM)).ok()?;
        (point, row)
    } else {
        (anchor(list), selected_row(list)?)
    };
    let menu = Popup::new()?;
    menu.item(1, "打开", true);
    menu.item(2, "在资源管理器中定位", true);
    menu.item(3, "复制完整路径", true);
    menu.divider();
    menu.item(4, "更多文件操作…", true);
    menu.item(5, "强制删除…", true);
    let action = match menu.choose(window, point) {
        1 => FileAction::Open,
        2 => FileAction::Reveal,
        3 => FileAction::CopyPath,
        4 => FileAction::All,
        5 => FileAction::ForceDelete,
        _ => return None,
    };
    Some((action, row))
}

pub(super) fn search_snapshot(search: &Value, query: &str, extension_input: &str, content: bool) -> Value {
    let mut values = serde_json::Map::new();
    for &field in FIELDS {
        if let Some(value) = search.get(field) {
            values.insert(field.to_owned(), value.clone());
        }
    }
    values.entry("kind").or_insert(json!("all"));
    values.insert("scope".into(), search["scopes"].get(0).cloned().unwrap_or(json!("*")));
    for (key, ms) in [("modifiedAfter", "modifiedAfterMs"), ("modifiedBefore", "modifiedBeforeMs")] {
        if let Some(iso) = search[ms].as_u64().and_then(iso_at) {
            values.insert(key.into(), json!(iso));
        }
    }
    json!({
        "mode": if content { "content" } else { "name" },
        "query": query, "filters": values, "filterPanelOpen": true, "extensionInput": extension_input,
        "datePreset": if search["modifiedAfterMs"].is_number() || search["modifiedBeforeMs"].is_number() { "custom" } else { "any" },
        "contentScope": if content { search["scope"].as_str().unwrap_or("*") } else { "*" }
    })
}

pub(super) fn bookmark_name(snapshot: &Value, bookmarks: &[Bookmark]) -> String {
    let keywords = super::strings(&snapshot["filters"]["keywords"]).join(" ");
    let base: String = keywords.chars().take(48).collect();
    let names: std::collections::HashSet<_> = bookmarks.iter().map(|bookmark| bookmark.name.to_lowercase()).collect();
    let mut name = base.clone();
    let mut suffix = 2;
    while names.contains(&name.to_lowercase()) {
        name = format!("{base} ({suffix})");
        suffix += 1;
    }
    name
}

pub(super) struct SavedDate {
    pub day: String,
    pub timestamp: u64,
}

// Saved searches use Date.toISOString() in the Electron view. Keep the exact
// timestamp when importing preset dates instead of rounding them to midnight.
pub(super) fn saved_date(value: &Value) -> Option<SavedDate> {
    let iso = value.as_str()?;
    let (hour, minute, second, millis) = match iso.as_bytes() {
        [_, _, _, _, b'-', _, _, b'-', _, _] => (0, 0, 0, 0),
        [_, _, _, _, b'-', _, _, b'-', _, _, b'T', _, _, b':', _, _, b':', _, _, b'Z'] => {
            (number(iso, 11, 13)?, number(iso, 14, 16)?, number(iso, 17, 19)?, 0)
        }
        [_, _, _, _, b'-', _, _, b'-', _, _, b'T', _, _, b':', _, _, b':', _, _, b'.', _, _, _, b'Z'] => {
            (number(iso, 11, 13)?, number(iso, 14, 16)?, number(iso, 17, 19)?, number(iso, 20, 23)?)
        }
        _ => return None,
    };
    let utc = SYSTEMTIME {
        wYear: number(iso, 0, 4)?, wMonth: number(iso, 5, 7)?, wDay: number(iso, 8, 10)?,
        wHour: hour, wMinute: minute, wSecond: second, wMilliseconds: millis, wDayOfWeek: 0,
    };
    let mut local: SYSTEMTIME = unsafe { zeroed() };
    let mut file: FILETIME = unsafe { zeroed() };
    if unsafe { SystemTimeToFileTime(&utc, &mut file) } == 0
        || unsafe { SystemTimeToTzSpecificLocalTimeEx(null(), &utc, &mut local) } == 0
    {
        return None;
    }
    let ticks = (u64::from(file.dwHighDateTime) << 32) | u64::from(file.dwLowDateTime);
    Some(SavedDate {
        day: format!("{:04}-{:02}-{:02}", local.wYear, local.wMonth, local.wDay),
        timestamp: ticks.checked_sub(UNIX_EPOCH_TICKS)? / 10_000,
    })
}

fn number(value: &str, start: usize, end: usize) -> Option<u16> {
    let digits = value.get(start..end)?;
    if !digits.bytes().all(|digit| digit.is_ascii_digit()) { return None; }
    digits.parse().ok()
}

fn iso_at(timestamp: u64) -> Option<String> {
    let ticks = timestamp.checked_mul(10_000)?.checked_add(UNIX_EPOCH_TICKS)?;
    let file = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    let mut utc: SYSTEMTIME = unsafe { zeroed() };
    if unsafe { FileTimeToSystemTime(&file, &mut utc) } == 0 { return None; }
    Some(format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        utc.wYear, utc.wMonth, utc.wDay, utc.wHour, utc.wMinute, utc.wSecond, utc.wMilliseconds))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_time_round_trips_at_its_original_precision() {
        let original = "2025-11-10T13:27:17.431Z";
        let saved = saved_date(&json!(original)).unwrap();
        assert_eq!(iso_at(saved.timestamp).as_deref(), Some(original));
        assert_eq!(saved.day.len(), 10);
        assert!(saved_date(&json!("2025-02-30T05:21:00.000Z")).is_none());
    }

    #[test]
    fn search_to_bookmark_preserves_tag_order_and_numeric_filters() {
        let query = json!({
            "keywords": ["标签", "text"], "scopes": ["C:\\Logs"], "minSize": 150,
            "modifiedAfterMs": 1000, "cursor": "irrelevant", "limit": 120
        });
        let saved = search_snapshot(&query, "text", "log", false);
        assert_eq!(saved["filters"]["keywords"], query["keywords"]);
        assert_eq!(saved["filters"]["scope"], "C:\\Logs");
        assert_eq!(saved["filters"]["minSize"], 150);
        assert_eq!(saved["filters"]["modifiedAfter"], "1970-01-01T00:00:01.000Z");
        assert!(saved["filters"].get("cursor").is_none());
        assert_eq!(saved["extensionInput"], "log");
    }
}
