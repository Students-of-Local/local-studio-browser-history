//! `tychicus-hands hold <sway-socket> <argv...>`: how an agent's app starts on a Sway without sandbox criteria (before
//! 1.10). There the only rule that can name one app is `[pid=N]`, and Sway keeps rules for its whole session. So this
//! process starts the app stopped, adds the rules for its pid, lets it run, prints the pid, and then never reaps it:
//! when the app exits it stays a zombie, and Linux gives no other process its pid while it does. This process exits
//! when Sway does, which is also when the rules end. Only then is the pid free.

use crate::desktop;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

pub fn run(args: &[String]) -> i32 {
    let (Some(sock), Some(_)) = (args.first(), args.get(1)) else {
        eprintln!("usage: tychicus-hands hold <sway-socket> <program> [args...]");
        return 2;
    };
    let sock = Path::new(sock);
    // An ignored SIGCHLD, inherited across exec, would have the kernel reap the app at once.
    unsafe { libc::signal(libc::SIGCHLD, libc::SIG_DFL) };
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.args(["-c", "kill -STOP $$; exec \"$@\"", "sh"])
        .args(&args[1..])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            println!("error can't start {}: {e}", args[1]);
            return 1;
        }
    };
    let pid = child.id();
    // Dropping a Child never waits for it: the zombie, and with it the pid, stays held.
    drop(child);
    let deadline = Instant::now() + Duration::from_secs(2);
    while !stopped(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let claimed = if stopped(pid) {
        desktop::sway_claim_pid(sock, pid)
    } else {
        Err("the app didn't reach its start in 2 s".into())
    };
    if let Err(e) = claimed {
        // Its windows would land on the person's workspace: it never runs.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
            libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
        }
        println!("error {e}");
        return 1;
    }
    unsafe { libc::kill(pid as i32, libc::SIGCONT) };
    println!("{pid}");
    let _ = std::io::stdout().flush();
    // Nothing more goes to the helper: point standard output at /dev/null so its pipe closes.
    if let Ok(null) = std::fs::OpenOptions::new().write(true).open("/dev/null") {
        use std::os::fd::AsRawFd;
        unsafe { libc::dup2(null.as_raw_fd(), 1) };
    }
    while desktop::sway_alive(sock) {
        std::thread::sleep(Duration::from_secs(5));
    }
    0
}

/// True when `pid` is stopped (state T in /proc/<pid>/stat).
fn stopped(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|t| {
            t.rsplit(')')
                .next()
                .map(|r| r.trim_start().starts_with('T'))
        })
        .unwrap_or(false)
}
