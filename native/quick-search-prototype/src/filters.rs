use std::mem::zeroed;
use std::ptr::null;

use windows_sys::Win32::{
    Foundation::{FILETIME, SYSTEMTIME},
    System::Time::{SystemTimeToFileTime, TzSpecificLocalTimeToSystemTimeEx},
};

pub fn keywords<'a>(additional: &'a str, query: &'a str) -> Result<Vec<&'a str>, String> {
    let mut keywords = Vec::new();
    for term in additional.lines().chain([query]).map(str::trim).filter(|term| !term.is_empty()) {
        if !keywords.contains(&term) {
            keywords.push(term);
        }
        if keywords.len() > 32 {
            return Err("最多可输入 32 个关键词".into());
        }
    }
    Ok(keywords)
}

pub fn extensions(text: &str) -> Vec<String> {
    let mut extensions = Vec::new();
    for value in text.split(|ch: char| matches!(ch, ',' | ';' | '|') || ch.is_whitespace()) {
        let value = value.strip_prefix("*.").unwrap_or(value);
        let value = value.strip_prefix('.').unwrap_or(value);
        if !(1..=24).contains(&value.len())
            || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'-'))
        {
            continue;
        }
        let value = value.to_ascii_lowercase();
        if !extensions.contains(&value) {
            extensions.push(value);
        }
        if extensions.len() == 64 { break; }
    }
    extensions
}

pub fn bytes(text: &str) -> Result<Option<u64>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    text.parse().map(Some).map_err(|_| "大小应为非负的整数，单位为字节".into())
}

pub fn modified(text: &str, end_of_day: bool) -> Result<Option<u64>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let invalid = || "日期应为有效的本地日期（YYYY-MM-DD）".to_string();
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
        || !bytes.iter().enumerate().all(|(position, digit)| matches!(position, 4 | 7) || digit.is_ascii_digit())
    {
        return Err(invalid());
    }

    // Electron date picks use midnight and 23:59:59 in the user's timezone.
    let local = SYSTEMTIME {
        wYear: text[..4].parse().map_err(|_| invalid())?,
        wMonth: text[5..7].parse().map_err(|_| invalid())?,
        wDay: text[8..].parse().map_err(|_| invalid())?,
        wHour: if end_of_day { 23 } else { 0 },
        wMinute: if end_of_day { 59 } else { 0 },
        wSecond: if end_of_day { 59 } else { 0 },
        wDayOfWeek: 0,
        wMilliseconds: 0,
    };
    let mut utc: SYSTEMTIME = unsafe { zeroed() };
    let mut time: FILETIME = unsafe { zeroed() };
    unsafe {
        if SystemTimeToFileTime(&local, &mut time) == 0
            || TzSpecificLocalTimeToSystemTimeEx(null(), &local, &mut utc) == 0
            || SystemTimeToFileTime(&utc, &mut time) == 0
        {
            return Err(invalid());
        }
    }
    const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;
    let ticks = (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    ticks.checked_sub(UNIX_EPOCH_TICKS).map(|ticks| Some(ticks / 10_000))
        .ok_or_else(|| "索引时间范围不支持 1970 年以前的日期".into())
}

pub fn range(start: Option<u64>, end: Option<u64>, label: &str) -> Result<(), String> {
    if matches!((start, end), (Some(start), Some(end)) if start > end) {
        return Err(format!("{label}范围的起点不能晚于终点"));
    }
    Ok(())
}
