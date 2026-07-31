use memmap2::{Mmap, MmapOptions};
use notify::{
    event::{ModifyKind, RemoveKind},
    Config as NotifyConfig, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use regex::RegexBuilder;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CACHE_MAGIC: &[u8; 8] = b"CSIDX02\0";
const CONTENT_INDEX_VERSION: u32 = 2;

#[derive(Clone, Debug)]
struct Entry {
    path: String,
    is_directory: bool,
    size: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum IndexDelta {
    Upsert {
        path: String,
        is_directory: bool,
        size: u64,
    },
    Remove {
        path: String,
        tree: bool,
    },
}

enum PathStorage {
    Empty,
    Owned(Vec<u8>),
    Mapped(Mmap),
}

impl Default for PathStorage {
    fn default() -> Self {
        Self::Empty
    }
}

#[derive(Clone, Copy)]
struct IndexedEntry {
    offset: u64,
    // Bit 31 = watcher/delta byte pool, bit 30 = directory.
    length_and_flags: u32,
    size: u64,
}

impl IndexedEntry {
    const DELTA_FLAG: u32 = 1 << 31;
    const DIRECTORY_FLAG: u32 = 1 << 30;
    const LENGTH_MASK: u32 = Self::DIRECTORY_FLAG - 1;

    fn new(offset: u64, length: usize, is_directory: bool, delta: bool, size: u64) -> Self {
        let mut length_and_flags = (length.min(Self::LENGTH_MASK as usize)) as u32;
        if is_directory {
            length_and_flags |= Self::DIRECTORY_FLAG;
        }
        if delta {
            length_and_flags |= Self::DELTA_FLAG;
        }
        Self {
            offset,
            length_and_flags,
            size,
        }
    }

    fn length(self) -> usize {
        (self.length_and_flags & Self::LENGTH_MASK) as usize
    }

    fn is_directory(self) -> bool {
        self.length_and_flags & Self::DIRECTORY_FLAG != 0
    }

    fn is_delta(self) -> bool {
        self.length_and_flags & Self::DELTA_FLAG != 0
    }
}

#[derive(Default)]
struct SearchIndex {
    storage: PathStorage,
    delta_paths: Vec<u8>,
    entries: Vec<IndexedEntry>,
    name_signatures: Vec<u64>,
    live: Vec<bool>,
    // The immutable base uses a sorted flat vector (16 bytes/entry) rather than
    // a hash table. Live watcher additions remain in a small hash map.
    path_positions: Vec<(u64, u32)>,
    delta_positions: HashMap<u64, u32>,
    live_count: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    mode: String,
    state: String,
    entries: usize,
    progress: f64,
    root: String,
    updated_at: Option<String>,
    message: Option<String>,
}

struct SharedState {
    index: RwLock<SearchIndex>,
    status: Mutex<Status>,
    roots: Vec<String>,
    display_root: String,
    cache_path: PathBuf,
    content_cache_dir: PathBuf,
    scanning: AtomicBool,
    content_scanning: AtomicBool,
    watching: AtomicBool,
    loading: AtomicBool,
    backgrounded: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    delta_lock: Mutex<()>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    op: String,
    root: Option<String>,
    cache_path: Option<String>,
    content_cache_dir: Option<String>,
    query: Option<String>,
    kind: Option<String>,
    scope: Option<String>,
    scopes: Option<Vec<String>>,
    categories: Option<Vec<String>>,
    extensions: Option<Vec<String>>,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    match_path: Option<bool>,
    regex: Option<bool>,
    background: Option<bool>,
    force_rebuild: Option<bool>,
    rebuild_reason: Option<String>,
    mouse_button: Option<String>,
    mouse_hold_ms: Option<u64>,
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    path: String,
    name: String,
    is_directory: bool,
    size: u64,
    score: f64,
    source: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentSearchResult {
    path: String,
    name: String,
    preview: String,
    score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentIndexStatus {
    state: &'static str,
    root: String,
    files_visited: usize,
    files_indexed: usize,
    message: String,
}

#[derive(Clone)]
struct Output {
    lock: Arc<Mutex<()>>,
}

impl Output {
    fn send(&self, value: &Value) {
        let _guard = self.lock.lock().unwrap_or_else(|error| error.into_inner());
        let stdout = io::stdout();
        let mut handle = stdout.lock();
        if serde_json::to_writer(&mut handle, value).is_ok() {
            let _ = handle.write_all(b"\n");
            let _ = handle.flush();
        }
    }

    fn status(&self, status: &Status) {
        self.send(&json!({ "event": "status", "status": status }));
    }
}

#[cfg(windows)]
struct MouseShortcutState {
    output: Output,
    pressed: AtomicBool,
    sequence: AtomicU64,
    button: AtomicU64,
    hold_ms: AtomicU64,
}

#[cfg(windows)]
static MOUSE_SHORTCUT_STATE: OnceLock<MouseShortcutState> = OnceLock::new();

#[cfg(windows)]
fn mouse_button_code(button: &str) -> u64 {
    match button {
        "back" => 1,
        "forward" => 2,
        "middle" => 3,
        _ => 0,
    }
}

#[cfg(windows)]
fn mouse_button_name(button: u64) -> &'static str {
    match button {
        1 => "back",
        2 => "forward",
        3 => "middle",
        _ => "disabled",
    }
}

#[cfg(windows)]
fn configure_mouse_shortcut(button: &str, hold_ms: u64) {
    let Some(state) = MOUSE_SHORTCUT_STATE.get() else {
        return;
    };
    state.pressed.store(false, Ordering::SeqCst);
    state.sequence.fetch_add(1, Ordering::SeqCst);
    state
        .button
        .store(mouse_button_code(button), Ordering::SeqCst);
    state
        .hold_ms
        .store(hold_ms.clamp(500, 10_000), Ordering::SeqCst);
}

#[cfg(not(windows))]
fn configure_mouse_shortcut(_button: &str, _hold_ms: u64) {}

#[cfg(windows)]
fn begin_mouse_shortcut_hold(button: u64) {
    let Some(state) = MOUSE_SHORTCUT_STATE.get() else {
        return;
    };
    if button == 0 || state.button.load(Ordering::SeqCst) != button {
        return;
    }
    if state.pressed.swap(true, Ordering::SeqCst) {
        return;
    }
    let sequence = state.sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let hold_ms = state.hold_ms.load(Ordering::SeqCst);
    let output = state.output.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(hold_ms));
        let Some(current) = MOUSE_SHORTCUT_STATE.get() else {
            return;
        };
        if current.pressed.load(Ordering::SeqCst)
            && current.sequence.load(Ordering::SeqCst) == sequence
            && current.button.load(Ordering::SeqCst) == button
        {
            output.send(&json!({
                "event": "mouseShortcutHold",
                "button": mouse_button_name(button),
                "holdMs": hold_ms
            }));
            current.pressed.store(false, Ordering::SeqCst);
        }
    });
}

#[cfg(windows)]
fn end_mouse_shortcut_hold(button: u64) {
    let Some(state) = MOUSE_SHORTCUT_STATE.get() else {
        return;
    };
    if state.button.load(Ordering::SeqCst) != button {
        return;
    }
    state.pressed.store(false, Ordering::SeqCst);
    state.sequence.fetch_add(1, Ordering::SeqCst);
}

#[cfg(windows)]
unsafe extern "system" fn mouse_shortcut_window_proc(
    window: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Input::{
        GetRawInputData, RAWINPUT, RAWINPUTHEADER, RID_INPUT, RIM_TYPEMOUSE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_4_UP, RI_MOUSE_BUTTON_5_DOWN,
        RI_MOUSE_BUTTON_5_UP, RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_UP, WM_INPUT,
    };

    if message == WM_INPUT {
        let mut raw = std::mem::MaybeUninit::<RAWINPUT>::zeroed();
        let mut size = std::mem::size_of::<RAWINPUT>() as u32;
        let copied = GetRawInputData(
            lparam,
            RID_INPUT,
            raw.as_mut_ptr().cast(),
            &mut size,
            std::mem::size_of::<RAWINPUTHEADER>() as u32,
        );
        if copied != u32::MAX {
            let raw = raw.assume_init();
            if raw.header.dwType == RIM_TYPEMOUSE {
                let flags = raw.data.mouse.Anonymous.Anonymous.usButtonFlags;
                if flags & RI_MOUSE_BUTTON_4_DOWN as u16 != 0 {
                    begin_mouse_shortcut_hold(1);
                }
                if flags & RI_MOUSE_BUTTON_4_UP as u16 != 0 {
                    end_mouse_shortcut_hold(1);
                }
                if flags & RI_MOUSE_BUTTON_5_DOWN as u16 != 0 {
                    begin_mouse_shortcut_hold(2);
                }
                if flags & RI_MOUSE_BUTTON_5_UP as u16 != 0 {
                    end_mouse_shortcut_hold(2);
                }
                if flags & RI_MOUSE_MIDDLE_BUTTON_DOWN as u16 != 0 {
                    begin_mouse_shortcut_hold(3);
                }
                if flags & RI_MOUSE_MIDDLE_BUTTON_UP as u16 != 0 {
                    end_mouse_shortcut_hold(3);
                }
            }
        }
    }
    DefWindowProcW(window, message, wparam, lparam)
}

