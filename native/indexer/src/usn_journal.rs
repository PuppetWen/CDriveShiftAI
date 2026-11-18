//! Read-only Windows NTFS change journal access. The unprivileged journal
//! retains file and parent IDs but may remove names. Callers must reconcile
//! affected directories before claiming a checkpoint has been applied.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io;

#[path = "usn_snapshot.rs"]
pub(crate) mod snapshot;

const DIRECTORY_ATTRIBUTE: u32 = 0x10;
const REPARSE_POINT_ATTRIBUTE: u32 = 0x400;
const FILE_CREATE: u32 = 0x100;
const FILE_DELETE: u32 = 0x200;
const RENAME_OLD_NAME: u32 = 0x1000;
const RENAME_NEW_NAME: u32 = 0x2000;
const HARD_LINK_CHANGE: u32 = 0x10000;
const REPARSE_POINT_CHANGE: u32 = 0x100000;
const KNOWN_REASONS: u32 = 0x81ff_ff77;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct VolumeIdentity {
    pub(crate) guid_path: String,
    pub(crate) serial: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct JournalCheckpoint {
    pub(crate) volume: VolumeIdentity,
    pub(crate) journal_id: u64,
    pub(crate) next_usn: i64,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum CheckpointMismatch {
    VolumeChanged,
    JournalChanged,
    Expired,
    AheadOfJournal,
}

#[derive(Debug)]
pub(crate) struct JournalWindow {
    pub(crate) volume: VolumeIdentity,
    pub(crate) journal_id: u64,
    pub(crate) first_usn: i64,
    pub(crate) lowest_valid_usn: i64,
    pub(crate) next_usn: i64,
}

impl JournalWindow {
    pub(crate) fn first_readable_usn(&self) -> i64 {
        self.first_usn.max(self.lowest_valid_usn)
    }

    /// Capture before reading a baseline volume snapshot. Only publish this
    /// cursor together with that snapshot or with durably applied changes.
    pub(crate) fn checkpoint(&self) -> JournalCheckpoint {
        JournalCheckpoint {
            volume: self.volume.clone(),
            journal_id: self.journal_id,
            next_usn: self.next_usn,
        }
    }

    pub(crate) fn validate_checkpoint(
        &self,
        checkpoint: &JournalCheckpoint,
    ) -> Result<(), CheckpointMismatch> {
        if checkpoint.volume != self.volume {
            return Err(CheckpointMismatch::VolumeChanged);
        }
        if checkpoint.journal_id != self.journal_id {
            return Err(CheckpointMismatch::JournalChanged);
        }
        if checkpoint.next_usn < self.first_readable_usn() {
            return Err(CheckpointMismatch::Expired);
        }
        if checkpoint.next_usn > self.next_usn {
            return Err(CheckpointMismatch::AheadOfJournal);
        }
        Ok(())
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct JournalChange {
    pub(crate) file_id: u128,
    pub(crate) parent_id: u128,
    pub(crate) usn: i64,
    pub(crate) reason: u32,
    // V4 modified-range records do not carry file attributes.
    pub(crate) attributes: Option<u32>,
}

#[derive(Debug)]
pub(crate) struct JournalBatch {
    pub(crate) records: Vec<JournalChange>,
    /// Resume here only after the records have been fully reconciled and
    /// committed. Never replace this with the journal's current NextUsn.
    pub(crate) resume: JournalCheckpoint,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum RequiredScan {
    UnknownParent(u128),
    HardLink(u128),
    DirectoryMove(u128),
    DirectoryTreeChanged(u128),
    ReparsePoint(u128),
    UnknownChange(u128),
}

/// Plan nonrecursive reconciliation of parents represented by the baseline
/// index. Even a single ambiguous change invalidates the batch. Callers
/// must also retain the original records and include known file-ID aliases
/// when refreshing indexed metadata and file contents.
pub(crate) fn dirty_directories<'a>(
    changes: impl IntoIterator<Item = &'a JournalChange>,
    mut is_known_directory: impl FnMut(u128) -> bool,
) -> Result<BTreeSet<u128>, RequiredScan> {
    let mut parents = BTreeSet::new();
    for change in changes {
        if change.reason & HARD_LINK_CHANGE != 0 {
            return Err(RequiredScan::HardLink(change.file_id));
        }
        if change.reason & REPARSE_POINT_CHANGE != 0
            || change.attributes.is_some_and(|attr| attr & REPARSE_POINT_ATTRIBUTE != 0)
        {
            return Err(RequiredScan::ReparsePoint(change.file_id));
        }
        let attributes = change.attributes.ok_or(RequiredScan::UnknownChange(change.file_id))?;
        if change.reason == 0 || change.reason & !KNOWN_REASONS != 0 {
            return Err(RequiredScan::UnknownChange(change.file_id));
        }
        if attributes & DIRECTORY_ATTRIBUTE != 0 {
            if change.reason & (RENAME_OLD_NAME | RENAME_NEW_NAME) != 0 {
                return Err(RequiredScan::DirectoryMove(change.file_id));
            }
            if change.reason & (FILE_CREATE | FILE_DELETE) != 0 {
                return Err(RequiredScan::DirectoryTreeChanged(change.file_id));
            }
        }
        if change.parent_id == 0 || !is_known_directory(change.parent_id) {
            return Err(RequiredScan::UnknownParent(change.parent_id));
        }
        parents.insert(change.parent_id);
    }
    Ok(parents)
}

fn invalid_data(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn field<const N: usize>(bytes: &[u8], offset: usize) -> io::Result<[u8; N]> {
    bytes
        .get(offset..offset + N)
        .and_then(|value| value.try_into().ok())
        .ok_or_else(|| invalid_data("truncated NTFS journal data"))
}

fn parse_window(volume: VolumeIdentity, bytes: &[u8]) -> io::Result<JournalWindow> {
    // USN_JOURNAL_DATA_V0 is the common prefix of later layouts.
    if bytes.len() < 56 {
        return Err(invalid_data("truncated NTFS journal window"));
    }
    if bytes.len() >= 60 {
        let min_major = u16::from_le_bytes(field(bytes, 56)?);
        let max_major = u16::from_le_bytes(field(bytes, 58)?);
        if min_major < 2 || max_major > 4 || min_major > max_major {
            return Err(invalid_data("unsupported NTFS journal record versions"));
        }
    }
    let result = JournalWindow {
        volume,
        journal_id: u64::from_le_bytes(field(bytes, 0)?),
        first_usn: i64::from_le_bytes(field(bytes, 8)?),
        next_usn: i64::from_le_bytes(field(bytes, 16)?),
        lowest_valid_usn: i64::from_le_bytes(field(bytes, 24)?),
    };
    if result.first_usn < 0 || result.lowest_valid_usn < 0 || result.next_usn < result.first_readable_usn() {
        return Err(invalid_data("invalid NTFS journal cursor window"));
    }
    Ok(result)
}

fn parse_record(bytes: &[u8]) -> io::Result<JournalChange> {
    let version = u16::from_le_bytes(field(bytes, 4)?);
    let (minimum_len, id_width, usn_offset, reason_offset, attributes_offset) = match version {
        2 => (60, 8, 24, 40, Some(52)),
        3 => (76, 16, 40, 56, Some(68)),
        4 => (64, 16, 40, 48, None),
        _ => return Err(invalid_data("unsupported NTFS journal record")),
    };
    if bytes.len() < minimum_len {
        return Err(invalid_data("truncated NTFS journal record"));
    }
    let file_id = |offset| -> io::Result<u128> {
        if id_width == 8 {
            Ok(u64::from_le_bytes(field(bytes, offset)?) as u128)
        } else {
            Ok(u128::from_le_bytes(field(bytes, offset)?))
        }
    };
    // Reconciliation uses the IDs and flags. No filename is read, even
    // when the system supplies one instead of redacting it.
    Ok(JournalChange {
        file_id: file_id(8)?,
        parent_id: file_id(8 + id_width)?,
        usn: i64::from_le_bytes(field(bytes, usn_offset)?),
        reason: u32::from_le_bytes(field(bytes, reason_offset)?),
        attributes: attributes_offset
            .map(|offset| field(bytes, offset).map(u32::from_le_bytes))
            .transpose()?,
    })
}

fn parse_batch(
    checkpoint: &JournalCheckpoint,
    bytes: &[u8],
) -> io::Result<JournalBatch> {
    let next_usn = i64::from_le_bytes(field(bytes, 0)?);
    if next_usn < checkpoint.next_usn {
        return Err(invalid_data("NTFS journal cursor moved backwards"));
    }
    let mut rest = &bytes[8..];
    let mut records = Vec::new();
    let mut previous = checkpoint.next_usn;
    while !rest.is_empty() {
        let length = u32::from_le_bytes(field(rest, 0)?) as usize;
        if length < 8 || length % 8 != 0 || length > rest.len() {
            return Err(invalid_data("invalid NTFS journal record length"));
        }
        let (entry, remaining) = rest.split_at(length);
        let record = parse_record(entry)?;
        if record.usn < previous || record.usn >= next_usn {
            return Err(invalid_data("NTFS journal record outside the batch cursor range"));
        }
        previous = record.usn;
        records.push(record);
        rest = remaining;
    }
    Ok(JournalBatch {
        records,
        resume: JournalCheckpoint { next_usn, ..checkpoint.clone() },
    })
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::OsString;
    use std::mem::size_of;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ExtendedFileIdType, FileAttributeTagInfo, FileIdExtdDirectoryInfo,
        FileIdExtdDirectoryRestartInfo, FileIdInfo, FileIdType, GetFileInformationByHandleEx,
        GetFinalPathNameByHandleW, GetVolumeInformationByHandleW, OpenFileById,
        FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_ID_128, FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FILE_ID_INFO, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        VOLUME_NAME_DOS, VOLUME_NAME_GUID,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;

    // winioctl.h on recent Windows SDKs. The unprivileged operation is
    // intentionally distinct from FSCTL_READ_USN_JOURNAL.
    const FSCTL_QUERY_USN_JOURNAL: u32 = 0x0009_00f4;
    const FSCTL_READ_UNPRIVILEGED_USN_JOURNAL: u32 = 0x0009_03ab;
    const READ_BUFFER_LEN: usize = 64 * 1024;

    pub(crate) struct UsnJournal {
        handle: OwnedHandle,
        volume: VolumeIdentity,
    }

    #[derive(Debug, Eq, PartialEq)]
    pub(crate) struct DirectoryEntry {
        pub(crate) name: OsString,
        pub(crate) file_id: u128,
        pub(crate) attributes: u32,
        pub(crate) size: u64,
        // 100 ns since 1601-01-01 UTC, as provided by NTFS.
        pub(crate) last_write_time: i64,
    }

    impl UsnJournal {
        pub(crate) fn open(root: &str) -> io::Result<Self> {
            match root.as_bytes() {
                [letter, b':', b'\\'] if letter.is_ascii_alphabetic() => {}
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "NTFS journal requires a drive root such as E:\\",
                    ))
                }
            }
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS,
                    0,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
            let volume = read_volume_identity(handle)?;
            Ok(Self { handle: owned, volume })
        }

        pub(crate) fn window(&self) -> io::Result<JournalWindow> {
            let mut bytes = [0; 80];
            let count = self.control(FSCTL_QUERY_USN_JOURNAL, &mut [], &mut bytes)?;
            parse_window(self.volume.clone(), &bytes[..count])
        }

        pub(crate) fn root_file_id(&self) -> io::Result<u128> {
            let info = file_id_info(self.handle.as_raw_handle() as HANDLE)?;
            Ok(u128::from_le_bytes(info.FileId.Identifier))
        }

        pub(crate) fn read_batch(&self, checkpoint: &JournalCheckpoint) -> io::Result<JournalBatch> {
            let before = self.window()?;
            validate(&before, checkpoint)?;
            if checkpoint.next_usn == before.next_usn {
                return Ok(JournalBatch { records: Vec::new(), resume: checkpoint.clone() });
            }

            // Little-endian READ_USN_JOURNAL_DATA_V1, with zero timeout and
            // BytesToWaitFor for bounded, non-blocking catch-up at EOF.
            let mut request = [0; 48];
            request[0..8].copy_from_slice(&checkpoint.next_usn.to_le_bytes());
            request[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
            request[32..40].copy_from_slice(&checkpoint.journal_id.to_le_bytes());
            request[40..42].copy_from_slice(&2u16.to_le_bytes());
            request[42..44].copy_from_slice(&4u16.to_le_bytes());
            let mut data = vec![0; READ_BUFFER_LEN];
            let count = self.control(FSCTL_READ_UNPRIVILEGED_USN_JOURNAL, &mut request, &mut data)?;
            let batch = parse_batch(checkpoint, &data[..count])?;
            // Catch a truncation or reset racing the read. A short response
            // may still advance its cursor over record-free space.
            let after = self.window()?;
            validate(&after, checkpoint)?;
            validate(&after, &batch.resume)?;
            if batch.resume.next_usn <= checkpoint.next_usn {
                return Err(invalid_data("NTFS journal read did not advance the cursor"));
            }
            Ok(batch)
        }

        /// Enumerate one known parent without following reparse points. A
        /// missing, moved or inaccessible directory must be rescanned by the
        /// caller. Do not publish any partial results if enumeration fails.
        pub(crate) fn visit_directory(
            &self,
            directory_id: u128,
            expected_path: &Path,
            mut visit: impl FnMut(DirectoryEntry) -> io::Result<()>,
        ) -> io::Result<()> {
            let directory = self.open_known_directory(directory_id, expected_path)?;
            let handle = directory.as_raw_handle() as HANDLE;
            // The Windows directory entries require 8-byte buffer alignment.
            let mut buffer = vec![0u64; READ_BUFFER_LEN / size_of::<u64>()];
            let mut class = FileIdExtdDirectoryRestartInfo;
            loop {
                let success = unsafe {
                    GetFileInformationByHandleEx(
                        handle,
                        class,
                        buffer.as_mut_ptr().cast(),
                        READ_BUFFER_LEN as u32,
                    )
                };
                if success == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                        return self.validate_directory(handle, directory_id, expected_path);
                    }
                    return Err(error);
                }
                let bytes = unsafe {
                    std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), READ_BUFFER_LEN)
                };
                visit_directory_buffer(bytes, &mut visit)?;
                class = FileIdExtdDirectoryInfo;
            }
        }

        fn open_known_directory(
            &self,
            directory_id: u128,
            expected_path: &Path,
        ) -> io::Result<OwnedHandle> {
            let mut descriptor = FILE_ID_DESCRIPTOR {
                dwSize: size_of::<FILE_ID_DESCRIPTOR>() as u32,
                Type: ExtendedFileIdType,
                Anonymous: FILE_ID_DESCRIPTOR_0 {
                    ExtendedFileId: FILE_ID_128 { Identifier: directory_id.to_le_bytes() },
                },
            };
            if let Ok(narrow_id) = u64::try_from(directory_id) {
                descriptor.Type = FileIdType;
                descriptor.Anonymous.FileId = narrow_id as i64;
            }
            let handle = unsafe {
                OpenFileById(
                    self.handle.as_raw_handle() as HANDLE,
                    &descriptor,
                    FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    null(),
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
            self.validate_directory(handle, directory_id, expected_path)?;
            Ok(owned)
        }

        fn validate_directory(
            &self,
            handle: HANDLE,
            directory_id: u128,
            expected_path: &Path,
        ) -> io::Result<()> {
            let identity = file_id_info(handle)?;
            if u128::from_le_bytes(identity.FileId.Identifier) != directory_id
                || identity.VolumeSerialNumber as u32 != self.volume.serial
            {
                return Err(invalid_data("NTFS parent directory identity changed"));
            }
            let mut attributes = FILE_ATTRIBUTE_TAG_INFO { FileAttributes: 0, ReparseTag: 0 };
            let success = unsafe {
                GetFileInformationByHandleEx(
                    handle,
                    FileAttributeTagInfo,
                    (&mut attributes as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                    size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
                )
            };
            if success == 0 {
                return Err(io::Error::last_os_error());
            }
            if attributes.FileAttributes & (DIRECTORY_ATTRIBUTE | REPARSE_POINT_ATTRIBUTE)
                != DIRECTORY_ATTRIBUTE
            {
                return Err(invalid_data("NTFS parent is not a plain directory"));
            }
            let actual = current_directory_path(handle)?;
            let expected: Vec<_> = expected_path.as_os_str().encode_wide().collect();
            const EXTENDED_PREFIX: [u16; 4] = [92, 92, 63, 92];
            if actual.strip_prefix(&EXTENDED_PREFIX).unwrap_or(&actual)
                != expected.strip_prefix(&EXTENDED_PREFIX).unwrap_or(&expected)
            {
                return Err(invalid_data("NTFS parent directory moved or was renamed"));
            }
            Ok(())
        }

        fn control(&self, code: u32, input: &mut [u8], output: &mut [u8]) -> io::Result<usize> {
            let ptr = if input.is_empty() { null_mut() } else { input.as_mut_ptr().cast() };
            let mut returned = 0;
            let success = unsafe {
                DeviceIoControl(
                    self.handle.as_raw_handle() as HANDLE,
                    code,
                    ptr,
                    input.len() as u32,
                    output.as_mut_ptr().cast(),
                    output.len() as u32,
                    &mut returned,
                    null_mut(),
                )
            };
            let count = returned as usize;
            if success == 0 {
                return Err(io::Error::last_os_error());
            }
            if count > output.len() {
                return Err(invalid_data("oversized NTFS journal response"));
            }
            Ok(count)
        }
    }

    pub(super) fn file_id_info(handle: HANDLE) -> io::Result<FILE_ID_INFO> {
        let mut result = FILE_ID_INFO {
            VolumeSerialNumber: 0,
            FileId: FILE_ID_128 { Identifier: [0; 16] },
        };
        let success = unsafe {
            GetFileInformationByHandleEx(
                handle, FileIdInfo, (&mut result as *mut FILE_ID_INFO).cast(),
                size_of::<FILE_ID_INFO>() as u32,
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(result)
    }

    fn current_directory_path(handle: HANDLE) -> io::Result<Vec<u16>> {
        let mut path = vec![0; 256];
        loop {
            let count = unsafe {
                GetFinalPathNameByHandleW(
                    handle, path.as_mut_ptr(), path.len() as u32, VOLUME_NAME_DOS,
                )
            } as usize;
            if count == 0 {
                return Err(io::Error::last_os_error());
            }
            if count < path.len() {
                path.truncate(count);
                return Ok(path);
            }
            if count > 32_767 {
                return Err(invalid_data("NTFS parent directory path is too long"));
            }
            path.resize(count + 1, 0);
        }
    }

    fn visit_directory_buffer(
        mut bytes: &[u8],
        visit: &mut impl FnMut(DirectoryEntry) -> io::Result<()>,
    ) -> io::Result<()> {
        const NAME_OFFSET: usize = 88;
        loop {
            let next_offset = u32::from_le_bytes(field(bytes, 0)?) as usize;
            let entry = if next_offset == 0 {
                bytes
            } else {
                if next_offset < NAME_OFFSET || next_offset % 8 != 0 {
                    return Err(invalid_data("invalid NTFS directory entry offset"));
                }
                bytes.get(..next_offset).ok_or_else(|| invalid_data("truncated NTFS directory buffer"))?
            };
            let name_len = u32::from_le_bytes(field(entry, 60)?) as usize;
            if name_len == 0 || name_len % 2 != 0 || name_len > entry.len().saturating_sub(NAME_OFFSET) {
                return Err(invalid_data("invalid NTFS directory entry name"));
            }
            let name: Vec<u16> = entry[NAME_OFFSET..NAME_OFFSET + name_len]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            if name != [46] && name != [46, 46] {
                if name.iter().any(|&unit| matches!(unit, 0 | 47 | 92)) {
                    return Err(invalid_data("invalid NTFS filename component"));
                }
                let size = i64::from_le_bytes(field(entry, 40)?);
                visit(DirectoryEntry {
                    name: OsString::from_wide(&name),
                    file_id: u128::from_le_bytes(field(entry, 72)?),
                    attributes: u32::from_le_bytes(field(entry, 56)?),
                    size: u64::try_from(size).map_err(|_| invalid_data("invalid NTFS file size"))?,
                    last_write_time: i64::from_le_bytes(field(entry, 24)?),
                })?;
            }
            if next_offset == 0 {
                return Ok(());
            }
            bytes = &bytes[next_offset..];
        }
    }

    fn read_volume_identity(handle: HANDLE) -> io::Result<VolumeIdentity> {
        let mut filesystem = [0; 32];
        let mut serial = 0;
        let success = unsafe {
            GetVolumeInformationByHandleW(
                handle, null_mut(), 0, &mut serial, null_mut(), null_mut(),
                filesystem.as_mut_ptr(), filesystem.len() as u32,
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        let end = filesystem.iter().position(|unit| *unit == 0).unwrap_or(filesystem.len());
        if String::from_utf16_lossy(&filesystem[..end]) != "NTFS" {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "volume is not NTFS"));
        }

        // Resolve identity from the same handle used for queries, avoiding a
        // race with drive-letter changes. A SUBST directory is not the root.
        let mut path = [0; 64];
        let count = unsafe {
            GetFinalPathNameByHandleW(handle, path.as_mut_ptr(), path.len() as u32, VOLUME_NAME_GUID)
        } as usize;
        if count == 0 {
            return Err(io::Error::last_os_error());
        }
        let decoded = path.get(..count).and_then(|units| String::from_utf16(units).ok())
            .ok_or_else(|| invalid_data("invalid NTFS volume GUID path"))?;
        let guid_path = decoded.to_ascii_lowercase();
        let guid = guid_path.strip_prefix(r"\\?\volume{").and_then(|rest| rest.strip_suffix("}\\"));
        if !guid.is_some_and(is_volume_guid) {
            return Err(invalid_data("drive does not identify a single NTFS volume root"));
        }
        Ok(VolumeIdentity { guid_path, serial })
    }

    fn is_volume_guid(value: &str) -> bool {
        value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() }
        })
    }

    fn validate(window: &JournalWindow, checkpoint: &JournalCheckpoint) -> io::Result<()> {
        window.validate_checkpoint(checkpoint).map_err(|error| {
            io::Error::new(io::ErrorKind::InvalidData, format!("stale NTFS journal checkpoint: {error:?}"))
        })
    }
}

#[cfg(windows)]
pub(crate) use windows::{DirectoryEntry, UsnJournal};

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> JournalWindow {
        JournalWindow {
            volume: VolumeIdentity { guid_path: "test-volume".to_string(), serial: 42 },
            journal_id: 123,
            first_usn: 10,
            lowest_valid_usn: 20,
            next_usn: 1000,
        }
    }

    fn record_v2(file_id: u64, parent_id: u64, usn: i64, reason: u32) -> [u8; 64] {
        let mut data = [0; 64];
        data[0..4].copy_from_slice(&64u32.to_le_bytes());
        data[4..6].copy_from_slice(&2u16.to_le_bytes());
        data[8..16].copy_from_slice(&file_id.to_le_bytes());
        data[16..24].copy_from_slice(&parent_id.to_le_bytes());
        data[24..32].copy_from_slice(&usn.to_le_bytes());
        data[40..44].copy_from_slice(&reason.to_le_bytes());
        data[52..56].copy_from_slice(&0x10u32.to_le_bytes());
        data
    }

    #[test]
    fn checkpoint_refuses_replaced_volume_journal_and_expired_history() {
        let window = window();
        let mut checkpoint = window.checkpoint();
        assert_eq!(window.validate_checkpoint(&checkpoint), Ok(()));
        checkpoint.next_usn = 1001;
        assert_eq!(window.validate_checkpoint(&checkpoint), Err(CheckpointMismatch::AheadOfJournal));
        checkpoint.next_usn = 19;
        assert_eq!(window.validate_checkpoint(&checkpoint), Err(CheckpointMismatch::Expired));
        checkpoint.next_usn = 20;
        assert_eq!(window.validate_checkpoint(&checkpoint), Ok(()));
        checkpoint.journal_id += 1;
        assert_eq!(window.validate_checkpoint(&checkpoint), Err(CheckpointMismatch::JournalChanged));
        checkpoint.volume.serial += 1;
        assert_eq!(window.validate_checkpoint(&checkpoint), Err(CheckpointMismatch::VolumeChanged));
    }

    #[test]
    fn decodes_volume_window_and_rejects_bad_boundaries() {
        let window = window();
        let mut bytes = [0; 80];
        bytes[0..8].copy_from_slice(&window.journal_id.to_le_bytes());
        bytes[8..16].copy_from_slice(&window.first_usn.to_le_bytes());
        bytes[16..24].copy_from_slice(&window.next_usn.to_le_bytes());
        bytes[24..32].copy_from_slice(&window.lowest_valid_usn.to_le_bytes());
        bytes[56..58].copy_from_slice(&2u16.to_le_bytes());
        bytes[58..60].copy_from_slice(&4u16.to_le_bytes());
        let parsed = parse_window(window.volume.clone(), &bytes).unwrap();
        assert_eq!(parsed.first_readable_usn(), 20);
        assert_eq!(parsed.checkpoint(), window.checkpoint());
        assert!(parse_window(window.volume.clone(), &bytes[..48]).is_err());
        bytes[16..24].copy_from_slice(&19i64.to_le_bytes());
        assert!(parse_window(window.volume, &bytes).is_err());
    }

    #[test]
    fn preserves_both_rename_parents_without_file_names() {
        let checkpoint = window().checkpoint();
        let mut bytes = 1200i64.to_le_bytes().to_vec();
        bytes.extend(record_v2(17, 21, 1010, 0x1000));
        bytes.extend(record_v2(17, 35, 1080, 0x2000));
        let batch = parse_batch(&checkpoint, &bytes).unwrap();
        assert_eq!(batch.resume.next_usn, 1200);
        assert_eq!(batch.records, vec![
            JournalChange { file_id: 17, parent_id: 21, usn: 1010, reason: 0x1000, attributes: Some(0x10) },
            JournalChange { file_id: 17, parent_id: 35, usn: 1080, reason: 0x2000, attributes: Some(0x10) },
        ]);
    }

    #[test]
    fn handles_wide_ids_in_record_versions_three_and_four() {
        let file_id = 0x8000_0000_0000_0000_1122_3344_5566_7788u128;
        let parent_id = 0x9876_0000_0000_0000_0000_0000_0000_1111u128;
        for (version, reason_offset, attributes) in [(3, 56, Some(0)), (4, 48, None)] {
            let mut bytes = [0; 80];
            bytes[4..6].copy_from_slice(&u16::to_le_bytes(version));
            bytes[8..24].copy_from_slice(&file_id.to_le_bytes());
            bytes[24..40].copy_from_slice(&parent_id.to_le_bytes());
            bytes[40..48].copy_from_slice(&80i64.to_le_bytes());
            bytes[reason_offset..reason_offset + 4].copy_from_slice(&42u32.to_le_bytes());
            let decoded = parse_record(&bytes).unwrap();
            assert_eq!(decoded, JournalChange { file_id, parent_id, usn: 80, reason: 42, attributes });
        }
    }

    #[test]
    fn invalid_or_truncated_batches_never_produce_a_resume_checkpoint() {
        let checkpoint = window().checkpoint();
        let mut bytes = 1100i64.to_le_bytes().to_vec();
        let record = record_v2(1, 2, 1020, 0x80_0000);
        bytes.extend(record);
        assert!(parse_batch(&checkpoint, &bytes[..bytes.len() - 1]).is_err());
        bytes[12..14].copy_from_slice(&5u16.to_le_bytes());
        assert!(parse_batch(&checkpoint, &bytes).is_err());
        bytes[12..14].copy_from_slice(&2u16.to_le_bytes());
        bytes[0..8].copy_from_slice(&1020i64.to_le_bytes());
        assert!(parse_batch(&checkpoint, &bytes).is_err());
        bytes[0..8].copy_from_slice(&999i64.to_le_bytes());
        assert!(parse_batch(&checkpoint, &bytes).is_err());
    }

    #[test]
    fn reconciles_both_file_move_parents_and_rejects_ambiguous_events() {
        let event = |parent_id, reason, attributes| JournalChange {
            file_id: 7,
            parent_id,
            usn: 1000,
            reason,
            attributes,
        };
        let renamed = [
            event(100, RENAME_OLD_NAME, Some(0)),
            event(101, RENAME_NEW_NAME, Some(0)),
            event(101, FILE_DELETE, Some(0)),
        ];
        assert_eq!(
            dirty_directories(&renamed, |_| true),
            Ok(BTreeSet::from([100, 101]))
        );
        assert_eq!(
            dirty_directories(&renamed, |id| id == 100),
            Err(RequiredScan::UnknownParent(101))
        );
        for (event, fallback) in [
            (event(100, HARD_LINK_CHANGE, Some(0)), RequiredScan::HardLink(7)),
            (event(100, RENAME_NEW_NAME, Some(DIRECTORY_ATTRIBUTE)), RequiredScan::DirectoryMove(7)),
            (event(100, FILE_DELETE, Some(DIRECTORY_ATTRIBUTE)), RequiredScan::DirectoryTreeChanged(7)),
            (event(100, REPARSE_POINT_CHANGE, Some(0)), RequiredScan::ReparsePoint(7)),
            (event(100, FILE_CREATE, Some(REPARSE_POINT_ATTRIBUTE)), RequiredScan::ReparsePoint(7)),
            (event(100, FILE_CREATE, None), RequiredScan::UnknownChange(7)),
            (event(100, 0x2000_0000, Some(0)), RequiredScan::UnknownChange(7)),
        ] {
            assert_eq!(dirty_directories([&event], |_| true), Err(fallback));
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "set CSHIFT_TEST_USN_ROOT to read an existing NTFS journal without elevation"]
    fn reads_live_ntfs_journal_without_mutating_it() {
        let root = std::env::var("CSHIFT_TEST_USN_ROOT").expect("set CSHIFT_TEST_USN_ROOT");
        let journal = UsnJournal::open(&root).expect("open NTFS root");
        let window = journal.window().expect("read NTFS journal window");
        assert_ne!(journal.root_file_id().expect("read root directory ID"), 0);
        assert!(window.volume.guid_path.starts_with(r"\\?\volume{"));
        assert!(window.next_usn > window.first_readable_usn(), "test volume needs existing journal records");
        let checkpoint = JournalCheckpoint { next_usn: window.first_readable_usn(), ..window.checkpoint() };
        let batch = journal.read_batch(&checkpoint).expect("read first batch");
        assert!(!batch.records.is_empty());
        assert!(batch.resume.next_usn > checkpoint.next_usn);
        assert!(batch.records.iter().any(|record| record.parent_id != 0));
        eprintln!("unprivileged NTFS journal read returned {} records", batch.records.len());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "creates an isolated fixture under the project's .task-tmp on an NTFS drive"]
    fn reconciles_real_create_rename_and_delete_by_known_parent_id() -> io::Result<()> {
        use std::fs::{self, OpenOptions};
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use std::path::{Path, PathBuf};
        use std::thread;
        use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };

        struct Fixture { path: PathBuf, parent: PathBuf }
        impl Drop for Fixture {
            fn drop(&mut self) {
                if self.path.canonicalize().ok().as_ref() == Some(&self.path)
                    && self.path.parent() == Some(self.parent.as_path())
                {
                    if let Err(error) = fs::remove_dir_all(&self.path) {
                        eprintln!("could not remove isolated USN fixture: {error}");
                    }
                }
            }
        }

        fn file_id(path: &Path) -> io::Result<u128> {
            let file = OpenOptions::new()
                .access_mode(0)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)?;
            let info = windows::file_id_info(file.as_raw_handle() as _)?;
            Ok(u128::from_le_bytes(info.FileId.Identifier))
        }

        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").canonicalize()?;
        let parent = workspace.join(".task-tmp");
        fs::create_dir_all(&parent)?;
        if parent.canonicalize()? != parent {
            return Err(invalid_data("USN fixture parent is not local to the workspace"));
        }
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let path = parent.join(format!("usn-journal-{}-{unique}", std::process::id()));
        fs::create_dir(&path)?;
        let fixture = Fixture { path, parent };
        let left = fixture.path.join("left");
        let right = fixture.path.join("right");
        fs::create_dir(&left)?;
        fs::create_dir(&right)?;
        let left_id = file_id(&left)?;
        let right_id = file_id(&right)?;
        assert_ne!(left_id, right_id);

        let prefix = workspace.to_str().ok_or_else(|| invalid_data("invalid fixture volume path"))?;
        let drive = prefix.strip_prefix(r"\\?\").unwrap_or(prefix);
        let journal = UsnJournal::open(drive.get(..3).ok_or_else(|| invalid_data("invalid fixture volume"))?)?;
        let mut checkpoint = journal.window()?.checkpoint();
        let name = "移动-😀.txt";
        let initial = left.join(name);
        let moved = right.join(name);

        let list = |id, path: &Path| -> io::Result<Vec<DirectoryEntry>> {
            let mut files = Vec::new();
            journal.visit_directory(id, path, |value| {
                files.push(value);
                Ok(())
            })?;
            Ok(files)
        };
        fs::write(&initial, b"isolated fixture")?;
        let created = list(left_id, &left)?;
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].name, name);
        assert_eq!(created[0].size, 16);
        let moved_id = created[0].file_id;
        fs::rename(&initial, &moved)?;
        assert!(list(left_id, &left)?.is_empty());
        assert_eq!(list(right_id, &right)?, created);
        fs::remove_file(&moved)?;
        assert!(list(right_id, &right)?.is_empty());

        let mut file_changes = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let batch = journal.read_batch(&checkpoint)?;
            checkpoint = batch.resume;
            file_changes.extend(batch.records.into_iter().filter(|change| change.file_id == moved_id));
            if [FILE_CREATE, FILE_DELETE, RENAME_OLD_NAME, RENAME_NEW_NAME]
                .iter()
                .all(|flag| file_changes.iter().any(|change| change.reason & flag != 0))
                || Instant::now() >= deadline
            {
                break;
            }
            thread::sleep(Duration::from_millis(15));
        }
        assert!(file_changes.iter().any(|change| change.parent_id == left_id && change.reason & FILE_CREATE != 0));
        assert!(file_changes.iter().any(|change| change.parent_id == left_id && change.reason & RENAME_OLD_NAME != 0));
        assert!(file_changes.iter().any(|change| change.parent_id == right_id && change.reason & RENAME_NEW_NAME != 0));
        assert!(file_changes.iter().any(|change| change.parent_id == right_id && change.reason & FILE_DELETE != 0));
        assert_eq!(
            dirty_directories(&file_changes, |id| id == left_id || id == right_id),
            Ok(BTreeSet::from([left_id, right_id]))
        );

        let renamed_parent = fixture.path.join("moved-parent");
        fs::rename(&right, &renamed_parent)?;
        assert!(list(right_id, &right).is_err());
        assert!(list(right_id, &renamed_parent)?.is_empty());
        Ok(())
    }
}
