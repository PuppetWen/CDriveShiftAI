#![windows_subsystem = "windows"]

mod engine;
mod filters;
mod window;

use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc};
use std::{env, fs, io::{self, Write}};

use engine::{Config, Engine, SearchMode};
use serde_json::{json, Value};

fn run() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let mut indexer = None;
    let mut data = None;
    let mut root = None;
    let mut probe = None;
    let mut hosted = false;
    while let Some(flag) = args.next() {
        if flag == "--hosted" {
            hosted = true;
            continue;
        }
        let value = args.next().ok_or_else(|| format!("Missing value for {}", flag.to_string_lossy()))?;
        match flag.to_str() {
            Some("--indexer") => indexer = Some(PathBuf::from(value)),
            Some("--data") => data = Some(PathBuf::from(value)),
            Some("--root") => root = Some(value.into_string().map_err(|_| "Invalid root")?),
            Some("--probe") => probe = Some(PathBuf::from(value)),
            _ => return Err(format!("Unknown option: {}", flag.to_string_lossy())),
        }
    }
    let root = root.unwrap_or_else(|| "*".to_string());
    let config = if hosted {
        if indexer.is_some() || data.is_some() || probe.is_some() {
            return Err("--hosted only accepts a search root".to_string());
        }
        Config::hosted(root)?
    } else {
        Config::new(
            indexer.ok_or("Specify --indexer <cshift-indexer.exe>")?,
            data.ok_or("Specify --data <prototype-cache-directory>")?,
            root,
        )?
    };
    if let Some(probe) = probe {
        let queries: Vec<Value> =
            serde_json::from_slice(&fs::read(probe).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        let mut engine = Engine::start(&config, Arc::new(AtomicBool::new(false)), None, None)?;
        let mut pages = Vec::new();
        for query in queries {
            match query["op"].as_str() {
                Some("contentIndex") => {
                    engine.index_content(query["scope"].as_str().ok_or("Missing content index scope")?)?;
                    engine.await_content_index()?;
                }
                Some("contentQuery") => pages.push(engine.query(SearchMode::Content, query)?),
                Some("query") | None => pages.push(engine.query(SearchMode::Name, query)?),
                Some(op) => return Err(format!("Unsupported probe operation: {op}")),
            }
        }
        let mut output = io::stdout().lock();
        serde_json::to_writer(&mut output, &json!(pages)).map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())
    } else {
        window::show(config)
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        if !env::args_os().any(|arg| arg == "--probe" || arg == "--hosted") {
            window::show_error(&error);
        }
        std::process::exit(1);
    }
}