#[cfg(windows)]
fn start_mouse_shortcut_listener(output: Output) {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::{RegisterRawInputDevices, RAWINPUTDEVICE, RIDEV_INPUTSINK};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage,
        HWND_MESSAGE, MSG, WNDCLASSW,
    };

    let listener_output = output.clone();
    if MOUSE_SHORTCUT_STATE
        .set(MouseShortcutState {
            output,
            pressed: AtomicBool::new(false),
            sequence: AtomicU64::new(0),
            button: AtomicU64::new(1),
            hold_ms: AtomicU64::new(3_000),
        })
        .is_err()
    {
        return;
    }

    thread::spawn(move || unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        let class_name: Vec<u16> = "CDriveShiftAI.MouseBackListener\0".encode_utf16().collect();
        let window_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(mouse_shortcut_window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: module,
            hIcon: 0,
            hCursor: 0,
            hbrBackground: 0,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        if RegisterClassW(&window_class) == 0 {
            listener_output.send(&json!({
                "event": "mouseShortcutStatus",
                "available": false,
                "errorCode": GetLastError()
            }));
            return;
        }

        let window = CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            0,
            module,
            std::ptr::null(),
        );
        if window == 0 {
            listener_output.send(&json!({
                "event": "mouseShortcutStatus",
                "available": false,
                "errorCode": GetLastError()
            }));
            return;
        }

        let mouse = RAWINPUTDEVICE {
            usUsagePage: 0x01,
            usUsage: 0x02,
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: window,
        };
        if RegisterRawInputDevices(&mouse, 1, std::mem::size_of::<RAWINPUTDEVICE>() as u32) == 0 {
            listener_output.send(&json!({
                "event": "mouseShortcutStatus",
                "available": false,
                "errorCode": GetLastError()
            }));
            return;
        }

        listener_output.send(&json!({
            "event": "mouseShortcutStatus",
            "available": true,
            "button": "back",
            "holdMs": 3000
        }));
        let mut message: MSG = std::mem::zeroed();
        loop {
            let result = GetMessageW(&mut message, 0, 0, 0);
            if result > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
                continue;
            }
            if result <= 0 {
                listener_output.send(&json!({
                    "event": "mouseShortcutStatus",
                    "available": false,
                    "errorCode": if result < 0 { GetLastError() } else { 0 },
                    "messageLoopResult": result
                }));
                break;
            }
        }
    });
}

#[cfg(not(windows))]
fn start_mouse_shortcut_listener(_output: Output) {}

fn now_iso_like() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    seconds.to_string()
}

fn normalized(value: &str) -> String {
    value.replace('/', "\\").to_lowercase()
}

fn normalized_path_hash(value: &str) -> u64 {
    // FNV-1a over the normalized UTF-8 representation is stable across runs,
    // compact, and sufficient for local path identity. Exact paths are still
    // verified against Entry when an unlikely collision is encountered.
    let mut hash = 14_695_981_039_346_656_037u64;
    for byte in normalized(value).bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    hash
}

fn wait_while_backgrounded(backgrounded: &AtomicBool, stopping: &AtomicBool) -> bool {
    while backgrounded.load(Ordering::Relaxed) && !stopping.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(250));
    }
    stopping.load(Ordering::Relaxed)
}

#[cfg(windows)]
fn trim_process_working_set() {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, SetProcessWorkingSetSize};
    unsafe {
        // usize::MAX asks Windows to discard reclaimable working-set pages.
        // The mapped cache stays valid and pages back on demand.
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

#[cfg(not(windows))]
fn trim_process_working_set() {}

fn file_name(value: &str) -> &str {
    value
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(value)
}

fn extension_name(value: &str) -> String {
    let name = file_name(value);
    name.rsplit_once('.')
        .filter(|(stem, extension)| !stem.is_empty() && !extension.is_empty())
        .map(|(_, extension)| extension.to_lowercase())
        .unwrap_or_default()
}

fn file_category(is_directory: bool, path_value: &str) -> &'static str {
    if is_directory {
        return "folder";
    }
    match extension_name(path_value).as_str() {
        "doc" | "docx" | "odt" | "pdf" | "ppt" | "pptx" | "rtf" | "txt" | "csv" | "xls"
        | "xlsx" => "document",
        "apng" | "avif" | "bmp" | "gif" | "heic" | "ico" | "jpeg" | "jpg" | "png" | "svg"
        | "tif" | "tiff" | "webp" => "image",
        "avi" | "flv" | "m2ts" | "m4v" | "mkv" | "mov" | "mp4" | "mpeg" | "mpg" | "webm"
        | "wmv" => "video",
        "aac" | "aiff" | "alac" | "ape" | "flac" | "m4a" | "mp3" | "ogg" | "opus" | "wav"
        | "wma" => "audio",
        "7z" | "bz2" | "cab" | "gz" | "iso" | "rar" | "tar" | "tgz" | "xz" | "zip" | "zst" => {
            "archive"
        }
        "appx" | "bat" | "cmd" | "com" | "dll" | "exe" | "msi" | "msix" | "ps1" | "scr" => {
            "executable"
        }
        "c" | "cc" | "cpp" | "cs" | "css" | "go" | "h" | "hpp" | "html" | "java" | "js" | "jsx"
        | "json" | "kt" | "kts" | "lua" | "md" | "php" | "pl" | "py" | "rb" | "rs" | "scss"
        | "sh" | "sql" | "swift" | "toml" | "ts" | "tsx" | "vue" | "xml" | "yaml" | "yml" => "code",
        _ => "other",
    }
}

fn is_word_character(value: char) -> bool {
    value.is_alphanumeric() || value == '_'
}

fn contains_whole_word(target: &str, needle: &str) -> bool {
    target.match_indices(needle).any(|(start, _)| {
        let before = target[..start].chars().next_back();
        let end = start + needle.len();
        let after = target[end..].chars().next();
        before
            .map(|value| !is_word_character(value))
            .unwrap_or(true)
            && after.map(|value| !is_word_character(value)).unwrap_or(true)
    })
}

