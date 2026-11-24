// What each permission mode lets an agent do (docs/decisions.md, D67), beyond the store and its migration
// (permission-modes.test.mjs): a remote session is never in Yolo, and every step in the Runs log carries its mode. The
// bridge itself is driven in dialog-preset.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { allowHost, getPermissionMode, isRemoteClient, isUrlAllowed, LEGACY_MODE_KEY, MODE_KEY, modeFor, peekPermissionMode, setPermissionMode } from "../src/bridge/permissions.ts";
import { addStep } from "../src/runs/log.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");

function fresh() {
	installFakeChrome();
	chrome.runtime.id = "abcdefghijklmnopabcdefghijklmnop";
}

test("a remote session is never in Yolo: it gets Auto's rule", async () => {
	fresh();
	assert.deepEqual(
		["manual", "auto", "yolo"].map((m) => [modeFor(m, false), modeFor(m, true)]),
		[["manual", "manual"], ["auto", "auto"], ["yolo", "auto"]],
	);
	await setPermissionMode("yolo");
	assert.equal(await isUrlAllowed("https://news.example.com/", "unknown", false), true);
	assert.equal(await isUrlAllowed("https://news.example.com/", "unknown", true), false, "remote, unknown model: asks");
	assert.equal(await isUrlAllowed("https://news.example.com/", "frontier", true), true, "remote, frontier: Auto's rule");
});

test("Auto: a frontier model opens an ordinary site, but mail, a bank or a password manager asks until allowed", async () => {
	fresh();
	await setPermissionMode("auto");
	assert.equal(await isUrlAllowed("https://news.example.com/today", "frontier"), true);
	for (const tier of ["frontier", "unknown"]) assert.equal(await isUrlAllowed("about:blank", tier), true);
	const sensitive = ["https://mail.google.com/mail/u/0", "https://www.chase.com/", "https://vault.bitwarden.com/", "https://console.aws.amazon.com/"];
	for (const url of sensitive) assert.equal(await isUrlAllowed(url, "frontier"), false, url);
	await allowHost("chase.com");
	assert.equal(await isUrlAllowed("https://secure.chase.com/web/auth", "frontier"), true, "the person allowed it");
	await setPermissionMode("yolo");
	assert.equal(await isUrlAllowed("https://mail.google.com/mail/u/0", "unknown"), true, "Yolo asks nothing");
	assert.equal(await isUrlAllowed("https://mail.google.com/mail/u/0", "frontier", true), false, "but a remote session in Yolo has Auto's asks");
	await setPermissionMode("manual");
	assert.equal(await isUrlAllowed("https://news.example.com/today", "frontier"), false);
});

test("a refused site says how the person allows it, whatever the mode: Auto refuses a frontier model's sensitive site", () => {
	const native = read("src/bridge/native.ts");
	assert.match(native, /Not allowed to open \$\{hostOf\(url\) \|\| url\}\. The user can allow it in the Tychicus side panel under Settings > Agents, or answer the permission prompt\.`/);
	assert.doesNotMatch(native, /Bridge navigation is blocked/);
});

test("an older CLI says nothing about remote, but its remote sessions are told by the name serve gives them", () => {
	for (const [client, remote] of [
		[{ name: "claude", remote: true }, true],
		[{ name: "remote-web" }, true],
		[{ name: "claude" }, false],
		[{ name: "claude", remote: "yes" }, false],
		[{ name: "my-remote-agent" }, false],
		[{}, false],
	])
		assert.equal(isRemoteClient(client), remote, JSON.stringify(client));
	// The name this rests on.
	assert.match(read("cli/src/remote.ts"), /name: `remote-\$\{label\}`,/);
});

test("peeking at the mode migrates nothing: the Runs log reads it on every step", async () => {
	fresh();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "allow_all" });
	assert.equal(await peekPermissionMode(), "yolo");
	assert.equal((await chrome.storage.local.get(MODE_KEY))[MODE_KEY], undefined, "nothing written");
	// getPermissionMode migrates a legacy name kept under the current key like no mode at all.
	await chrome.storage.local.remove(LEGACY_MODE_KEY);
	await chrome.storage.local.set({ [MODE_KEY]: "allow_all" });
	const peeked = await peekPermissionMode();
	assert.equal(peeked, await getPermissionMode());
	assert.equal(peeked, "auto");
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
