// The product is called Tychicus. Fails when "Polycarp" or "Tabkyra" appears in text a person can see: the extension's
// source, its static pages, the helper's source, and the manifest. Polycarp is a separate Mac and Windows app, and some
// text is genuinely about it: its Mac helper (polycarp-spaces) that the computer tools call, the commands and
// folders Tychicus imports from or steps around. Those lines match KEPT below, or carry the marker comment. What stays
// on purpose (MCP tool names, the manifest key, stored data, the fallbacks that keep older installs working) is written
// in AGENTS.md ("Names that keep the old name") and is lowercase or an identifier, which this scan leaves alone. The
// renamed identifiers (native host, socket folder, hub headers, User-Agent, npm command) are guarded below so the old
// ones come back only as the named fallbacks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Lines that may say Tabkyra, by file, with the reason. A line carrying the marker comment is allowed too. */
const ALLOW = new Map([
	// The setup prompt names the section heading and the clone folder that earlier setups made.
	["src/agent-setup-prompt.ts", "earlier section heading and clone folder"],
	// The skill gate: its rules and tests match on these words (the install marker, the old skill name tabkyra), and the lint, its
	// router and the catalog are maintainer-reviewed. They change only in a change that is about them.
	["cli/src/skill-lint.ts", "skill lint matches the install marker"],
	["cli/src/skill-router.ts", "router reads tabkyra as the polycarp-browser skill's old name"],
	["cli/src/skills-catalog.ts", "generated from skills/, which keep their names"],
]);
/**
 * Files whose subject is the Polycarp app itself, so "Polycarp" in their prose is right. They are still held to the
 * old-command check: `remote import-polycarp` moves Polycarp's connector over and says what it found of Polycarp's.
 */
const ABOUT_POLYCARP = new Set(["cli/src/import-polycarp.ts"]);
const MARKER = "product-name allowlist";

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (name === "node_modules" || name === "dist" || name === "dist-chrome") continue;
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (/\.(ts|js|mjs|html|json|css)$/.test(name)) yield path;
	}
}

const TEXT_DIRS = ["src", "static", "cli/src"];
// Capitalized in prose, also right after a "\n" escape in source, where there is no word boundary to see.
const CAPITAL = /\bTabkyra\b/;
// Lowercase in prose: "the tabkyra side panel", "the matching tabkyra command". The command, the MCP server name, the host
// name and the folders are lowercase too, but none of them is followed by one of these words.
const PROSE = /(?<![/\w.@-])tabkyra (?:side panel|panel|command|extension|helper|app|host|bridge|cli)\b/i;
// "tabkyra setup" in text a person reads: the command to type is `tychicus setup`.
const COMMAND = /(?<![/\w.@-])tabkyra (?=(?:setup|doctor|install|update|reload|status|allow|deny|skill|theme|serve|hub|link|remote|token|threads|sessions|tabs|library|debug|host|pi-extension|copilot-sdk|completion|version|help|tunnel|sessions|reload)\b)/;

// The old name inside a sentence a person reads: "Use tabkyra to open...", "through tabkyra mcp". Comment lines are not read by anyone.
const SENTENCE = /(?<![/\w.@-])tabkyra mcp\b|\bUse tabkyra\b/;
const COMMENT = /^\s*(?:\/\/|\/?\*)/;

test("no user-visible text says Tabkyra", () => {
	const found = [];
	for (const dir of TEXT_DIRS) {
		for (const file of walk(join(root, dir))) {
			const rel = relative(root, file);
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((raw, i) => {
					// "\nTabkyra" in source has no word boundary; read the escapes as the spaces they print as.
					const line = raw.replace(/\\[nrt]/g, " ");
					if (!CAPITAL.test(line) && !COMMAND.test(line) && !PROSE.test(line) && !(SENTENCE.test(line) && !COMMENT.test(raw))) return;
					if (raw.includes(MARKER) || ALLOW.has(rel)) return;
					found.push(`${rel}:${i + 1}: ${raw.trim().slice(0, 100)}`);
				});
		}
	}
	assert.deepEqual(found, [], `say Tychicus, or \`tychicus <command>\`:\n${found.slice(0, 20).join("\n")}`);
});

