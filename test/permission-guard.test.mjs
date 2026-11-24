// What each permission mode lets an agent do (docs/decisions.md, D67), beyond the store and its migration
// (permission-modes.test.mjs): Auto asks before sensitive sites even for a frontier model, a remote session is never in
// Yolo, the rules look at a target only when they could act on it, "Allow on this site" for actions is its own list, the
// Yolo warning comes once, and every step in the Runs log carries its mode. The bridge itself is driven in
// dialog-preset.test.mjs (asks, Deny, allow on a site, hard limits in Yolo, a remote session's cap).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	ACTION_HOSTS_KEY,
	allowActionsOn,
	allowHost,
	getActionHosts,
	getAllowedHosts,
	isUrlAllowed,
	LEGACY_MODE_KEY,
	MODE_KEY,
	modeFor,
	peekPermissionMode,
	revokeActionsOn,
	setPermissionMode,
	turnOnYolo,
	YOLO_WARNED_KEY,
	yoloWarned,
} from "../src/bridge/permissions.ts";
import { needsTarget } from "../src/bridge/risk-rules.ts";
import { addStep } from "../src/runs/log.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");

function fresh() {
	installFakeChrome();
	chrome.runtime.id = "abcdefghijklmnopabcdefghijklmnop";
}

test("Auto: a frontier model opens an ordinary site, but mail, a bank or a password manager asks until allowed", async () => {
	fresh();
	await setPermissionMode("auto");
	assert.equal(await isUrlAllowed("https://news.example.com/today", "frontier"), true);
	for (const url of ["https://mail.google.com/mail/u/0", "https://www.chase.com/", "https://vault.bitwarden.com/", "https://console.aws.amazon.com/"])
		assert.equal(await isUrlAllowed(url, "frontier"), false, url);
	await allowHost("chase.com");
	assert.equal(await isUrlAllowed("https://secure.chase.com/web/auth", "frontier"), true, "the person allowed it");
	await setPermissionMode("yolo");
	assert.equal(await isUrlAllowed("https://mail.google.com/mail/u/0", "unknown"), true, "Yolo asks nothing");
	await setPermissionMode("manual");
	assert.equal(await isUrlAllowed("https://news.example.com/today", "frontier"), false);
});

test("a remote session is never in Yolo: it gets Auto's asks", async () => {
	fresh();
	assert.deepEqual(
		["manual", "auto", "yolo"].map((m) => [modeFor(m, false), modeFor(m, true)]),
		[["manual", "manual"], ["auto", "auto"], ["yolo", "auto"]],
	);
	await setPermissionMode("yolo");
	assert.equal(await isUrlAllowed("https://news.example.com/", "unknown", false), true);
	assert.equal(await isUrlAllowed("https://news.example.com/", "unknown", true), false, "remote, unknown model: asks");
	assert.equal(await isUrlAllowed("https://mail.google.com/", "frontier", true), false, "remote, sensitive site: asks");
	assert.equal(await isUrlAllowed("https://news.example.com/", "frontier", true), true, "remote, frontier: Auto's rule");
});

test("the rules look at a target only when they could refuse or ask: text always, risky input outside Yolo", () => {
	const cases = [
		// tool, key, submit, yolo, needed
		["fill", undefined, false, true, true],
		["type", undefined, false, true, true],
		["press", "a", false, true, true],
		["press", "Shift+A", false, true, true],
		["press", "Enter", false, true, false],
		["press", "Enter", false, false, true],
		["press", "Meta+Enter", false, false, true],
		["press", "Tab", false, false, false],
		["press", "ArrowDown", false, false, false],
		["click", undefined, false, true, false],
		["click", undefined, false, false, true],
		["type", undefined, true, false, true],
		["hover", undefined, false, false, false],
		["scroll", undefined, false, false, false],
	];
	for (const [tool, key, submit, yolo, want] of cases)
		assert.equal(needsTarget(tool, key, submit, yolo), want, `${tool} ${key ?? ""} submit=${submit} yolo=${yolo}`);
});

test("Allow on this site for actions is its own list: it opens no site, and Remove takes it back", async () => {
	fresh();
	await allowActionsOn("GitHub.com");
	await allowActionsOn("github.com");
	assert.deepEqual(await getActionHosts(), ["github.com"]);
	assert.deepEqual(await getAllowedHosts(), [], "the site list is untouched");
	assert.deepEqual((await chrome.storage.local.get(ACTION_HOSTS_KEY))[ACTION_HOSTS_KEY], ["github.com"]);
	await revokeActionsOn("github.com");
	assert.deepEqual(await getActionHosts(), []);
});

