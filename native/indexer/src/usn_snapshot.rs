//! USN baseline metadata lives beside the cache, bound to the exact durable
//! index generation. An unfinished transaction always invalidates the hint.

use super::{JournalCheckpoint, VolumeIdentity};
use memmap2::{Mmap, MmapOptions};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAGIC: &[u8; 8] = b"CSUSN01\0";
const MARKER_MAGIC: &[u8; 8] = b"CSUSNP1\0";
const POINTER_MAGIC: &[u8; 8] = b"CSUSNI1\0";
const STAMP_LEN: usize = 48;
const ROW_LEN: usize = 16 + 8 + 2;
const HEADER_LEN: usize = 8 + 8 + STAMP_LEN + 1 + STAMP_LEN + 1;
const VOLUME_HEADER_LEN: usize = 1 + 49 + 4 + 8 + 8 + 4 + 8;
const MAX_ROWS: usize = 20_000_000;
const MAX_SNAPSHOT_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const HASH_OFFSET: u64 = 0xcbf29ce484222325;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CacheBinding {
    /// Persistent cache generation, not the process-local notification count.
    pub(crate) generation: u64,
    pub(crate) source_stamp: [u8; STAMP_LEN],
    /// The stamp of the exact persisted replay data, including ordinary
    /// watcher deltas. None means the source is the entire durable image.
    pub(crate) delta_stamp: Option<[u8; STAMP_LEN]>,
}

#[derive(Debug)]
pub(crate) enum NeedsScan {
    NoCheckpoint,
    PendingTransaction,
    CacheChanged,
    Unreadable(io::Error),
}

pub(crate) struct DirectoryRow {
    pub(crate) file_id: u128,
    /// Full DOS path, using the exact UTF-16 name spelling from NTFS.
    pub(crate) path: Vec<u16>,
}

pub(crate) struct VolumeSnapshot<'a> {
    pub(crate) drive_letter: u8,
    /// A cursor captured before the full scan or the end of a reconciled
    /// batch. It must never advance past what the durable index represents.
    pub(crate) checkpoint: &'a JournalCheckpoint,
    /// Sorted by unmodified file ID; an incomplete table forces scan for any
    /// change whose parent it doesn't cover.
    pub(crate) directories: &'a [DirectoryRow],
}

pub(crate) struct Snapshot {
    bytes: Mmap,
    volumes: Vec<VolumeTable>,
}

struct VolumeTable {
    drive_letter: u8,
    checkpoint: JournalCheckpoint,
    rows: Range<usize>,
    names: Range<usize>,
}

pub(crate) struct Volume<'a> {
    table: &'a VolumeTable,
    bytes: &'a [u8],
}

impl Snapshot {
    pub(crate) fn volume(&self, letter: u8) -> Option<Volume<'_>> {
        self.volumes
            .iter()
            .find(|volume| volume.drive_letter == letter.to_ascii_uppercase())
            .map(|table| Volume { table, bytes: &self.bytes })
    }
}

impl Volume<'_> {
    pub(crate) fn checkpoint(&self) -> &JournalCheckpoint {
        &self.table.checkpoint
    }

    pub(crate) fn contains_directory(&self, file_id: u128) -> bool {
        self.row(file_id).is_some()
    }

    pub(crate) fn directory_path(&self, file_id: u128) -> Option<Vec<u16>> {
        let row = self.row(file_id)?;
        let start = self.table.names.start + row.offset;
        Some(self.bytes[start..start + row.length * 2]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect())
    }

    fn row(&self, file_id: u128) -> Option<DecodedRow> {
        let rows = &self.bytes[self.table.rows.clone()];
        let mut left = 0;
        let mut right = rows.len() / ROW_LEN;
        while left < right {
            let middle = left + (right - left) / 2;
            let row = decode_row(&rows[middle * ROW_LEN..][..ROW_LEN]).ok()?;
            match row.file_id.cmp(&file_id) {
                std::cmp::Ordering::Less => left = middle + 1,
                std::cmp::Ordering::Greater => right = middle,
                std::cmp::Ordering::Equal => return Some(row),
            }
        }
        None
    }
}

