//! Own the exact process tree started for update verification. A suspended
//! process is assigned before its first instruction, so even short-lived
//! parents and detached descendants remain in this job. No PID/name matching
//! is used to decide which running applications to terminate.

use std::ffi::OsString;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    QueryInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};
use windows_sys::Win32::System::Threading::{
    GetProcessIdOfThread, OpenThread, QueryFullProcessImageNameW, ResumeThread,
    CREATE_SUSPENDED, PROCESS_NAME_WIN32, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0); }
    }
}

pub struct ApplicationProcess {
    pub(crate) child: Child,
    job: Handle,
}

impl ApplicationProcess {
    pub fn spawn(command: &mut Command, expected_executable: &Path) -> io::Result<Self> {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job == 0 { return Err(io::Error::last_os_error()); }
        // Deliberately no KILL_ON_JOB_CLOSE: verified applications continue
        // running normally after the updater exits and releases this handle.
        let job = Handle(job);
        let mut child = command.creation_flags(CREATE_SUSPENDED).spawn()?;
        let setup = (|| {
            let process = child.as_raw_handle() as HANDLE;
            verify_image(process, expected_executable)?;
            if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            resume_initial_thread(child.id())
        })();
        if let Err(error) = setup {
            // This is still our suspended process, identified by its retained
            // process handle; never fall back to terminating a process name.
            unsafe { TerminateJobObject(job.0, 1); }
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(Self { child, job })
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    #[cfg(test)]
    pub fn release(self) -> Child { self.child }

    pub fn active_processes(&self) -> io::Result<u32> {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.job.0,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut _,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 { return Err(io::Error::last_os_error()); }
        Ok(accounting.ActiveProcesses)
    }

    pub fn terminate_and_wait(&mut self, timeout: Duration) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.job.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let started = Instant::now();
        while self.active_processes()? != 0 {
            if started.elapsed() >= timeout {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "updated application process tree did not exit"));
            }
            thread::sleep(Duration::from_millis(50));
        }
        self.child.wait()?;
        Ok(())
    }
}

fn verify_image(process: HANDLE, expected: &Path) -> io::Result<()> {
    let mut name = vec![0u16; 32_768];
    let mut length = name.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, name.as_mut_ptr(), &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let actual = PathBuf::from(OsString::from_wide(&name[..length as usize])).canonicalize()?;
    let expected = expected.canonicalize()?;
    if !actual.as_os_str().to_string_lossy().eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy()) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "started executable does not match update target"));
    }
    Ok(())
}

fn resume_initial_thread(process_id: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    let snapshot = Handle(snapshot);
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut available = unsafe { Thread32First(snapshot.0, &mut entry) };
    while available != 0 {
        if entry.th32OwnerProcessID == process_id {
            let thread_handle = unsafe {
                OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION, 0, entry.th32ThreadID)
            };
            if thread_handle == 0 { return Err(io::Error::last_os_error()); }
            let thread_handle = Handle(thread_handle);
            // The owned Child retains the root process handle throughout this
            // check, preventing PID reuse while resolving its initial thread.
            if unsafe { GetProcessIdOfThread(thread_handle.0) } != process_id {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "initial thread no longer belongs to update target"));
            }
            let previous_suspend_count = unsafe { ResumeThread(thread_handle.0) };
            if previous_suspend_count == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            if previous_suspend_count > 0 {
                return Ok(());
            }
        }
        available = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "suspended update target has no initial thread"))
}
