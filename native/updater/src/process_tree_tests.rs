use super::*;
use std::os::windows::fs::OpenOptionsExt;
use std::process::Child;

const ROLE: &str = "CSHIFT_UPDATER_TEST_ROLE";
const ROOT: &str = "CSHIFT_UPDATER_TEST_ROOT";

struct TestApplication(ApplicationProcess);
impl Drop for TestApplication {
    fn drop(&mut self) { let _ = self.0.terminate_and_wait(Duration::from_secs(5)); }
}

struct TestChild(Child);
impl Drop for TestChild {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn fixture_command(executable: &Path, root: &Path, role: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("--exact").arg("process_tree_tests::tree_fixture_child").arg("--nocapture")
        .env(ROLE, role).env(ROOT, root).env("TEMP", root).env("TMP", root)
        .current_dir(root)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command
}

fn wait_until(mut predicate: impl FnMut() -> bool) {
    let started = Instant::now();
    while !predicate() {
        assert!(started.elapsed() < Duration::from_secs(10), "fixture did not become ready");
        thread::sleep(Duration::from_millis(25));
    }
}

// Child fixture invoked only by these tests. No real app or installer runs.
#[test]
fn tree_fixture_child() {
    let Ok(role) = env::var(ROLE) else { return; };
    let root = PathBuf::from(env::var_os(ROOT).unwrap());
    let executable = env::current_exe().unwrap();
    if role == "parent" || role == "worker" {
        let descendant = if role == "parent" { "worker" } else { "grandchild" };
        fixture_command(&executable, &root, descendant).spawn().unwrap();
    }
    let _locked = if role == "worker" || role == "grandchild" {
        Some(OpenOptions::new().read(true).write(true).share_mode(0)
            .open(root.join("CDriveShiftAI").join(format!("{role}.lock"))).unwrap())
    } else { None };
    fs::write(root.join(format!("{role}.ready")), std::process::id().to_string()).unwrap();
    thread::sleep(Duration::from_secs(45));
}

#[test]
fn rollback_stops_orphaned_descendants_releases_files_and_preserves_unrelated_process() {
    let root = tests::fixture("process-tree-rollback");
    let plan = tests::installed_plan(&root);
    let installed = plan.installed_dir.as_ref().unwrap();
    fs::create_dir_all(installed.join(DATA_DIRECTORY)).unwrap();
    fs::create_dir_all(&plan.backup_path).unwrap();
    fs::write(installed.join(DATA_DIRECTORY).join("settings.json"), b"keep-user-data").unwrap();
    fs::write(installed.join("worker.lock"), b"new-worker-file").unwrap();
    fs::write(installed.join("grandchild.lock"), b"new-grandchild-file").unwrap();
    fs::copy(env::current_exe().unwrap(), &plan.target_path).unwrap();
    fs::write(plan.backup_path.join("CDriveShiftAI.exe"), b"previous-version").unwrap();
    fs::write(plan.backup_path.join("previous-resource.txt"), b"previous-resource").unwrap();
    let logger = Logger { path: plan.log_path.clone() };

    // Same executable name, but a separately launched process outside this job.
    let mut unrelated = TestChild(fixture_command(&env::current_exe().unwrap(), &root, "unrelated").spawn().unwrap());
    let mut command = fixture_command(&plan.target_path, &root, "parent");
    let mut updated = TestApplication(ApplicationProcess::spawn(&mut command, &plan.target_path).unwrap());
    wait_until(|| root.join("worker.ready").exists() && root.join("grandchild.ready").exists() && root.join("unrelated.ready").exists());
    assert_eq!(updated.0.active_processes().unwrap(), 3);

    // Reproduce the old rollback: root-only termination leaves both descendants
    // alive and their real Windows file handles reject deletion.
    updated.0.child.kill().unwrap();
    updated.0.child.wait().unwrap();
    for name in ["worker", "grandchild"] {
        let error = fs::remove_file(installed.join(format!("{name}.lock"))).unwrap_err();
        assert!(matches!(error.raw_os_error(), Some(5 | 32 | 33)), "{error}");
    }
    assert_eq!(updated.0.active_processes().unwrap(), 2);

    stop_updated_application(&mut updated.0, &logger).unwrap();
    assert_eq!(updated.0.active_processes().unwrap(), 0);
    restore_installed(&plan, &logger).unwrap();
    assert_eq!(fs::read(&plan.target_path).unwrap(), b"previous-version");
    assert_eq!(fs::read(installed.join("previous-resource.txt")).unwrap(), b"previous-resource");
    assert_eq!(fs::read(installed.join(DATA_DIRECTORY).join("settings.json")).unwrap(), b"keep-user-data");
    assert!(!installed.join("worker.lock").exists());
    assert!(!installed.join("grandchild.lock").exists());
    assert!(unrelated.0.try_wait().unwrap().is_none(), "unrelated process was terminated");
    drop(updated);
    drop(unrelated);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn successful_application_survives_releasing_the_job_handle() {
    let root = tests::fixture("successful-job-release");
    fs::create_dir_all(&root).unwrap();
    let executable = env::current_exe().unwrap();
    let mut command = fixture_command(&executable, &root, "successful");
    let updated = ApplicationProcess::spawn(&mut command, &executable).unwrap();
    wait_until(|| root.join("successful.ready").exists());
    // Dropping the job owner must not kill a successfully verified application.
    let mut child = TestChild(updated.release());
    thread::sleep(Duration::from_millis(250));
    assert!(child.0.try_wait().unwrap().is_none());
    drop(child);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn mismatched_executable_is_rejected_before_running() {
    let root = tests::fixture("process-identity");
    fs::create_dir_all(&root).unwrap();
    let executable = env::current_exe().unwrap();
    let other = root.join("different.exe");
    fs::write(&other, b"different executable").unwrap();
    let mut command = fixture_command(&executable, &root, "must-not-run");
    let result = ApplicationProcess::spawn(&mut command, &other);
    assert!(result.is_err());
    assert!(!root.join("must-not-run.ready").exists());
    fs::remove_dir_all(root).unwrap();
}
