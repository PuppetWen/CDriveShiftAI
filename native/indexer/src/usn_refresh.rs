//! Reuse immutable baseline rows only when a volume's journal proves that
//! nothing changed. Changed volumes deliberately retain the full scan path.
use super::mapped_tables::source_stamp;
use super::usn_journal::snapshot::{self, CacheBinding, DirectoryRow, Transaction, VolumeSnapshot};
use super::usn_journal::{JournalCheckpoint, JournalWindow, UsnJournal};
use super::{is_drive_root, load_cache_index, normalized, wait_while_backgrounded, Entry};
use memmap2::MmapOptions;
use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::mem::{size_of, MaybeUninit};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::{
    GetTokenInformation, IsTokenRestricted, TokenStatistics, TOKEN_QUERY, TOKEN_STATISTICS,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub(super) struct Baseline {
    letter: u8,
    checkpoint: JournalCheckpoint,
    root_id: [DirectoryRow; 1],
}

pub(super) struct ReusableVolume {
    pub(super) baseline: Baseline,
    pub(super) entries: Vec<Entry>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

// Restrict reuse to the same logon and access token view. An elevated scan
// may see paths unavailable to a later standard-user process, and vice versa.
fn access_generation() -> io::Result<u64> {
    let mut token = 0;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token as _) };
    let handle = token.as_raw_handle() as HANDLE;
    if unsafe { IsTokenRestricted(handle) } != 0 {
        return Err(invalid("restricted access token"));
    }
    let mut stats = MaybeUninit::<TOKEN_STATISTICS>::uninit();
    let mut written = 0;
    if unsafe {
        GetTokenInformation(
            handle,
            TokenStatistics,
            stats.as_mut_ptr().cast(),
            size_of::<TOKEN_STATISTICS>() as u32,
            &mut written,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if written as usize != size_of::<TOKEN_STATISTICS>() {
        return Err(invalid("incomplete access token statistics"));
    }
    let stats = unsafe { stats.assume_init() };
    let mut hash = 0xcbf29ce484222325u64;
    for word in [
        stats.AuthenticationId.LowPart,
        stats.AuthenticationId.HighPart as u32,
        stats.ModifiedId.LowPart,
        stats.ModifiedId.HighPart as u32,
    ] {
        for byte in word.to_le_bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
        }
    }
    Ok(hash)
}

fn binding(cache: &Path, generation: u64) -> io::Result<CacheBinding> {
    let file = File::open(cache)?;
    let bytes = unsafe { MmapOptions::new().map(&file)? };
    Ok(CacheBinding {
        generation,
        source_stamp: source_stamp(&file, &bytes)?,
        // This tier reuses only immutable base rows from volumes with no
        // journal writes since before the baseline scan. It never reads
        // or claims to have applied the separate watcher replay log.
        delta_stamp: None,
    })
}

fn unchanged(window: &JournalWindow, checkpoint: &JournalCheckpoint) -> bool {
    window.validate_checkpoint(checkpoint).is_ok() && window.next_usn == checkpoint.next_usn
}

impl Baseline {
    pub(super) fn capture(root: &str) -> Option<Self> {
        Self::capture_window(root).map(|(baseline, _)| baseline)
    }

    fn capture_window(root: &str) -> Option<(Self, JournalWindow)> {
        if !is_drive_root(root) {
            return None;
        }
        let letter = root.as_bytes()[0].to_ascii_uppercase();
        let journal = UsnJournal::open(root).ok()?;
        let window = journal.window().ok()?;
        let root = format!("{}:\\", char::from(letter));
        let file_id = journal.root_file_id().ok().filter(|id| *id != 0)?;
        let baseline = Self {
            letter,
            checkpoint: window.checkpoint(),
            root_id: [DirectoryRow {
                file_id,
                path: root.encode_utf16().collect(),
            }],
        };
        Some((baseline, window))
    }

    pub(super) fn still_unchanged(&self, root: &str) -> bool {
        Self::capture(root).is_some_and(|current| {
            current.checkpoint == self.checkpoint
                && current.root_id[0].file_id == self.root_id[0].file_id
        })
    }
}

pub(super) fn reusable_volumes(
    roots: &[String],
    cache: &Path,
    backgrounded: &AtomicBool,
    stopping: &AtomicBool,
) -> io::Result<HashMap<u8, ReusableVolume>> {
    let mut volumes = HashMap::new();
    if !roots.iter().all(|root| is_drive_root(root)) {
        return Ok(volumes);
    }
    let expected = binding(cache, access_generation()?)?;
    let Ok(snapshot) = snapshot::load(cache, &expected) else {
        return Ok(volumes);
    };
    for root in roots {
        let Some((current, window)) = Baseline::capture_window(root) else {
            continue;
        };
        let Some(previous) = snapshot.volume(current.letter) else {
            continue;
        };
        if unchanged(&window, previous.checkpoint())
            && previous.contains_directory(current.root_id[0].file_id)
        {
            volumes.insert(
                current.letter,
                ReusableVolume {
                    baseline: current,
                    entries: Vec::new(),
                },
            );
        }
    }
    if volumes.is_empty() {
        return Ok(volumes);
    }
    let (cached_roots, index) = load_cache_index(cache, backgrounded, stopping)?;
    if normalized(&cached_roots) != normalized(&roots.join("|"))
        || binding(cache, expected.generation)? != expected
    {
        return Err(invalid("USN baseline changed while loading"));
    }
    let mut path = Vec::new();
    let pool = index.path_pool();
    for row in 0..index.entry_count() {
        if row % 4_096 == 0 && wait_while_backgrounded(backgrounded, stopping) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "indexer is stopping"));
        }
        let entry = index.entry_at(row).ok_or_else(|| invalid("invalid USN baseline entry"))?;
        let value = index
            .path_into(pool.as_ref(), row, entry, &mut path)
            .ok_or_else(|| invalid("invalid USN baseline path"))?;
        let [drive, b':', b'\\', ..] = value.as_bytes() else {
            return Err(invalid("USN baseline contains a non-volume path"));
        };
        if let Some(volume) = volumes.get_mut(&drive.to_ascii_uppercase()) {
            volume.entries.push(Entry {
                path: value.to_owned(),
                is_directory: entry.is_directory(),
                size: entry.size(),
            });
        }
    }
    Ok(volumes)
}