/** Lines that may say Polycarp, by file, with the reason. Each file here names Polycarp only as an old name it still reads. */
const POLYCARP_ALLOW = new Map([
	// The compiled helper inside the Polycarp app calls itself `polycarp browser`, and a checkout linked before the rename
	// answers to `polycarp-browser`: the name is shown as the helper was started.
	["cli/src/self.ts", "the names the helper may have been started under"],
	// The skill gate and its router read the old skill names, and the catalog is generated from skills/.
	["cli/src/skill-lint.ts", "skill lint matches the install marker and the old command names"],
	["cli/src/skill-router.ts", "router reads polycarp-browser and tabkyra as the browser skill"],
	["cli/src/skills-catalog.ts", "generated from skills/, which keep their names"],
]);

/**
 * Text that is about Polycarp the separate app, and stays: its Mac app and helper (polycarp-spaces, which the computer
 * tools call), the app's own update command, and the connector
 * `remote import-polycarp` moves over, and the move of agents off Polycarp's browser MCP server (`tychicus setup --agents`,
 * cli/src/agent-migration.ts), which names the server it moves them from.
 */
const KEPT = /Polycarp(?:'s)? (?:Mac )?app\b|Polycarp\.app|polycarp-spaces|Polycarp's computer-use helper|Polycarp's Mac helper|Tychicus or Polycarp serve|install Polycarp from its releases page|import-polycarp|part of Polycarp, which updates it|`polycarp update`|Polycarp's browser MCP\b|agents from Polycarp\b|Polycarp drops its browser/;

// Capitalized in prose, also right after a "\n" escape in source.
const POLYCARP = /\bPolycarp\b/;
// The old command, the old repo and the old log prefixes in text a person reads: `polycarp browser setup`,
// `polycarp-browser doctor`, github.com/baney75/polycarp, "[polycarp-host] ...".
const POLYCARP_COMMAND =
	/(?<![/\w.@-])polycarp(?: |-)browser (?=(?:setup|doctor|install|update|reload|status|allow|deny|skill|theme|serve|hub|link|remote|token|threads|sessions|tabs|library|debug|host|pi-extension|completion|version|help|tunnel|mcp)\b)|github\.com\/baney75\/polycarp\b|\[polycarp(?:-host)?\]|\bpolycarp\.(?:yourdomain|example)\.com|dbaney\.com\/polycarp/;

test("no user-visible text says Polycarp, except about the Polycarp app", () => {
	const found = [];
	for (const dir of TEXT_DIRS) {
		for (const file of walk(join(root, dir))) {
			const rel = relative(root, file);
			if (POLYCARP_ALLOW.has(rel)) continue;
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((raw, i) => {
					if (COMMENT.test(raw)) return;
					const line = raw.replace(/\\[nrt]/g, " ");
					const prose = POLYCARP.test(line) && !ABOUT_POLYCARP.has(rel);
					if (!prose && !POLYCARP_COMMAND.test(line)) return;
					if (raw.includes(MARKER) || KEPT.test(line)) return;
					found.push(`${rel}:${i + 1}: ${raw.trim().slice(0, 100)}`);
				});
		}
	}
	assert.deepEqual(found, [], `say Tychicus, or \`tychicus <command>\` (${found.length} lines):\n${found.slice(0, 40).join("\n")}`);
});

test("the product-name scan catches the old name and lets the Polycarp app's own text through", () => {
	const flagged = (line) => (POLYCARP.test(line) || POLYCARP_COMMAND.test(line)) && !KEPT.test(line);
	for (const line of ['html`<h1>Welcome to Polycarp</h1>`', '"Run polycarp-browser doctor"', "`polycarp browser setup`", "https://github.com/baney75/polycarp", "[polycarp-host] bad frame", "polycarp.yourdomain.com", "Polycarp's helper isn't connected", "Polycarp theme in use: Still Water. To change it, run polycarp theme set <name>."])
		assert.ok(flagged(line), line);
	for (const line of ["Computer use needs Polycarp's Mac app on a Mac.", "through polycarp-spaces", "the owner's approval in the Polycarp app", "remote import-polycarp", "polycarpMark(18)", "Claude Code still runs Polycarp's browser MCP server (polycarp)", "Move agents from Polycarp (dry run)", "when Polycarp drops its browser, these lose their browser tools."])
		assert.ok(!flagged(line), line);
	// "approval" starts with "app", which must not pass as the Polycarp app.
	assert.ok(flagged("this computer's Polycarp approval address"));
});

function manifests() {
	const list = [join(root, "static/manifest.chrome.json")];
	const built = join(root, "dist-chrome/manifest.json");
	if (existsSync(built)) list.push(built);
	return list;
}

test("the manifest and every locale file name the product Tychicus", () => {
	for (const file of manifests()) {
		const m = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(m.name, "Tychicus", file);
		assert.doesNotMatch(String(m.description), /tabkyra/i, file);
		assert.doesNotMatch(String(m.action?.default_title), /tabkyra/i, file);
		assert.equal(m.default_locale, undefined, "a locale would need scanning too");
	}
	for (const base of [join(root, "static/_locales"), join(root, "_locales")]) {
		if (!existsSync(base)) continue;
		for (const file of walk(base)) assert.doesNotMatch(readFileSync(file, "utf8"), /tabkyra/i, file);
	}
});

test("the extension id still comes from the unchanged manifest key", () => {
	// Every installed host manifest allows only this id (D54), so a changed key cuts off every install. The id is pinned
	// here on purpose, apart from src/bridge/extension-id.json, so changing the key and the constant together still fails.
	const m = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));
	const hex = createHash("sha256").update(Buffer.from(m.key, "base64")).digest("hex").slice(0, 32);
	const id = [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
	assert.equal(id, "igjafcggmahiboobmnhfkndodphjdnhg");
	assert.equal(JSON.parse(readFileSync(join(root, "src/bridge/extension-id.json"), "utf8")).id, id);
});