fn trigram_hash(chars: &[char]) -> u32 {
    let mut hash = 2_166_136_261u32;
    for character in chars {
        hash ^= *character as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

fn name_signature(value: &str) -> u64 {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < 3 {
        return 0;
    }
    let mut signature = 0u64;
    for window in chars.windows(3) {
        let hash = trigram_hash(window);
        signature |= 1u64 << (hash & 63);
        signature |= 1u64 << ((hash >> 6) & 63);
    }
    signature
}

impl SearchIndex {
    fn path(&self, index: usize) -> Option<&str> {
        let entry = *self.entries.get(index)?;
        let start = usize::try_from(entry.offset).ok()?;
        let end = start.checked_add(entry.length())?;
        let bytes = if entry.is_delta() {
            self.delta_paths.get(start..end)?
        } else {
            match &self.storage {
                PathStorage::Empty => return None,
                PathStorage::Owned(bytes) => bytes.get(start..end)?,
                PathStorage::Mapped(mapping) => mapping.get(start..end)?,
            }
        };
        std::str::from_utf8(bytes).ok()
    }

    fn from_parts_controlled(
        storage: PathStorage,
        entries: Vec<IndexedEntry>,
        backgrounded: &AtomicBool,
        stopping: &AtomicBool,
    ) -> Option<Self> {
        let mut index = Self {
            storage,
            delta_paths: Vec::new(),
            name_signatures: Vec::with_capacity(entries.len()),
            live: vec![true; entries.len()],
            path_positions: Vec::with_capacity(entries.len()),
            delta_positions: HashMap::new(),
            live_count: entries.len(),
            entries,
        };
        for entry_index in 0..index.entries.len() {
            if entry_index % 4_096 == 0 && wait_while_backgrounded(backgrounded, stopping) {
                return None;
            }
            let (signature, path_hash) = {
                let path_value = index.path(entry_index)?;
                (
                    name_signature(&file_name(path_value).to_lowercase()),
                    normalized_path_hash(path_value),
                )
            };
            index.name_signatures.push(signature);
            index.path_positions.push((path_hash, entry_index as u32));
        }
        index
            .path_positions
            .sort_unstable_by_key(|(path_hash, _)| *path_hash);
        index.path_positions.shrink_to_fit();
        index.name_signatures.shrink_to_fit();
        index.entries.shrink_to_fit();
        Some(index)
    }

    fn from_entries_controlled(
        entries: Vec<Entry>,
        backgrounded: &AtomicBool,
        stopping: &AtomicBool,
    ) -> Option<Self> {
        let capacity = entries.iter().map(|entry| entry.path.len()).sum();
        let mut paths = Vec::with_capacity(capacity);
        let mut indexed_entries = Vec::with_capacity(entries.len());
        for (entry_index, entry) in entries.into_iter().enumerate() {
            if entry_index % 4_096 == 0 && wait_while_backgrounded(backgrounded, stopping) {
                return None;
            }
            let offset = paths.len() as u64;
            paths.extend_from_slice(entry.path.as_bytes());
            indexed_entries.push(IndexedEntry::new(
                offset,
                entry.path.len(),
                entry.is_directory,
                false,
                entry.size,
            ));
        }
        paths.shrink_to_fit();
        Self::from_parts_controlled(
            PathStorage::Owned(paths),
            indexed_entries,
            backgrounded,
            stopping,
        )
    }

    fn find_path(&self, path_value: &str) -> Option<usize> {
        let hash = normalized_path_hash(path_value);
        let normalized_path = normalized(path_value);
        if let Some(index) = self.delta_positions.get(&hash).copied() {
            if self
                .path(index as usize)
                .is_some_and(|candidate| normalized(candidate) == normalized_path)
            {
                return Some(index as usize);
            }
        }
        let start = self
            .path_positions
            .partition_point(|(candidate, _)| *candidate < hash);
        for (_, index) in self.path_positions[start..]
            .iter()
            .take_while(|(candidate, _)| *candidate == hash)
        {
            if self.live.get(*index as usize).copied().unwrap_or(false)
                && self
                    .path(*index as usize)
                    .is_some_and(|candidate| normalized(candidate) == normalized_path)
            {
                return Some(*index as usize);
            }
        }
        None
    }

    fn remove_path(&mut self, path_value: &str) {
        let hash = normalized_path_hash(path_value);
        if let Some(index) = self.find_path(path_value) {
            if self.live.get(index).copied().unwrap_or(false) {
                if let Some(live) = self.live.get_mut(index) {
                    *live = false;
                }
                self.live_count = self.live_count.saturating_sub(1);
                if self
                    .entries
                    .get(index)
                    .is_some_and(|entry| entry.is_delta())
                {
                    self.delta_positions.remove(&hash);
                }
            }
        }
    }

    fn remove_tree(&mut self, path_value: &str) {
        let key = normalized(path_value);
        let prefix = format!("{}\\", key);
        let removed: Vec<usize> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(index, _entry)| {
                self.live.get(*index).copied().unwrap_or(false) && {
                    let candidate = normalized(self.path(*index).unwrap_or_default());
                    candidate == key || candidate.starts_with(&prefix)
                }
            })
            .map(|(index, _)| index)
            .collect();
        for index in removed {
            if self
                .entries
                .get(index)
                .is_some_and(|entry| entry.is_delta())
            {
                if let Some(path_value) = self.path(index) {
                    let hash = normalized_path_hash(path_value);
                    self.delta_positions.remove(&hash);
                }
            }
            if let Some(live) = self.live.get_mut(index) {
                *live = false;
            }
            self.live_count = self.live_count.saturating_sub(1);
        }
    }

    fn len(&self) -> usize {
        self.live_count
    }

    fn upsert(&mut self, entry: Entry) {
        self.remove_path(&entry.path);
        let index = self.entries.len() as u32;
        let offset = self.delta_paths.len() as u64;
        self.delta_paths.extend_from_slice(entry.path.as_bytes());
        self.entries.push(IndexedEntry::new(
            offset,
            entry.path.len(),
            entry.is_directory,
            true,
            entry.size,
        ));
        self.name_signatures
            .push(name_signature(&file_name(&entry.path).to_lowercase()));
        self.live.push(true);
        self.delta_positions
            .insert(normalized_path_hash(&entry.path), index);
        self.live_count += 1;
    }

    #[allow(clippy::too_many_arguments)]
    fn query(
        &self,
        text: &str,
        kind: &str,
        scopes: &[String],
        categories: &[String],
        extensions: &[String],
        case_sensitive: bool,
        whole_word: bool,
        match_path: bool,
        regex_mode: bool,
        limit: usize,
    ) -> Result<Vec<SearchResult>, String> {
        let needle = if case_sensitive {
            text.to_string()
        } else {
            text.to_lowercase()
        };
        let tokens: Vec<&str> = needle
            .split_whitespace()
            .filter(|part| !part.is_empty())
            .collect();
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        let scope_values: Vec<String> = scopes
            .iter()
            .filter(|scope| {
                !scope.is_empty() && scope.as_str() != "*" && !scope.eq_ignore_ascii_case("all")
            })
            .map(|scope| normalized(scope))
            .collect();
        let category_values: HashSet<&str> = categories.iter().map(String::as_str).collect();
        let extension_values: HashSet<String> = extensions
            .iter()
            .map(|extension| extension.trim().trim_start_matches('.').to_lowercase())
            .filter(|extension| !extension.is_empty())
            .collect();
        let expression = if regex_mode {
            Some(
                RegexBuilder::new(text)
                    .case_insensitive(!case_sensitive)
                    .build()
                    .map_err(|error| format!("正则表达式无效：{}", error))?,
            )
        } else {
            None
        };

        let first_token_lower = tokens[0].to_lowercase();
        let query_signature =
            if !regex_mode && !match_path && first_token_lower.chars().count() >= 3 {
                name_signature(&first_token_lower)
            } else {
                0
            };

        let mut matches = Vec::with_capacity(limit.saturating_mul(2));
        for index in 0..self.entries.len() {
            if !self.live.get(index).copied().unwrap_or(false) {
                continue;
            }
            if query_signature != 0
                && self.name_signatures.get(index).map_or(true, |candidate| {
                    candidate & query_signature != query_signature
                })
            {
                continue;
            }
            let entry = match self.entries.get(index).copied() {
                Some(value) => value,
                None => continue,
            };
            let path_value = match self.path(index) {
                Some(value) => value,
                None => continue,
            };
            let is_directory = entry.is_directory();
            if kind == "folder" && !is_directory {
                continue;
            }
            if kind == "file" && is_directory {
                continue;
            }
            let entry_path_lower = if !scope_values.is_empty() || match_path {
                Some(normalized(path_value))
            } else {
                None
            };
            if !scope_values.is_empty()
                && !scope_values.iter().any(|scope| {
                    entry_path_lower.as_deref() == Some(scope.as_str())
                        || entry_path_lower
                            .as_deref()
                            .unwrap_or_default()
                            .strip_prefix(scope)
                            .is_some_and(|suffix| suffix.starts_with(['\\', '/']))
                })
            {
                continue;
            }
            if !category_values.is_empty()
                && !category_values.contains(file_category(is_directory, path_value))
            {
                continue;
            }
            if !extension_values.is_empty()
                && (is_directory || !extension_values.contains(&extension_name(path_value)))
            {
                continue;
            }
            let original_target = if match_path {
                path_value
            } else {
                file_name(path_value)
            };
            let folded_target;
            let target = if case_sensitive {
                original_target
            } else {
                folded_target = original_target.to_lowercase();
                &folded_target
            };
            let matches_query = if let Some(regex) = &expression {
                regex.is_match(original_target)
            } else if whole_word {
                tokens
                    .iter()
                    .all(|token| contains_whole_word(target, token))
            } else {
                tokens.iter().all(|token| target.contains(token))
            };
            if !matches_query {
                continue;
            }

            let mut score = 60.0;
            let scoring_needle = text.to_lowercase();
            let entry_name_lower = file_name(path_value).to_lowercase();
            if entry_name_lower == scoring_needle {
                score = 100.0;
            } else if entry_name_lower.starts_with(&scoring_needle) {
                score = 92.0;
            } else if entry_name_lower.contains(&scoring_needle) {
                score = 82.0;
            } else if entry_path_lower
                .as_deref()
                .is_some_and(|path_value| path_value.ends_with(&scoring_needle))
                || (!match_path && normalized(path_value).ends_with(&scoring_needle))
            {
                score = 76.0;
            }
            score -= (path_value.len().min(400) as f64) * 0.01;
            matches.push(SearchResult {
                path: path_value.to_string(),
                name: file_name(path_value).to_string(),
                is_directory,
                size: entry.size,
                score,
                source: "native-index",
            });
            if matches.len() >= limit.saturating_mul(40).clamp(2_000, 50_000) {
                break;
            }
        }
        matches.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.path.len().cmp(&b.path.len()))
        });
        matches.truncate(limit);
        Ok(matches)
    }

    fn executable_catalog(&self, limit: usize) -> Vec<SearchResult> {
        let mut results = Vec::with_capacity(limit.min(8_192));
        for (index, entry) in self.entries.iter().copied().enumerate() {
            let path_value = self.path(index).unwrap_or_default();
            if !self.live.get(index).copied().unwrap_or(false)
                || entry.is_directory()
                || extension_name(path_value) != "exe"
            {
                continue;
            }
            results.push(SearchResult {
                path: path_value.to_string(),
                name: file_name(path_value).to_string(),
                is_directory: false,
                size: entry.size,
                score: 100.0,
                source: "native-index",
            });
            if results.len() >= limit {
                break;
            }
        }
        results
    }
}

fn update_status(state: &SharedState, output: &Output, patch: Status) {
    {
        let mut status = state
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *status = patch.clone();
    }
    output.status(&patch);
}

fn save_cache(
    cache_path: &Path,
    root: &str,
    entries: &[Entry],
    backgrounded: &AtomicBool,
    stopping: &AtomicBool,
) -> io::Result<()> {
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = cache_path.with_extension("tmp");
    let mut writer = BufWriter::new(File::create(&temporary)?);
    writer.write_all(CACHE_MAGIC)?;
    let root_bytes = root.as_bytes();
    writer.write_all(&(root_bytes.len() as u16).to_le_bytes())?;
    writer.write_all(root_bytes)?;
    writer.write_all(&(entries.len() as u64).to_le_bytes())?;
    for (index, entry) in entries.iter().enumerate() {
        if index % 4_096 == 0 && wait_while_backgrounded(backgrounded, stopping) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "indexer is stopping",
            ));
        }
        let flags = if entry.is_directory { 1u8 } else { 0u8 };
        let path_bytes = entry.path.as_bytes();
        writer.write_all(&[flags])?;
        writer.write_all(&entry.size.to_le_bytes())?;
        writer.write_all(&(path_bytes.len() as u32).to_le_bytes())?;
        writer.write_all(path_bytes)?;
    }
    writer.flush()?;
    drop(writer);
    fs::rename(temporary, cache_path)?;
    Ok(())
}

fn load_cache_index(
    cache_path: &Path,
    backgrounded: &AtomicBool,
    stopping: &AtomicBool,
) -> io::Result<(String, SearchIndex)> {
    let file = File::open(cache_path)?;
    let mapping = unsafe { MmapOptions::new().map(&file)? };
    if mapping.get(0..8) != Some(CACHE_MAGIC.as_slice()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad index magic",
        ));
    }
    let mut cursor = 8usize;
    let root_length = u16::from_le_bytes(
        mapping
            .get(cursor..cursor + 2)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "bad root length"))?
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad root length"))?,
    ) as usize;
    cursor += 2;
    let root = std::str::from_utf8(
        mapping
            .get(cursor..cursor + root_length)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "bad root"))?,
    )
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad root encoding"))?
    .to_string();
    cursor += root_length;
    let count = u64::from_le_bytes(
        mapping
            .get(cursor..cursor + 8)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "bad entry count"))?
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad entry count"))?,
    ) as usize;
    cursor += 8;
    if count > 20_000_000 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "index is too large",
        ));
    }
    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        if index % 4_096 == 0 && wait_while_backgrounded(backgrounded, stopping) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "indexer is stopping",
            ));
        }
        let flags = *mapping
            .get(cursor)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "bad entry flags"))?;
        cursor += 1;
        let size = u64::from_le_bytes(
            mapping
                .get(cursor..cursor + 8)
                .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "bad entry size"))?
                .try_into()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad entry size"))?,
        );
        cursor += 8;
        let length = u32::from_le_bytes(
            mapping
                .get(cursor..cursor + 4)
                .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "bad path length"))?
                .try_into()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad path length"))?,
        ) as usize;
        cursor += 4;
        if length > 128 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "path is too large",
            ));
        }
        let path_end = cursor
            .checked_add(length)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad path range"))?;
        let path_bytes = mapping
            .get(cursor..path_end)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "bad path bytes"))?;
        std::str::from_utf8(path_bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad path encoding"))?;
        entries.push(IndexedEntry::new(
            cursor as u64,
            length,
            flags & 1 == 1,
            false,
            size,
        ));
        cursor = path_end;
    }
    let index = SearchIndex::from_parts_controlled(
        PathStorage::Mapped(mapping),
        entries,
        backgrounded,
        stopping,
    )
    .ok_or_else(|| io::Error::new(io::ErrorKind::Interrupted, "indexer is stopping"))?;
    Ok((root, index))
}

