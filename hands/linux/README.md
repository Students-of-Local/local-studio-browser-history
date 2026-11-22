# tychicus-hands for Linux

Tychicus's computer-use helper for Linux: `tychicus-hands mcp [--connector]`. It speaks the hands protocol
(`docs/hands-protocol.md`) over stdio, reads and acts on windows through AT-SPI, and never sends physical input: no
synthetic keys, no pointer moves, no typing into the window the person is using. What it can't do in the background it
refuses with a protocol code.

One static binary per architecture (musl, about 2 MB, no shared libraries):

```sh
cargo build --release --target x86_64-unknown-linux-musl
cargo build --release --target aarch64-unknown-linux-musl   # links with rustup's rust-lld (.cargo/config.toml)
install -m 755 target/x86_64-unknown-linux-musl/release/tychicus-hands ~/.local/bin/
```

Tychicus finds it on `PATH` or in `~/.local/bin` (`findHelper` in `cli/src/computer.ts`); `TYCHICUS_HANDS_BIN` names
one outright.

## Desktops

| Desktop | Windows from | Agent workspace | `open` | `shot` |
| --- | --- | --- | --- | --- |
| Hyprland | `hyprctl` socket | `special:tychicus` | `exec [workspace special:tychicus silent]` | grim, when the window is on screen |
| Sway | sway IPC | `tychicus-agent` (a named workspace) | started stopped, then `for_window [pid=N]` and `no_focus [pid=N]`, then let go | grim, when the window is on screen |
| X11 (EWMH window manager) | `_NET_CLIENT_LIST` | none: an agent's window is the one an agent started | started, focus watched 1.2 s and given back | X11 GetImage, clipped to the screen |
| GNOME, KDE (Wayland) | AT-SPI frames only | none | started where the compositor puts it | not supported |

GNOME and KDE on Wayland give another program no window list, no way to place a window off screen or keep it from
focus, and no window pictures. There the helper reads and acts through AT-SPI only, an app it starts opens wherever the
compositor puts it (often in front of the person), and `shot` and `close` answer `not_supported`. `windows` says which
case it is in (`desktop: "atspi-only (GNOME)"`).

## Who may use what

The person's access mode and app list live in `hands.json` in Tychicus's config folder (`TYCHICUS_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/tychicus`, else `~/.config/tychicus`), read on every call so a change applies at once:

```json
{ "access": "default", "apps": ["gnome-text-editor", "/home/me/bin/tool"] }
```

- `access`: `read_only`, `default` (the default, and what any other value reads as) or `full`. A connector
  (`--connector`) never gets more than `default`.
- Under `default`, an agent may use windows on the agent workspace and windows of processes an agent started, and may
  start editors, calculators and viewers (`DEFAULT_APPS` in `src/engine.rs`) plus the apps in `apps`. The person's own
  windows are `outside_agent_workspace`.
- Under `full`, every window is open to an agent on this computer, and any app may be started.
- Browsers, mail, password managers and chat apps are never started for an agent, in any mode (`needs_sandbox`):
  they hold the person's own data and sessions.
- `lend` and `return` answer `needs_lend`: Linux has no lend sheet yet.

An action on an app the person is using (its window has focus) waits up to `wait` seconds, then answers `in_use`.

## What the background can't do on Linux

- `drag`: Wayland gives no pointer input to a window in the background, and on X11 it would move the person's pointer.
- Right clicks: context menus aren't offered through accessibility.
- `press` of a key with no accessibility meaning (F5, Tab, arrows): Linux has no way to send a key to a background
  window without typing into the person's. Return, Enter, space, ctrl+a, BackSpace, Delete, Home, End and single
  characters work, as accessibility actions or text edits.
- `shot` of a window that isn't on screen on Hyprland or Sway (grim captures outputs), and anything on GNOME or KDE.
- GTK 3 menus: activating a menu bar item through accessibility posts its menus for a moment. `menu` waits until they
  close (`menus_closed` in its answer) before it returns.

## Tests

`test/headless-session.sh x11|sway -- <command>` runs a command in a private desktop: its own runtime folder, session
bus, accessibility bus and display (Xvfb with openbox, or sway on the headless wlroots backend), with a stand-in for the
person's window holding focus. Nothing reaches the desktop the person is using. `HANDS_SESSION_LOGS=<dir>` keeps the
display server's, window manager's and registry's logs.

```sh
cargo test
# Every verb on the GTK fixture (test/fixture.py), and end to end through `tychicus mcp` (build cli/ first):
test/headless-session.sh x11 -- env TYCHICUS_HANDS_LIVE_BIN=$PWD/target/x86_64-unknown-linux-musl/release/tychicus-hands \
  node --test ../../cli/test/hands-linux-live.test.mjs
# The protocol suite against the binary, at the mode hands.json in TYCHICUS_CONFIG_DIR sets:
test/headless-session.sh x11 -- sh -c 'cd ../../cli && TYCHICUS_HANDS_CONFORMANCE_BIN=... node --test test/hands-conformance.test.mjs'
```

The session needs Xvfb, openbox and xdotool (or sway and grim), at-spi2-core, dbus, gdbus, and PyGObject with GTK 3.
CI installs them with apt and runs both desktops (`.github/workflows/hands-linux.yml`).
