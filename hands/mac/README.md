# tychicus-hands for macOS

Tychicus's computer-use helper: `tychicus-hands mcp [--connector]`, a stdio MCP server that speaks the hands protocol
(`docs/hands-protocol.md`). Tychicus's `computer_*` tools find it on PATH, in `~/.local/bin`, or through
`TYCHICUS_HANDS_BIN`.

The code came from Polycarp (baney75/polycarp, tag `pre-hands-removal`, commit e43ee1d6), carved with
`git filter-repo` so `git blame` still reaches Polycarp's history. What changed on the way:

- No Polycarp app behind it. The router runs in this process; `TychicusHost` gives it windows from Accessibility and
  the window server.
- The agent workspace is Polycarp's when Polycarp is running (its agent workspace API on
  `~/Library/Application Support/Polycarp/polycarp.sock`); without Polycarp, the windows of apps this helper started
  count as the agent's and nothing moves (`AgentWorkspace.swift`).
- No window-manager verbs (workspaces, query, events, arrange, move, switch, focus, frame). `close` stays. A connector
  still gets `permission_denied` for every managing verb.
- No consent sheets yet, so nothing widens access: the mode is Default, or Read Only with
  `defaults write tychicus-hands agentAccessMode read_only`. Lending answers `needs_lend` as before.

## Build

```sh
scripts/build-engine.sh          # agent-desktop's C library, pinned in engine/PIN (needs cargo); BANEYSPACES_ARM64_ONLY=1 for arm64 only
swift build -c release           # .build/release/tychicus-hands
```

The binary finds `libagent_desktop_ffi.dylib` next to itself, in `../Frameworks`, or in `engine/lib`.

## Check

```sh
cd ../../cli && TYCHICUS_HANDS_CONFORMANCE_BIN=$PWD/../hands/mac/.build/release/tychicus-hands node --test test/hands-conformance.test.mjs
```

It needs Accessibility for the app that starts it (Tychicus, or the terminal) to act on windows; without it every
window verb answers `permission_denied` and says so.
