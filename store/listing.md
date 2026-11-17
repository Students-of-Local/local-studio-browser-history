# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. Reasons for each permission are in
[permissions.md](permissions.md). The images come from `node scripts/store-shots.mjs` (see its header).

Build the zip:

```bash
scripts/build-store.sh "$HOME/Downloads/tychicus-store"
```

It writes `tychicus-<version>-store.zip` (the version is `static/manifest.chrome.json`'s, which must equal
`package.json`'s). The build refuses a zip whose manifest has a `key`, a name other than Tychicus, a missing icon, or a
permission with no row in permissions.md.

## Order of the first upload

1. Build the zip and upload it as a draft. Don't submit it yet. Google assigns the store id.
2. Put that id in `STORE_EXTENSION_ID` in `cli/src/install.ts` (it is `""` now) and merge. That one constant is where
   the store id is pinned: the native host manifest `tychicus install` writes allows it (`extensionOrigins`), and the
   host refuses any other caller (`callerRefusal` in `cli/src/host.ts`). The unpacked copy's id stays
   `igjafcggmahiboobmnhfkndodphjdnhg` in `src/bridge/extension-id.json`, fixed by the manifest key the zip leaves out.
   `test/store-origins.test.mjs` covers both ids.
3. Release the helper from that commit with `./release.sh patch` (it tags `v<version>`, and
   `.github/workflows/release.yml` builds the helper with the id in it). People who installed before run
   `tychicus install --release <folder>` again, which rewrites the host manifest to allow the store copy.
4. Submit the draft for review.

## Store listing tab

**Title:** Tychicus

**Summary** (from the manifest's `description`, 132 characters at most):

```
Lets AI agents work in your browser, in their own tab group, while you keep working.
```

**Category:** Tools (Productivity)

**Language:** English

**Description:**

```
Tychicus lets an AI agent work in your browser while you keep working. The agent gets its own tab group. It opens pages, reads them, clicks, fills in forms and checks its own work there, and your tabs stay yours.

Tychicus comes three ways: a Local Studio plugin, an app you install on its own, and this Chrome extension. The extension works with or without Local Studio.

Use it two ways:

• Chat in the side panel. With Local Studio on your computer, the panel runs on it by default: your local models, and the plans you signed in to inside Local Studio, with no API key or sign-in in the extension. Without Local Studio, add an API key from Anthropic, OpenAI, Google, OpenRouter and others, or use a free OpenRouter key; with Local Studio, "Use an API key instead" does the same.
• Connect the coding agent you already use. Claude Code, Codex and any MCP agent can drive your browser through the free Tychicus helper on your computer.

You stay in charge:

• The agent can't open a new site until you allow it.
• It stops and hands the tab to you for sign-ins and captchas.
• Private mode only sends prompts to models that don't keep them, or to your own machines.

Tychicus has no account and no analytics, and it runs no servers of its own. Your chats and settings stay on your computer. Your messages, and what the agent reads, go only to the AI you picked.

A note on provider terms: using a consumer chat subscription through automation may break that provider's terms of service. Some allow it, some forbid it, and terms change. Tychicus doesn't decide this for you. Read your provider's terms before you connect a subscription; API keys under a developer agreement are the safer route where terms are unclear.

Local Studio chats need macOS or Linux for now.

Free software under the AGPL-3.0. Source: https://github.com/baney75/tychicus
Built on 0xSero's agent bridge and Mario Zechner's Sitegeist.
```

**Homepage:** https://github.com/baney75/tychicus

**Support:** https://github.com/baney75/tychicus/issues

**Images:**

- Icon: `static/icon-128.png`
- Screenshots, 1280x800, in this order: `store/screenshots/local-studio.png`, `store/screenshots/models.png`,
  `store/screenshots/agents.png`. `scripts/store-shots.mjs` also draws `welcome.png` and `site-access.png`, but only once
  those screens in the panel stop showing the old product name; it refuses them until then.
- Small promo tile, 440x280: `store/promo-small.png`
- Marquee, 1400x560: `store/promo-marquee.png`

## Privacy tab

**Single purpose:**

```
Tychicus lets AI agents operate web pages in the user's browser on the user's behalf, from its side panel or from an AI agent the user connects.
```

**Permission justifications:** paste each row of [permissions.md](permissions.md) into its box.

**Are you using remote code?** Yes.

```
The agent's page actions run through the Debugger API and the User Scripts API, the two APIs the program policies permit for this, and only as those APIs document. Separately, the agent can write code that runs in sandbox.html, a sandboxed page isolated from extension APIs. That code can import packages from public CDNs (esm.run, jsDelivr, unpkg, cdnjs, esm.sh, Skypack, Tailwind), listed in the manifest's sandbox content security policy, for example to draw a chart or read a spreadsheet the user attached. All of the extension's own logic is in the package; nothing fetched remotely runs with extension API access.
```

**Data usage: what the extension handles.** Tick these:

- Authentication information: API keys the user adds under "Use an API key instead". Stored locally and sent only to that provider. Local Studio sign-ins stay in Local Studio; the extension never sees them.
- Web history: the addresses of pages the agent opens.
- User activity: the agent's clicks and typing in its own tabs.
- Website content: text, images and form contents of pages the agent reads.

Leave the other boxes empty.

**Certify all three:** not sold to third parties, not used or transferred for purposes unrelated to the single purpose,
not used to determine creditworthiness or for lending.

**Privacy policy:** https://github.com/baney75/tychicus/blob/main/PRIVACY.md

## Distribution tab

**Visibility:** Public. **Regions:** All.

## Test instructions for the reviewer

```
No account is needed.

1. Click the toolbar icon to open the side panel.
2. In the welcome, choose "Chat here" and add a key for any listed provider. A free key from openrouter.ai works with Free mode. (Local Studio, the default when it runs, needs the Local Studio app on the same computer. Without it the panel offers API keys, so the reviewer doesn't need it.)
3. Ask: "Open example.com and tell me what the page says."
4. Approve example.com when asked. A new tab group opens, and the agent reads the page in it.

Connecting a coding agent needs the free Tychicus helper from https://github.com/baney75/tychicus/releases. It isn't required to review the side panel.
```
