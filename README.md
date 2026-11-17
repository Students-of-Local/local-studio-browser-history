# Tychicus

[![CI](https://github.com/baney75/tychicus/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/baney75/tychicus/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

Tychicus gives AI agents browser use and computer use. It is a Chromium extension, a CLI helper
and an MCP server. Claude Code, Codex, pi or any MCP client drives your real browser through it,
in background tabs of its own, while you keep working. The computer-use tools reach desktop apps
through a platform driver.

Tychicus is becoming a Local Studio plugin. In that design the extension talks to the Eukhe
daemon over Chrome native messaging, and the daemon runs agents on the subscriptions you already
have (Claude, ChatGPT and others) without the extension holding any API key. That work has not
landed yet; today the extension and CLI work as they did in Polycarp.

The name is Tychicus, Paul's courier in the New Testament (Ephesians 6:21-22, Colossians 4:7-8):
the one who carries messages and does the errands.

## Provider terms

Driving a consumer subscription (a chat plan you pay for as a person) through automation may
break that provider's terms of service. Some providers allow it, some forbid it, and terms
change. Tychicus does not decide this for you. Read your provider's terms and decide whether to
connect a subscription; API keys under a developer agreement are the safer route where terms
are unclear.

## Build and load the extension

You need Node 22 or newer, git, and a Chromium 141+ browser (Helium, Chrome, Brave or Chromium).

```bash
git clone https://github.com/baney75/tychicus && cd tychicus
./scripts/setup-siblings.sh        # clones pinned pi-mono and mini-lit into vendor/, patches, installs
npm run build                      # writes the unpacked extension to dist-chrome/
(cd cli && npm run build && npm link)
```

Load it by hand: open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**
and pick the `dist-chrome/` folder. Then register the native host and connect your agents:

```bash
tychicus setup                     # or: tychicus doctor
claude mcp add --scope user tychicus -- tychicus mcp
```

The extension ID comes from the manifest key, so it is the same ID Polycarp had, and existing
native host registrations keep working.

### Old names still work

| Old | Now |
| --- | --- |
| `polycarp-browser <command>` | `tychicus <command>` (both binaries ship) |
| MCP server named `polycarp` | `tychicus mcp` reports `tychicus`; `tychicus mcp --name polycarp` keeps the old name, and `polycarp-browser mcp` still reports `polycarp` |
| `polycarp browser <command>` | still forwarded by the `polycarp` shim |

Stored data, the native host name and the extension ID did not change.

## Checks

```bash
./check.sh                         # biome, tsc, theme check, extension and CLI unit tests, skill lint
(cd cli && npm run bench:dom)      # 44-page DOM benchmark against cli/test/dom-bench/floor.json
```

CI runs the same on every push and pull request (`.github/workflows/ci.yml`), plus the headless
end-to-end tests.

## Platforms

macOS and Linux run the extension, the CLI and the MCP server. Native app control on Linux is
not built yet; see [docs/LINUX.md](docs/LINUX.md) for what works there and what is missing.

## More

- [GUIDE.md](GUIDE.md): the full user guide (sessions, skills, library, remote MCP, safety model).
- [docs/](docs/README.md): design notes and references.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Moved from Polycarp

This repository is the `browser/` folder of [baney75/polycarp](https://github.com/baney75/polycarp)
at commit `4d1b9443` ("Dock: keep each tile's icons in join order, not by last use (#416)"),
moved to the root with its full history, including the earlier `baney75/tabkyra` history that
Polycarp merged in. Polycarp's other folders (spaces, voice, cli, core) stay there.

## Credits

The agent bridge is the work of [0xSero](https://github.com/0xSero)
([0xSero/sitegeist](https://github.com/0xSero/sitegeist)). The extension is
[Mario Zechner](https://github.com/badlogic)'s [Sitegeist](https://github.com/badlogic/sitegeist),
built on his [pi](https://github.com/badlogic/pi-mono) and
[mini-lit](https://github.com/badlogic/mini-lit) libraries. Details are in
[GUIDE.md](GUIDE.md#credits) and [docs/fork-changes.md](docs/fork-changes.md).

## License

[AGPL-3.0](LICENSE), unchanged from Polycarp's `browser/` folder and from upstream. If you run a
modified Tychicus for others over a network, the AGPL asks you to offer them its source. The
Polycarp name and logo (in Polycarp's `brand/` folder) are not covered by this license.