test("the Yolo warning comes once: before the first Yolo, and never after a yes (Settings or the CLI)", async () => {
	fresh();
	assert.equal(await yoloWarned(), false);
	await turnOnYolo();
	assert.equal((await chrome.storage.local.get(MODE_KEY))[MODE_KEY], "yolo");
	assert.equal(await yoloWarned(), true);
	await setPermissionMode("auto");
	assert.equal(await yoloWarned(), true, "picking Yolo again shows no second warning");
	assert.ok((await chrome.storage.local.get(YOLO_WARNED_KEY))[YOLO_WARNED_KEY]);
	const tab = read("src/dialogs/BridgeTab.ts");
	assert.match(tab, /if \(mode === "yolo" && !\(await yoloWarned\(\)\)\) \{\s*this\.yoloAsk = true;/, "Settings warns before saving");
	assert.match(tab, /children: "Turn on Yolo", onClick: \(\) => this\.confirmYolo\(\)/);
	assert.match(tab, /private async confirmYolo\(\) \{\s*this\.yoloAsk = false;\s*await turnOnYolo\(\);/);
	// `tychicus mode yolo` showed the warning in the terminal, so the bridge marks it seen.
	assert.match(read("src/bridge/native.ts"), /\(mode === "yolo" \? turnOnYolo\(\) : setPermissionMode\(mode\)\)/);
});

test("peeking at the mode migrates nothing: the Runs log reads it on every step", async () => {
	fresh();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "allow_all" });
	assert.equal(await peekPermissionMode(), "yolo");
	assert.equal((await chrome.storage.local.get(MODE_KEY))[MODE_KEY], undefined, "nothing written");
	await setPermissionMode("manual");
	assert.equal(await peekPermissionMode(), "manual");
});

test("every step in the Runs log carries the mode it ran under", () => {
	const log = addStep({ runs: [] }, "s1", { who: "claude", tool: "click", params: { ref: "e3" }, ok: true, ms: 12, mode: "yolo" }, 1);
	assert.equal(log.runs[0].steps[0].mode, "yolo");
	const native = read("src/bridge/native.ts");
	assert.match(native, /if \(isRunStep\(req\.method\)\) runMode = modeFor\(await peekPermissionMode\(\), state\.remote\);/);
	assert.match(native, /\.\.\.\(runMode \? \{ mode: runMode \} : \{\}\),/);
});

test("the input tools all pass the mode's check, beside the look before them; the side panel's own agent has none", () => {
	const tools = read("src/bridge/tools.ts");
	for (const tool of ["click", "type", "press", "fill"])
		assert.match(tools, new RegExp(`beforeInput\\(ctx, "${tool}", tabId, params`), tool);
	assert.match(tools, /const \[before, asked\] = await Promise\.all\(\[/);
	assert.doesNotMatch(read("src/bridge/panel-calls.ts"), /guard:/, "the side panel's agent is the person's own");
});

test("the mode notice tells an updated install that Auto now asks before risky actions, since the bridge does", () => {
	const notice = read("src/components/ModeNotice.ts");
	assert.match(notice, /frontier models open ordinary sites on their own/);
	assert.match(notice, /asks before mail, banks and other sensitive sites, and before it sends, posts, buys, deletes or changes settings as you/);
	assert.match(read("src/bridge/native.ts"), /\bactionRisk\(/);
	assert.match(read("src/bridge/permissions.ts"), /return !sensitiveSite\(url\)/);
});

test("the side panel shows an action question above the chat, with one click to allow once, allow on the site or deny", async () => {
	fresh();
	const ask = {
		requestId: "c1:q1",
		clientId: "c1",
		clientName: "claude",
		host: "mail.example.com",
		url: "https://mail.example.com/compose",
		createdAt: 1,
		action: { tool: "click", target: 'click "Send"', rule: "send", why: "sends a message as you" },
	};
	await chrome.storage.session.set({ bridge_pending_requests: [ask] });
	const { agentAsks, askChoices, askLine, watchAgentAsks } = await import(`../src/components/AgentAsks.ts?ctx=${Date.now()}`);
	assert.deepEqual(
		askChoices(ask).map((c) => [c.decision, c.label]),
		[
			["allow_once", "Allow once"],
			["allow_host", "Allow on mail.example.com"],
			["deny", "Deny"],
		],
	);
	assert.equal(askLine(ask), 'claude wants to click "Send" on mail.example.com. This sends a message as you.');
	assert.deepEqual(
		askChoices({ ...ask, action: undefined, upload: { files: [] } }).map((c) => c.decision),
		["allow_once", "deny"],
		"an upload is never allowed for a whole site",
	);
	let redraws = 0;
	await watchAgentAsks(() => redraws++);
	const section = agentAsks();
	assert.notEqual(typeof section, "symbol", "the card is drawn");
	// The section's one value is the list of cards; the card's handlers are its buttons, in order.
	const [cards] = section.values;
	const handlers = cards[0].values.flat(Number.POSITIVE_INFINITY).flatMap((v) => (v?.values ? v.values : [v])).filter((v) => typeof v === "function");
	assert.equal(handlers.length, 3);
	await handlers[2]();
	assert.equal((await chrome.storage.session.get("bridge_decision_c1:q1"))["bridge_decision_c1:q1"], "deny");
	assert.equal(typeof agentAsks(), "symbol", "answered: the card goes at once");
	assert.ok(redraws >= 2);
	assert.match(read("src/sidepanel.ts"), /\$\{modeNotice\(\)\}\s*\$\{agentAsks\(\)\}/);
	assert.match(read("src/dialogs/BridgeTab.ts"), /this\.pending\.map\(\(p\) => askCard\(p, \(d\) => this\.decide\(p, d\)\)\)/);
});
