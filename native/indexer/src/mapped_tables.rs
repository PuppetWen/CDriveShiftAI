use super::compact_path_pool::{encode_paths, CompactPathPool};
use super::{IndexedEntry, PathPosition};
use memmap2::{Mmap, MmapOptions};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::mem::{align_of, size_of};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAGIC: &[u8; 8] = b"CSTBL03\0";
const STAMP_SIZE: usize = 48;
// Signatures come first so their u64 alignment is independent of record count.
const HEADER_SIZE: usize = 64;

pub(super) struct MappedTables {
    data: Mmap,
    count: usize,
}

#[derive(Clone, Copy)]
#[repr(C, packed(4))]
struct MappedEntry {
    size: u64,
    flags: u32,
}

fn invalid_data(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub(super) fn source_stamp(file: &File, data: &[u8]) -> io::Result<[u8; STAMP_SIZE]> {
    let metadata = file.metadata()?;
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid_data("invalid source modification time"))?;
    let (volume, identity) = file_identity(file)?;
    let sample_size = data.len().min(4096);
    let mut sample_hash = 0xcbf29ce484222325u64;
    for byte in data[..sample_size].iter().chain(&data[data.len() - sample_size..]) {
        sample_hash = (sample_hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    let fields = [
        metadata.len(),
        modified.as_secs(),
        u64::from(modified.subsec_nanos()),
        volume,
        identity,
        sample_hash,
    ];
    let mut stamp = [0; STAMP_SIZE];
    for (slot, value) in stamp.chunks_exact_mut(8).zip(fields) {
        slot.copy_from_slice(&value.to_le_bytes());
    }
    Ok(stamp)
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as isize, info.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    let identity = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok((u64::from(info.dwVolumeSerialNumber), identity))
}

#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_file: &File) -> io::Result<(u64, u64)> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "no file identity"))
}

fn companion_path(cache: &Path) -> PathBuf {
    cache.with_extension("tables")
}

impl MappedTables {
    pub(super) fn open(cache: &Path, stamp: &[u8; STAMP_SIZE], count: usize) -> io::Result<Self> {
        let pool_start = pool_start(count);
        let file = File::open(companion_path(cache))?;
        if file.metadata()?.len() <= pool_start as u64 {
            return Err(invalid_data("wrong derived index size"));
        }
        // Our writer only publishes new files via rename. Never rewrite a
        // published image while a search holds a read-only mapping of it.
        let data = unsafe { MmapOptions::new().map(&file)? };
        if !cfg!(target_endian = "little")
            || data.get(..8) != Some(MAGIC)
            || data.get(8..56) != Some(stamp)
            || data.get(56..64) != Some(&((count as u64).to_le_bytes())[..])
            || data.len() <= pool_start
            || size_of::<MappedEntry>() != 12
            || size_of::<PathPosition>() != 12
        {
            return Err(invalid_data("derived index does not match the path cache"));
        }
        let tables = Self { data, count };
        if tables.path_pool()?.len() != count {
            return Err(invalid_data("wrong compact path count"));
        }
        Ok(tables)
    }

    pub(super) fn len(&self) -> usize {
        self.count
    }

    pub(super) fn signatures(&self) -> &[u64] {
        self.table(HEADER_SIZE, self.count)
    }

    pub(super) fn entry(&self, index: usize) -> Option<IndexedEntry> {
        let entries: &[MappedEntry] = self.table(HEADER_SIZE + self.count * 8, self.count);
        let entry = entries.get(index)?;
        Some(IndexedEntry::new(
            0,
            0,
            entry.flags & IndexedEntry::DIRECTORY_FLAG != 0,
            false,
            entry.size,
        ))
    }

    pub(super) fn positions(&self) -> &[PathPosition] {
        self.table(HEADER_SIZE + self.count * (8 + 12), self.count)
    }

    pub(super) fn path_pool(&self) -> io::Result<CompactPathPool<'_>> {
        CompactPathPool::open(&self.data[pool_start(self.count)..])
    }

    fn table<T>(&self, offset: usize, count: usize) -> &[T] {
        let bytes = &self.data[offset..offset + count * size_of::<T>()];
        debug_assert_eq!(bytes.as_ptr() as usize % align_of::<T>(), 0);
        // The three private callers use only integers or repr(C, packed(4))
        // structs of integers: all bit patterns are valid. open() checks the
        // complete, fixed-width image; the page-aligned offsets satisfy T.
        unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<T>(), count) }
    }
}

fn pool_start(count: usize) -> usize {
    HEADER_SIZE + count * (8 + 12 + 12)
}

pub(super) fn publish(
    cache: &Path,
    stamp: &[u8; STAMP_SIZE],
    entries: &[IndexedEntry],
    signatures: &[u64],
    positions: &[PathPosition],
    path_data: &[u8],
) -> io::Result<MappedTables> {
    let target = companion_path(cache);
    let temp = cache.with_extension(format!("tables.{}.tmp", std::process::id()));
    let file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
    let result = (|| {
        let mut writer = BufWriter::with_capacity(256 * 1024, file);
        writer.write_all(MAGIC)?;
        writer.write_all(stamp)?;
        writer.write_all(&(entries.len() as u64).to_le_bytes())?;
        for signature in signatures {
            writer.write_all(&signature.to_le_bytes())?;
        }
        for entry in entries {
            let mut row = [0; 12];
            row[..8].copy_from_slice(&entry.size().to_le_bytes());
            row[8..].copy_from_slice(&entry.length_and_flags.to_le_bytes());
            writer.write_all(&row)?;
        }
        for position in positions {
            let mut row = [0; 12];
            row[..8].copy_from_slice(&position.hash.to_le_bytes());
            row[8..].copy_from_slice(&position.index.to_le_bytes());
            writer.write_all(&row)?;
        }
        let paths = entries.iter().map(|entry| {
            let start = usize::try_from(entry.offset).map_err(|_| invalid_data("bad path offset"))?;
            let end = start.checked_add(entry.length()).ok_or_else(|| invalid_data("bad path range"))?;
            path_data.get(start..end).ok_or_else(|| invalid_data("bad path range"))
        });
        encode_paths(paths, &mut writer)?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        if target.exists() {
            // This image is derived. A failed replacement costs regeneration
            // only, and cannot damage the original path cache or journal.
            fs::remove_file(&target)?;
        }
        fs::rename(&temp, &target)?;
        MappedTables::open(cache, stamp, entries.len())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
