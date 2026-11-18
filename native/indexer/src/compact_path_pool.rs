use std::collections::HashMap;
use std::io::{self, Seek, SeekFrom, Write};

const MAGIC: &[u8; 8] = b"CSPTH01\0";
const HEADER_LEN: usize = 24;
const ROW_LEN: usize = 8;

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn pool_offset(value: usize) -> io::Result<u32> {
    u32::try_from(value).map_err(|_| invalid("compact path pool exceeds 32-bit limits"))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    Some(u32::from_le_bytes(bytes.get(offset..end)?.try_into().ok()?))
}

fn is_separator(byte: u8) -> bool {
    byte == b'\\' || byte == b'/'
}

fn name_end(path: &[u8]) -> usize {
    path.iter()
        .rposition(|&byte| !is_separator(byte))
        .map_or(0, |index| index + 1)
}

fn split_path(path: &[u8]) -> (&[u8], &[u8]) {
    // Keep the exact delimiters, including trailing separators. Searching for
    // the filename may ignore the latter, but a reconstructed path cannot.
    let parent_end = path[..name_end(path)]
        .iter()
        .rposition(|&byte| is_separator(byte))
        .map_or(0, |index| index + 1);
    path.split_at(parent_end)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct PathPoolStats {
    pub(super) paths: usize,
    pub(super) distinct_prefixes: usize,
    pub(super) prefix_bytes: usize,
    pub(super) suffix_bytes: usize,
}

/// Build a compact little-endian image from one immutable path snapshot.
/// Clones of the iterator must visit the same borrowed paths in the same order.
///
/// The header records the two counts and payload lengths. It is followed by
/// [prefix ID, suffix offset] pairs and a sentinel pair, prefix offsets and a
/// sentinel offset, then the prefix and suffix bytes. File metadata stays in
/// the index tables. The mapping can use a separate image per volume when a
/// pool would exceed the 32-bit payload limit.
pub(super) fn encode_paths<'a, I>(
    paths: I,
    writer: &mut (impl Write + Seek),
) -> io::Result<PathPoolStats>
where
    I: Iterator<Item = io::Result<&'a [u8]>> + Clone,
{
    let header_offset = writer.stream_position()?;
    writer.write_all(&[0; HEADER_LEN])?;
    let mut count = 0usize;
    let mut prefixes = Vec::new();
    let mut prefix_ids = HashMap::new();
    let mut prefix_bytes = 0usize;
    let mut suffix_bytes = 0usize;
    for path in paths.clone() {
        let (prefix, suffix) = split_path(path?);
        let prefix_id = if let Some(&id) = prefix_ids.get(prefix) {
            id
        } else {
            let id = pool_offset(prefixes.len())?;
            prefixes.push((prefix, pool_offset(prefix_bytes)?));
            prefix_ids.insert(prefix, id);
            prefix_bytes = prefix_bytes
                .checked_add(prefix.len())
                .ok_or_else(|| invalid("bad prefix pool size"))?;
            id
        };
        writer.write_all(&prefix_id.to_le_bytes())?;
        writer.write_all(&pool_offset(suffix_bytes)?.to_le_bytes())?;
        count += 1;
        suffix_bytes = suffix_bytes
            .checked_add(suffix.len())
            .ok_or_else(|| invalid("bad suffix pool size"))?;
    }
    drop(prefix_ids);

    writer.write_all(&u32::MAX.to_le_bytes())?;
    writer.write_all(&pool_offset(suffix_bytes)?.to_le_bytes())?;
    for &(_, start) in &prefixes {
        writer.write_all(&start.to_le_bytes())?;
    }
    writer.write_all(&pool_offset(prefix_bytes)?.to_le_bytes())?;
    for &(prefix, _) in &prefixes {
        writer.write_all(prefix)?;
    }
    let mut emitted_count = 0usize;
    let mut emitted_bytes = 0usize;
    for path in paths {
        let (_, suffix) = split_path(path?);
        emitted_count += 1;
        emitted_bytes += suffix.len();
        writer.write_all(suffix)?;
    }
    if count != emitted_count || suffix_bytes != emitted_bytes {
        return Err(invalid("path snapshot length changed"));
    }
    let end = writer.stream_position()?;
    writer.seek(SeekFrom::Start(header_offset))?;
    writer.write_all(MAGIC)?;
    for value in [count, prefixes.len(), prefix_bytes, suffix_bytes] {
        writer.write_all(&pool_offset(value)?.to_le_bytes())?;
    }
    writer.seek(SeekFrom::Start(end))?;
    Ok(PathPoolStats {
        paths: count,
        distinct_prefixes: prefixes.len(),
        prefix_bytes,
        suffix_bytes,
    })
}

/// Borrow the index and string pools directly from a read-only file mapping.
/// Individual ranges are bounds checked on access so the header can be opened
/// without touching every page after a restart.
pub(super) struct CompactPathPool<'a> {
    count: usize,
    rows: &'a [u8],
    prefix_offsets: &'a [u8],
    prefixes: &'a [u8],
    suffixes: &'a [u8],
}

fn table_len(count: usize, width: usize) -> io::Result<usize> {
    count
        .checked_add(1)
        .and_then(|length| length.checked_mul(width))
        .ok_or_else(|| invalid("compact path table is too large"))
}

fn take<'a>(image: &mut &'a [u8], amount: usize) -> io::Result<&'a [u8]> {
    let bytes = image
        .get(..amount)
        .ok_or_else(|| invalid("truncated compact path table"))?;
    *image = &image[amount..];
    Ok(bytes)
}

