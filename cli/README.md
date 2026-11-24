# tychicus (CLI)

Bridge between coding harnesses and the Tychicus browser extension. Any MCP client
(Claude Code, Codex, OpenCode, Cursor, OMP) and pi can drive a Chromium browser through it. Each harness
gets its own tab group and works in the background while you keep using your tabs.

```
harness ── stdio MCP ── tychicus mcp ── unix socket ── native host ── native messaging ── extension
```

Nothing listens on the network. The browser spawns the native host; the host owns a
socket in `/tmp/tychicus-bridge-<user>/` (0700 directory, 0600 socket) that only your
user can reach. The client refuses sockets and directories it does not own.

## Install

```bash
npm link                      # from this directory; puts tychicus on PATH
tychicus setup                 # build, register, load, connect and wire up your harnesses
```

`tychicus setup` builds `dist-chrome` if it is missing, registers the native host for every
Chromium browser it finds, shows the one manual step (Load unpacked), waits until the
extension connects, and offers to add the MCP server to each harness it detects. It edits
a harness config only after a yes; `--yes` accepts every offer, `--no-wait` skips the
wait, `--timeout=<s>` bounds it. `tychicus doctor` re-checks everything later and prints
one fix per problem (`--json` for scripts).

`tychicus mcp` runs the installer itself on first use, so a harness configured to start
it needs no extra step. Reload the extension once after the first install.

## Commands

| Command | Purpose |
| --- | --- |
| `tychicus setup [--yes] [--no-wait] [--timeout <s>]` | first-time setup, end to end |
| `tychicus status [--json]` | is the extension connected, which sites are allowed, which browsers have the host |
| `tychicus doctor [--json]` | check Node, the build, host manifests, the connection and harness configs; exits 1 on a failure |
| `tychicus mcp [--session <name>]` | stdio MCP server exposing the browser tools; without `--session` (or `TYCHICUS_SESSION`) the session is the project's (git root), so a restarted harness resumes its tabs |
| `tychicus sessions [list\|show\|rename\|end\|release\|focus\|collapse\|expand] [--json]` | agent sessions and their tab groups (see the main README, "Sessions and tab groups") |
| `tychicus tabs [session] [--json]` | every agent tab, by session |
| `tychicus allow <host>` | let agents open a site without a prompt (subdomains included) |
| `tychicus mode [manual\|auto\|yolo]` | show or set the permission mode; Auto is the default, and Yolo needs a person at a terminal ([docs/permissions.md](../docs/permissions.md)) |
| `tychicus ask` | same as `mode manual` |
| `tychicus allow-all` | same as `mode yolo` (`yolo` still works) |
| `tychicus install [--force]` | write the native host manifest (Helium, Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Opera; Linux and Windows too) and the launchers in `~/.config/tychicus/` |
| `tychicus reload` | reload the extension (after rebuilding `dist-chrome`) |
| `tychicus debug` | bridge state, recent request timings, Chrome API benchmark |
| `tychicus pi-extension` | write `~/.pi/agent/extensions/tychicus.ts` for pi; it removes a `polycarp.ts` or `tabkyra.ts` an older copy of this helper wrote, and names the Polycarp app's own `polycarp.ts` without touching it |
| `tychicus skill install [name...] [--all] [--force]` | install the bundled skills into Claude Code, Codex and OpenCode; a same-name skill Tychicus didn't write is left alone without `--force` |
| `tychicus skill list` | the bundled skills and what each is for |
| `tychicus skill print [name] [--raw]` | a skill as an AGENTS.md section (default `polycarp-browser`); `--raw` is the exact SKILL.md |
| `tychicus skill lint [path...]` | check skills for hidden text, injection, remote code, secret handling and structure ([rules](../docs/skill-security.md)) |
| `tychicus skill apply <folder> [--yes]` | lint and diff an edited skill; `--yes` backs up the current one and installs the edit |
| `tychicus skill revert <name>` | drop your edit and go back to the bundled skill |
| `tychicus library add <doi\|arxiv> [--quote] [--location] [--note] [--tag]` | save a source, verified against its registry, OpenAlex and Crossref retraction notices |
| `tychicus library list\|search\|verify\|cite\|export\|obsidian\|remove` | find, re-check, cite (apa, mla, chicago, ieee, harvard, vancouver), export (bibtex, ris, csl) or write Obsidian notes |
| `tychicus serve [--port 8787]` | MCP over Streamable HTTP at `/mcp`, loopback only; every request needs a token |
| `tychicus token create <name> --scope a,b` | a scoped, revocable token, shown once (`token list`, `token revoke <id\|name>`, `token scopes`) |
| `tychicus tunnel tailscale [--port N] [--public] [--off]` | reach `serve` over HTTPS through your tailnet (`--public` uses Funnel) |
| `tychicus tunnel cloudflare [--port N] [--off]` | reach `serve` through a cloudflared quick tunnel |
| `tychicus remote setup [--tailscale\|--cloudflare [name]\|--public-url https://host]` | connect claude.ai, ChatGPT and grok.com in one command, then prove it from outside ([docs/remote.md](../docs/remote.md)) |
| `tychicus remote status [--json]` | fast checks from this computer |
| `tychicus remote test [--json]` | what an assistant sees from outside: public DNS, TLS, OAuth metadata, the sign-in challenge and a streaming probe |
| `tychicus remote fix [--yes] [--dry-run] [--json]` | repair what test or status found, one step at a time, asking first |
| `tychicus update [--check] [--rollback] [--channel stable\|nightly]` | install the latest signed release ([docs/updates.md](../docs/updates.md)) |
| `tychicus completion zsh\|bash\|fish` | shell completions for commands, subcommands and flags |
| `tychicus version [--json]` | the CLI's version, which is the extension's (`static/manifest.chrome.json`) |