fn delta_path(cache_path: &Path) -> PathBuf {
    cache_path.with_extension("delta")
}

fn append_deltas(cache_path: &Path, deltas: &[IndexDelta]) -> io::Result<()> {
    if deltas.is_empty() {
        return Ok(());
    }
    let path = delta_path(cache_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let mut writer = BufWriter::new(file);
    for delta in deltas {
        serde_json::to_writer(&mut writer, delta)?;
        writer.write_all(b"\n")?;
    }
    writer.flush()
}

fn load_deltas(cache_path: &Path) -> io::Result<Vec<IndexDelta>> {
    let path = delta_path(cache_path);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let reader = BufReader::new(File::open(path)?);
    let mut deltas = Vec::new();
    for line in reader.lines().take(5_000_000) {
        let value = line?;
        if value.trim().is_empty() {
            continue;
        }
        let delta = serde_json::from_str::<IndexDelta>(&value).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("bad index delta: {}", error),
            )
        })?;
        deltas.push(delta);
    }
    Ok(deltas)
}

fn reset_deltas(cache_path: &Path) -> io::Result<()> {
    let path = delta_path(cache_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    File::create(path).map(|_| ())
}

fn apply_deltas(index: &mut SearchIndex, deltas: &[IndexDelta]) {
    for delta in deltas {
        match delta {
            IndexDelta::Upsert {
                path,
                is_directory,
                size,
            } => index.upsert(Entry {
                path: path.clone(),
                is_directory: *is_directory,
                size: *size,
            }),
            IndexDelta::Remove { path, tree } => {
                if *tree {
                    index.remove_tree(path);
                } else {
                    index.remove_path(path);
                }
            }
        }
    }
}

fn stable_hash(value: &str) -> u64 {
    let mut hash = 14_695_981_039_346_656_037u64;
    for byte in normalized(value).as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    hash
}

fn content_database_path(cache_dir: &Path, root: &str) -> PathBuf {
    cache_dir.join(format!(
        "{:016x}-v{}.sqlite",
        stable_hash(root),
        CONTENT_INDEX_VERSION
    ))
}

fn content_index_status(
    state: &SharedState,
    root_input: &str,
) -> Result<ContentIndexStatus, String> {
    let root = fs::canonicalize(root_input).map_err(|error| error.to_string())?;
    let root_text = root.to_string_lossy().to_string();
    let database_path = content_database_path(&state.content_cache_dir, &root_text);
    if !database_path.exists() {
        return Ok(ContentIndexStatus {
            state: "idle",
            root: root_text,
            files_visited: 0,
            files_indexed: 0,
            message: "该目录尚未建立内容索引".to_string(),
        });
    }

    let connection =
        Connection::open_with_flags(database_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| error.to_string())?;
    let stored_root: String = connection
        .query_row("SELECT value FROM meta WHERE key = 'root'", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("无法读取内容索引范围：{}", error))?;
    if normalized(&stored_root) != normalized(&root_text) {
        return Err("内容索引范围校验失败，请重新建立索引".to_string());
    }
    let documents = connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'documents'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);

    Ok(ContentIndexStatus {
        state: "ready",
        root: stored_root,
        files_visited: documents,
        files_indexed: documents,
        message: "已载入该目录的本地内容索引".to_string(),
    })
}

