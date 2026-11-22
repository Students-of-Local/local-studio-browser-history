//! What agents may do here: the person's access mode, read from Tychicus's config folder on every call so a narrowing
//! applies at once, and the connector cap over it. Also the folders the helper uses and the record of processes agents
//! started, which is what makes a window an agent's when there is no agent workspace to put it on.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    ReadOnly,
    Default,
    Full,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::ReadOnly => "read_only",
            Mode::Default => "default",
            Mode::Full => "full",
        }
    }
    /// A saved value that isn't one of the modes reads as Default, never as more access.
    pub fn parse(s: Option<&str>) -> Mode {
        match s {
            Some("read_only") => Mode::ReadOnly,
            Some("full") => Mode::Full,
            _ => Mode::Default,
        }
    }
    /// What a caller on another machine gets: never more than Default.
    pub fn for_remote(self) -> Mode {
        if self == Mode::Full {
            Mode::Default
        } else {
            self
        }
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

pub fn home() -> PathBuf {
    env("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// The same folder `configDir()` in cli/src/files.ts picks: the override, else $XDG_CONFIG_HOME or ~/.config, then tychicus.
pub fn config_dir() -> PathBuf {
    if let Some(d) = env("TYCHICUS_CONFIG_DIR")
        .or_else(|| env("POLYCARP_BROWSER_CONFIG_DIR"))
        .or_else(|| env("TABKYRA_CONFIG_DIR"))
    {
        return PathBuf::from(d);
    }
    env("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"))
        .join("tychicus")
}

pub fn data_dir() -> PathBuf {
    env("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local").join("share"))
        .join("tychicus")
}

pub fn state_dir() -> PathBuf {
    env("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local").join("state"))
        .join("tychicus")
}

pub fn cache_dir() -> PathBuf {
    env("TYCHICUS_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home().join(".cache"))
                .join("tychicus")
        })
}

pub fn handoff_dir() -> PathBuf {
    data_dir().join("handoff")
}

pub fn shots_dir() -> PathBuf {
    cache_dir().join("shots")
}

/// `hands.json` in the config folder: `{"access": "read_only" | "default" | "full", "apps": ["gedit", "/opt/x/bin/y"]}`.
/// A file that is missing or can't be read means Default and no extra apps.
#[derive(Clone, Debug)]
pub struct Settings {
    pub mode: Mode,
    pub apps: Vec<String>,
}

pub fn settings() -> Settings {
    let path = config_dir().join("hands.json");
    let parsed: Option<Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let mode = Mode::parse(
        parsed
            .as_ref()
            .and_then(|v| v.get("access"))
            .and_then(Value::as_str),
    );
    let apps = parsed
        .as_ref()
        .and_then(|v| v.get("apps"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Settings { mode, apps }
}

/// The mode this session works under: the person's, capped at Default for a connector.
pub fn mode(connector: bool) -> Mode {
    let m = settings().mode;
    if connector {
        m.for_remote()
    } else {
        m
    }
}

/// A process's start time in clock ticks since boot (field 22 of /proc/<pid>/stat), so a reused pid isn't taken for
/// the one an agent started.
pub fn start_time(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = &stat[stat.rfind(')')? + 2..];
    after.split_whitespace().nth(19)?.parse().ok()
}

pub fn parent_of(pid: u32) -> Option<u32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = &stat[stat.rfind(')')? + 2..];
    after.split_whitespace().nth(1)?.parse().ok()
}

/// Processes agents started on this machine, kept in the state folder across helper runs, as `pid start_time` lines.
/// A window belongs to an agent when its process is one of these or a child of one.
pub struct AgentProcesses;

impl AgentProcesses {
    fn path() -> PathBuf {
        state_dir().join("hands-agent-processes")
    }

    pub fn load() -> Vec<(u32, u64)> {
        let text = fs::read_to_string(Self::path()).unwrap_or_default();
        text.lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
            })
            .filter(|(pid, start)| start_time(*pid) == Some(*start))
            .collect()
    }

    pub fn add(pid: u32) {
        let Some(start) = start_time(pid) else { return };
        let mut all = Self::load();
        all.push((pid, start));
        let _ = fs::create_dir_all(state_dir());
        let text: String = all.iter().map(|(p, s)| format!("{p} {s}\n")).collect();
        let _ = fs::write(Self::path(), text);
    }

    /// Whether `pid` is an agent's process or descends from one.
    pub fn owns(list: &[(u32, u64)], pid: u32) -> bool {
        let mut p = pid;
        for _ in 0..32 {
            if list.iter().any(|(q, _)| *q == p) {
                return true;
            }
            match parent_of(p) {
                Some(up) if up > 1 => p = up,
                _ => return false,
            }
        }
        false
    }
}
