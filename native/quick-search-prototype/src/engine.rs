use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Name,
    Content,
}

pub struct Config {
    source: Source,
    pub root: String,
}

enum Source {
    Standalone { indexer: PathBuf, data: PathBuf },
    Hosted,
}

impl Config {
    pub fn new(indexer: PathBuf, data: PathBuf, root: String) -> Result<Self, String> {
        let indexer = fs::canonicalize(indexer).map_err(|error| format!("Cannot locate indexer: {error}"))?;
        if !indexer.is_file() {
            return Err("The indexer argument must point to its executable".into());
        }
        Self::validate_root(&root)?;
        // This name keeps an installed application's existing cache separate,
        // even if the operator supplies the application's data directory.
        let data = if data.is_absolute() {
            data
        } else {
            std::env::current_dir().map_err(|error| error.to_string())?.join(data)
        }.join("native-quick-search-prototype");
        fs::create_dir_all(&data).map_err(|error| format!("Cannot create prototype cache: {error}"))?;
        Ok(Self { source: Source::Standalone { indexer, data }, root })
    }

    pub fn hosted(root: String) -> Result<Self, String> {
        Self::validate_root(&root)?;
        Ok(Self { source: Source::Hosted, root })
    }

    fn validate_root(root: &str) -> Result<(), String> {
        if root == "*" || PathBuf::from(root).is_absolute() {
            Ok(())
        } else {
            Err("Search root must be an absolute directory or *".into())
        }
    }