fn is_content_candidate(path: &Path) -> bool {
    const EXTENSIONS: &[&str] = &[
        "txt",
        "md",
        "markdown",
        "log",
        "csv",
        "tsv",
        "json",
        "jsonl",
        "xml",
        "yaml",
        "yml",
        "toml",
        "ini",
        "cfg",
        "conf",
        "properties",
        "env",
        "sql",
        "html",
        "htm",
        "css",
        "scss",
        "less",
        "js",
        "jsx",
        "mjs",
        "cjs",
        "ts",
        "tsx",
        "vue",
        "svelte",
        "py",
        "pyi",
        "rs",
        "go",
        "java",
        "kt",
        "kts",
        "c",
        "h",
        "cc",
        "cpp",
        "hpp",
        "cs",
        "fs",
        "fsx",
        "vb",
        "php",
        "rb",
        "swift",
        "sh",
        "bash",
        "zsh",
        "ps1",
        "bat",
        "cmd",
        "gradle",
        "cmake",
        "dockerfile",
        "gitignore",
        "gitattributes",
        "editorconfig",
        "rtf",
    ];
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if matches!(
        name.as_str(),
        "dockerfile" | "makefile" | "readme" | "license" | "changelog"
    ) {
        return true;
    }
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| EXTENSIONS.contains(&extension.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_excluded_content_directory(path: &Path) -> bool {
    const EXCLUDED_NAMES: &[&str] = &[
        ".git",
        ".hg",
        ".svn",
        ".cache",
        ".next",
        ".nuxt",
        ".parcel-cache",
        ".turbo",
        ".venv",
        "__pycache__",
        "bower_components",
        "build",
        "coverage",
        "dist",
        "node_modules",
        "out",
        "target",
        "temp",
        "tmp",
        "venv",
    ];
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|name| EXCLUDED_NAMES.contains(&name.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn read_text_document(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let probe_length = bytes.len().min(8192);
    if bytes[..probe_length].contains(&0) {
        // Handle common UTF-16 BOMs without treating every binary with NUL bytes as text.
        if bytes.starts_with(&[0xff, 0xfe]) {
            let words: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            return Some(String::from_utf16_lossy(&words));
        }
        if bytes.starts_with(&[0xfe, 0xff]) {
            let words: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect();
            return Some(String::from_utf16_lossy(&words));
        }
        return None;
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let replacements = text
        .chars()
        .filter(|character| *character == '\u{fffd}')
        .count();
    if replacements > (text.chars().count() / 20).max(8) {
        None
    } else {
        Some(text)
    }
}

fn emit_content_status(
    output: &Output,
    state: &str,
    root: &str,
    files_visited: usize,
    files_indexed: usize,
    message: &str,
) {
    output.send(&json!({
        "event": "contentStatus",
        "status": {
            "state": state,
            "root": root,
            "filesVisited": files_visited,
            "filesIndexed": files_indexed,
            "message": message
        }
    }));
}

fn start_content_index(
    state: Arc<SharedState>,
    output: Output,
    root_input: String,
) -> Result<(), String> {
    if state.content_scanning.swap(true, Ordering::SeqCst) {
        return Err("已有一个内容索引任务正在运行".to_string());
    }
    let root = fs::canonicalize(&root_input).map_err(|error| {
        state.content_scanning.store(false, Ordering::SeqCst);
        format!("无法访问内容索引目录：{}", error)
    })?;
    if !root.is_dir() {
        state.content_scanning.store(false, Ordering::SeqCst);
        return Err("内容索引范围必须是目录".to_string());
    }

    thread::spawn(move || {
        let root_text = root.to_string_lossy().to_string();
        emit_content_status(
            &output,
            "indexing",
            &root_text,
            0,
            0,
            "正在发现文本文件，自动跳过依赖与生成目录",
        );
        let result = (|| -> Result<usize, String> {
            fs::create_dir_all(&state.content_cache_dir).map_err(|error| error.to_string())?;
            let database_path = content_database_path(&state.content_cache_dir, &root_text);
            let temporary_path = database_path.with_extension("building");
            let backup_path = database_path.with_extension("previous");
            if temporary_path.exists() {
                fs::remove_file(&temporary_path).map_err(|error| error.to_string())?;
            }
            let mut connection =
                Connection::open(&temporary_path).map_err(|error| error.to_string())?;
            connection
                .execute_batch(
                    "PRAGMA journal_mode=OFF;
                     PRAGMA synchronous=OFF;
                     PRAGMA temp_store=MEMORY;
                     CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                     CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, content, tokenize='trigram');",
                )
                .map_err(|error| format!("无法创建全文索引：{}", error))?;

            let queue = Arc::new(Mutex::new(VecDeque::from([root.clone()])));
            let active = Arc::new(AtomicUsize::new(0));
            let visited = Arc::new(AtomicUsize::new(0));
            let (sender, receiver) = mpsc::sync_channel::<(String, String)>(12);
            let workers = thread::available_parallelism()
                .map(|count| count.get().clamp(2, 8))
                .unwrap_or(4);
            let mut handles = Vec::with_capacity(workers);
            for _ in 0..workers {
                let queue = Arc::clone(&queue);
                let active = Arc::clone(&active);
                let visited = Arc::clone(&visited);
                let sender = sender.clone();
                let stopping = Arc::clone(&state.stopping);
                let backgrounded = Arc::clone(&state.backgrounded);
                handles.push(thread::spawn(move || loop {
                    if wait_while_backgrounded(&backgrounded, &stopping) {
                        break;
                    }
                    let next = queue
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .pop_front();
                    let directory = match next {
                        Some(value) => {
                            active.fetch_add(1, Ordering::Relaxed);
                            value
                        }
                        None => {
                            if active.load(Ordering::Relaxed) == 0 {
                                break;
                            }
                            thread::sleep(Duration::from_millis(2));
                            continue;
                        }
                    };
                    if let Ok(items) = fs::read_dir(&directory) {
                        for item in items.flatten() {
                            if wait_while_backgrounded(&backgrounded, &stopping) {
                                break;
                            }
                            let file_type = match item.file_type() {
                                Ok(value) => value,
                                Err(_) => continue,
                            };
                            if file_type.is_symlink() {
                                continue;
                            }
                            let item_path = item.path();
                            if file_type.is_dir() {
                                if is_excluded_content_directory(&item_path) {
                                    continue;
                                }
                                queue
                                    .lock()
                                    .unwrap_or_else(|error| error.into_inner())
                                    .push_back(item_path);
                            } else if file_type.is_file() {
                                visited.fetch_add(1, Ordering::Relaxed);
                                if is_content_candidate(&item_path) {
                                    if let Some(content) = read_text_document(&item_path) {
                                        if sender
                                            .send((
                                                item_path.to_string_lossy().to_string(),
                                                content,
                                            ))
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    active.fetch_sub(1, Ordering::Relaxed);
                }));
            }
            drop(sender);

            let transaction = connection
                .transaction()
                .map_err(|error| error.to_string())?;
            let mut indexed = 0usize;
            {
                let mut statement = transaction
                    .prepare("INSERT INTO docs(path, content) VALUES (?1, ?2)")
                    .map_err(|error| error.to_string())?;
                for (document_path, content) in receiver {
                    if wait_while_backgrounded(&state.backgrounded, &state.stopping) {
                        return Err("indexer is stopping".to_string());
                    }
                    statement
                        .execute(params![document_path, content])
                        .map_err(|error| error.to_string())?;
                    indexed += 1;
                    if indexed % 250 == 0 {
                        emit_content_status(
                            &output,
                            "indexing",
                            &root_text,
                            visited.load(Ordering::Relaxed),
                            indexed,
                            "正在写入本地全文索引",
                        );
                    }
                }
            }
            for handle in handles {
                let _ = handle.join();
            }
            transaction
                .execute(
                    "INSERT INTO meta(key, value) VALUES ('root', ?1), ('updatedAt', ?2), ('documents', ?3)",
                    params![root_text, now_iso_like(), indexed.to_string()],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
            if wait_while_backgrounded(&state.backgrounded, &state.stopping) {
                return Err("indexer is stopping".to_string());
            }
            connection
                .execute("INSERT INTO docs(docs) VALUES ('optimize')", [])
                .map_err(|error| format!("无法优化全文索引：{}", error))?;
            drop(connection);

            if database_path.exists() {
                if backup_path.exists() {
                    fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
                }
                fs::rename(&database_path, &backup_path).map_err(|error| error.to_string())?;
            }
            if let Err(error) = fs::rename(&temporary_path, &database_path) {
                if backup_path.exists() {
                    let _ = fs::rename(&backup_path, &database_path);
                }
                return Err(error.to_string());
            }
            if backup_path.exists() {
                let _ = fs::remove_file(backup_path);
            }
            Ok(indexed)
        })();

        match result {
            Ok(indexed) => emit_content_status(
                &output,
                "ready",
                &root_text,
                indexed,
                indexed,
                "指定目录内容索引已就绪",
            ),
            Err(error) => emit_content_status(&output, "error", &root_text, 0, 0, &error),
        }
        state.content_scanning.store(false, Ordering::SeqCst);
    });
    Ok(())
}

fn query_content(
    state: &SharedState,
    root_input: &str,
    query: &str,
    regex_mode: bool,
    case_sensitive: bool,
    limit: usize,
) -> Result<Vec<ContentSearchResult>, String> {
    let root = fs::canonicalize(root_input).map_err(|error| error.to_string())?;
    let root_text = root.to_string_lossy().to_string();
    let database_path = content_database_path(&state.content_cache_dir, &root_text);
    if !database_path.exists() {
        return Err("该目录尚未建立内容索引，请先点击“建立内容索引”".to_string());
    }
    let connection =
        Connection::open_with_flags(database_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| error.to_string())?;

    if regex_mode {
        let pattern = query.trim();
        if pattern.is_empty() {
            return Err("正则表达式不能为空".to_string());
        }
        if pattern.chars().count() > 1024 {
            return Err("正则表达式过长，请控制在 1024 个字符以内".to_string());
        }
        let expression = RegexBuilder::new(pattern)
            .case_insensitive(!case_sensitive)
            .unicode(true)
            .size_limit(8 * 1024 * 1024)
            .dfa_size_limit(16 * 1024 * 1024)
            .build()
            .map_err(|error| format!("正则表达式无效：{}", error))?;
        if expression.is_match("") {
            return Err("该正则可以匹配空内容，会产生过多结果；请增加至少一个明确条件".to_string());
        }

        let mut statement = connection
            .prepare("SELECT path, content FROM docs")
            .map_err(|error| error.to_string())?;
        let mut rows = statement.query([]).map_err(|error| error.to_string())?;
        let mut results = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let path_value: String = row.get(0).map_err(|error| error.to_string())?;
            let content: String = row.get(1).map_err(|error| error.to_string())?;
            let Some(found) = expression.find(&content) else {
                continue;
            };
            results.push(ContentSearchResult {
                name: file_name(&path_value).to_string(),
                path: path_value,
                preview: regex_content_preview(&content, found),
                score: 1.0 / (1.0 + found.start() as f64),
            });
            if results.len() >= limit {
                break;
            }
        }
        return Ok(results);
    }

    let expression = format!("\"{}\"", query.trim().replace('"', "\"\""));
    let mut statement = connection
        .prepare(
            "SELECT path, snippet(docs, 1, '〔', '〕', ' … ', 22), bm25(docs)
             FROM docs WHERE docs MATCH ?1 ORDER BY bm25(docs) LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![expression, limit as i64], |row| {
            let path_value: String = row.get(0)?;
            let rank: f64 = row.get(2)?;
            Ok(ContentSearchResult {
                name: file_name(&path_value).to_string(),
                path: path_value,
                preview: row.get(1)?,
                score: -rank,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|error| error.to_string())?);
    }
    Ok(results)
}

fn regex_content_preview(content: &str, found: regex::Match<'_>) -> String {
    const CONTEXT_CHARS: usize = 72;
    let before = &content[..found.start()];
    let after = &content[found.end()..];
    let start = before
        .char_indices()
        .rev()
        .nth(CONTEXT_CHARS)
        .map(|(index, _)| index)
        .unwrap_or(0);
    let end = after
        .char_indices()
        .nth(CONTEXT_CHARS)
        .map(|(index, _)| found.end() + index)
        .unwrap_or(content.len());
    let normalize = |value: &str| value.replace("\r\n", " ").replace(['\r', '\n', '\t'], " ");
    format!(
        "{}{}〔{}〕{}{}",
        if start > 0 { "… " } else { "" },
        normalize(&content[start..found.start()]),
        normalize(found.as_str()),
        normalize(&content[found.end()..end]),
        if end < content.len() { " …" } else { "" }
    )
}

#[cfg(windows)]
mod ntfs {
    use super::Entry;
    use std::collections::{HashMap, HashSet};
    use std::io;
    use std::mem::size_of;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_HANDLE_EOF, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, GetDriveTypeW, GetLogicalDrives};
    use windows_sys::Win32::System::IO::DeviceIoControl;

    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
    const FSCTL_ENUM_USN_DATA: u32 = 0x0009_00b3;
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;

    #[repr(C)]
    struct MftEnumDataV0 {
        start_file_reference_number: u64,
        low_usn: i64,
        high_usn: i64,
    }

    #[derive(Clone)]
    struct RawNode {
        parent: u64,
        name: String,
        is_directory: bool,
    }

    struct OwnedHandle(isize);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn local_roots() -> Vec<String> {
        let mask = unsafe { GetLogicalDrives() };
        let mut roots = Vec::new();
        for index in 0..26u32 {
            if mask & (1 << index) == 0 {
                continue;
            }
            let letter = (b'A' + index as u8) as char;
            let root = format!("{}:\\", letter);
            let mut wide: Vec<u16> = root.encode_utf16().collect();
            wide.push(0);
            let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
            if drive_type == DRIVE_FIXED || drive_type == DRIVE_REMOVABLE {
                roots.push(root);
            }
        }
        roots
    }

    fn read_u16(buffer: &[u8], offset: usize) -> Option<u16> {
        Some(u16::from_le_bytes(
            buffer.get(offset..offset + 2)?.try_into().ok()?,
        ))
    }

    fn read_u32(buffer: &[u8], offset: usize) -> Option<u32> {
        Some(u32::from_le_bytes(
            buffer.get(offset..offset + 4)?.try_into().ok()?,
        ))
    }

    fn read_u64(buffer: &[u8], offset: usize) -> Option<u64> {
        Some(u64::from_le_bytes(
            buffer.get(offset..offset + 8)?.try_into().ok()?,
        ))
    }

    fn resolve_path(
        id: u64,
        root: &str,
        nodes: &HashMap<u64, RawNode>,
        cache: &mut HashMap<u64, String>,
        visiting: &mut HashSet<u64>,
    ) -> Option<String> {
        if let Some(value) = cache.get(&id) {
            return Some(value.clone());
        }
        if !visiting.insert(id) {
            return None;
        }
        let node = nodes.get(&id)?;
        let result = if node.parent == id || node.name.is_empty() || node.name == "." {
            root.to_string()
        } else {
            let parent = resolve_path(node.parent, root, nodes, cache, visiting)?;
            if parent.ends_with('\\') {
                format!("{}{}", parent, node.name)
            } else {
                format!("{}\\{}", parent, node.name)
            }
        };
        visiting.remove(&id);
        cache.insert(id, result.clone());
        Some(result)
    }

    pub fn enumerate(
        root: &str,
        backgrounded: &std::sync::atomic::AtomicBool,
        stopping: &std::sync::atomic::AtomicBool,
    ) -> io::Result<Vec<Entry>> {
        if root.len() != 3 || !root.ends_with(":\\") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "MFT enumeration requires a drive root",
            ));
        }
        let drive = root
            .chars()
            .next()
            .filter(|character| character.is_ascii_alphabetic())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid drive root"))?;
        let volume = format!(r"\\.\{}:", drive.to_ascii_uppercase());
        let mut wide: Vec<u16> = volume.encode_utf16().collect();
        wide.push(0);
        let raw_handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                0,
            )
        };
        if raw_handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let _handle = OwnedHandle(raw_handle);
        let mut data = MftEnumDataV0 {
            start_file_reference_number: 0,
            low_usn: 0,
            high_usn: i64::MAX,
        };
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut nodes: HashMap<u64, RawNode> = HashMap::new();

        loop {
            if super::wait_while_backgrounded(backgrounded, stopping) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "indexer is stopping",
                ));
            }
            let mut returned = 0u32;
            let success = unsafe {
                DeviceIoControl(
                    raw_handle,
                    FSCTL_ENUM_USN_DATA,
                    &mut data as *mut _ as *mut _,
                    size_of::<MftEnumDataV0>() as u32,
                    buffer.as_mut_ptr() as *mut _,
                    buffer.len() as u32,
                    &mut returned,
                    null_mut(),
                )
            };
            if success == 0 {
                let code = unsafe { GetLastError() };
                if code == ERROR_HANDLE_EOF {
                    break;
                }
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            if returned < 8 {
                break;
            }
            data.start_file_reference_number = read_u64(&buffer, 0).unwrap_or(0);
            let mut offset = 8usize;
            let returned = returned as usize;
            let mut records_in_chunk = 0usize;
            while offset + 60 <= returned {
                records_in_chunk += 1;
                if records_in_chunk % 8_192 == 0
                    && super::wait_while_backgrounded(backgrounded, stopping)
                {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "indexer is stopping",
                    ));
                }
                let record_length = match read_u32(&buffer, offset) {
                    Some(0) | None => break,
                    Some(value) => value as usize,
                };
                if offset + record_length > returned {
                    break;
                }
                let major_version = read_u16(&buffer, offset + 4).unwrap_or(0);
                if major_version == 2 {
                    let id = read_u64(&buffer, offset + 8).unwrap_or(0);
                    let parent = read_u64(&buffer, offset + 16).unwrap_or(0);
                    let attributes = read_u32(&buffer, offset + 52).unwrap_or(0);
                    let name_length = read_u16(&buffer, offset + 56).unwrap_or(0) as usize;
                    let name_offset = read_u16(&buffer, offset + 58).unwrap_or(0) as usize;
                    if name_offset + name_length <= record_length && name_length % 2 == 0 {
                        let bytes =
                            &buffer[offset + name_offset..offset + name_offset + name_length];
                        let utf16: Vec<u16> = bytes
                            .chunks_exact(2)
                            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                            .collect();
                        let name = String::from_utf16_lossy(&utf16);
                        nodes.insert(
                            id,
                            RawNode {
                                parent,
                                name,
                                is_directory: attributes & FILE_ATTRIBUTE_DIRECTORY != 0,
                            },
                        );
                    }
                }
                offset += record_length;
            }
            if data.start_file_reference_number == 0 {
                break;
            }
        }

        // NTFS root is normally file reference 5. Add it when the record stream omitted its name.
        nodes.entry(5).or_insert(RawNode {
            parent: 5,
            name: String::new(),
            is_directory: true,
        });
        let mut cache: HashMap<u64, String> = HashMap::with_capacity(nodes.len());
        cache.insert(5, root.to_string());
        // Resolve all parent chains first, then move the resolved strings into
        // Entry. Previously each full path remained in this cache and was also
        // cloned into Entry, nearly doubling the peak during a full MFT scan.
        for (index, id) in nodes.keys().enumerate() {
            if index % 2_048 == 0 && super::wait_while_backgrounded(backgrounded, stopping) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "indexer is stopping",
                ));
            }
            let mut visiting = HashSet::new();
            let _ = resolve_path(*id, root, &nodes, &mut cache, &mut visiting);
        }
        let mut entries = Vec::with_capacity(nodes.len());
        for (id, node) in &nodes {
            if let Some(path_value) = cache.remove(id) {
                if path_value == root {
                    continue;
                }
                entries.push(Entry {
                    path: path_value,
                    is_directory: node.is_directory,
                    size: 0,
                });
            }
        }
        Ok(entries)
    }
}