fn malformed(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn snapshot_path(cache: &Path) -> PathBuf {
    cache.with_extension("usn-snapshot")
}

fn image_path(cache: &Path, id: u128) -> PathBuf {
    cache.with_extension(format!("usn-image-{id:032x}"))
}

fn marker_path(cache: &Path) -> PathBuf {
    cache.with_extension("usn-pending")
}

fn marker_present(marker: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(marker) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Only use the returned metadata with the corresponding opened index view.
/// Callers must serialize reconciliation and updates under the index write lock.
pub(crate) fn load(cache: &Path, expected: &CacheBinding) -> Result<Snapshot, NeedsScan> {
    let marker = marker_path(cache);
    if marker_present(&marker).map_err(NeedsScan::Unreadable)? {
        return Err(NeedsScan::PendingTransaction);
    }
    let id = match published_id(cache) {
        Ok(id) => id,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(NeedsScan::NoCheckpoint),
        Err(error) => return Err(NeedsScan::Unreadable(error)),
    };
    let file = File::open(image_path(cache, id)).map_err(NeedsScan::Unreadable)?;
    let metadata = file.metadata().map_err(NeedsScan::Unreadable)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SNAPSHOT_BYTES {
        return Err(NeedsScan::Unreadable(malformed("invalid USN snapshot file")));
    }
    // Published files are immutable. Only the directory entry is replaced.
    let bytes = unsafe { MmapOptions::new().map(&file) }.map_err(NeedsScan::Unreadable)?;
    let mut input = Decoder::new(&bytes);
    let binding = read_binding(&mut input).map_err(NeedsScan::Unreadable)?;
    if &binding != expected {
        return Err(NeedsScan::CacheChanged);
    }
    let volumes = read_volumes(&mut input).map_err(NeedsScan::Unreadable)?;
    if published_id(cache).map_err(NeedsScan::Unreadable)? != id {
        return Err(NeedsScan::CacheChanged);
    }
    if marker_present(&marker).map_err(NeedsScan::Unreadable)? {
        return Err(NeedsScan::PendingTransaction);
    }
    Ok(Snapshot { bytes, volumes })
}

pub(crate) struct Transaction {
    cache: PathBuf,
    id: u128,
}

impl Transaction {
    /// First durable write of any transaction that may update the index or
    /// its deltas. Hold the index writer lock from begin through commit.
    pub(crate) fn begin(cache: &Path) -> io::Result<Self> {
        Self::publish_marker(cache, false)
    }

    /// Use only with the exclusive index writer lock when discarding a
    /// previous incomplete transaction and building a new full baseline.
    pub(crate) fn begin_full_rebuild(cache: &Path) -> io::Result<Self> {
        Self::publish_marker(cache, true)
    }

    fn publish_marker(cache: &Path, replace: bool) -> io::Result<Self> {
        let id = unique_id();
        publish_record(&marker_path(cache), MARKER_MAGIC, id, replace)?;
        Ok(Self { cache: cache.to_path_buf(), id })
    }

    /// Call after reconciling all changes and flushing the index and deltas.
    /// Read their durable binding from disk under the same index writer lock.
    /// Dropping this transaction, or any failure, leaves the marker in place.
    pub(crate) fn commit_after_index(
        self,
        expected: &CacheBinding,
        volumes: &[VolumeSnapshot<'_>],
        read_durable_binding: impl FnOnce() -> io::Result<CacheBinding>,
    ) -> io::Result<()> {
        self.verify_marker()?;
        let destination = image_path(&self.cache, self.id);
        let (temp, file) = Temporary::new(&destination)?;
        write_image(file, expected, volumes)?;
        self.verify_marker()?;
        if read_durable_binding()? != *expected {
            return Err(malformed("USN snapshot does not match the durable cache"));
        }
        publish(&temp.path, &destination, false)?;
        let image = Temporary { path: destination, remove: true };
        // Windows can't replace an image while an old snapshot maps it. Only
        // point to the new immutable generation after its data is durable.
        publish_record(&snapshot_path(&self.cache), POINTER_MAGIC, self.id, true)?;
        image.keep();
        prune_old_images(&self.cache, self.id);
        fs::remove_file(marker_path(&self.cache))
    }

    fn verify_marker(&self) -> io::Result<()> {
        if read_record(&marker_path(&self.cache), MARKER_MAGIC)? != self.id {
            return Err(malformed("USN transaction marker changed"));
        }
        Ok(())
    }
}

fn publish_record(path: &Path, magic: &[u8; 8], id: u128, replace: bool) -> io::Result<()> {
    let (temp, mut file) = Temporary::new(path)?;
    file.write_all(magic)?;
    file.write_all(&id.to_le_bytes())?;
    file.sync_all()?;
    drop(file);
    publish(&temp.path, path, replace)
}

fn read_record(path: &Path, magic: &[u8; 8]) -> io::Result<u128> {
    let mut file = File::open(path)?;
    let mut received = [0; 8];
    file.read_exact(&mut received)?;
    let mut id = [0; 16];
    file.read_exact(&mut id)?;
    if &received != magic || file.read(&mut [0])? != 0 {
        return Err(malformed("invalid USN transaction record"));
    }
    Ok(u128::from_le_bytes(id))
}

fn published_id(cache: &Path) -> io::Result<u128> {
    read_record(&snapshot_path(cache), POINTER_MAGIC)
}

fn prune_old_images(cache: &Path, current: u128) {
    let Some(parent) = cache.parent().filter(|path| !path.as_os_str().is_empty()) else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id_text) = path.extension().and_then(|ext| ext.to_str())
            .and_then(|ext| ext.strip_prefix("usn-image-")).filter(|id| id.len() == 32)
        else {
            continue;
        };
        let Ok(id) = u128::from_str_radix(id_text, 16) else {
            continue;
        };
        if id != current && path == image_path(cache, id) && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            // An old Windows reader may still have this image mapped; a later
            // successful commit can retry removing it.
            let _ = fs::remove_file(path);
        }
    }
}

