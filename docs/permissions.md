# Permission modes

Tychicus has one permission mode for everything an agent does in your browser: Manual, Auto (the default) or Yolo.
Pick it in the side panel under Settings > Agents, or run `tychicus mode manual|auto|yolo`. `tychicus mode` with no
argument, `tychicus status`, `tychicus doctor` and the MCP `status` tool all name it. Decision D67 in
[decisions.md](decisions.md) has the reasons.

## What asks in each mode

| | Manual | Auto (default) | Yolo |
| --- | --- | --- | --- |
| An ordinary site the agent hasn't opened before | asks | frontier models go ahead; small or unknown models ask | goes ahead |
| A sensitive site (mail, a bank, a password manager, a cloud console, a government or health account) | asks | asks | goes ahead |
| A risky action as you (send, post, buy or pay, delete, change settings or access, grant an app access, download and run a program) | asks | asks | goes ahead |
| Reading, scrolling, typing without sending | goes ahead | goes ahead | goes ahead |
| Uploading a file from your computer | asks | asks | asks |

A model's tier comes from the agent's harness (`cli/src/model-tier.ts`). A site you allowed, in Settings > Agents or
with `tychicus allow <host>`, never asks again.

## The ask

The question shows in your agent's own prompt when the harness supports it (Claude Code and Codex do), and as a card
above the chat in the side panel. Settings > Agents lists the same questions under "Waiting for your answer". Each
has three buttons:

- **Allow once**: this one action goes ahead.
- **Allow on this site**: risky actions on this site stop asking. Settings > Agents lists those sites under "Sites
  where agents act without asking", each with Remove. This list is separate from the sites an agent may open.
- **Deny**: the action doesn't happen.

You have 60 seconds. No answer counts as Deny. Either way the agent is told what it didn't do and that it should ask
you. `TYCHICUS_AUTO_ALLOW=1` answers site questions only, never an action question.

When Tychicus can't read the page before a click, an Enter or a `type` with submit, it can't tell whether the action is
risky, so Manual and Auto ask about it the same way.

## What no mode allows

These hold in Yolo too:

- **Password and payment fields.** An agent can't type into a password field or a card field, including a payment
  provider's card frame. It's told to leave the field empty, bring the tab to you with `tabs_show` and let you type.
- **Tychicus's own pages and its local services.** The extension's pages, the connector approval page and the
  addresses Tychicus's own servers answer on are never opened by an agent.
- **Remote sessions.** A session from a web assistant (`tychicus mcp --connector`, or a scoped token) is never in
  Yolo: under Yolo it gets Auto's asks. It can't answer its own question or change the mode.

## Turning on Yolo

The first time you pick Yolo in Settings > Agents, a warning comes first, with Turn on Yolo and Cancel. In a terminal,
`tychicus mode yolo` shows the same warning and asks for a yes. It refuses to run without a terminal, so an agent with
a shell can't turn its own asks off. The skill lint flags `tychicus mode yolo` in a skill.

## Moving from 1.4.0

| 1.4.0 setting | Now |
| --- | --- |
| Ask before opening a new site (`tychicus ask`) | Manual |
| Always allow (`tychicus allow-all`) | Yolo |
| Match the model, or never set | Auto, with a one-time notice in the side panel and a Switch to Manual button |

A new install starts in Auto with no notice. `tychicus ask` and `tychicus allow-all` still work and mean Manual and Yolo.

## Audit

Every step in the side panel's Runs view records the mode it ran under.

## Limits

The rules read what a page shows: a button's name, a field's type and label, the form and dialog around it, the
page's address. A page can name its Send button something else. Auto's asks catch an agent's mistakes; they are not a
sandbox. `run_js` runs page code directly and isn't checked by these rules. For every new site to ask, use Manual. The
rules live in `src/bridge/risk-rules.ts`, and `evals/market/risky-actions` scores them on labeled actions with recall
on risky ones held at 100%.
