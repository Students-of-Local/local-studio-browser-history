// The Chrome Web Store copy: what the zip holds, how a copy knows it came from the store, and that
// every permission has a written reason.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { askedPermissions, explainedPermissions, prepare, problems } from "../scripts/store-package.mjs";
import { isStoreInstall } from "../src/update/store-install.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));

function fakeBuild() {
	const dir = mkdtempSync(join(tmpdir(), "store-"));
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(join(dir, "sidepanel.html"), `<script src="sidepanel.js"></script>`);
	for (const f of ["sidepanel.js", "sidepanel.js.map", "debug.html", "debug.js", "debug.js.map"]) {
		writeFileSync(join(dir, f), "x");
	}
	for (const icon of Object.values(manifest.icons)) writeFileSync(join(dir, icon), "png");
	mkdirSync(join(dir, "ort"));
	writeFileSync(join(dir, "ort/a.mjs.map"), "x");
	return dir;
}

test("a raw build is refused: this is the check that protects the zip", () => {
	const found = problems(fakeBuild()).join("\n");
	for (const word of ["sidepanel.js.map", "debug.html", "debug.js", "ort/a.mjs.map", "manifest has a key", "LICENSE is missing", "NOTICE is missing"]) {
		assert.ok(found.includes(word), `${word} should be reported in:\n${found}`);
	}
});

test("a prepared build passes, keeps the app, and names its source and credits", () => {
	const dir = fakeBuild();
	prepare(dir, root);
	assert.deepEqual(problems(dir), []);
	assert.equal(readFileSync(join(dir, "sidepanel.js"), "utf8"), "x");
	const notice = readFileSync(join(dir, "NOTICE"), "utf8");
	assert.match(notice, /^Tychicus browser extension/);
	assert.match(notice, /github\.com\/baney75\/tychicus/);
	assert.match(notice, /Mario Zechner/);
	assert.match(notice, /0xSero/);
});

test("an html page that loads the debug script is refused", () => {
	const dir = fakeBuild();
	prepare(dir, root);
	writeFileSync(join(dir, "sidepanel.html"), `<script src="debug.js"></script>`);
	assert.match(problems(dir).join(), /sidepanel\.html loads the debug page/);
});

test("only a manifest with update_url counts as a store copy", () => {
	assert.equal(isStoreInstall({ update_url: "https://clients2.google.com/service/update2/crx" }), true);
	assert.equal(isStoreInstall({}), false);
	assert.equal(isStoreInstall({ update_url: "" }), false);
	assert.equal(isStoreInstall(manifest), false, "the manifest we ship declares none, so unpacked copies keep their updater");
});

test("the store description fits and states one purpose", () => {
	assert.ok(manifest.description.length <= 132);
	assert.doesNotMatch(manifest.description, /\band a\b/);
});

test("store/permissions.md has one row per permission the manifest asks for, and no other", () => {
	const doc = readFileSync(join(root, "store/permissions.md"), "utf8");
	const explained = explainedPermissions(doc);
	const asked = askedPermissions(manifest);
	assert.deepEqual([...explained].sort(), [...asked].sort());
	assert.equal(new Set(explained).size, explained.length, "a permission has two rows");
	assert.doesNotMatch(doc, /NOT NEEDED/, "remove the permission or give its reason");
});

/** A source root with this package.json version and permissions.md, for the checks that read them. */
function fakeRoot({ version = manifest.version, doc = readFileSync(join(root, "store/permissions.md"), "utf8") } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "store-root-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
	mkdirSync(join(dir, "store"));
	writeFileSync(join(dir, "store/permissions.md"), doc);
	return dir;
}

function preparedWith(change) {
	const dir = fakeBuild();
	prepare(dir, root);
	const path = join(dir, "manifest.json");
	const m = JSON.parse(readFileSync(path, "utf8"));
	change(m);
	writeFileSync(path, JSON.stringify(m));
	return dir;
}

test("the zip's manifest must be named Tychicus", () => {
	assert.match(problems(preparedWith((m) => (m.name = "Polycarp"))).join(), /manifest name is "Polycarp", not "Tychicus"/);
});

test("every icon the manifest names must be in the zip", () => {
	assert.match(problems(preparedWith((m) => (m.icons["128"] = "icon-gone.png"))).join(), /icon icon-gone\.png is missing/);
	assert.match(problems(preparedWith((m) => delete m.icons["128"])).join(), /no 128 px icon/);
});

test("with the source root: the version must be package.json's", () => {
	const dir = preparedWith(() => {});
	assert.deepEqual(problems(dir, fakeRoot()), []);
	assert.match(problems(dir, fakeRoot({ version: "0.0.1" })).join(), /manifest version .* is not package.json's 0\.0\.1/);
});

test("with the source root: a permission with no reason, or a reason with no permission, is refused", () => {
	assert.match(problems(preparedWith((m) => m.permissions.push("history")), fakeRoot()).join(), /permission history has no reason/);
	const extra = `${readFileSync(join(root, "store/permissions.md"), "utf8")}| \`cookies\` | Not asked for. |\n`;
	assert.match(problems(preparedWith(() => {}), fakeRoot({ doc: extra })).join(), /explains cookies, which the manifest does not ask for/);
});

test("the repo's package.json version is the manifest's", () => {
	assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, manifest.version);
});

test("the listing's summary is the manifest description, word for word", () => {
	const listing = readFileSync(join(root, "store/listing.md"), "utf8");
	const summary = /\*\*Summary\*\*[^\n]*\n\n```\n([^\n]+)\n```/.exec(listing)?.[1];
	assert.equal(summary, manifest.description);
});

test("store/ names only Tychicus", () => {
	for (const name of readdirSync(join(root, "store")).filter((n) => n.endsWith(".md"))) {
		const text = readFileSync(join(root, "store", name), "utf8");
		assert.doesNotMatch(text, /Polycarp|Tabkyra/i, `store/${name} names another product`);
		assert.doesNotMatch(text, /[\u2013\u2014]/, `store/${name} has an en or em dash`);
	}
});

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (path) => {
	const b = readFileSync(path);
	assert.equal(b.toString("latin1", 1, 4), "PNG", `${path} is not a PNG`);
	return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

test("the store images are the sizes the dashboard takes", () => {
	const shots = readdirSync(join(root, "store/screenshots")).filter((n) => n.endsWith(".png"));
	assert.ok(shots.length >= 1 && shots.length <= 5, `the store takes 1 to 5 screenshots, not ${shots.length}`);
	for (const name of shots) assert.deepEqual(pngSize(join(root, "store/screenshots", name)), [1280, 800], name);
	assert.deepEqual(pngSize(join(root, "store/promo-small.png")), [440, 280]);
	assert.deepEqual(pngSize(join(root, "store/promo-marquee.png")), [1400, 560]);
	assert.deepEqual(pngSize(join(root, "static/icon-128.png")), [128, 128]);
	const listing = readFileSync(join(root, "store/listing.md"), "utf8");
	for (const name of shots) assert.ok(listing.includes(`store/screenshots/${name}`), `listing.md does not list ${name}`);
});