fn unique_id() -> u128 {
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let high = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
    let low = (u64::from(std::process::id()) << 32) | NEXT_ID.fetch_add(1, Ordering::Relaxed) as u32 as u64;
    (u128::from(high) << 64) | u128::from(low)
}

struct Temporary { path: PathBuf, remove: bool }

impl Temporary {
    fn new(destination: &Path) -> io::Result<(Self, File)> {
        let path = destination.with_extension(format!("usn-tmp-{:032x}", unique_id()));
        let file = OpenOptions::new().write(true).create_new(true).open(&path)?;
        Ok((Self { path, remove: true }, file))
    }

    fn keep(mut self) {
        self.remove = false;
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        if self.remove {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(windows)]
fn publish(source: &Path, destination: &Path, replace: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};

    let wide = |path: &Path| path.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
    let mut flags = MOVEFILE_WRITE_THROUGH;
    if replace {
        flags |= MOVEFILE_REPLACE_EXISTING;
    }
    if unsafe { MoveFileExW(wide(source).as_ptr(), wide(destination).as_ptr(), flags) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish(source: &Path, destination: &Path, replace: bool) -> io::Result<()> {
    if replace {
        fs::rename(source, destination)?;
    } else {
        fs::hard_link(source, destination)?;
    }
    let parent = destination.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or(Path::new("."));
    File::open(parent)?.sync_all()
}

fn hash_bytes(mut value: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        value = (value ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    value
}

struct HashedWriter {
    writer: BufWriter<File>,
    checksum: u64,
}

impl HashedWriter {
    fn put(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.writer.write_all(bytes)?;
        self.checksum = hash_bytes(self.checksum, bytes);
        Ok(())
    }

    fn finish(mut self) -> io::Result<()> {
        self.writer.write_all(&self.checksum.to_le_bytes())?;
        self.writer.flush()?;
        self.writer.get_ref().sync_all()
    }
}

fn valid_guid_path(path: &str) -> bool {
    path.strip_prefix(r"\\?\volume{")
        .and_then(|guid| guid.strip_suffix("}\\"))
        .is_some_and(|guid| guid.len() == 36 && guid.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() }
        }))
}

fn valid_path(path: impl Iterator<Item = u16>, letter: u8) -> bool {
    let mut path = path;
    for unit in [u16::from(letter), 58, 92] {
        if path.next() != Some(unit) {
            return false;
        }
    }
    let mut component_length = 0;
    let mut only_dots = true;
    let mut saw_any = false;
    for unit in path {
        saw_any = true;
        match unit {
            0 | 47 | 58 => return false,
            92 => {
                if component_length == 0 || (only_dots && component_length <= 2) {
                    return false;
                }
                component_length = 0;
                only_dots = true;
            }
            _ => {
                component_length += 1;
                only_dots &= unit == 46;
            }
        }
    }
    !saw_any || (component_length != 0 && (!only_dots || component_length > 2))
}

fn write_image(file: File, binding: &CacheBinding, volumes: &[VolumeSnapshot<'_>]) -> io::Result<()> {
    if volumes.is_empty() || volumes.len() > 26 {
        return Err(malformed("invalid USN snapshot volume count"));
    }
    let mut out = HashedWriter { writer: BufWriter::with_capacity(64 * 1024, file), checksum: HASH_OFFSET };
    out.put(MAGIC)?;
    out.put(&binding.generation.to_le_bytes())?;
    out.put(&binding.source_stamp)?;
    out.put(&[u8::from(binding.delta_stamp.is_some())])?;
    out.put(&binding.delta_stamp.unwrap_or([0; STAMP_LEN]))?;
    out.put(&[volumes.len() as u8])?;
    let mut drive_letters = 0u32;
    let mut path_bytes = [0; 256];
    let mut image_len = (HEADER_LEN + 8) as u64;
    for volume in volumes {
        let bit = drive_bit(volume.drive_letter)?;
        if drive_letters & bit != 0 {
            return Err(malformed("duplicate USN snapshot volume"));
        }
        drive_letters |= bit;
        let checkpoint = volume.checkpoint;
        if !valid_guid_path(&checkpoint.volume.guid_path) || checkpoint.next_usn < 0
            || volume.directories.is_empty() || volume.directories.len() > MAX_ROWS
        {
            return Err(malformed("invalid USN volume baseline"));
        }
        let mut previous_id = 0;
        let mut path_len = 0u64;
        for row in volume.directories {
            if row.file_id <= previous_id || row.path.len() > 32_767
                || !valid_path(row.path.iter().copied(), volume.drive_letter)
            {
                return Err(malformed("invalid USN snapshot directory"));
            }
            previous_id = row.file_id;
            path_len += (row.path.len() * 2) as u64;
            if path_len > MAX_SNAPSHOT_BYTES {
                return Err(malformed("USN directory path pool is too large"));
            }
        }
        image_len += (VOLUME_HEADER_LEN + ROW_LEN * volume.directories.len()) as u64 + path_len;
        if image_len > MAX_SNAPSHOT_BYTES {
            return Err(malformed("USN snapshot is too large"));
        }
        out.put(&[volume.drive_letter])?;
        out.put(checkpoint.volume.guid_path.as_bytes())?;
        out.put(&checkpoint.volume.serial.to_le_bytes())?;
        out.put(&checkpoint.journal_id.to_le_bytes())?;
        out.put(&checkpoint.next_usn.to_le_bytes())?;
        out.put(&(volume.directories.len() as u32).to_le_bytes())?;
        out.put(&path_len.to_le_bytes())?;
        let mut offset = 0u64;
        for row in volume.directories {
            out.put(&row.file_id.to_le_bytes())?;
            out.put(&offset.to_le_bytes())?;
            out.put(&(row.path.len() as u16).to_le_bytes())?;
            offset += (row.path.len() * 2) as u64;
        }
        for row in volume.directories {
            for units in row.path.chunks(path_bytes.len() / 2) {
                for (pair, unit) in path_bytes.chunks_exact_mut(2).zip(units) {
                    pair.copy_from_slice(&unit.to_le_bytes());
                }
                out.put(&path_bytes[..units.len() * 2])?;
            }
        }
    }
    out.finish()
}

struct Decoder<'a> {
    data: &'a [u8],
    cursor: usize,
}

impl<'a> Decoder<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, cursor: 0 }
    }

    fn take(&mut self, length: usize) -> io::Result<&'a [u8]> {
        let end = self.cursor.checked_add(length).ok_or_else(|| malformed("USN snapshot length overflow"))?;
        let result = self.data.get(self.cursor..end).ok_or_else(|| malformed("truncated USN snapshot"))?;
        self.cursor = end;
        Ok(result)
    }

    fn fixed<const N: usize>(&mut self) -> io::Result<[u8; N]> {
        self.take(N)?.try_into().map_err(|_| malformed("truncated USN snapshot field"))
    }
}

