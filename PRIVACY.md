# Tychicus privacy policy

Tychicus is a browser extension and a helper program that let AI agents work in the user's browser. This policy covers
the Tychicus extension and the `tychicus` helper. It was last changed on 2026-11-17.

## What Tychicus collects

Nothing, for itself. Tychicus has no account, no analytics, no automatic crash reporting and no server of its own. Its
developer receives none of the data below, except a bug report the user chooses to post (see "Bug reports").

## What stays on the user's computer

- Chats, settings, skills, the sites the user allowed, and API keys the user chose to add are stored in the browser,
  under the extension's own storage.
- The helper keeps its settings and logs in its own folders on the user's computer (`~/.config/tychicus`,
  `~/.local/share/tychicus`, `~/.cache/tychicus`). If the user turns on the chat copy for coding agents, a copy of the
  chats is kept there too.
- Tokens for the ChatGPT and GitHub Copilot sign-ins (Settings > Providers) are kept by the helper in files only the user
  can read. The browser never holds them.
- Recordings and network captures an agent asks for are saved as files on the user's computer.

## What leaves the computer, and where it goes

Only to the AI the user picked, and only to answer the user's request:

- **Local Studio (the default).** The side panel sends each chat, and what the agent reads from a page, to Local Studio
  on the same computer through the helper. A local model keeps it on the computer. A subscription the user signed in to
  inside Local Studio sends it to that subscription's provider. The extension never sees a key or a sign-in token.
- **A ChatGPT or GitHub Copilot sign-in.** The side panel sends the chat to the helper on the same computer, which adds the
  user's token and forwards it to OpenAI or GitHub. The sign-in itself runs on that provider's own page.
- **An API key the user added.** The chat and what the agent reads go straight from the browser to that provider.
- **Free mode.** Messages go to free models through OpenRouter, which may keep and train on them. Tychicus asks first,
  tries models that keep nothing first, and removes keys, card numbers and US Social Security numbers from the text.
- **Private mode.** When the user turns it on, prompts go only to models that promise not to keep them, or to machines
  the user named as their own.
- **Coding agents the user connects** (Claude Code, Codex and others) get what they ask the browser for, through the
  helper on the same computer. What they send on is under that agent's own policy.

- **Remote connectors, hubs and linked devices.** Off unless the user runs `tychicus remote setup`, `tychicus hub setup`
  or `tychicus link`. Then an assistant the user added as a connector (claude.ai, ChatGPT, grok.com) or the user's own
  hub machine can ask the browser for page content and tool results. Those travel over the tunnel the user set up, on
  the user's own Tailscale Funnel or Cloudflare account, or to the hub machine the user named. Every request needs a
  sign-in the user approved. `tychicus remote off` turns it off.

## Bug reports

Off by default. When the user turns on "Keep error reports so I can send them", errors from the side panel are kept in
the browser with web addresses, emails and keys removed. Nothing is sent: the user reviews the report, copies it, and
pastes it into a GitHub issue they open and post themselves. Turning the switch off deletes the kept errors.

Each provider's own privacy policy and terms cover what it does with the data.

## What the agent can see

The agent reads and acts only in tabs it opened or the user gave it, kept in their own tab group. It can't open a new
site until the user allows it, and it hands the tab back for sign-ins and captchas.

## Data sale and use

Tychicus does not sell user data, does not use or transfer it for anything but the single purpose above, and does not
use it to decide creditworthiness or for lending.

## Contact

Questions and requests: https://github.com/baney75/tychicus/issues