fn walk_filesystem(root: &str, output: &Output, state: &SharedState) -> Vec<Entry> {
    let queue = Arc::new(Mutex::new(VecDeque::from([PathBuf::from(root)])));
    let entries = Arc::new(Mutex::new(Vec::new()));
    let active = Arc::new(AtomicUsize::new(0));
    let discovered = Arc::new(AtomicUsize::new(0));
    let stopping = Arc::clone(&state.stopping);
    let backgrounded = Arc::clone(&state.backgrounded);
    let workers = thread::available_parallelism()
        .map(|count| count.get().clamp(2, 8))
        .unwrap_or(4);
    let mut handles = Vec::with_capacity(workers);

    for _ in 0..workers {
        let queue = Arc::clone(&queue);
        let entries = Arc::clone(&entries);
        let active = Arc::clone(&active);
        let discovered = Arc::clone(&discovered);
        let output = output.clone();
        let root = root.to_string();
        let stopping = Arc::clone(&stopping);
        let backgrounded = Arc::clone(&backgrounded);
        handles.push(thread::spawn(move || loop {
            if wait_while_backgrounded(&backgrounded, &stopping) {
                break;
            }
            let next = queue
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .pop_front();
            let directory = match next {
                Some(value) => {
                    active.fetch_add(1, Ordering::Relaxed);
                    value
                }
                None => {
                    if active.load(Ordering::Relaxed) == 0 {
                        break;
                    }
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
            };
            if let Ok(read_dir) = fs::read_dir(&directory) {
                for item in read_dir.flatten() {
                    if wait_while_backgrounded(&backgrounded, &stopping) {
                        break;
                    }
                    let file_type = match item.file_type() {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    if file_type.is_symlink() {
                        continue;
                    }
                    let path_buf = item.path();
                    let path_value = path_buf.to_string_lossy().to_string();
                    if file_type.is_dir() {
                        queue
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .push_back(path_buf);
                    }
                    entries
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .push(Entry {
                            path: path_value,
                            is_directory: file_type.is_dir(),
                            size: 0,
                        });
                    let count = discovered.fetch_add(1, Ordering::Relaxed) + 1;
                    if count % 100_000 == 0 {
                        output.status(&Status {
                            mode: "walker".to_string(),
                            state: "indexing".to_string(),
                            entries: count,
                            progress: 0.0,
                            root: root.clone(),
                            updated_at: None,
                            message: Some(format!("并行扫描已发现 {} 个条目", count)),
                        });
                    }
                }
            }
            active.fetch_sub(1, Ordering::Relaxed);
        }));
    }
    for handle in handles {
        let _ = handle.join();
    }
    Arc::try_unwrap(entries)
        .ok()
        .and_then(|mutex| mutex.into_inner().ok())
        .unwrap_or_default()
}

fn entry_from_path(path_value: &Path) -> Option<Entry> {
    let metadata = fs::symlink_metadata(path_value).ok()?;
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return None;
    }
    let path_text = path_value.to_string_lossy().to_string();
    Some(Entry {
        path: path_text,
        is_directory: metadata.is_dir(),
        size: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
    })
}

fn collect_subtree(root: &Path, maximum: usize, state: &SharedState) -> Vec<Entry> {
    let mut output = Vec::new();
    let mut queue = VecDeque::from([root.to_path_buf()]);
    while let Some(directory) = queue.pop_front() {
        if wait_while_backgrounded(&state.backgrounded, &state.stopping) {
            break;
        }
        if output.len() >= maximum {
            break;
        }
        let Ok(items) = fs::read_dir(directory) else {
            continue;
        };
        for item in items.flatten() {
            let path_value = item.path();
            if let Some(entry) = entry_from_path(&path_value) {
                if entry.is_directory {
                    queue.push_back(path_value);
                }
                output.push(entry);
                if output.len() >= maximum {
                    break;
                }
            }
        }
    }
    output
}

fn start_watchers(state: Arc<SharedState>, output: Output) {
    if state.watching.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let (sender, receiver) = mpsc::channel();
        let mut watchers = Vec::new();
        for root in &state.roots {
            let event_sender = sender.clone();
            let watcher = RecommendedWatcher::new(
                move |result| {
                    let _ = event_sender.send(result);
                },
                NotifyConfig::default(),
            );
            match watcher {
                Ok(mut value) => {
                    if value
                        .watch(Path::new(root), RecursiveMode::Recursive)
                        .is_ok()
                    {
                        watchers.push(value);
                    }
                }
                Err(_) => continue,
            }
        }
        drop(sender);
        if watchers.is_empty() {
            output.status(&Status {
                mode: state
                    .status
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .mode
                    .clone(),
                state: "ready".to_string(),
                entries: state
                    .index
                    .read()
                    .unwrap_or_else(|error| error.into_inner())
                    .entries
                    .len(),
                progress: 1.0,
                root: state.display_root.clone(),
                updated_at: Some(now_iso_like()),
                message: Some("实时变更监听不可用，可手动刷新索引".to_string()),
            });
            state.watching.store(false, Ordering::SeqCst);
            return;
        }

        while !state.stopping.load(Ordering::Relaxed) {
            if wait_while_backgrounded(&state.backgrounded, &state.stopping) {
                break;
            }
            let event = match receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(Ok(value)) => value,
                Ok(Err(error)) => {
                    output.status(&Status {
                        mode: "hybrid".to_string(),
                        state: "ready".to_string(),
                        entries: state
                            .index
                            .read()
                            .unwrap_or_else(|item| item.into_inner())
                            .entries
                            .len(),
                        progress: 1.0,
                        root: state.display_root.clone(),
                        updated_at: Some(now_iso_like()),
                        message: Some(format!("变更监听提示：{}", error)),
                    });
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let event_kind = event.kind;
            let is_new_tree = matches!(
                &event_kind,
                EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
            );
            let remove_kind = match &event_kind {
                EventKind::Remove(kind) => Some(kind.clone()),
                _ => None,
            };
            for changed_path in event.paths {
                let changed_key = normalized(&changed_path.to_string_lossy());
                let cache_key = normalized(&state.cache_path.to_string_lossy());
                let delta_key = normalized(&delta_path(&state.cache_path).to_string_lossy());
                let content_cache_key = normalized(&state.content_cache_dir.to_string_lossy());
                if changed_key == cache_key
                    || changed_key == delta_key
                    || changed_key == content_cache_key
                    || changed_key.starts_with(&format!("{}\\", content_cache_key))
                {
                    continue;
                }
                if remove_kind.is_some() || !changed_path.exists() {
                    let path_text = changed_path.to_string_lossy().to_string();
                    let remove_tree = !changed_path.exists()
                        && matches!(
                            remove_kind,
                            Some(RemoveKind::Folder | RemoveKind::Any | RemoveKind::Other) | None
                        );
                    let delta_guard = state
                        .delta_lock
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    let delta_error = append_deltas(
                        &state.cache_path,
                        &[IndexDelta::Remove {
                            path: path_text.clone(),
                            tree: remove_tree,
                        }],
                    )
                    .err();
                    if remove_tree {
                        state
                            .index
                            .write()
                            .unwrap_or_else(|error| error.into_inner())
                            .remove_tree(&path_text);
                    } else {
                        state
                            .index
                            .write()
                            .unwrap_or_else(|error| error.into_inner())
                            .remove_path(&path_text);
                    }
                    drop(delta_guard);
                    if let Some(error) = delta_error {
                        let mut status = state
                            .status
                            .lock()
                            .unwrap_or_else(|item| item.into_inner())
                            .clone();
                        status.message = Some(format!("索引增量日志写入失败：{}", error));
                        update_status(&state, &output, status);
                    }
                    continue;
                }
                if let Some(entry) = entry_from_path(&changed_path) {
                    let is_directory = entry.is_directory;
                    let mut additions = vec![entry];
                    if is_directory && is_new_tree {
                        // Walking a newly created tree performs filesystem I/O. Do it without
                        // holding the index writer lock, then merge in responsive chunks.
                        additions.extend(collect_subtree(&changed_path, 250_000, &state));
                    }
                    let deltas: Vec<IndexDelta> = additions
                        .iter()
                        .map(|item| IndexDelta::Upsert {
                            path: item.path.clone(),
                            is_directory: item.is_directory,
                            size: item.size,
                        })
                        .collect();
                    let delta_guard = state
                        .delta_lock
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    let delta_error = append_deltas(&state.cache_path, &deltas).err();
                    for entries in additions.chunks(2_048) {
                        let mut index = state
                            .index
                            .write()
                            .unwrap_or_else(|error| error.into_inner());
                        for entry in entries {
                            index.upsert(entry.clone());
                        }
                        drop(index);
                        thread::yield_now();
                    }
                    drop(delta_guard);
                    if let Some(error) = delta_error {
                        let mut status = state
                            .status
                            .lock()
                            .unwrap_or_else(|item| item.into_inner())
                            .clone();
                        status.message = Some(format!("索引增量日志写入失败：{}", error));
                        update_status(&state, &output, status);
                    }
                }
            }
        }
        drop(watchers);
        state.watching.store(false, Ordering::SeqCst);
    });
}