    pub fn is_hosted(&self) -> bool {
        matches!(self.source, Source::Hosted)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_directory: Option<bool>,
    pub size: u64,
    score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at_ms: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub results: Vec<Hit>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub total_matches: Option<usize>,
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
    #[serde(default)]
    pub cursor_reset: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentStatus {
    pub root: String,
    pub state: String,
    pub message: String,
    pub files_indexed: usize,
}

pub enum HostMessage {
    Show,
    Hide,
    Shutdown,
    IndexStatus { state: String, message: String },
    IndexChanged,
}

enum Connection {
    Standalone { child: Child, input: ChildStdin },
    Hosted,
}

pub struct Engine {
    connection: Connection,
    replies: mpsc::Receiver<Value>,
    content_completion: mpsc::Receiver<ContentStatus>,
    stop: Arc<AtomicBool>,
    request_id: u64,
}

impl Engine {
    pub fn start(
        config: &Config,
        stop: Arc<AtomicBool>,
        on_content_status: Option<Box<dyn Fn(ContentStatus) + Send>>,
        on_host_message: Option<Box<dyn Fn(HostMessage) + Send>>,
    ) -> Result<Self, String> {
        let (connection, output): (Connection, Box<dyn BufRead + Send>) = match &config.source {
            Source::Standalone { indexer, data } => {
                let mut child = Command::new(indexer)
                    .arg("--serve")
                    .current_dir(data)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map_err(|error| format!("Cannot start the indexer: {error}"))?;
                let input = child.stdin.take().expect("piped input");
                let output = child.stdout.take().expect("piped output");
                (Connection::Standalone { child, input }, Box::new(BufReader::new(output)))
            }
            Source::Hosted => (Connection::Hosted, Box::new(BufReader::new(io::stdin()))),
        };
        let (writer, replies) = mpsc::channel();
        let (content_notify, content_completion) = mpsc::sync_channel(1);
        let loading = Arc::new(AtomicBool::new(!config.is_hosted()));
        let reader_loading = Arc::clone(&loading);
        thread::spawn(move || {
            for line in output.lines() {
                let Ok(line) = line else { break };
                let Ok(mut message) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(handler) = &on_host_message {
                    let command = match message["command"].as_str() {
                        Some("show") => Some(HostMessage::Show),
                        Some("hide") => Some(HostMessage::Hide),
                        Some("shutdown") => Some(HostMessage::Shutdown),
                        _ if message["event"] == "indexStatus" => message["status"]["state"].as_str()
                            .map(|state| HostMessage::IndexStatus {
                                state: state.to_owned(),
                                message: message["status"]["message"].as_str().unwrap_or_default().to_owned(),
                            }),
                        _ if message["event"] == "indexChanged" => Some(HostMessage::IndexChanged),
                        _ => None,
                    };
                    if let Some(command) = command {
                        let shutdown = matches!(command, HostMessage::Shutdown);
                        handler(command);
                        if shutdown {
                            // The window handles shutdown without involving shared backend lifetime.
                            return;
                        }
                        continue;
                    }
                }
                // Only one request can be in flight. Ignore spontaneous
                // index updates and progress so they cannot grow a UI queue.
                let state = message["status"]["state"].as_str();
                let completion = reader_loading.load(Ordering::Relaxed)
                    && message["event"] == "status"
                    && matches!(state, Some("ready" | "error"));
                if message["event"] == "contentStatus" && matches!(state, Some("ready" | "error")) {
                    if let Ok(status) = serde_json::from_value(message["status"].take()) {
                        if let Some(handler) = &on_content_status {
                            handler(status);
                        } else {
                            let _ = content_notify.try_send(status);
                        }
                    }
                    continue;
                }
                if (message["id"].is_number() || completion) && writer.send(message).is_err() {
                    return;
                }
            }
            if let Some(handler) = on_host_message {
                handler(HostMessage::Shutdown);
            }
        });
        let mut engine = Self { connection, replies, content_completion, stop, request_id: 0 };
        let Source::Standalone { data, .. } = &config.source else {
            return Ok(engine);
        };
        engine.request("init", json!({
            "root": config.root,
            "cachePath": data.join("search-index-v1.bin"),
            "contentCacheDir": data.join("content-indexes"),
            "mouseButton": "disabled",
            "magnifierEnabled": false
        }))?;
        let remaining = Instant::now() + RESPONSE_TIMEOUT;
        loop {
            // The daemon acknowledges init before starting its cache load.
            let status = engine.receive(remaining)?;
            if status["event"] == "status" {
                match status["status"]["state"].as_str() {
                    Some("ready") => break,
                    Some("error") => return Err(status["status"]["message"].as_str().unwrap_or("Index failed").to_string()),
                    _ => {}
                }
            }
        }
        loading.store(false, Ordering::Relaxed);
        Ok(engine)
    }

    pub fn query(&mut self, mode: SearchMode, mut filters: Value) -> Result<Page, String> {
        let fields = filters.as_object_mut().ok_or("Search filters must be an object")?;
        let (op, page_size) = match mode {
            SearchMode::Name => ("query", 120),
            SearchMode::Content => ("contentQuery", 80),
        };
        fields.entry("limit").or_insert(json!(page_size));
        serde_json::from_value(self.request(op, filters)?)
            .map_err(|error| format!("Invalid search page: {error}"))
    }

    pub fn index_content(&mut self, root: &str) -> Result<(), String> {
        self.request("contentIndex", json!({ "scope": root }))?;
        Ok(())
    }

    pub fn await_content_index(&self) -> Result<(), String> {
        let status = self.content_completion.recv_timeout(RESPONSE_TIMEOUT)
            .map_err(|error| format!("Content index did not complete: {error}"))?;
        if status.state == "ready" { Ok(()) } else { Err(status.message) }
    }

    pub fn hosted_action(&mut self, operation: &str, fields: Value) -> Result<Value, String> {
        if !matches!(self.connection, Connection::Hosted) {
            return Err("该功能只在 CDriveShiftAI 启动原生窗口时可用".into());
        }
        self.request(operation, fields)
    }

    fn request(&mut self, operation: &str, mut fields: Value) -> Result<Value, String> {
        self.request_id += 1;
        let id = self.request_id;
        fields["id"] = json!(id);
        fields["op"] = json!(operation);
        self.write(&fields)?;
        let until = Instant::now() + RESPONSE_TIMEOUT;
        loop {
            let reply = self.receive(until)?;
            if reply["id"] != id { continue; }
            if reply["ok"] == true { return Ok(reply); }
            return Err(reply["error"].as_str().unwrap_or("Indexer request failed").to_string());
        }
    }

    fn write(&mut self, value: &Value) -> Result<(), String> {
        match &mut self.connection {
            Connection::Standalone { input, .. } => write_frame(input, value),
            Connection::Hosted => send_host_event(value),
        }
    }

    fn receive(&self, until: Instant) -> Result<Value, String> {
        loop {
            if self.stop.load(Ordering::Relaxed) { return Err("Search closed".into()); }
            let now = Instant::now();
            if now >= until { return Err("Indexer timed out".into()); }
            match self.replies.recv_timeout((until - now).min(Duration::from_millis(100))) {
                Ok(message) => return Ok(message),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err("Indexer exited".into()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if matches!(self.connection, Connection::Hosted) {
            return;
        }
        let _ = self.write(&json!({ "id": self.request_id + 1, "op": "quit" }));
        let Connection::Standalone { child, .. } = &mut self.connection else { return };
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) { return; }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub fn send_host_event(value: &Value) -> Result<(), String> {
    // Hold one lock over the whole frame. The window reports visibility
    // while the worker sends requests, and their JSON cannot interleave.
    write_frame(&mut io::stdout().lock(), value)
}

fn write_frame(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value).map_err(|error| error.to_string())?;
    writer.write_all(b"\n").and_then(|_| writer.flush())
        .map_err(|error| format!("Indexer pipe failed: {error}"))
}
