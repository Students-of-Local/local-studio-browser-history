# Moving agents from Polycarp

Before Tychicus, the browser tools came from Polycarp's browser helper, so your agents may have an MCP entry, usually named `polycarp`, that runs `polycarp browser mcp`, `polycarp-browser mcp`, `tabkyra mcp` or Polycarp's old browser launcher (`~/.config/polycarp/browser/polycarp mcp`). Once Polycarp drops its browser, those agents lose their browser tools. `tychicus setup` moves them.

## See what would change

```bash
tychicus setup --dry-run
```

For each agent config that runs Polycarp's browser server, this prints the file, the entries it would move, and the exact lines before and after, as `diff -u` shows them. It writes nothing. `tychicus doctor` lists the same agents with a warning.

## Move them

```bash
tychicus setup --agents        # asks first; add --yes to skip the question
```

`tychicus setup` does the same move in its "Connect your coding agents" step. For each entry it finds, it:

- adds a `tychicus` entry that runs Tychicus's launcher (`~/.config/tychicus/tychicus mcp`), unless one is already there;
- points the old entry at that same command, and keeps its old name, so rules and prompts that say "the polycarp MCP server" keep working.

Before writing a file it saves a copy beside it, named `<file>.tychicus-backup-<time>`, with the same permissions. Only the entries that move change, and the rest of the file stays byte for byte. A file that doesn't parse (OpenCode's JSON with comments, for example) is refused and left alone, with the reason printed. Running it again finds nothing to move and writes nothing.

| Agent | File (user scope) |
| --- | --- |
| Claude Code | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set), top-level `mcpServers` |
| Codex | `~/.codex/config.toml` (`$CODEX_HOME` when set), `[mcp_servers.<name>]` and its subtables |
| OpenCode | `~/.config/opencode/opencode.json`, `mcp` |
| Cursor | `~/.cursor/mcp.json`, `mcpServers` |
| OMP | `~/.omp/agent/mcp.json`, `mcpServers` |

What it leaves alone:
- any entry that runs something else, including the Polycarp app's own `polycarp mcp`
- an entry with extra arguments after `mcp` (it names it so you can move it by hand)
- Claude Code project and local scopes
- Polycarp's own folders and launchers, which it never reads or writes

Restart an agent that was running for it to pick up the change. If a running Claude Code wrote `~/.claude.json` over the move, run `tychicus setup --agents` again.

## The old names are temporary

The entries that kept their old names are listed in `~/.config/tychicus/agent-aliases.json`, and `tychicus doctor` shows them. They are aliases while fleet rules and prompts still say `polycarp`. Once nothing names them, delete those entries from each agent's config; the `tychicus` entry beside each one stays. An agent then reaches the same tools as `tychicus` (tool names such as `mcp__tychicus__navigate` in Claude Code).
