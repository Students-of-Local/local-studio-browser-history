# Tychicus

[![CI](https://github.com/baney75/tychicus/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/baney75/tychicus/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

Tychicus gives AI agents browser use and computer use. It is a Chromium extension, a CLI helper
and an MCP server. Claude Code, Codex, pi or any MCP client drives your real browser through it,
in background tabs of its own, while you keep working. The computer-use tools reach desktop apps
through a platform driver.

Tychicus is becoming a Local Studio plugin. The side panel already chats through Local Studio's
Eukhe daemon when it runs, on your local models and the subscriptions you signed in to there,
without the extension holding any API key (see below). The rest of the CLI and the outside-agent
tools work as they did in Polycarp.

The name is Tychicus, Paul's courier in the New Testament (Ephesians 6:21-22, Colossians 4:7-8):
the one who carries messages and does the errands.

## How the panel reaches models

When Local Studio runs, the side panel's default provider is **Local Studio**, and the first run
asks for no key. The panel sends each chat to the `tychicus` native host over Chrome native
messaging; the host passes it to Local Studio's Eukhe daemon on its local socket, and each panel
chat becomes a Eukhe session of its own. The daemon runs the model and streams the answer and its
tool steps back to the panel. Stop sends Abort to that session.

- **No keys in the extension.** The extension never sees a key or a sign-in token. Local models
  need none; subscriptions are signed in inside Local Studio, with `eukhe` and its `/login`
  command (ChatGPT, Claude, Copilot and others). The model picker lists local models first, then
  the signed-in subscriptions, each labeled.
- **The browser tools come back through the plugin.** `tychicus install --local-studio` gives
  Eukhe the `tychicus` tool server, so the session reads and acts on your tabs with the small tool
  list.
- **A page can't make a panel chat change your files.** A panel chat reads web pages, and a page
  can tell the model anything. So the host limits each panel session before the panel may use it:
  the session works in an empty private folder instead of your home folder, and only reads in that
  folder run without asking (Eukhe's `shell.autoEffects`, set for that session alone). Every shell
  command and file write then asks, and the panel says no to each one. If Local Studio won't take
  the limit, the chat does not start.
- **Only this extension.** The host answers only the pinned Tychicus extension ID and exits for
  any other caller before it reads a message.
- **When Local Studio is not running**, a chat on it says so and how to fix it (start Local
  Studio, or run `eukhe` in a terminal) within a few seconds, instead of waiting. Local Studio
  chats are not on Windows yet.
- **API keys are still there.** On the first run, "Use an API key instead" opens the provider
  keys, and every key provider stays in the model picker.

## Provider terms

Driving a consumer subscription (a chat plan you pay for as a person) through automation may
break that provider's terms of service. Some providers allow it, some forbid it, and terms
change. Tychicus does not decide this for you. Read your provider's terms and decide whether to
connect a subscription; API keys under a developer agreement are the safer route where terms
are unclear.

## Install from a release

You need a Chromium 141+ browser (Helium, Chrome, Brave, Edge or Chromium). Nothing else: the
`tychicus` program in each release carries its own runtime.

1. From the [latest release](https://github.com/baney75/tychicus/releases/latest), download
   `SHA256SUMS` and the archive for your computer (`tychicus-<version>-linux-x64.tar.gz`,
   `-darwin-arm64.tar.gz` or `-win-x64.zip`) into one empty folder.
2. In that folder, unpack it and run its installer:

   ```bash
   tar -xzf tychicus-*.tar.gz && ./tychicus-*/tychicus install --release .
   ```

   On Windows, in PowerShell: `tar -xf tychicus-<version>-win-x64.zip` and then
   `.\tychicus-<version>-win-x64\tychicus.exe install --release .`
   The installer checks every file against `SHA256SUMS`, and against its build attestation when
   the [GitHub CLI](https://cli.github.com) is installed, and refuses the whole install on any
   mismatch. It unpacks each version into a folder of its own under
   `~/.local/share/tychicus/versions/` (`%LOCALAPPDATA%\Tychicus\versions\` on Windows), registers
   the native host with each Chromium browser it finds, then points `release` at the new version
   and copies the extension to the fixed folder `~/.local/share/tychicus/extension`. An upgrade
   never deletes a version a running host or MCP server was started from; the old folder is
   removed by a later install, once nothing runs from it. Add `--local-studio` to also install the
   Local Studio plugins and their Eukhe tool server; `--dry-run` lists what it would write and
   writes nothing.
3. Load the extension: open `chrome://extensions`, turn on Developer mode, choose **Load
   unpacked** and pick the folder the installer printed. Its ID is fixed by the manifest key, so
   the host registration already allows it.

Then point your agent at it, for example
`claude mcp add --scope user tychicus -- ~/.local/share/tychicus/release/tychicus mcp`.
CI's `clean-install` job runs these steps from an empty home folder on every pull request and
fails if they take more than three steps or 60 seconds, or if a changed file is accepted.

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

The extension ID (`igjafcggmahiboobmnhfkndodphjdnhg`) comes from the manifest key and
differs from Polycarp's, and the native host is `com.tychicus.browser`, so Tychicus and Polycarp
can be installed side by side without either one answering for the other.

### Tychicus keeps to its own files

Tychicus never writes to Polycarp's files. It has its own config folder (`~/.config/tychicus`),
data and cache folders, launchers (`tychicus`, `tychicus-host`), native host
(`com.tychicus.browser`), socket folder (`/tmp/tychicus-bridge-<user>`), service names
(`com.tychicus.serve`, `tychicus-serve.service` and so on) and MCP entry (`tychicus`). The npm
package installs only the `tychicus` command; `polycarp` and `polycarp-browser` stay Polycarp's.
Polycarp's folders, launchers, host manifest, MCP entry and permission rules are left as they are,
and so are the older `tabkyra` folders Polycarp moves itself.

### Upgrading from a build with the old ID

Builds before the manifest key ran under Polycarp's extension ID, `kenehmggpggpiolepbjojeenmeapgfoc`.
The browser keeps each extension's chats, API keys, skills and settings under its ID, so the new
ID, `igjafcggmahiboobmnhfkndodphjdnhg`, starts empty: nothing carries over by itself.
Removing the old extension deletes everything stored under it. In this order:

1. While the old extension is still loaded, save the chats you want with the helper that came
   with that build: `polycarp-browser threads list`, then
   `polycarp-browser threads export <id> --out <file>` for each one. The new `tychicus` command
   talks only to the new extension. The on-disk thread mirror, if you turned it on, also keeps
   them.
2. Write down which providers you use; API keys are not exported, so you enter them again.
3. Load the new build. It appears as a second extension with the new ID.
4. Enter your keys and settings in the new one, and check it works.
5. Only then remove the old extension.

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
