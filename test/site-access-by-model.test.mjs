// "Match the model" site access (docs/decisions.md, D60): the default mode, what it decides for each tier, and that a
// stored "ask" or "allow_all" still means what it did.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	allowHost,
	asModelTier,
	effectiveMode,
	getPermissionMode,
	isUrlAllowed,
	setPermissionMode,
} from "../src/bridge/permissions.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const SITE = "https://example.com/page";

function fresh() {
	installFakeChrome();
	chrome.runtime.id = "abcdefghijklmnopabcdefghijklmnop";
}

test("nothing stored is by_model; a stored ask or allow_all is kept", async () => {
	fresh();
	assert.equal(await getPermissionMode(), "by_model");
	await chrome.storage.local.set({ bridge_permission_mode: "something-else" });
	assert.equal(await getPermissionMode(), "by_model");
	await setPermissionMode("ask");
	assert.equal(await getPermissionMode(), "ask");
	await setPermissionMode("allow_all");
	assert.equal(await getPermissionMode(), "allow_all");
	await setPermissionMode("by_model");
	assert.equal(await getPermissionMode(), "by_model");
});

test("by_model: a frontier model opens any site; small, unknown and silent clients need the site allowed", async () => {
	fresh();
	assert.equal(await isUrlAllowed(SITE, "frontier"), true);
	assert.equal(await isUrlAllowed(SITE, "small"), false);
	assert.equal(await isUrlAllowed(SITE, "unknown"), false);
	assert.equal(await isUrlAllowed(SITE), false, "an older CLI sends no tier");
	await allowHost("example.com");
	assert.equal(await isUrlAllowed(SITE, "small"), true, "an allowed site opens for every tier");
	assert.equal(await isUrlAllowed(SITE, "unknown"), true);
	assert.equal(effectiveMode("by_model", "frontier"), "allow_all");
	assert.equal(effectiveMode("by_model", "small"), "ask");
	assert.equal(effectiveMode("by_model", "unknown"), "ask");
	assert.equal(effectiveMode("by_model", undefined), "ask");
});

test("a stored ask still asks a frontier client, and allow_all still opens for an unknown one", async () => {
	fresh();
	await setPermissionMode("ask");
	assert.equal(await isUrlAllowed(SITE, "frontier"), false);
	assert.equal(effectiveMode("ask", "frontier"), "ask");
	await setPermissionMode("allow_all");
	assert.equal(await isUrlAllowed(SITE, "unknown"), true);
	assert.equal(effectiveMode("allow_all", "small"), "allow_all");
});

test("by_model never opens Tychicus's own pages, even for a frontier model", async () => {
	fresh();
	const own = `chrome-extension://${chrome.runtime.id}/sidepanel.html`;
	assert.equal(await isUrlAllowed(own, "frontier"), false);
	assert.equal(await isUrlAllowed(`blob:chrome-extension://${chrome.runtime.id}/6f1c0c3e`, "frontier"), false);
});

test("a hello's tier is trusted only as frontier or small; anything else is unknown", () => {
	assert.equal(asModelTier("frontier"), "frontier");
	assert.equal(asModelTier("small"), "small");
	for (const v of [undefined, null, "", "FRONTIER", "allow_all", 1, {}]) assert.equal(asModelTier(v), "unknown", String(v));
});

test("the bridge checks each site against the calling client's tier, and guarded hosts before that", () => {
	const native = read("src/bridge/native.ts");
	assert.match(native, /tier: asModelTier\(msg\.client\.tier\)/, "the hello's tier is kept for the client");
	assert.match(native, /async function askPermission\([^)]*\): Promise<boolean> \{\s*if \(isOwnExtensionUrl\(url\)\) return false;\s*if \(await isUrlAllowed\(url, state\.tier\)\) return true;/);
	assert.match(native, /if \(isGuardedUrl\(url, req\.guardedHosts\)\) throw guardedError\(url\);\s*if \(!\(await askPermission\(state, url\)\)\)/);
	assert.match(native, /isUrlAllowed\(url, state\.tier\)\),\s*askUpload/, "frames use the client's tier");
	assert.match(read("src/bridge/files.ts"), /isUrlAllowed\(url, ctx\.tier\)/, "an upload's page uses the client's tier");
	// The upload question is asked in every mode: askUpload never reads the permission mode.
	const askUpload = native.slice(native.indexOf("async function askUpload("), native.indexOf("async function askUpload(") + 1500);
	assert.doesNotMatch(askUpload, /getPermissionMode|isUrlAllowed|effectiveMode/);
});

test("Settings > Agents offers Match the model first, and it is the default", () => {
	const tab = read("src/dialogs/BridgeTab.ts");
	assert.match(tab, /@state\(\) private mode: PermissionMode = "by_model";/);
	const radios = [...tab.matchAll(/name="bridge-mode" value="([a-z_]+)"/g)].map((m) => m[1]);
	assert.deepEqual(radios, ["by_model", "ask", "allow_all"]);
	assert.match(tab, /Match the model: agents on frontier models open any site; small or unknown models ask first/);
});