fn start_initial_cache_load(state: Arc<SharedState>, output: Output) {
    if state.loading.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let loaded = (|| -> io::Result<(SearchIndex, usize, String)> {
            let (cached_root, mut index) =
                load_cache_index(&state.cache_path, &state.backgrounded, &state.stopping)?;
            if normalized(&cached_root) != normalized(&state.roots.join("|")) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "cached drive set changed",
                ));
            }
            let (delta_count, message) = match load_deltas(&state.cache_path) {
                Ok(deltas) => {
                    let delta_count = deltas.len();
                    apply_deltas(&mut index, &deltas);
                    let message = if delta_count == 0 {
                        "已载入持久化索引，实时监听已接管".to_string()
                    } else {
                        format!(
                            "已载入持久化索引并重放 {} 条增量，实时监听已接管",
                            delta_count
                        )
                    };
                    (delta_count, message)
                }
                Err(error) => (
                    0,
                    format!(
                        "已载入持久化索引，但增量日志损坏（{}）；建议手动刷新",
                        error
                    ),
                ),
            };
            Ok((index, delta_count, message))
        })();

        state.loading.store(false, Ordering::SeqCst);
        match loaded {
            Ok((index, _delta_count, message)) => {
                let count = index.len();
                *state
                    .index
                    .write()
                    .unwrap_or_else(|error| error.into_inner()) = index;
                trim_process_working_set();
                update_status(
                    &state,
                    &output,
                    Status {
                        mode: "cached".to_string(),
                        state: "ready".to_string(),
                        entries: count,
                        progress: 1.0,
                        root: state.display_root.clone(),
                        updated_at: Some(now_iso_like()),
                        message: Some(message),
                    },
                );
                start_watchers(Arc::clone(&state), output.clone());
            }
            Err(error) if state.stopping.load(Ordering::Relaxed) => {
                let _ = error;
            }
            Err(_) => start_scan(Arc::clone(&state), output.clone()),
        }
    });
}

fn start_scan(state: Arc<SharedState>, output: Output) {
    if state.loading.load(Ordering::SeqCst) || state.scanning.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        if wait_while_backgrounded(&state.backgrounded, &state.stopping) {
            state.scanning.store(false, Ordering::SeqCst);
            return;
        }
        let reset_result = {
            let _delta_guard = state
                .delta_lock
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            reset_deltas(&state.cache_path)
        };
        if let Err(error) = reset_result {
            update_status(
                &state,
                &output,
                Status {
                    mode: "unavailable".to_string(),
                    state: "error".to_string(),
                    entries: state
                        .index
                        .read()
                        .unwrap_or_else(|item| item.into_inner())
                        .len(),
                    progress: 0.0,
                    root: state.display_root.clone(),
                    updated_at: None,
                    message: Some(format!("无法初始化索引增量日志：{}", error)),
                },
            );
            state.scanning.store(false, Ordering::SeqCst);
            return;
        }
        update_status(
            &state,
            &output,
            Status {
                mode: "mft".to_string(),
                state: "indexing".to_string(),
                entries: state
                    .index
                    .read()
                    .unwrap_or_else(|error| error.into_inner())
                    .entries
                    .len(),
                progress: 0.08,
                root: state.display_root.clone(),
                updated_at: None,
                message: Some("正在读取各磁盘 NTFS MFT 元数据".to_string()),
            },
        );

        #[cfg(windows)]
        let (mode, result) = {
            let mut combined = Vec::new();
            let mut used_walker = false;
            for (drive_index, root) in state.roots.iter().enumerate() {
                if state.stopping.load(Ordering::Relaxed) {
                    break;
                }
                let progress = 0.06 + 0.54 * drive_index as f64 / state.roots.len().max(1) as f64;
                update_status(
                    &state,
                    &output,
                    Status {
                        mode: if used_walker { "hybrid" } else { "mft" }.to_string(),
                        state: "indexing".to_string(),
                        entries: combined.len(),
                        progress,
                        root: state.display_root.clone(),
                        updated_at: None,
                        message: Some(format!("正在索引 {}", root)),
                    },
                );
                if wait_while_backgrounded(&state.backgrounded, &state.stopping) {
                    break;
                }
                match ntfs::enumerate(root, &state.backgrounded, &state.stopping) {
                    Ok(mut entries) => combined.append(&mut entries),
                    Err(mft_error) => {
                        used_walker = true;
                        output.status(&Status {
                            mode: "hybrid".to_string(),
                            state: "indexing".to_string(),
                            entries: combined.len(),
                            progress,
                            root: state.display_root.clone(),
                            updated_at: None,
                            message: Some(format!(
                                "{} 的 MFT 快速通道不可用（{}），切换并行扫描",
                                root, mft_error
                            )),
                        });
                        combined.extend(walk_filesystem(root, &output, &state));
                    }
                }
            }
            (
                if used_walker { "hybrid" } else { "mft" }.to_string(),
                Ok::<Vec<Entry>, io::Error>(combined),
            )
        };

        #[cfg(not(windows))]
        let (mode, result) = {
            let mut combined = Vec::new();
            for root in &state.roots {
                combined.extend(walk_filesystem(root, &output, &state));
            }
            ("walker".to_string(), Ok::<Vec<Entry>, io::Error>(combined))
        };

        match result {
            Ok(entries) => {
                if state.stopping.load(Ordering::Relaxed) {
                    state.scanning.store(false, Ordering::SeqCst);
                    return;
                }
                let scanned_count = entries.len();
                update_status(
                    &state,
                    &output,
                    Status {
                        mode: mode.clone(),
                        state: "indexing".to_string(),
                        entries: scanned_count,
                        progress: 0.82,
                        root: state.display_root.clone(),
                        updated_at: None,
                        message: Some("正在构建内存倒排索引".to_string()),
                    },
                );
                let cache_key = state.roots.join("|");
                let save_result = save_cache(
                    &state.cache_path,
                    &cache_key,
                    &entries,
                    &state.backgrounded,
                    &state.stopping,
                );
                let cache_error = save_result.err();
                let mut index = if cache_error.is_none() {
                    drop(entries);
                    match load_cache_index(&state.cache_path, &state.backgrounded, &state.stopping)
                    {
                        Ok((_cached_root, index)) => index,
                        Err(_) => {
                            state.scanning.store(false, Ordering::SeqCst);
                            return;
                        }
                    }
                } else {
                    let Some(index) = SearchIndex::from_entries_controlled(
                        entries,
                        &state.backgrounded,
                        &state.stopping,
                    ) else {
                        state.scanning.store(false, Ordering::SeqCst);
                        return;
                    };
                    index
                };
                let delta_guard = state
                    .delta_lock
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let delta_result = load_deltas(&state.cache_path);
                if let Ok(deltas) = &delta_result {
                    apply_deltas(&mut index, deltas);
                }
                let count = index.len();
                *state
                    .index
                    .write()
                    .unwrap_or_else(|error| error.into_inner()) = index;
                drop(delta_guard);
                trim_process_working_set();
                let cache_message = match (cache_error, delta_result.err()) {
                    (Some(cache_error), Some(delta_error)) => Some(format!(
                        "索引可用，但缓存和增量日志读取失败：{}；{}",
                        cache_error, delta_error
                    )),
                    (Some(error), None) => Some(format!("索引可用，但缓存写入失败：{}", error)),
                    (None, Some(error)) => Some(format!("索引可用，但增量日志读取失败：{}", error)),
                    (None, None) => None,
                };
                update_status(
                    &state,
                    &output,
                    Status {
                        mode,
                        state: "ready".to_string(),
                        entries: count,
                        progress: 1.0,
                        root: state.display_root.clone(),
                        updated_at: Some(now_iso_like()),
                        message: cache_message,
                    },
                );
                start_watchers(Arc::clone(&state), output.clone());
            }
            Err(error) => {
                update_status(
                    &state,
                    &output,
                    Status {
                        mode,
                        state: "error".to_string(),
                        entries: 0,
                        progress: 0.0,
                        root: state.display_root.clone(),
                        updated_at: None,
                        message: Some(error.to_string()),
                    },
                );
            }
        }
        state.scanning.store(false, Ordering::SeqCst);
    });
}

