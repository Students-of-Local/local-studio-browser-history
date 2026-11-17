# Moving agents from Polycarp

Before Tychicus, the browser tools came from Polycarp's browser helper, so your agents may have an MCP entry, usually named `polycarp`, that runs `polycarp browser mcp`, `polycarp-browser mcp`, `tabkyra mcp` or Polycarp's old browser launcher (`~/.config/polycarp/browser/polycarp mcp`). Once Polycarp drops its browser, those agents lose their browser tools. `tychicus setup` moves them in two steps: the move, then the finish.

## See what would change

```bash
tychicus setup --dry-run
```

For each agent config that runs Polycarp's browser server, this prints the file, the entries it would move, and the exact lines before and after, as `diff -u` shows them. It writes nothing. `tychicus doctor` lists the same agents with a warning.

## Step 1: move them

```bash
tychicus setup --agents        # asks first; add --yes to skip the question
```

`tychicus setup` does the same move in its "Connect your coding agents" step. Each entry it finds keeps its name, position and env, and only its command and arguments change: it now runs Tychicus's launcher (`~/.config/tychicus/tychicus mcp`). No second entry is added, so each agent still starts one server, and rules and prompts that say "the polycarp MCP server" keep working. Setup and doctor count that entry as the agent's Tychicus server.

If the file already has a `tychicus` entry beside the old one, the agent runs two Tychicus servers until the finish step, and the plan says so.

How each file is written:

- Before writing a file it saves a copy beside it, named `<file>.tychicus-backup-<time>`, with the same permissions.
- Only the moved entries change. The rest of the file, comments and indent included, stays byte for byte. The result is parsed before it is written, and a result that doesn't parse is refused.
- Just before the write, the file is read again. If an agent changed it while you were reading the plan (Claude Code writes `~/.claude.json` often), the move is made again on the new text and written only if it moves the same entries you said yes to. Otherwise that file is refused with "it changed while you were deciding" and nothing is written to it; run the command again.
- A symlinked config (dotfiles) is written through the link and stays a link.
- Running it again finds nothing to move and writes nothing.

| Agent | File (user scope) |
| --- | --- |
| Claude Code | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set), top-level `mcpServers` |
| Codex | `~/.codex/config.toml` (`$CODEX_HOME` when set), `[mcp_servers.<name>]` and its subtables |
| OpenCode | `~/.config/opencode/opencode.json`, `mcp` (read as JSONC: comments and trailing commas are fine) |
| Cursor | `~/.cursor/mcp.json`, `mcpServers` |
| OMP | `~/.omp/agent/mcp.json`, `mcpServers` (strict JSON: OMP itself skips a file with a trailing comma) |

Codex's file is read with a TOML parser ([smol-toml](https://github.com/squirrelchat/smol-toml)), so a `tychicus` server written as an inline table or with dotted keys is found. The edit itself is made in the table's text, so comments and layout stay.

A config that doesn't parse is left alone, with the reason printed. If its text names `polycarp` or `tabkyra`, setup counts that as a failure, since an entry may be stuck there; fix the file and run it again. If it names neither, there was nothing to move in it, so setup prints a warning and carries on.

What it leaves alone:
- any entry that runs something else, including the Polycarp app's own `polycarp mcp`
- an entry with extra arguments after `mcp` (it names it so you can move it by hand)
- a Codex entry written as an inline table or with dotted keys (named, to move by hand)
- Polycarp's own folders and launchers, which it never reads or writes

Claude Code's project scope (`projects.<folder>.mcpServers` in `~/.claude.json`, the `local` scope) is not edited. An entry there with the same name wins over the user entry in that folder, so the plan and `tychicus doctor` name each one that runs Polycarp's browser server, with the fix:

```bash
cd <folder> && claude mcp remove <name> -s local
```

Restart an agent that was running for it to pick up the change.

## Step 2: finish

The entries that kept their old names are aliases, listed in `~/.config/tychicus/agent-aliases.json`, and `tychicus doctor` names them with the finish step. If that list can't be written, setup says so and the config change stands: the finish and doctor also count any entry named `polycarp` or `tabkyra` (any case) that runs Tychicus's launcher as an alias. Once no fleet rule or prompt names them:

```bash
tychicus setup --agents --finish --dry-run   # see the renames
tychicus setup --agents --finish             # asks first; add --yes to skip the question
```

Each alias is renamed to `tychicus` in place, with the same command, env and position. When a `tychicus` entry is already there and matches the alias in every field (command, args, env, `enabled` and the rest, in any key order), the alias is removed instead. When they differ in any field, both are left for you to settle by hand, with the fields named, and the finish exits 1: removing the alias could drop the server the agent actually runs, such as an enabled alias beside a disabled `tychicus`, or its env. Neighboring aliases are removed in one edit. `--dry-run` writes nothing, the alias list included. Files are backed up and checked the same way as in step 1, each finished alias leaves `agent-aliases.json`, and running it again changes nothing. An agent then reaches the same tools as `tychicus` (tool names such as `mcp__tychicus__navigate` in Claude Code).