pub(super) struct BaselineCommit {
    transaction: Transaction,
    generation: u64,
}

impl BaselineCommit {
    pub(super) fn begin(cache: &Path) -> io::Result<Self> {
        let generation = access_generation()?;
        Ok(Self {
            transaction: Transaction::begin_full_rebuild(cache)?,
            generation,
        })
    }

    pub(super) fn finish(self, cache: &Path, baselines: &[Baseline]) -> io::Result<()> {
        let expected = binding(cache, self.generation)?;
        let volumes: Vec<_> = baselines
            .iter()
            .map(|baseline| VolumeSnapshot {
                drive_letter: baseline.letter,
                checkpoint: &baseline.checkpoint,
                directories: &baseline.root_id,
            })
            .collect();
        self.transaction.commit_after_index(&expected, &volumes, || {
            binding(cache, self.generation)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usn_journal::VolumeIdentity;

    #[test]
    fn only_reuses_an_unchanged_same_volume_and_journal() {
        let mut window = JournalWindow {
            volume: VolumeIdentity { guid_path: "volume E".to_string(), serial: 2 },
            journal_id: 7,
            first_usn: 1,
            lowest_valid_usn: 5,
            next_usn: 23,
        };
        let previous = window.checkpoint();
        assert!(unchanged(&window, &previous));
        window.next_usn += 1;
        assert!(!unchanged(&window, &previous));
        window.next_usn -= 1;
        window.first_usn = 24;
        assert!(!unchanged(&window, &previous));
        window.first_usn = 1;
        window.journal_id += 1;
        assert!(!unchanged(&window, &previous));
        window.journal_id -= 1;
        window.volume.serial += 1;
        assert!(!unchanged(&window, &previous));
    }

    #[test]
    #[ignore = "set CSHIFT_TEST_USN_REUSE_ROOT to a quiet NTFS volume other than the workspace volume"]
    fn reuses_bound_rows_and_falls_back_if_the_cache_changes() -> io::Result<()> {
        use std::fs;
        use std::path::PathBuf;
        use std::time::{SystemTime, UNIX_EPOCH};

        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Ok(entries) = fs::read_dir(&self.0) {
                    for entry in entries.flatten() {
                        let _ = fs::remove_file(entry.path());
                    }
                }
                let _ = fs::remove_dir(&self.0);
            }
        }

        let root = std::env::var("CSHIFT_TEST_USN_REUSE_ROOT")
            .expect("set CSHIFT_TEST_USN_REUSE_ROOT");
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize()?;
        let letter = root.as_bytes().first().expect("test NTFS drive root").to_ascii_uppercase();
        let workspace_text = workspace.to_string_lossy();
        let workspace_letter = workspace_text.strip_prefix(r"\\?\").unwrap_or(&workspace_text)
            .as_bytes()[0].to_ascii_uppercase();
        assert_ne!(letter, workspace_letter, "cache writes must be on another volume");
        let parent = workspace.join(".task-tmp");
        fs::create_dir_all(&parent)?;
        let time = SystemTime::now().duration_since(UNIX_EPOCH).expect("system clock");
        let directory = parent.join(format!("usn-reuse-{}-{}", std::process::id(), time.as_nanos()));
        fs::create_dir(&directory)?;
        let fixture = Fixture(directory);
        let cache = fixture.0.join("synthetic.bin");
        let backgrounded = AtomicBool::new(false);
        let stopping = AtomicBool::new(false);
        let roots = [root.clone()];
        let mut rows = [Entry {
            path: format!("{root}SyntheticTestFile.txt"),
            is_directory: false,
            size: 37,
        }];
        crate::save_cache(&cache, &root, &rows, &backgrounded, &stopping)?;
        assert!(reusable_volumes(&roots, &cache, &backgrounded, &stopping)?.is_empty());

        let baseline = Baseline::capture(&root).ok_or_else(|| invalid("test journal unavailable"))?;
        BaselineCommit::begin(&cache)?.finish(&cache, &[baseline])?;
        let mut reusable = reusable_volumes(&roots, &cache, &backgrounded, &stopping)?;
        let volume = reusable.remove(&letter).expect("test volume changed during the fixture");
        assert!(volume.baseline.still_unchanged(&root));
        assert_eq!(volume.entries.len(), 1);
        assert_eq!(volume.entries[0].path, rows[0].path);
        assert_eq!(volume.entries[0].size, rows[0].size);

        rows[0].size += 1;
        crate::save_cache(&cache, &root, &rows, &backgrounded, &stopping)?;
        assert!(reusable_volumes(&roots, &cache, &backgrounded, &stopping)?.is_empty());
        Ok(())
    }
}