fn run_server() -> io::Result<()> {
    let output = Output {
        lock: Arc::new(Mutex::new(())),
    };
    start_mouse_shortcut_listener(output.clone());
    let stdin = io::stdin();
    let mut state: Option<Arc<SharedState>> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        let request: Request = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                output.send(&json!({ "ok": false, "error": error.to_string() }));
                continue;
            }
        };
        match request.op.as_str() {
            "init" => {
                configure_mouse_shortcut(
                    request.mouse_button.as_deref().unwrap_or("back"),
                    request.mouse_hold_ms.unwrap_or(3_000),
                );
                let requested_root = request.root.unwrap_or_else(|| "*".to_string());
                #[cfg(windows)]
                let roots = if requested_root == "*" {
                    ntfs::local_roots()
                } else {
                    vec![requested_root.clone()]
                };
                #[cfg(not(windows))]
                let roots = vec![requested_root.clone()];
                let roots = if roots.is_empty() {
                    vec!["C:\\".to_string()]
                } else {
                    roots
                };
                let display_root = if roots.len() > 1 {
                    "本机所有磁盘".to_string()
                } else {
                    roots[0].clone()
                };
                let cache_path = PathBuf::from(
                    request
                        .cache_path
                        .unwrap_or_else(|| "search-index-v1.bin".to_string()),
                );
                let content_cache_dir = PathBuf::from(
                    request
                        .content_cache_dir
                        .unwrap_or_else(|| "content-indexes".to_string()),
                );
                let initial_status = Status {
                    mode: "loading".to_string(),
                    state: "idle".to_string(),
                    entries: 0,
                    progress: 0.0,
                    root: display_root.clone(),
                    updated_at: None,
                    message: Some("正在载入本地索引".to_string()),
                };
                let shared = Arc::new(SharedState {
                    index: RwLock::new(SearchIndex::default()),
                    status: Mutex::new(initial_status.clone()),
                    roots: roots.clone(),
                    display_root: display_root.clone(),
                    cache_path: cache_path.clone(),
                    content_cache_dir,
                    scanning: AtomicBool::new(false),
                    content_scanning: AtomicBool::new(false),
                    watching: AtomicBool::new(false),
                    loading: AtomicBool::new(false),
                    backgrounded: Arc::new(AtomicBool::new(request.background.unwrap_or(false))),
                    stopping: Arc::new(AtomicBool::new(false)),
                    delta_lock: Mutex::new(()),
                });
                output.status(&initial_status);

                let force_rebuild = request.force_rebuild.unwrap_or(false);
                let _rebuild_reason = request.rebuild_reason;
                state = Some(Arc::clone(&shared));
                output.send(&json!({ "id": request.id, "ok": true }));
                // Cache parsing and in-memory index construction must not block
                // the command loop; otherwise a minimize/background request
                // cannot pause a large startup load until it has already ended.
                if force_rebuild {
                    start_scan(shared, output.clone());
                } else {
                    start_initial_cache_load(shared, output.clone());
                }
            }
            "setBackground" => {
                if let Some(shared) = &state {
                    let background = request.background.unwrap_or(false);
                    shared.backgrounded.store(background, Ordering::SeqCst);
                    if background {
                        trim_process_working_set();
                    }
                    output.send(&json!({
                        "id": request.id,
                        "ok": true,
                        "background": background
                    }));
                } else {
                    output.send(
                        &json!({ "id": request.id, "ok": false, "error": "not initialized" }),
                    );
                }
            }
            "setMouseShortcut" => {
                let button = request.mouse_button.as_deref().unwrap_or("disabled");
                let hold_ms = request.mouse_hold_ms.unwrap_or(3_000).clamp(500, 10_000);
                configure_mouse_shortcut(button, hold_ms);
                output.send(&json!({
                    "id": request.id,
                    "ok": true,
                    "available": cfg!(windows),
                    "button": button,
                    "holdMs": hold_ms
                }));
            }
            "query" => {
                let Some(shared) = &state else {
                    output.send(
                        &json!({ "id": request.id, "ok": false, "error": "not initialized" }),
                    );
                    continue;
                };
                let query = request.query.unwrap_or_default();
                let kind = request.kind.unwrap_or_else(|| "all".to_string());
                let scopes = request
                    .scopes
                    .unwrap_or_else(|| vec![request.scope.unwrap_or_else(|| "*".to_string())]);
                let categories = request.categories.unwrap_or_default();
                let extensions = request.extensions.unwrap_or_default();
                let limit = request.limit.unwrap_or(120).clamp(1, 2_000);
                let results = shared
                    .index
                    .read()
                    .unwrap_or_else(|error| error.into_inner())
                    .query(
                        &query,
                        &kind,
                        &scopes,
                        &categories,
                        &extensions,
                        request.case_sensitive.unwrap_or(false),
                        request.whole_word.unwrap_or(false),
                        request.match_path.unwrap_or(false),
                        request.regex.unwrap_or(false),
                        limit,
                    );
                match results {
                    Ok(results) => {
                        output.send(&json!({ "id": request.id, "ok": true, "results": results }))
                    }
                    Err(error) => {
                        output.send(&json!({ "id": request.id, "ok": false, "error": error }))
                    }
                }
            }
            "executableCatalog" => {
                let Some(shared) = &state else {
                    output.send(
                        &json!({ "id": request.id, "ok": false, "error": "not initialized" }),
                    );
                    continue;
                };
                let limit = request.limit.unwrap_or(20_000).clamp(1, 50_000);
                let results = shared
                    .index
                    .read()
                    .unwrap_or_else(|error| error.into_inner())
                    .executable_catalog(limit);
                output.send(&json!({ "id": request.id, "ok": true, "results": results }));
            }
            "contentIndex" => {
                let Some(shared) = &state else {
                    output.send(
                        &json!({ "id": request.id, "ok": false, "error": "not initialized" }),
                    );
                    continue;
                };
                let root = request.scope.unwrap_or_default();
                match start_content_index(Arc::clone(shared), output.clone(), root) {
                    Ok(()) => output.send(&json!({ "id": request.id, "ok": true })),
                    Err(error) => {
                        output.send(&json!({ "id": request.id, "ok": false, "error": error }))
                    }
                }
            }
            "contentStatus" => {
                let Some(shared) = &state else {
                    output.send(
                        &json!({ "id": request.id, "ok": false, "error": "not initialized" }),
                    );
                    continue;
                };
                let root = request.scope.unwrap_or_default();
                match content_index_status(shared, &root) {
                    Ok(status) => {
                        output.send(&json!({ "id": request.id, "ok": true, "status": status }))
                    }
                    Err(error) => {
                        output.send(&json!({ "id": request.id, "ok": false, "error": error }))
                    }
                }
            }
            "contentQuery" => {
                let Some(shared) = &state else {
                    output.send(
                        &json!({ "id": request.id, "ok": false, "error": "not initialized" }),
                    );
                    continue;
                };
                let query = request.query.unwrap_or_default();
                let root = request.scope.unwrap_or_default();
                let limit = request.limit.unwrap_or(120).clamp(1, 500);
                let regex_mode = request.regex.unwrap_or(false);
                let case_sensitive = request.case_sensitive.unwrap_or(false);
                let shared = Arc::clone(shared);
                let output = output.clone();
                let request_id = request.id;
                thread::spawn(move || {
                    match query_content(&shared, &root, &query, regex_mode, case_sensitive, limit) {
                        Ok(results) => output
                            .send(&json!({ "id": request_id, "ok": true, "results": results })),
                        Err(error) => {
                            output.send(&json!({ "id": request_id, "ok": false, "error": error }))
                        }
                    }
                });
            }
            "status" => {
                let status = state.as_ref().map(|shared| {
                    shared
                        .status
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .clone()
                });
                output.send(&json!({ "id": request.id, "ok": true, "status": status }));
            }
            "rebuild" => {
                if let Some(shared) = &state {
                    start_scan(Arc::clone(shared), output.clone());
                    output.send(&json!({ "id": request.id, "ok": true }));
                } else {
                    output.send(
                        &json!({ "id": request.id, "ok": false, "error": "not initialized" }),
                    );
                }
            }
            "quit" => {
                if let Some(shared) = &state {
                    shared.stopping.store(true, Ordering::SeqCst);
                }
                output.send(&json!({ "id": request.id, "ok": true }));
                break;
            }
            _ => {
                output.send(&json!({ "id": request.id, "ok": false, "error": "unknown operation" }))
            }
        }
    }
    Ok(())
}

fn main() {
    let serve = env::args().any(|argument| argument == "--serve");
    if !serve {
        eprintln!("Usage: cshift-indexer --serve");
        std::process::exit(2);
    }
    if let Err(error) = run_server() {
        eprintln!("{}", error);
        std::process::exit(1);
    }
}
