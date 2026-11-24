// The permission mode's one store and its migration from 1.4.0 (docs/decisions.md, D65): "ask" becomes Manual,
// "allow_all" becomes Yolo, nothing stored (or "Match the model") becomes Auto with a one-time notice, and a fresh
// install is Auto with no notice.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	asPermissionMode,
	dismissModeNotice,
	getModeNotice,
	getPermissionMode,
	LEGACY_MODE_KEY,
	MODE_KEY,
	MODE_NOTICE_KEY,
	migrateLegacyMode,
	setPermissionMode,
	startFreshInstall,
} from "../src/bridge/permissions.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const stored = async (key) => (await chrome.storage.local.get(key))[key];

test("migration: a stored ask becomes Manual, with no notice", async () => {
	installFakeChrome();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "ask" });
	assert.equal(await getPermissionMode(), "manual");
	assert.equal(await stored(MODE_KEY), "manual", "the new store holds it");
	assert.equal(await getModeNotice(), undefined);
});

test("migration: a stored allow_all becomes Yolo, with no notice", async () => {
	installFakeChrome();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "allow_all" });
	assert.equal(await getPermissionMode(), "yolo");
	assert.equal(await getModeNotice(), undefined);
});

test("migration: an update with nothing stored becomes Auto, and the side panel gets a notice once", async () => {
	installFakeChrome();
	assert.equal(await getPermissionMode(), "auto");
	const notice = await getModeNotice();
	assert.equal(notice?.from, "unset");
	assert.equal(typeof notice?.at, "number");
	// Read again: no second migration, the notice is the same one.
	assert.equal(await getPermissionMode(), "auto");
	assert.deepEqual(await getModeNotice(), notice);
	await dismissModeNotice();
	assert.equal(await getModeNotice(), undefined);
	assert.equal(await getPermissionMode(), "auto");
	assert.equal(await getModeNotice(), undefined, "a dismissed notice never comes back");
});

test("migration: 1.4.0's stored Match the model becomes Auto, with the notice", async () => {
	installFakeChrome();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "by_model" });
	assert.equal(await getPermissionMode(), "auto");
	assert.equal((await getModeNotice())?.from, "by_model");
});

test("a fresh install is Auto with no notice, even when something read the mode first", async () => {
	installFakeChrome();
	await startFreshInstall();
	assert.equal(await getPermissionMode(), "auto");
	assert.equal(await getModeNotice(), undefined);
	installFakeChrome();
	assert.equal(await getPermissionMode(), "auto");
	await startFreshInstall();
	assert.equal(await getModeNotice(), undefined, "onInstalled takes back a notice an early read left");
	assert.equal(await stored(MODE_KEY), "auto");
});

test("startFreshInstall leaves an install that has a 1.4.0 setting alone", async () => {
	installFakeChrome();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "ask" });
	await startFreshInstall();
	assert.equal(await getPermissionMode(), "manual");
});

test("choosing a mode takes the notice away; a chosen mode is never migrated again", async () => {
	installFakeChrome();
	await getPermissionMode();
	assert.ok(await getModeNotice());
	await setPermissionMode("manual");
	assert.equal(await getModeNotice(), undefined);
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "allow_all" });
	assert.equal(await getPermissionMode(), "manual", "the old key no longer decides");
});

test("mode names: the three modes, and the 1.4.0 names an older CLI sends", () => {
	assert.deepEqual(
		["manual", "auto", "yolo", "ask", "allow_all", "by_model"].map(asPermissionMode),
		["manual", "auto", "yolo", "manual", "yolo", "auto"],
	);
	for (const v of [undefined, null, "", "MANUAL", "full", 1]) assert.equal(asPermissionMode(v), undefined, String(v));
	assert.deepEqual(migrateLegacyMode("ask"), { mode: "manual" });
	assert.deepEqual(migrateLegacyMode("allow_all"), { mode: "yolo" });
	assert.deepEqual(migrateLegacyMode(undefined), { mode: "auto", notice: "unset" });
	assert.deepEqual(migrateLegacyMode("garbage"), { mode: "auto", notice: "unset" });
});

test("the worker starts a fresh install in Auto, and the bridge takes the new and old names", () => {
	assert.match(read("src/background.ts"), /details\.reason === "install"\) startFreshInstall\(\)/);
	const native = read("src/bridge/native.ts");
	assert.match(native, /const mode = asPermissionMode\(message\.params\?\.mode\);/);
	assert.match(native, /mode must be manual, auto or yolo/);
	assert.ok(MODE_NOTICE_KEY && MODE_KEY !== LEGACY_MODE_KEY);
});

test("the side panel shows the notice once, and its button switches to Manual", async () => {
	installFakeChrome();
	const { MODE_NOTICE_TEXT, modeNotice, watchModeNotice } = await import(`../src/components/ModeNotice.ts?ctx=${Date.now()}`);
	let changes = 0;
	await watchModeNotice(() => changes++);
	const card = modeNotice();
	assert.ok(card.strings.join("").includes("Switch to Manual"), "the card offers Manual");
	assert.match(MODE_NOTICE_TEXT, /Auto mode/);
	assert.match(MODE_NOTICE_TEXT, /send, post, buy, delete or change settings/);
	const [toManual] = card.values.filter((v) => typeof v === "function");
	await toManual();
	assert.equal(await getPermissionMode(), "manual");
	assert.equal(await getModeNotice(), undefined);
	assert.ok(changes >= 2, "the panel redraws when the notice goes");
	assert.equal(typeof modeNotice(), "symbol", "the card is gone (lit's nothing)");
	const panel = read("src/sidepanel.ts");
	assert.match(panel, /\$\{updateNotice\(\)\}\s*\$\{modeNotice\(\)\}/, "drawn under the update notice");
	assert.match(panel, /watchModeNotice\(renderApp\)/);
});