test("the extension's stored data keeps its names", () => {
	// A renamed storage key or database would hide a person's chats, keys and skills after the update, so the storage code
	// may say Polycarp only in comments.
	const storage = readFileSync(join(root, "src/storage/app-storage.ts"), "utf8");
	assert.match(storage, /class TabkyraAppStorage/);
	for (const file of walk(join(root, "src/storage"))) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (/Polycarp/.test(line)) assert.match(line.trim(), /^(\/\/|\/?\*)/, `${relative(root, file)}: ${line.trim()}`);
		}
	}
});

// The identifiers renamed from tabkyra, and the code lines that may still hold the old one: each is a fallback for an install
// made before the rename (AGENTS.md says how long they stay). Comments are not counted. A new use fails here.
const RENAMED = /ai\.tabkyra\.bridge|tabkyra-bridge|x-tabkyra-hub|tabkyra-cli/;
const RENAMED_ALLOWED = new Map([
	["src/bridge/native.ts", 1], // the keepalive alarm's name, which no one sees
	["cli/src/remote.ts", 2], // LEGACY_HUB_SCOPES_HEADER and LEGACY_HUB_CALLER_HEADER
]);

test("renamed identifiers come back only as the named fallbacks", () => {
	const counts = new Map();
	const found = [];
	for (const dir of TEXT_DIRS) {
		for (const file of walk(join(root, dir))) {
			const rel = relative(root, file);
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (!RENAMED.test(line) || COMMENT.test(line)) return;
					counts.set(rel, (counts.get(rel) ?? 0) + 1);
					found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
				});
		}
	}
	assert.deepEqual(Object.fromEntries(counts), Object.fromEntries(RENAMED_ALLOWED), `use com.polycarp.browser, polycarp-bridge, x-polycarp-hub or USER_AGENT:\n${found.join("\n")}`);
});

test("the helper's npm package installs only tychicus: polycarp and polycarp-browser are Polycarp's commands", () => {
	const pkg = JSON.parse(readFileSync(join(root, "cli/package.json"), "utf8"));
	assert.deepEqual(Object.keys(pkg.bin).sort(), ["tychicus"], "no polycarp, tabkyra or sitegeist alias");
	const lock = JSON.parse(readFileSync(join(root, "cli/package-lock.json"), "utf8"));
	// npm writes the lockfile's names sorted, so the order is not part of the check.
	assert.deepEqual(Object.keys(lock.packages[""].bin ?? {}).sort(), ["tychicus"], "the lockfile agrees");
});