impl<'a> CompactPathPool<'a> {
    pub(super) fn open(mut image: &'a [u8]) -> io::Result<Self> {
        let header = take(&mut image, HEADER_LEN)?;
        if header.get(..MAGIC.len()) != Some(MAGIC) {
            return Err(invalid("bad compact path table magic"));
        }
        let header_u32 = |offset| read_u32(header, offset).unwrap() as usize;
        let count = header_u32(8);
        let prefix_count = header_u32(12);
        let rows = take(&mut image, table_len(count, ROW_LEN)?)?;
        let prefix_offsets = take(&mut image, table_len(prefix_count, 4)?)?;
        let prefixes = take(&mut image, header_u32(16))?;
        let suffixes = take(&mut image, header_u32(20))?;
        if !image.is_empty()
            || (count > 0 && prefix_count == 0)
            || prefix_count > count
            || read_u32(prefix_offsets, 0) != Some(0)
            || read_u32(prefix_offsets, prefix_offsets.len() - 4) != Some(prefixes.len() as u32)
            || read_u32(rows, 4) != Some(0)
            || read_u32(rows, rows.len() - ROW_LEN) != Some(u32::MAX)
            || read_u32(rows, rows.len() - 4) != Some(suffixes.len() as u32)
        {
            return Err(invalid("inconsistent compact path table"));
        }
        Ok(Self { count, rows, prefix_offsets, prefixes, suffixes })
    }

    pub(super) fn len(&self) -> usize {
        self.count
    }

    pub(super) fn prefix_id(&self, index: usize) -> Option<u32> {
        if index >= self.count {
            return None;
        }
        read_u32(self.rows, index * ROW_LEN)
    }

    pub(super) fn prefix(&self, id: u32) -> Option<&'a [u8]> {
        let offset = (id as usize).checked_mul(4)?;
        let start = read_u32(self.prefix_offsets, offset)? as usize;
        let end = read_u32(self.prefix_offsets, offset.checked_add(4)?)? as usize;
        self.prefixes.get(start..end)
    }

    pub(super) fn suffix(&self, index: usize) -> Option<&'a [u8]> {
        if index >= self.count {
            return None;
        }
        let offset = index * ROW_LEN + 4;
        let start = read_u32(self.rows, offset)? as usize;
        let end = read_u32(self.rows, offset + ROW_LEN)? as usize;
        self.suffixes.get(start..end)
    }

    pub(super) fn name(&self, index: usize) -> Option<&'a [u8]> {
        let suffix = self.suffix(index)?;
        Some(&suffix[..name_end(suffix)])
    }

    pub(super) fn parts(&self, index: usize) -> Option<(&'a [u8], &'a [u8])> {
        Some((self.prefix(self.prefix_id(index)?)?, self.suffix(index)?))
    }

    /// Decode with storage reused across queries. An empty component can be
    /// returned directly from the mapping.
    pub(super) fn decode<'scratch>(
        &self,
        index: usize,
        scratch: &'scratch mut Vec<u8>,
    ) -> Option<&'scratch [u8]>
    where
        'a: 'scratch,
    {
        let (prefix, suffix) = self.parts(index)?;
        if prefix.is_empty() {
            return Some(suffix);
        }
        if suffix.is_empty() {
            return Some(prefix);
        }
        scratch.clear();
        scratch.extend_from_slice(prefix);
        scratch.extend_from_slice(suffix);
        Some(scratch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(paths: &[&[u8]]) -> Vec<u8> {
        let mut bytes = io::Cursor::new(Vec::new());
        encode_paths(paths.iter().copied().map(Ok), &mut bytes).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn preserves_verbatim_paths_exact_names_and_input_order() {
        let big_path = format!("C:\\nested\\{}\\File", "x".repeat(70_000));
        let paths: &[&[u8]] = &[
            "C:\\Users\\文件.txt".as_bytes(),
            b"C:\\Users\\Second.TXT",
            b"C:/Users/Second.TXT",
            b"C:\\Users\\A\\",
            b"\\\\server/share/file\\/",
            b"C:\\",
            b"//",
            b"relative.bin",
            b"",
            b"C:\\raw-\xff",
            big_path.as_bytes(),
            "C:\\Users\\文件.txt".as_bytes(),
        ];
        let bytes = image(paths);
        let pool = CompactPathPool::open(&bytes).unwrap();
        assert_eq!(pool.len(), paths.len());
        let mut scratch = Vec::new();
        for (index, path) in paths.iter().enumerate().rev() {
            assert_eq!(pool.decode(index, &mut scratch), Some(*path));
        }
        assert_eq!(pool.prefix_id(0), pool.prefix_id(1));
        assert_ne!(pool.prefix_id(1), pool.prefix_id(2));
        assert_eq!(pool.name(3), Some(b"A".as_slice()));
        assert_eq!(pool.name(4), Some(b"file".as_slice()));
        assert_eq!(pool.name(5), Some(b"C:".as_slice()));
        assert_eq!(pool.name(6), Some(b"".as_slice()));
        assert!(pool.decode(usize::MAX, &mut scratch).is_none());
    }

    #[test]
    fn empty_and_truncated_images_are_handled() {
        let empty = image(&[]);
        assert_eq!(CompactPathPool::open(&empty).unwrap().len(), 0);
        let example = image(&[b"x/y", b"x/z"]);
        for length in 0..example.len() {
            assert!(CompactPathPool::open(&example[..length]).is_err());
        }
    }

    #[test]
    fn corrupt_records_cannot_escape_their_pools() {
        let mut bytes = image(&[b"x/a", b"x/b"]);
        bytes[HEADER_LEN..HEADER_LEN + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        bytes[HEADER_LEN + ROW_LEN + 4..HEADER_LEN + ROW_LEN + 8]
            .copy_from_slice(&u32::MAX.to_le_bytes());
        let pool = CompactPathPool::open(&bytes).unwrap();
        assert!(pool.parts(0).is_none());
        assert!(pool.parts(1).is_none());
    }
}