fn read_binding(input: &mut Decoder<'_>) -> io::Result<CacheBinding> {
    if input.take(MAGIC.len())? != MAGIC {
        return Err(malformed("wrong USN snapshot version"));
    }
    let generation = u64::from_le_bytes(input.fixed()?);
    let source_stamp = input.fixed()?;
    let [kind] = input.fixed()?;
    let delta = input.fixed()?;
    let delta_stamp = match kind {
        0 if delta == [0; STAMP_LEN] => None,
        1 => Some(delta),
        _ => return Err(malformed("invalid USN delta binding")),
    };
    Ok(CacheBinding { generation, source_stamp, delta_stamp })
}

fn drive_bit(letter: u8) -> io::Result<u32> {
    if !letter.is_ascii_uppercase() {
        return Err(malformed("invalid USN snapshot drive letter"));
    }
    Ok(1 << (letter - b'A'))
}

struct DecodedRow {
    file_id: u128,
    offset: usize,
    length: usize,
}

fn decode_row(bytes: &[u8]) -> io::Result<DecodedRow> {
    let mut input = Decoder::new(bytes);
    Ok(DecodedRow {
        file_id: u128::from_le_bytes(input.fixed()?),
        offset: usize::try_from(u64::from_le_bytes(input.fixed()?))
            .map_err(|_| malformed("invalid USN path offset"))?,
        length: usize::from(u16::from_le_bytes(input.fixed()?)),
    })
}