Output is colored only on a terminal; `NO_COLOR` turns it off. Read commands take `--json`
(`status`, `doctor`, `sessions`, `tabs`, `skill list`, `skill match`, `skill versions`, `library list`,
`library search`, `token list`, `token scopes`, `update --check`, `version`); `debug`
always prints JSON.

Exit codes, for every command: **0** success; **1** failed, not connected, or nothing found
(the message says the next step); **2** usage error (an unknown command, option or
argument). `update --check` exits 100 when an update exists; `library add` exits 3 for a
retracted source and 4 when the retraction check couldn't finish. `remote setup` and `remote fix` exit 3 when a
person has to act, and `remote test` exits 3 when nothing is set up.

### Shell completions

```bash
echo 'eval "$(tychicus completion zsh)"' >> ~/.zshrc     # zsh
echo 'eval "$(tychicus completion bash)"' >> ~/.bashrc   # bash
tychicus completion fish > ~/.config/fish/completions/tychicus.fish
```

The launcher `tychicus install` writes (`~/.config/tychicus/tychicus`, what harness configs run)
sets `NODE_COMPILE_CACHE` (Node 22.1+). The saving is small: on one Apple M-series machine
`tychicus mcp` started in 108 ms with it and 119 ms without (medians of 15 interleaved starts
each, `cli/eval/bridge-metrics.mjs --only launcher`), while the same harness on main, where
both arms are identical, differed by 9 ms. Treat it as at most about 10%.

## Harness setup

`tychicus setup` does this for you. By hand, point each harness at the launcher
`~/.config/tychicus/tychicus`, which `tychicus install` writes. It runs this CLI with an
absolute Node path, so harnesses started from a GUI don't need `node` on their PATH:

```bash
claude mcp add --scope user tychicus -- ~/.config/tychicus/tychicus mcp
codex mcp add tychicus -- ~/.config/tychicus/tychicus mcp
tychicus pi-extension
```

OpenCode (`~/.config/opencode/opencode.json`):

```json
{ "mcp": { "tychicus": { "type": "local", "command": ["/Users/you/.config/tychicus/tychicus", "mcp"], "enabled": true } } }
```

Cursor (`~/.cursor/mcp.json`) and OMP (`~/.omp/agent/mcp.json`):

```json
{ "mcpServers": { "tychicus": { "command": "/Users/you/.config/tychicus/tychicus", "args": ["mcp"] } } }
```

## Permissions

By default the extension asks before an agent opens a new site. MCP clients that support
elicitation (Claude Code, Codex) show the prompt inline; otherwise answer it in the
Tychicus side panel under Settings > Agents, run `tychicus allow <host>`, or switch the
mode to "allow any site" there. pi: set `TYCHICUS_AUTO_ALLOW=1` to auto-approve.

`TYCHICUS_SESSION=<name>` makes a harness re-adopt the same tab group across restarts.
`TYCHICUS_SOCKET_DIR` moves the socket directory (the end-to-end test runs a private bridge this way).
`TYCHICUS_CLIENT_NAME` overrides the tab group label.

## MCP tools

| Tool | Does |
| --- | --- |
| `status` | connection, permission mode, allowed sites, your tab group and its tabs; never fails |
| `tabs_context`, `tabs_create`, `tabs_close`, `tabs_select` | your own background tabs |
| `tabs_show` | bring a tab in front of the user (the only tool that changes what they see) |
| `navigate` | open a URL, or go back/forward |
| `read_page`, `find`, `get_page_text`, `get_page_html`, `screenshot` | read the page |
| `click`, `hover`, `type`, `press`, `fill`, `scroll`, `drag`, `actions` | act on it; all but `hover` return `changes`: new refs and what changed or went |
| `run_js`, `wait`, `read_console`, `read_network` | scripts, waits (for text, a selector, or `until: "settled"`) and debugging; input tools wait up to 2.5 s for the page to settle |
| `handle_dialog` | answer an alert, confirm or prompt box; while one is open, other calls fail at once with `dialog_open` |
| `capture` | evidence from the agent's own tab as files under `~/.config/tychicus/captures`: a redacted HAR (`network_start`/`network_stop`), a WebM recording (`record_start`/`record_stop`), the last minute of video (`flight_start`/`flight_save`); `status`, `cancel` |
| `library_add`, `library_search`, `library_cite` | the source library (`tychicus library`) |

**How much a read returns.** Each read tool answers with a bounded part and says when it cut, with the call that reads on, so one page can't fill an agent's context: `get_page_text` and `get_page_html` 50,000 characters (a PDF tab by pages), `run_js` values 50,000 (an `offset` reads on from the value kept, without running the code again) and `page_markdown` 40,000, all with `offset`; `read_page` 300 elements and 3,000 characters of text; `read_console` and `read_network` the newest 100 entries at 2,000 characters each, older ones by `offset` (after `clear` they are gone, and the note says so); `crawl` 3,000 characters a page; `files` `read` 50 KB of text (up to 200 KB with `max_bytes`) and `offset`, cut on a character boundary. No tool result is longer than 100,000 characters.

Every tool documents its parameters and includes an example in its description. The server's instructions tell the
agent that page text is untrusted data and that it must ask before acting under the
user's sign-in. With no browser connected, every tool returns: "Tychicus isn't connected.
Ask the user to open Helium/Chrome with the Tychicus extension loaded, or run
`tychicus doctor`."
