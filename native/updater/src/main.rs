use serde::Deserialize;
use sha2::{Digest, Sha512};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const DATA_DIRECTORY: &str = ".cdriveshiftai-data";
const START_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePlan {
    schema_version: u32,
    mode: String,
    parent_pid: u32,
    package_path: PathBuf,
    target_path: PathBuf,
    installed_dir: Option<PathBuf>,
    staging_dir: PathBuf,
    backup_path: PathBuf,
    success_marker: PathBuf,
    expected_version: String,
    expected_sha512: String,
    log_path: PathBuf,
}

struct Logger {
    path: PathBuf,
}

impl Logger {
    fn line(&self, message: impl AsRef<str>) {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = writeln!(file, "{}", message.as_ref());
        }
    }
}

fn canonical_or_absolute(path: &Path) -> io::Result<PathBuf> {
    if path.exists() {
        path.canonicalize()
    } else if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
        if parent.exists() {
            parent
                .canonicalize()
                .map(|canonical_parent| canonical_parent.join(file_name))
        } else if path.is_absolute() {
            Ok(path.to_path_buf())
        } else {
            env::current_dir().map(|cwd| cwd.join(path))
        }
    } else if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        env::current_dir().map(|cwd| cwd.join(path))
    }
}

fn validate_plan(plan: &UpdatePlan) -> Result<(), String> {
    if plan.schema_version != 1 {
        return Err("unsupported update plan schema".to_string());
    }
    if plan.mode != "installed" && plan.mode != "portable" {
        return Err("unsupported update mode".to_string());
    }
    if plan.expected_version.trim().is_empty()
        || !plan
            .expected_sha512
            .chars()
            .all(|value| value.is_ascii_hexdigit())
        || plan.expected_sha512.len() != 128
    {
        return Err("invalid expected version or SHA-512".to_string());
    }
    let staging = canonical_or_absolute(&plan.staging_dir).map_err(|error| error.to_string())?;
    let staging_has_marker = staging.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".cdriveshiftai-update")
    });
    if !staging_has_marker {
        return Err("staging directory is outside the updater boundary".to_string());
    }
    for candidate in [
        &plan.package_path,
        &plan.backup_path,
        &plan.success_marker,
        &plan.log_path,
    ] {
        let absolute = canonical_or_absolute(candidate).map_err(|error| error.to_string())?;
        if !absolute.starts_with(&staging) {
            return Err(format!(
                "update plan path is outside staging: {}",
                candidate.display()
            ));
        }
    }
    if plan.target_path.starts_with(&staging) {
        return Err("update target must be outside staging".to_string());
    }
    let staging_base = staging
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "invalid staging directory structure".to_string())?;
    if plan.mode == "installed" {
        let installed = canonical_or_absolute(
            plan.installed_dir
                .as_ref()
                .ok_or_else(|| "installed update is missing installedDir".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        if installed.parent() != Some(staging_base)
            || canonical_or_absolute(&plan.target_path)
                .map_err(|error| error.to_string())?
                .parent()
                != Some(installed.as_path())
        {
            return Err("installed update target is outside its application directory".to_string());
        }
    } else {
        let target = canonical_or_absolute(&plan.target_path).map_err(|error| error.to_string())?;
        if target.parent() != Some(staging_base) {
            return Err("portable update target is outside its distribution directory".to_string());
        }
    }
    if plan.mode == "installed" && plan.installed_dir.is_none() {
        return Err("installed update is missing installedDir".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn wait_for_process(pid: u32, timeout: Duration) {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
    unsafe {
        let process = OpenProcess(SYNCHRONIZE_ACCESS, 0, pid);
        if process == 0 {
            return;
        }
        let result = WaitForSingleObject(process, timeout.as_millis().min(u32::MAX as u128) as u32);
        CloseHandle(process);
        if result != WAIT_OBJECT_0 {
            thread::sleep(Duration::from_secs(2));
        }
    }
}

#[cfg(not(windows))]
fn wait_for_process(_pid: u32, _timeout: Duration) {}

fn sha512(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha512::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn remove_entry(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn copy_tree(source: &Path, destination: &Path, skip_data: bool) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        if skip_data
            && item
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(DATA_DIRECTORY)
        {
            continue;
        }
        let source_path = item.path();
        let destination_path = destination.join(item.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            copy_tree(&source_path, &destination_path, false)?;
        } else {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn clear_application_directory(directory: &Path) -> io::Result<()> {
    if !directory.exists() {
        fs::create_dir_all(directory)?;
        return Ok(());
    }
    for item in fs::read_dir(directory)? {
        let item = item?;
        if item
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(DATA_DIRECTORY)
        {
            continue;
        }
        remove_entry(&item.path())?;
    }
    Ok(())
}

fn preserved_data_path(installed: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.cdriveshiftai-data-preserved",
        installed.display()
    ))
}

fn move_directory_with_retry(source: &Path, destination: &Path) -> Result<(), String> {
    let mut last_error = None;
    for _ in 0..80 {
        match fs::rename(source, destination) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                thread::sleep(Duration::from_millis(250));
            }
        }
    }
    Err(last_error
        .map(|error| error.to_string())
        .unwrap_or_else(|| "directory move failed".to_string()))
}

fn updater_preserved_data_path(plan: &UpdatePlan) -> PathBuf {
    plan.staging_dir.join("preserved-application-data")
}

fn preserve_application_data(plan: &UpdatePlan, installed: &Path) -> Result<(), String> {
    let data = installed.join(DATA_DIRECTORY);
    if !data.exists() {
        return Ok(());
    }
    let preserved = updater_preserved_data_path(plan);
    if preserved.exists() {
        return Err(format!(
            "updater data-preservation directory already exists: {}",
            preserved.display()
        ));
    }
    move_directory_with_retry(&data, &preserved)
}

fn ensure_preserved_data_restored(plan: &UpdatePlan, installed: &Path) -> Result<(), String> {
    let updater_preserved = updater_preserved_data_path(plan);
    let data = installed.join(DATA_DIRECTORY);
    if updater_preserved.exists() {
        if data.exists() {
            return Err(format!(
                "both active and updater-preserved application data exist: {}",
                updater_preserved.display()
            ));
        }
        fs::create_dir_all(installed).map_err(|error| error.to_string())?;
        move_directory_with_retry(&updater_preserved, &data)?;
    }

    let preserved = preserved_data_path(installed);
    if !preserved.exists() {
        return Ok(());
    }
    if data.exists() {
        return Err(format!(
            "both active and preserved application data exist: {}",
            preserved.display()
        ));
    }
    fs::create_dir_all(installed).map_err(|error| error.to_string())?;
    fs::rename(&preserved, &data).map_err(|error| error.to_string())
}

fn launch_updated(plan: &UpdatePlan) -> io::Result<Child> {
    Command::new(&plan.target_path)
        .arg("--updated")
        .arg("--update-staging")
        .arg(&plan.staging_dir)
        .arg("--update-version")
        .arg(&plan.expected_version)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn wait_for_success(child: &mut Child, marker: &Path) -> bool {
    let started = Instant::now();
    while started.elapsed() < START_TIMEOUT {
        if marker.exists() {
            return true;
        }
        match child.try_wait() {
            Ok(Some(_)) => return marker.exists(),
            Ok(None) => {}
            Err(_) => return false,
        }
        thread::sleep(Duration::from_millis(300));
    }
    false
}

fn launch_restored(plan: &UpdatePlan, reason: &str) {
    let _ = Command::new(&plan.target_path)
        .arg("--update-failed")
        .arg(reason)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn restore_installed(plan: &UpdatePlan, logger: &Logger) -> Result<(), String> {
    let installed = plan
        .installed_dir
        .as_ref()
        .ok_or_else(|| "missing installed directory".to_string())?;
    logger.line("restoring installed application backup");
    clear_application_directory(installed).map_err(|error| error.to_string())?;
    ensure_preserved_data_restored(plan, installed)?;
    copy_tree(&plan.backup_path, installed, false).map_err(|error| error.to_string())
}

fn update_installed(plan: &UpdatePlan, logger: &Logger) -> Result<(), String> {
    let installed = plan
        .installed_dir
        .as_ref()
        .ok_or_else(|| "missing installed directory".to_string())?;
    remove_entry(&plan.backup_path).map_err(|error| error.to_string())?;
    logger.line("creating application backup outside the install directory");
    copy_tree(installed, &plan.backup_path, true).map_err(|error| error.to_string())?;
    logger.line("moving application data outside the old install directory");
    preserve_application_data(plan, installed)?;

    logger.line("starting silent NSIS update");
    let status = match Command::new(&plan.package_path)
        .arg("/S")
        .arg("--updated")
        .arg(format!("/D={}", installed.display()))
        .status()
    {
        Ok(status) => status,
        Err(error) => {
            restore_installed(plan, logger)?;
            return Err(error.to_string());
        }
    };
    if !status.success() || !plan.target_path.exists() {
        restore_installed(plan, logger)?;
        return Err(format!("installer exited with {}", status));
    }
    ensure_preserved_data_restored(plan, installed)?;

    let mut child = launch_updated(plan).map_err(|error| error.to_string())?;
    if wait_for_success(&mut child, &plan.success_marker) {
        logger.line("new installed version reported a successful start");
        return Ok(());
    }
    logger.line("new installed version did not report success; rolling back");
    let _ = child.kill();
    let _ = child.wait();
    restore_installed(plan, logger)?;
    Err("new installed version failed its startup acknowledgement".to_string())
}

fn update_portable(plan: &UpdatePlan, logger: &Logger) -> Result<(), String> {
    remove_entry(&plan.backup_path).map_err(|error| error.to_string())?;
    logger.line("backing up portable executable");
    fs::rename(&plan.target_path, &plan.backup_path).map_err(|error| error.to_string())?;
    let replacement = plan.target_path.with_extension("update-new");
    let replace_result = (|| -> io::Result<()> {
        remove_entry(&replacement)?;
        fs::copy(&plan.package_path, &replacement)?;
        fs::rename(&replacement, &plan.target_path)?;
        Ok(())
    })();
    if let Err(error) = replace_result {
        let _ = remove_entry(&plan.target_path);
        let _ = fs::rename(&plan.backup_path, &plan.target_path);
        return Err(format!("portable replacement failed: {error}"));
    }

    let mut child = match launch_updated(plan) {
        Ok(child) => child,
        Err(error) => {
            let _ = remove_entry(&plan.target_path);
            let _ = fs::rename(&plan.backup_path, &plan.target_path);
            return Err(format!("new portable executable could not start: {error}"));
        }
    };
    if wait_for_success(&mut child, &plan.success_marker) {
        logger.line("new portable version reported a successful start");
        return Ok(());
    }
    logger.line("new portable version did not report success; rolling back");
    let _ = child.kill();
    let _ = child.wait();
    remove_entry(&plan.target_path).map_err(|error| error.to_string())?;
    fs::rename(&plan.backup_path, &plan.target_path).map_err(|error| error.to_string())?;
    Err("new portable version failed its startup acknowledgement".to_string())
}

fn run(plan_path: &Path) -> Result<(), String> {
    let plan_text = fs::read_to_string(plan_path).map_err(|error| error.to_string())?;
    let plan: UpdatePlan = serde_json::from_str(&plan_text).map_err(|error| error.to_string())?;
    validate_plan(&plan)?;
    let logger = Logger {
        path: plan.log_path.clone(),
    };
    logger.line(format!(
        "starting {} update to {}",
        plan.mode, plan.expected_version
    ));
    wait_for_process(plan.parent_pid, Duration::from_secs(120));
    let actual_sha512 = sha512(&plan.package_path).map_err(|error| error.to_string())?;
    if !actual_sha512.eq_ignore_ascii_case(&plan.expected_sha512) {
        return Err("helper SHA-512 verification rejected the package".to_string());
    }
    logger.line("helper SHA-512 verification passed");
    let result = if plan.mode == "installed" {
        update_installed(&plan, &logger)
    } else {
        update_portable(&plan, &logger)
    };
    match result {
        Ok(()) => {
            let _ = remove_entry(&plan.package_path);
            let _ = remove_entry(&plan.backup_path);
            let _ = remove_entry(plan_path);
            logger.line("update completed and package/backup were removed");
            Ok(())
        }
        Err(error) => {
            logger.line(format!("update failed: {error}"));
            launch_restored(&plan, &error);
            Err(error)
        }
    }
}

fn main() -> ExitCode {
    let arguments = env::args_os().collect::<Vec<_>>();
    let plan_path = arguments
        .windows(2)
        .find(|pair| pair[0] == "--plan")
        .map(|pair| PathBuf::from(&pair[1]));
    let Some(plan_path) = plan_path else {
        eprintln!("usage: cshift-updater.exe --plan <update-plan.json>");
        return ExitCode::from(2);
    };
    match run(&plan_path) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        env::temp_dir().join(format!(
            "cdriveshiftai-updater-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn sha512_matches_known_value() {
        let root = fixture("sha");
        fs::create_dir_all(&root).unwrap();
        let candidate = root.join("package.exe");
        fs::write(&candidate, b"abc").unwrap();
        assert_eq!(
            sha512(&candidate).unwrap(),
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a\
             2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
                .replace(' ', "")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn application_cleanup_preserves_data_directory() {
        let root = fixture("preserve");
        let data = root.join(DATA_DIRECTORY);
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("state.json"), b"important").unwrap();
        fs::write(root.join("old-app.exe"), b"old").unwrap();
        clear_application_directory(&root).unwrap();
        assert!(!root.join("old-app.exe").exists());
        assert_eq!(fs::read(data.join("state.json")).unwrap(), b"important");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installed_update_moves_and_restores_application_data_atomically() {
        let root = fixture("installed-data");
        let installed = root.join("CDriveShiftAI");
        let staging = root.join(".cdriveshiftai-update").join("0.0.2");
        let data = installed.join(DATA_DIRECTORY);
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(data.join("state.json"), b"migration journal").unwrap();
        let plan = UpdatePlan {
            schema_version: 1,
            mode: "installed".to_string(),
            parent_pid: 1,
            package_path: staging.join("installer.exe"),
            target_path: installed.join("CDriveShiftAI.exe"),
            installed_dir: Some(installed.clone()),
            staging_dir: staging.clone(),
            backup_path: staging.join("previous-version"),
            success_marker: staging.join("success.json"),
            expected_version: "0.0.2".to_string(),
            expected_sha512: "a".repeat(128),
            log_path: staging.join("update.log"),
        };
        preserve_application_data(&plan, &installed).unwrap();
        assert!(!data.exists());
        assert_eq!(
            fs::read(updater_preserved_data_path(&plan).join("state.json")).unwrap(),
            b"migration journal"
        );
        ensure_preserved_data_restored(&plan, &installed).unwrap();
        assert_eq!(
            fs::read(data.join("state.json")).unwrap(),
            b"migration journal"
        );
        assert!(!updater_preserved_data_path(&plan).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plan_rejects_files_outside_staging() {
        let root = fixture("boundary");
        let staging = root.join(".cdriveshiftai-update").join("0.0.2");
        fs::create_dir_all(&staging).unwrap();
        let plan = UpdatePlan {
            schema_version: 1,
            mode: "portable".to_string(),
            parent_pid: 1,
            package_path: root.join("outside.exe"),
            target_path: root.join("CDriveShiftAI.exe"),
            installed_dir: None,
            staging_dir: staging.clone(),
            backup_path: staging.join("backup.exe"),
            success_marker: staging.join("success.json"),
            expected_version: "0.0.2".to_string(),
            expected_sha512: "a".repeat(128),
            log_path: staging.join("update.log"),
        };
        assert!(validate_plan(&plan).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