fn read_volumes(input: &mut Decoder<'_>) -> io::Result<Vec<VolumeTable>> {
    let [count] = input.fixed()?;
    if count == 0 || count > 26 {
        return Err(malformed("invalid USN snapshot volume count"));
    }
    // Check the complete immutable image before interpreting any table.
    let footer = input.data.len().checked_sub(8).ok_or_else(|| malformed("missing USN snapshot checksum"))?;
    let stored = u64::from_le_bytes(input.data[footer..].try_into()
        .map_err(|_| malformed("missing USN snapshot checksum"))?);
    if stored != hash_bytes(HASH_OFFSET, &input.data[..footer]) {
        return Err(malformed("USN snapshot checksum mismatch"));
    }
    let mut volumes = Vec::with_capacity(count as usize);
    let mut drive_letters = 0u32;
    for _ in 0..count {
        let [drive_letter] = input.fixed()?;
        let bit = drive_bit(drive_letter)?;
        if drive_letters & bit != 0 {
            return Err(malformed("duplicate USN snapshot volume"));
        }
        drive_letters |= bit;
        let guid_path = std::str::from_utf8(input.take(49)?).map_err(|_| malformed("bad USN volume GUID"))?;
        let serial = u32::from_le_bytes(input.fixed()?);
        let journal_id = u64::from_le_bytes(input.fixed()?);
        let next_usn = i64::from_le_bytes(input.fixed()?);
        let rows = u32::from_le_bytes(input.fixed()?) as usize;
        let name_bytes = usize::try_from(u64::from_le_bytes(input.fixed()?))
            .map_err(|_| malformed("invalid USN paths length"))?;
        if !valid_guid_path(guid_path) || next_usn < 0 || rows == 0 || rows > MAX_ROWS {
            return Err(malformed("invalid USN volume baseline"));
        }
        let rows_start = input.cursor;
        let row_data = input.take(rows * ROW_LEN)?;
        let names_start = input.cursor;
        let names = input.take(name_bytes)?;
        let mut previous_id = 0;
        let mut expected_offset = 0usize;
        for raw in row_data.chunks_exact(ROW_LEN) {
            let row = decode_row(raw)?;
            if row.file_id <= previous_id || row.offset != expected_offset || row.length > 32_767 {
                return Err(malformed("invalid USN snapshot directory table"));
            }
            previous_id = row.file_id;
            expected_offset = expected_offset.checked_add(row.length * 2)
                .ok_or_else(|| malformed("USN snapshot path length overflow"))?;
            let text = names.get(row.offset..expected_offset).ok_or_else(|| malformed("invalid USN path range"))?;
            let units = text.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
            if !valid_path(units, drive_letter) {
                return Err(malformed("invalid USN directory path"));
            }
        }
        if expected_offset != names.len() {
            return Err(malformed("invalid USN path pool length"));
        }
        volumes.push(VolumeTable {
            drive_letter,
            checkpoint: JournalCheckpoint {
                volume: VolumeIdentity { guid_path: guid_path.to_string(), serial },
                journal_id,
                next_usn,
            },
            rows: rows_start..names_start,
            names: names_start..input.cursor,
        });
    }
    if input.cursor != footer {
        return Err(malformed("extra data in USN snapshot"));
    }
    Ok(volumes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom};

    struct TestCache {
        parent: PathBuf,
        path: PathBuf,
    }

    impl TestCache {
        fn new() -> Self {
            let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..").join("..").canonicalize().unwrap();
            let parent = workspace.join(".task-tmp");
            fs::create_dir_all(&parent).unwrap();
            assert_eq!(parent.canonicalize().unwrap(), parent);
            let path = parent.join(format!("usn-snapshot-test-{:032x}", unique_id()));
            fs::create_dir(&path).unwrap();
            Self { parent, path }
        }

        fn cache(&self) -> PathBuf {
            self.path.join("search-index.bin")
        }
    }

    impl Drop for TestCache {
        fn drop(&mut self) {
            if self.path.canonicalize().ok().as_ref() == Some(&self.path)
                && self.path.parent() == Some(self.parent.as_path())
            {
                let _ = fs::remove_dir_all(&self.path);
            }
        }
    }

    fn stamp(path: &Path) -> io::Result<[u8; STAMP_LEN]> {
        let mut file = File::open(path)?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        crate::mapped_tables::source_stamp(&file, &data)
    }

    fn read_actual(cache: &Path, generation: u64) -> io::Result<CacheBinding> {
        let delta_stamp = match stamp(&cache.with_extension("delta")) {
            Ok(value) => Some(value),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        Ok(CacheBinding { generation, source_stamp: stamp(cache)?, delta_stamp })
    }

    fn write_synced(path: &Path, bytes: &[u8]) {
        let mut file = File::create(path).unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }

    fn checkpoint() -> JournalCheckpoint {
        JournalCheckpoint {
            volume: VolumeIdentity {
                guid_path: "\\\\?\\volume{01234567-89ab-cdef-0123-456789abcdef}\\".to_string(),
                serial: 123,
            },
            journal_id: u64::MAX - 18,
            next_usn: 456,
        }
    }

    fn directories() -> Vec<DirectoryRow> {
        vec![
            DirectoryRow { file_id: 5, path: "E:\\".encode_utf16().collect() },
            DirectoryRow {
                file_id: 0xffff_aacc_0000_0099_u128,
                path: "E:\\名称😀\\测试".encode_utf16().collect(),
            },
        ]
    }

    fn commit(cache: &Path, transaction: Transaction, generation: u64) -> CacheBinding {
        let actual = read_actual(cache, generation).unwrap();
        transaction.commit_after_index(
            &actual,
            &[VolumeSnapshot {
                drive_letter: b'E',
                checkpoint: &checkpoint(),
                directories: &directories(),
            }],
            || read_actual(cache, generation),
        ).unwrap();
        actual
    }

    #[test]
    fn legacy_index_without_checkpoint_falls_back() {
        let fixture = TestCache::new();
        let cache = fixture.cache();
        write_synced(&cache, b"legacy cache without exact journal baseline");
        let binding = read_actual(&cache, 1).unwrap();
        assert!(matches!(load(&cache, &binding), Err(NeedsScan::NoCheckpoint)));
    }

    #[test]
    fn exact_image_can_be_reopened_and_rejects_generation_or_input_change() {
        let fixture = TestCache::new();
        let cache = fixture.cache();
        let transaction = Transaction::begin(&cache).unwrap();
        write_synced(&cache, b"new baseline");
        write_synced(&cache.with_extension("delta"), b"reconciled deltas");
        let binding = commit(&cache, transaction, 7);
        for _ in 0..2 {
            let snapshot = load(&cache, &binding).unwrap();
            let volume = snapshot.volume(b'e').unwrap();
            assert_eq!(volume.checkpoint(), &checkpoint());
            assert!(volume.contains_directory(5));
            let row = directories().pop().unwrap();
            assert_eq!(volume.directory_path(row.file_id), Some(row.path));
            assert!(!volume.contains_directory(6));
            assert!(snapshot.volume(b'C').is_none());
        }
        assert!(matches!(load(&cache, &read_actual(&cache, 8).unwrap()), Err(NeedsScan::CacheChanged)));
        write_synced(&cache.with_extension("delta"), b"unbound new deltas");
        assert!(matches!(load(&cache, &read_actual(&cache, 7).unwrap()), Err(NeedsScan::CacheChanged)));
        fs::remove_file(cache.with_extension("delta")).unwrap();
        assert!(matches!(load(&cache, &read_actual(&cache, 7).unwrap()), Err(NeedsScan::CacheChanged)));
        let no_delta = commit(&cache, Transaction::begin(&cache).unwrap(), 8);
        write_synced(&cache.with_extension("replacement"), b"replacement!");
        fs::remove_file(&cache).unwrap();
        fs::rename(cache.with_extension("replacement"), &cache).unwrap();
        assert!(matches!(load(&cache, &read_actual(&cache, 8).unwrap()), Err(NeedsScan::CacheChanged)));
        assert!(load(&cache, &no_delta).is_ok(), "the old opened cache view can still use its matching snapshot");
    }

    #[test]
    fn unfinished_or_wrong_binding_never_exposes_checkpoint_and_full_rebuild_recovers() {
        let fixture = TestCache::new();
        let cache = fixture.cache();
        let transaction = Transaction::begin(&cache).unwrap();
        write_synced(&cache, b"reconciled base");
        let prior = commit(&cache, transaction, 4);

        let pending = Transaction::begin(&cache).unwrap();
        assert!(Transaction::begin(&cache).is_err(), "the original writer owns its marker");
        assert!(matches!(load(&cache, &prior), Err(NeedsScan::PendingTransaction)));
        let wrong = CacheBinding { generation: 5, ..prior.clone() };
        let err = pending.commit_after_index(
            &wrong,
            &[VolumeSnapshot { drive_letter: b'E', checkpoint: &checkpoint(), directories: &directories() }],
            || read_actual(&cache, 4),
        );
        assert_eq!(err.unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert!(matches!(load(&cache, &prior), Err(NeedsScan::PendingTransaction)));

        let rebuild = Transaction::begin_full_rebuild(&cache).unwrap();
        write_synced(&cache, b"completely rebuilt");
        let actual = commit(&cache, rebuild, 6);
        assert!(load(&cache, &actual).is_ok());
        assert!(matches!(load(&cache, &prior), Err(NeedsScan::CacheChanged)));
    }

    #[test]
    fn marker_content_is_checked_before_publishing_or_reading_any_new_binding() {
        let fixture = TestCache::new();
        let cache = fixture.cache();
        let old_owner = Transaction::begin(&cache).unwrap();
        let replacement_owner = Transaction::begin_full_rebuild(&cache).unwrap();
        write_synced(&cache, b"rebuilt index");
        let binding = read_actual(&cache, 2).unwrap();
        assert!(old_owner.commit_after_index(&binding, &[], || panic!("stale marker must reject before reading binding")).is_err());
        assert!(matches!(load(&cache, &binding), Err(NeedsScan::PendingTransaction)));
        assert!(load(&cache, &commit(&cache, replacement_owner, 2)).is_ok());
    }

    #[test]
    fn new_generation_can_publish_while_the_old_directory_table_is_mapped() {
        let fixture = TestCache::new();
        let cache = fixture.cache();
        let transaction = Transaction::begin(&cache).unwrap();
        write_synced(&cache, b"first index");
        let prior = commit(&cache, transaction, 4);
        let old = load(&cache, &prior).unwrap();
        let old_image = image_path(&cache, published_id(&cache).unwrap());

        let transaction = Transaction::begin(&cache).unwrap();
        write_synced(&cache, b"updated index and directory table");
        let binding = read_actual(&cache, 5).unwrap();
        let mut advanced = checkpoint();
        advanced.next_usn += 50;
        transaction.commit_after_index(
            &binding,
            &[VolumeSnapshot { drive_letter: b'E', checkpoint: &advanced, directories: &directories() }],
            || read_actual(&cache, 5),
        ).unwrap();

        let new = load(&cache, &binding).unwrap();
        assert_eq!(new.volume(b'E').unwrap().checkpoint(), &advanced);
        assert_eq!(old.volume(b'E').unwrap().checkpoint(), &checkpoint());
        assert!(old.volume(b'E').unwrap().contains_directory(5));
        assert!(matches!(load(&cache, &prior), Err(NeedsScan::CacheChanged)));
        drop(old);
        drop(new);

        let transaction = Transaction::begin(&cache).unwrap();
        write_synced(&cache, b"third refreshed index");
        commit(&cache, transaction, 6);
        assert!(!old_image.exists(), "unmapped retired image was cleaned up");
    }

    #[test]
    fn truncated_or_corrupt_snapshot_is_rejected_even_with_matching_cache() {
        let fixture = TestCache::new();
        let cache = fixture.cache();
        let transaction = Transaction::begin(&cache).unwrap();
        write_synced(&cache, b"base index");
        let binding = commit(&cache, transaction, 5);
        let path = image_path(&cache, published_id(&cache).unwrap());
        let pointer = fs::read(snapshot_path(&cache)).unwrap();
        write_synced(&snapshot_path(&cache), &pointer[..pointer.len() - 1]);
        assert!(matches!(load(&cache, &binding), Err(NeedsScan::Unreadable(_))));
        write_synced(&snapshot_path(&cache), &pointer);
        let original = fs::read(&path).unwrap();
        write_synced(&path, &original[..original.len() - 3]);
        assert!(matches!(load(&cache, &binding), Err(NeedsScan::Unreadable(error)) if error.kind() == io::ErrorKind::InvalidData));

        write_synced(&path, &original);
        let mut file = OpenOptions::new().write(true).open(path).unwrap();
        file.seek(SeekFrom::Start((original.len() - 12) as u64)).unwrap();
        file.write_all(&[original[original.len() - 12] ^ 1]).unwrap();
        file.sync_all().unwrap();
        assert!(matches!(load(&cache, &binding), Err(NeedsScan::Unreadable(error)) if error.kind() == io::ErrorKind::InvalidData));
    }
}
