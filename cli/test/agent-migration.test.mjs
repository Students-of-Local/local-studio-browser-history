// Moving agents from Polycarp (agent-migration.ts): five harness configs in a fake HOME. Claude Code runs Polycarp's
// browser MCP (and so does one of its projects), Codex has only other servers, Cursor already has tychicus beside an
// old tabkyra entry, OMP's file is not valid JSON, and OpenCode runs Polycarp's old browser launcher in a JSONC file.
// A dry run writes nothing; a real run backs each file up first and points only those entries at Tychicus under their
// old names; a second run changes nothing; the finish step renames the aliases to tychicus.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { loadTs } from "./helpers/bundle-ts.mjs";

// `export *`: a name the source doesn't have is undefined, not a build error, so the tests that use only planMigration
// and applyMigration also run against an older agent-migration.ts.
const m = await loadTs(`export * from "@src/agent-migration.ts";`);
const { applyMigration, launchesPolycarpBrowser, planMigration, unifiedDiff } = m;

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "tychicus-migrate-"));
after(() => rmSync(root, { recursive: true, force: true }));

const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TYCHICUS_CONFIG_DIR", "POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR"];

/** Run `fn` with HOME at a fresh folder, the config overrides cleared and Tychicus's config folder inside it. */
function inHome(name, fn) {
	const home = join(root, name);
	mkdirSync(home, { recursive: true });
	const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.HOME = home;
	process.env.TYCHICUS_CONFIG_DIR = join(home, ".config", "tychicus");
	try {
		return fn(home);
	} finally {
		for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
}

function put(file, text, mode) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	if (mode) chmodSync(file, mode);
}

/** A TOML text as plain objects: smol-toml makes inline tables with a null prototype. */
const parseToml = (text) => JSON.parse(JSON.stringify(parse(text)));

const backups = (file) => readdirSync(dirname(file)).filter((f) => f.startsWith(`${basename(file)}.tychicus-backup-`));
const aliasList = () => m.readAliases().map((a) => `${a.harness}:${a.name}`).sort();

const CLAUDE = `{
  "numStartups": 412,
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    },
    "polycarp": {
      "type": "stdio",
      "command": "polycarp",
      "args": [
        "browser",
        "mcp"
      ],
      "env": {
        "POLYCARP_SESSION": "claude"
      }
    }
  },
  "projects": {
    "/work/app": {
      "mcpServers": {
        "polycarp": { "type": "stdio", "command": "polycarp", "args": ["browser", "mcp"] }
      }
    }
  }
}
`;

const CODEX = `model = "gpt-6.1-sol"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

# The Polycarp app's own server, not its browser.
[mcp_servers.polycarp-app]
command = "polycarp"
args = ["mcp"]
`;

const CURSOR = `{
	"mcpServers": {
		"tychicus": {
			"command": "/opt/tychicus/tychicus",
			"args": ["mcp"]
		},
		"tabkyra": {
			"command": "tabkyra",
			"args": ["mcp"]
		}
	}
}
`;

const OMP = `{
  "mcpServers": {
    "polycarp": { "type": "stdio", "command": "polycarp", "args": ["browser", "mcp"], },
  }
}
`;

/** OpenCode reads JSONC: a comment and a trailing comma, both kept by the move. */
function opencode(home) {
	return `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    // The browser, from Polycarp.
    "polycarp": {
      "type": "local",
      "command": ["${home}/.config/polycarp/browser/polycarp", "mcp"],
      "enabled": true,
    },
  },
}
`;
}

/** The five files in `home`; Cursor's is a link into a dotfiles folder, as stow makes it. */
function fixtures(home) {
	const files = {
		claude: join(home, ".claude.json"),
		codex: join(home, ".codex", "config.toml"),
		opencode: join(home, ".config", "opencode", "opencode.json"),
		cursor: join(home, ".cursor", "mcp.json"),
		omp: join(home, ".omp", "agent", "mcp.json"),
	};
	put(files.claude, CLAUDE, 0o600);
	put(files.codex, CODEX);
	put(files.opencode, opencode(home));
	const dotfile = join(home, "dotfiles", "cursor-mcp.json");
	put(dotfile, CURSOR);
	mkdirSync(dirname(files.cursor), { recursive: true });
	symlinkSync(dotfile, files.cursor);
	put(files.omp, OMP);
	return { files, dotfile };
}

/** OpenCode's JSONC, read the way OpenCode reads it, for checking a result. */
function jsonc(text) {
	return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
}

test("the browser MCP commands are recognized, and nothing else is", () => {
	assert.equal(launchesPolycarpBrowser("polycarp", ["browser", "mcp"]), true);
	assert.equal(launchesPolycarpBrowser("/opt/homebrew/bin/polycarp", ["browser", "mcp"]), true);
	assert.equal(launchesPolycarpBrowser("polycarp-browser", ["mcp"]), true);
	assert.equal(launchesPolycarpBrowser("tabkyra", ["mcp"]), true);
	assert.equal(launchesPolycarpBrowser("/Users/d/.config/tabkyra/tabkyra", ["mcp"]), true);
	assert.equal(launchesPolycarpBrowser("/Users/d/.config/polycarp/browser/polycarp", ["mcp"]), true);
	assert.equal(launchesPolycarpBrowser("C:\\Users\\d\\.config\\polycarp\\browser\\polycarp.cmd", ["mcp"]), true);
	// The Polycarp app's own server, other commands of the same programs, and other servers.
	assert.equal(launchesPolycarpBrowser("polycarp", ["mcp"]), false);
	assert.equal(launchesPolycarpBrowser("polycarp", ["browser", "serve"]), false);
	assert.equal(launchesPolycarpBrowser("polycarp-browser", ["mcp", "--name", "x"]), false);
	assert.equal(launchesPolycarpBrowser("/Users/d/.config/tychicus/tychicus", ["mcp"]), false);
	assert.equal(launchesPolycarpBrowser("npx", ["-y", "polycarp-browser", "mcp"]), false);
});

test("five harnesses: dry run, then the old entries run Tychicus under their old names, one server each, with backups; a second run changes nothing", () => {
	inHome("five", (home) => {
		const { files, dotfile } = fixtures(home);
		const bin = join(home, ".config", "tychicus", "tychicus");
		const original = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, "utf8")]));

		// Dry run: the plan, and nothing on disk changes.
		const plans = planMigration(bin);
		const by = Object.fromEntries(plans.map((p) => [p.harness, p]));
		assert.equal(by.claude.status, "change");
		assert.deepEqual(by.claude.repointed, [{ name: "polycarp", from: "polycarp browser mcp" }]);
		// Claude Code's project scope is named, not edited (first-F2).
		assert.deepEqual(by.claude.projects, [{ project: "/work/app", name: "polycarp", from: "polycarp browser mcp" }]);
		assert.equal(by.codex.status, "unchanged", "an unrelated MCP and the Polycarp app's own server are left alone");
		assert.equal(by.cursor.status, "change");
		assert.deepEqual(by.cursor.repointed, [{ name: "tabkyra", from: "tabkyra mcp" }]);
		assert.match(by.cursor.notes.join("\n"), /two Tychicus servers until the rename removes the old name/);
		assert.equal(by.omp.status, "refused");
		assert.equal(by.omp.blocking, true, "a file naming polycarp that doesn't parse is a failure");
		assert.match(by.omp.reason, /isn't valid JSON/);
		assert.equal(by.opencode.status, "change", "OpenCode's JSONC is read");
		assert.equal(by.opencode.repointed[0].from, `${home}/.config/polycarp/browser/polycarp mcp`);
		for (const [k, f] of Object.entries(files)) {
			assert.equal(readFileSync(f, "utf8"), original[k], `dry run changed ${k}`);
			assert.deepEqual(backups(f), [], `dry run made a backup of ${k}`);
		}

		// The exact before and after for Claude Code, as `diff -u` prints it: only the command and args change.
		assert.equal(
			unifiedDiff(files.claude, by.claude.before, by.claude.after),
			[
				`--- ${files.claude}`,
				`+++ ${files.claude} (after)`,
				"@@ -8,11 +8,8 @@",
				"     },",
				'     "polycarp": {',
				'       "type": "stdio",',
				'-      "command": "polycarp",',
				'-      "args": [',
				'-        "browser",',
				'-        "mcp"',
				"-      ],",
				`+      "command": "${bin}",`,
				'+      "args": ["mcp"],',
				'       "env": {',
				'         "POLYCARP_SESSION": "claude"',
				"       }",
			].join("\n"),
		);

		// Every printed diff is what `diff -u` prints for the same two texts (where diff is installed).
		for (const plan of plans.filter((p) => p.status === "change")) {
			const a = join(root, `${plan.harness}.before`);
			const b = join(root, `${plan.harness}.after`);
			writeFileSync(a, plan.before);
			writeFileSync(b, plan.after);
			const real = spawnSync("diff", ["-u", a, b], { encoding: "utf8" });
			if (real.error) break;
			const body = (text) => text.replace(/\n$/, "").split("\n").slice(2).join("\n");
			assert.equal(body(unifiedDiff(plan.file, plan.before, plan.after)), body(real.stdout), `${plan.harness}: the diff matches diff -u`);
		}

		// A real run, into a config folder that doesn't exist yet.
		assert.equal(existsSync(process.env.TYCHICUS_CONFIG_DIR), false);
		const stamp = new Date("2026-11-17T20:00:00Z");
		const written = applyMigration(plans, stamp);
		assert.deepEqual(written.map((w) => w.file).sort(), [files.claude, files.cursor, files.opencode].sort());
		for (const { file, backup } of written) {
			assert.equal(backup, `${file}.tychicus-backup-20261117T200000Z`);
			assert.equal(readFileSync(backup, "utf8"), original[Object.keys(files).find((k) => files[k] === file)], "the backup is the file as it was");
		}
		assert.equal(statSync(`${files.claude}.tychicus-backup-20261117T200000Z`).mode & 0o777, 0o600, "the backup keeps the file's permissions");
		assert.equal(statSync(files.claude).mode & 0o777, 0o600, "the file keeps its permissions");

		// One server per agent: the old entry runs Tychicus, and no second tychicus entry is added (second-F7).
		const claude = JSON.parse(readFileSync(files.claude, "utf8"));
		assert.deepEqual(claude.mcpServers.polycarp, { type: "stdio", command: bin, args: ["mcp"], env: { POLYCARP_SESSION: "claude" } });
		assert.deepEqual(Object.keys(claude.mcpServers), ["github", "polycarp"]);
		assert.deepEqual(claude.mcpServers.github, JSON.parse(CLAUDE).mcpServers.github);
		assert.deepEqual(claude.projects, JSON.parse(CLAUDE).projects, "project scope is not touched");
		assert.equal(claude.numStartups, 412);

		const cursor = JSON.parse(readFileSync(files.cursor, "utf8"));
		assert.deepEqual(cursor.mcpServers.tychicus, { command: "/opt/tychicus/tychicus", args: ["mcp"] }, "an existing tychicus entry is kept as it was");
		assert.deepEqual(cursor.mcpServers.tabkyra, { command: bin, args: ["mcp"] });
		assert.ok(lstatSync(files.cursor).isSymbolicLink(), "a linked config stays a link");
		assert.equal(readFileSync(dotfile, "utf8"), readFileSync(files.cursor, "utf8"));
		assert.match(readFileSync(files.cursor, "utf8"), /^\t\t"tabkyra": \{$/m, "the file's tab indent is kept");

		const ocText = readFileSync(files.opencode, "utf8");
		assert.equal(ocText, opencode(home).replace(`["${home}/.config/polycarp/browser/polycarp", "mcp"]`, `["${bin}", "mcp"]`), "only the command changes; the comment and trailing commas stay");
		assert.deepEqual(Object.keys(jsonc(ocText).mcp), ["polycarp"]);

		assert.equal(readFileSync(files.omp, "utf8"), OMP, "the malformed file is not written");
		assert.deepEqual(backups(files.omp), []);
		assert.equal(readFileSync(files.codex, "utf8"), CODEX);
		assert.deepEqual(backups(files.codex), []);

		// Polycarp's own folder is never created or written.
		assert.equal(existsSync(join(home, ".config", "polycarp")), false);

		// The aliases are recorded as temporary, in the config folder the run made.
		const record = JSON.parse(readFileSync(join(home, ".config", "tychicus", "agent-aliases.json"), "utf8"));
		assert.match(record.note, /^Temporary/);
		assert.deepEqual(aliasList(), ["claude:polycarp", "cursor:tabkyra", "opencode:polycarp"]);
		assert.equal(m.liveAlias("claude")?.name, "polycarp", "setup and doctor see Claude Code's Tychicus through the alias");
		assert.equal(m.liveAlias("codex"), undefined);

		// A second run: nothing to move, nothing written, no new backups.
		const again = planMigration(bin);
		assert.deepEqual(
			again.map((p) => `${p.harness}:${p.status}`),
			["claude:unchanged", "codex:unchanged", "opencode:unchanged", "cursor:unchanged", "omp:refused"],
		);
		const now = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, "utf8")]));
		assert.deepEqual(applyMigration(again, new Date("2026-11-17T21:00:00Z")), []);
		for (const [k, f] of Object.entries(files)) {
			assert.equal(readFileSync(f, "utf8"), now[k], `the second run changed ${k}`);
			assert.ok(backups(f).length <= 1, `the second run backed up ${k}`);
		}
		assert.equal(aliasList().length, 3, "the alias list doesn't grow");

		// The finish step renames each alias to tychicus in place; Cursor's tychicus runs another command, so its alias
		// stays for a manual fix. A backup made in the same second as the move's gets its own name.
		const finish = m.planFinish(bin);
		const fin = Object.fromEntries(finish.map((p) => [p.harness, p]));
		assert.deepEqual(fin.claude.finished, [{ name: "polycarp", action: "renamed" }]);
		assert.deepEqual(fin.opencode.finished, [{ name: "polycarp", action: "renamed" }]);
		assert.equal(fin.cursor.status, "unchanged");
		assert.match(fin.cursor.leftAlone[0], /the tychicus entry runs \/opt\/tychicus\/tychicus mcp\. Remove one of the two by hand/);
		const finished = applyMigration(finish, stamp);
		assert.deepEqual(finished.map((w) => w.backup).sort(), [`${files.claude}.tychicus-backup-20261117T200000Z-2`, `${files.opencode}.tychicus-backup-20261117T200000Z-2`].sort());
		assert.equal(readFileSync(`${files.claude}.tychicus-backup-20261117T200000Z`, "utf8"), original.claude, "the move's backup is kept");
		const done = JSON.parse(readFileSync(files.claude, "utf8"));
		assert.deepEqual(Object.keys(done.mcpServers), ["github", "tychicus"], "renamed in place");
		assert.deepEqual(done.mcpServers.tychicus, { type: "stdio", command: bin, args: ["mcp"], env: { POLYCARP_SESSION: "claude" } });
		assert.equal(readFileSync(files.opencode, "utf8"), ocText.replace('"polycarp": {', '"tychicus": {'));
		assert.deepEqual(aliasList(), ["cursor:tabkyra"], "finished aliases leave the list");
		assert.equal(m.liveAlias("claude"), undefined);

		// Finishing again changes nothing.
		const before = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, "utf8")]));
		assert.deepEqual(applyMigration(m.planFinish(bin), new Date("2026-11-17T22:00:00Z")), []);
		for (const [k, f] of Object.entries(files)) assert.equal(readFileSync(f, "utf8"), before[k], `a second finish changed ${k}`);
		assert.deepEqual(aliasList(), ["cursor:tabkyra"]);
	});
});

// The config folder exists in the race tests, so they fail on the race itself and not on second-F6's missing folder.
test("first-F1, sol-F2: a change made elsewhere in the file while the user decides survives the move", () => {
	inHome("race", (home) => {
		const file = join(home, ".claude.json");
		const bin = join(home, ".config", "tychicus", "tychicus");
		mkdirSync(process.env.TYCHICUS_CONFIG_DIR, { recursive: true });
		put(file, CLAUDE, 0o600);
		const [plan] = planMigration(bin).filter((p) => p.harness === "claude");
		assert.equal(plan.status, "change");
		// Claude Code bumps a counter while the user reads the diff.
		const bumped = CLAUDE.replace('"numStartups": 412', '"numStartups": 413');
		writeFileSync(file, bumped);
		applyMigration([plan], new Date("2026-11-17T20:00:00Z"));
		const moved = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(moved.numStartups, 413, "the change made while the user decided is kept");
		assert.equal(moved.mcpServers.polycarp.command, bin, "and the entry still moves");
		assert.equal(readFileSync(`${file}.tychicus-backup-20261117T200000Z`, "utf8"), bumped, "the backup is the file as it was just before the write");
	});
});

test("first-F1, sol-F2: a file whose entry changed while the user decides is refused, with nothing written", () => {
	inHome("race-entry", (home) => {
		const file = join(home, ".claude.json");
		const bin = join(home, ".config", "tychicus", "tychicus");
		mkdirSync(process.env.TYCHICUS_CONFIG_DIR, { recursive: true });
		put(file, CLAUDE, 0o600);
		const [plan] = planMigration(bin).filter((p) => p.harness === "claude");
		assert.equal(plan.status, "change");
		// The entry the user said yes to gets new arguments, so the approved plan no longer fits it.
		const edited = CLAUDE.replace('"args": [\n        "browser",\n        "mcp"\n      ]', '"args": ["browser", "mcp", "--session", "x"]');
		assert.notEqual(edited, CLAUDE);
		writeFileSync(file, edited);
		assert.deepEqual(applyMigration([plan], new Date("2026-11-17T20:00:00Z")), []);
		assert.equal(readFileSync(file, "utf8"), edited, "the file is left as the other writer left it");
		assert.deepEqual(backups(file), []);
		assert.equal(plan.status, "refused");
		assert.match(plan.reason, /changed while you were deciding; run .* setup --agents again/);
		assert.equal(existsSync(join(process.env.TYCHICUS_CONFIG_DIR, "agent-aliases.json")), false, "no alias is recorded");
	});
});

test("sol-F1: Codex with an inline tychicus table: the move and the finish both leave a config that parses", () => {
	inHome("codex-inline", (home) => {
		const file = join(home, ".codex", "config.toml");
		const bin = join(home, ".config", "tychicus", "tychicus");
		mkdirSync(process.env.TYCHICUS_CONFIG_DIR, { recursive: true });
		const text = `model = "gpt-6.1-sol"

[mcp_servers]
tychicus = { command = "/opt/tychicus/tychicus", args = ["mcp"] }

[mcp_servers.polycarp]
command = "polycarp" # the old helper
args = ["browser", "mcp"]
startup_timeout_sec = 30

[mcp_servers.polycarp.env]
POLYCARP_SESSION = "codex"
`;
		put(file, text);
		assert.deepEqual(Object.keys(parseToml(text).mcp_servers), ["tychicus", "polycarp"]);
		const [plan] = planMigration(bin).filter((p) => p.harness === "codex");
		assert.equal(plan.status, "change");
		const parsed = parseToml(plan.after);
		assert.deepEqual(parsed.mcp_servers.tychicus, { command: "/opt/tychicus/tychicus", args: ["mcp"] }, "the inline tychicus table is kept as it was");
		assert.deepEqual(parsed.mcp_servers.polycarp, { command: bin, args: ["mcp"], startup_timeout_sec: 30, env: { POLYCARP_SESSION: "codex" } });
		assert.equal(plan.after, text.replace('command = "polycarp" # the old helper\nargs = ["browser", "mcp"]', `command = "${bin}"\nargs = ["mcp"]`));
		applyMigration([plan], new Date("2026-11-17T20:00:00Z"));
		parseToml(readFileSync(file, "utf8"));

		// The finish: the inline tychicus runs another command, so the alias waits for a manual fix and the file stays.
		const [held] = m.planFinish(bin);
		assert.equal(held.status, "unchanged");
		assert.match(held.leftAlone[0], /Remove one of the two by hand/);

		// The same launcher but without the alias's timeout and env: removing the alias would drop them, so it stays.
		const moved = readFileSync(file, "utf8");
		writeFileSync(file, moved.replace('"/opt/tychicus/tychicus"', JSON.stringify(bin)));
		const [partial] = m.planFinish(bin);
		assert.equal(partial.status, "unchanged");
		assert.match(partial.leftAlone[0], /runs the same command as the tychicus entry but differs in "startup_timeout_sec", "env"/);

		// With the inline tychicus the same in every field, the alias and its env table go, and the file parses.
		const full = `{ command = ${JSON.stringify(bin)}, args = ["mcp"], startup_timeout_sec = 30, env = { POLYCARP_SESSION = "codex" } }`;
		writeFileSync(file, moved.replace('{ command = "/opt/tychicus/tychicus", args = ["mcp"] }', full));
		const [finish] = m.planFinish(bin);
		assert.deepEqual(finish.finished, [{ name: "polycarp", action: "removed" }]);
		applyMigration([finish], new Date("2026-11-17T21:00:00Z"));
		assert.deepEqual(parseToml(readFileSync(file, "utf8")).mcp_servers, { tychicus: { command: bin, args: ["mcp"], startup_timeout_sec: 30, env: { POLYCARP_SESSION: "codex" } } });
		assert.deepEqual(m.readAliases(), []);
	});
});

test("Codex: a browser MCP table is repointed in place, and the finish renames it and its env table to tychicus", () => {
	inHome("codex", (home) => {
		const file = join(home, ".codex", "config.toml");
		const text = `model = "gpt-6.1-sol"

[mcp_servers.polycarp]
command = "polycarp" # the old helper
args = [
  "browser",
  "mcp",
]
startup_timeout_sec = 30

[mcp_servers.polycarp.env]
POLYCARP_SESSION = "codex"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
`;
		put(file, text);
		const bin = "/home/u/.config/tychicus/tychicus";
		const [plan] = planMigration(bin).filter((p) => p.harness === "codex");
		assert.equal(plan.status, "change");
		assert.equal(plan.after, text.replace('command = "polycarp" # the old helper\nargs = [\n  "browser",\n  "mcp",\n]', `command = "${bin}"\nargs = ["mcp"]`));
		applyMigration([plan], new Date("2026-11-17T20:00:00Z"));
		assert.equal(readFileSync(`${file}.tychicus-backup-20261117T200000Z`, "utf8"), text);
		assert.equal(planMigration(bin).find((p) => p.harness === "codex").status, "unchanged");

		const [finish] = m.planFinish(bin);
		assert.deepEqual(finish.finished, [{ name: "polycarp", action: "renamed" }]);
		assert.equal(finish.after, plan.after.replace("[mcp_servers.polycarp]", "[mcp_servers.tychicus]").replace("[mcp_servers.polycarp.env]", "[mcp_servers.tychicus.env]"));
		applyMigration([finish], new Date("2026-11-17T21:00:00Z"));
		assert.deepEqual(Object.keys(parseToml(readFileSync(file, "utf8")).mcp_servers), ["tychicus", "github"]);
	});
});

test("second-F5: a JSONC or trailing-comma config with no Polycarp entry doesn't fail setup", () => {
	inHome("jsonc", (home) => {
		put(join(home, ".config", "opencode", "opencode.json"), `{\n  // my servers\n  "mcp": {\n    "github": { "type": "local", "command": ["npx", "-y", "gh-mcp"], },\n  },\n}\n`);
		put(join(home, ".omp", "agent", "mcp.json"), `{ "mcpServers": { "github": { "command": "npx", "args": ["gh-mcp"], }, } }\n`);
		const env = { HOME: home, PATH: join(home, "no-bin"), TYCHICUS_CONFIG_DIR: join(home, ".config", "tychicus"), TABKYRA_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
		for (const args of [["setup", "--agents", "--dry-run"], ["setup", "--agents", "--yes"]]) {
			const run = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, input: "", timeout: 60000 });
			const out = run.stdout + run.stderr;
			assert.equal(run.status, 0, `${args.join(" ")} exits 0:\n${out}`);
			assert.match(out, /OMP: .* was not read: it isn't valid JSON .* It names neither polycarp nor tabkyra/, "the file that doesn't parse is a warning");
			assert.doesNotMatch(out, /OpenCode: .* was not/, "OpenCode's JSONC is read");
			assert.doesNotMatch(out, /OpenCode: couldn't tell/, "and setup's own check of OpenCode reads it too");
		}
		const plans = planMigration("/t/tychicus");
		assert.equal(plans.find((p) => p.harness === "omp").blocking, false);
		assert.equal(plans.find((p) => p.harness === "opencode").status, "unchanged");
	});
});

test("second-F6: when a later file's write fails, the aliases already moved are recorded", { skip: process.getuid?.() === 0 && "root can write anywhere" }, () => {
	inHome("partial", (home) => {
		const bin = join(home, ".config", "tychicus", "tychicus");
		process.env.TYCHICUS_CONFIG_DIR = join(home, "not-yet", "tychicus");
		put(join(home, ".claude.json"), CLAUDE);
		const locked = join(home, ".cursor");
		const second = `{\n  "mcpServers": {\n    "polycarp": { "command": "polycarp", "args": ["browser", "mcp"] }\n  }\n}\n`;
		put(join(locked, "mcp.json"), second);
		const plans = planMigration(bin);
		assert.deepEqual(plans.filter((p) => p.status === "change").map((p) => p.harness), ["claude", "cursor"]);
		chmodSync(locked, 0o555);
		try {
			assert.throws(() => applyMigration(plans, new Date("2026-11-17T20:00:00Z")), /EACCES|EPERM/);
		} finally {
			chmodSync(locked, 0o755);
		}
		assert.equal(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.polycarp.command, bin, "the first file was written");
		const record = JSON.parse(readFileSync(join(home, "not-yet", "tychicus", "agent-aliases.json"), "utf8"));
		assert.deepEqual(
			record.aliases.map((a) => `${a.harness}:${a.name}`),
			["claude:polycarp"],
			"its alias is recorded, in a config folder made for it",
		);
		assert.equal(readFileSync(join(locked, "mcp.json"), "utf8"), second, "the second file is untouched");
	});
});

test("an entry with extra arguments after mcp is named, not moved", () => {
	inHome("extra", (home) => {
		const file = join(home, ".cursor", "mcp.json");
		const text = `{\n  "mcpServers": {\n    "polycarp": { "command": "polycarp-browser", "args": ["mcp", "--session", "cursor"] }\n  }\n}\n`;
		put(file, text);
		const [plan] = planMigration("/t/tychicus").filter((p) => p.harness === "cursor");
		assert.equal(plan.status, "unchanged");
		assert.match(plan.leftAlone[0], /extra arguments, so it was left alone/);
	});
});

test("a minified config is edited in place on its one line", () => {
	inHome("minified", (home) => {
		const file = join(home, ".omp", "agent", "mcp.json");
		put(file, `{"mcpServers":{"polycarp":{"type":"stdio","command":"polycarp","args":["browser","mcp"],"enabled":true}}}`);
		const [plan] = planMigration("/t/tychicus").filter((p) => p.harness === "omp");
		assert.equal(plan.status, "change");
		assert.equal(plan.after, `{"mcpServers":{"polycarp":{"type":"stdio","command":"/t/tychicus","args":["mcp"],"enabled":true}}}`);
	});
});

test("an entry written on one line stays on one line", () => {
	inHome("one-line", (home) => {
		const file = join(home, ".cursor", "mcp.json");
		put(file, `{\n  "mcpServers": {\n    "polycarp": { "command": "polycarp", "args": ["browser", "mcp"] },\n    "other": { "command": "x" }\n  }\n}\n`);
		const [plan] = planMigration("/t/tychicus").filter((p) => p.harness === "cursor");
		assert.equal(plan.after, `{\n  "mcpServers": {\n    "polycarp": { "command": "/t/tychicus", "args": ["mcp"] },\n    "other": { "command": "x" }\n  }\n}\n`);
	});
});

/** Record aliases the way the move does, for tests that start from a moved config. */
function recordAlias(home, ...aliases) {
	const file = join(process.env.TYCHICUS_CONFIG_DIR, "agent-aliases.json");
	put(file, `${JSON.stringify({ note: "Temporary", aliases: aliases.map(([harness, f, name]) => ({ harness, file: f, name, since: "2026-11-17T20:00:00.000Z" })) }, null, 2)}\n`);
	return file;
}

test("sol-F1 (round 2): the finish removes an alias only when it matches the tychicus entry in every field", () => {
	inHome("finish-fields", (home) => {
		const bin = join(home, ".config", "tychicus", "tychicus");
		const oc = join(home, ".config", "opencode", "opencode.json");
		const claude = join(home, ".claude.json");
		const cursor = join(home, ".cursor", "mcp.json");
		// OpenCode: the alias is the enabled server; tychicus runs the same command but is disabled.
		const ocText = `{\n  "mcp": {\n    "tychicus": { "type": "local", "command": ["${bin}", "mcp"], "enabled": false },\n    "polycarp": { "type": "local", "command": ["${bin}", "mcp"], "enabled": true },\n  },\n}\n`;
		// Claude Code: the same command, but the alias carries env the tychicus entry lacks.
		const claudeText = `{\n  "mcpServers": {\n    "tychicus": { "type": "stdio", "command": "${bin}", "args": ["mcp"] },\n    "polycarp": { "type": "stdio", "command": "${bin}", "args": ["mcp"], "env": { "POLYCARP_SESSION": "claude" } }\n  }\n}\n`;
		// Cursor: the same in every field, in another key order, so the alias goes.
		const cursorText = `{\n  "mcpServers": {\n    "tychicus": { "command": "${bin}", "args": ["mcp"], "env": { "A": "1" } },\n    "polycarp": { "env": { "A": "1" }, "args": ["mcp"], "command": "${bin}" }\n  }\n}\n`;
		put(oc, ocText);
		put(claude, claudeText);
		put(cursor, cursorText);
		recordAlias(home, ["opencode", oc, "polycarp"], ["claude", claude, "polycarp"], ["cursor", cursor, "polycarp"]);
		const plans = m.planFinish(bin);
		const by = Object.fromEntries(plans.map((p) => [p.harness, p]));
		assert.equal(by.opencode.status, "unchanged", "the enabled alias beside a disabled tychicus is kept");
		assert.match(by.opencode.leftAlone[0], /"polycarp" runs the same command as the tychicus entry but differs in "enabled"/);
		assert.equal(by.claude.status, "unchanged", "the alias's env is not dropped");
		assert.match(by.claude.leftAlone[0], /differs in "env"/);
		assert.deepEqual(by.cursor.finished, [{ name: "polycarp", action: "removed" }]);
		applyMigration(plans, new Date("2026-11-17T21:00:00Z"));
		assert.equal(readFileSync(oc, "utf8"), ocText);
		assert.equal(readFileSync(claude, "utf8"), claudeText);
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(cursor, "utf8")).mcpServers), ["tychicus"]);
		assert.deepEqual(aliasList(), ["claude:polycarp", "opencode:polycarp"], "the kept aliases stay on the list");
	});
});

test("sol-F4 (round 2): adjacent aliases beside tychicus are removed together and the file parses", () => {
	inHome("finish-adjacent", (home) => {
		const bin = join(home, ".config", "tychicus", "tychicus");
		const entry = `{ "type": "stdio", "command": "${bin}", "args": ["mcp"], "env": {} }`;
		// Claude Code: tychicus, then the two aliases at the end.
		const claude = join(home, ".claude.json");
		put(claude, `{\n  "mcpServers": {\n    "tychicus": ${entry},\n    "polycarp": ${entry},\n    "tabkyra": ${entry}\n  },\n  "numStartups": 3\n}\n`);
		// Cursor: the two aliases first, then tychicus and another server.
		const cursor = join(home, ".cursor", "mcp.json");
		put(cursor, `{\n  "mcpServers": {\n    "polycarp": ${entry},\n    "tabkyra": ${entry},\n    "tychicus": ${entry},\n    "github": { "command": "npx" }\n  }\n}\n`);
		recordAlias(home, ["claude", claude, "polycarp"], ["claude", claude, "tabkyra"], ["cursor", cursor, "polycarp"], ["cursor", cursor, "tabkyra"]);
		const plans = m.planFinish(bin);
		const by = Object.fromEntries(plans.map((p) => [p.harness, p]));
		for (const h of ["claude", "cursor"]) {
			assert.equal(by[h].status, "change", `${h}: ${by[h].reason ?? ""}`);
			assert.deepEqual(by[h].finished, [{ name: "polycarp", action: "removed" }, { name: "tabkyra", action: "removed" }]);
		}
		assert.equal(by.claude.after, `{\n  "mcpServers": {\n    "tychicus": ${entry}\n  },\n  "numStartups": 3\n}\n`);
		assert.equal(by.cursor.after, `{\n  "mcpServers": {\n    "tychicus": ${entry},\n    "github": { "command": "npx" }\n  }\n}\n`);
		applyMigration(plans, new Date("2026-11-17T21:00:00Z"));
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(claude, "utf8")).mcpServers), ["tychicus"]);
		assert.deepEqual(aliasList(), []);
	});
});

test("the alias list is written whole and private, and stays as it was when the write fails", () => {
	inHome("alias-whole", (home) => {
		const bin = join(home, ".config", "tychicus", "tychicus");
		put(join(home, ".claude.json"), CLAUDE, 0o600);
		const file = recordAlias(home, ["cursor", join(home, "elsewhere.json"), "polycarp"]);
		const before = readFileSync(file, "utf8");
		// A folder where the temporary file goes: writing it fails (EISDIR), for root too.
		mkdirSync(`${file}.${process.pid}.tmp`);
		const plans = planMigration(bin);
		applyMigration(plans, new Date("2026-11-17T20:00:00Z"));
		assert.match(plans.find((p) => p.harness === "claude").aliasWarning, /agent-aliases\.json couldn't be updated/);
		assert.equal(readFileSync(file, "utf8"), before);
	});
	inHome("alias-private", (home) => {
		put(join(home, ".claude.json"), CLAUDE, 0o600);
		applyMigration(planMigration(join(home, ".config", "tychicus", "tychicus")), new Date("2026-11-17T20:00:00Z"));
		const file = join(process.env.TYCHICUS_CONFIG_DIR, "agent-aliases.json");
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).aliases.map((a) => a.name), ["polycarp"]);
		if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
	});
});

test("sol-F3 (round 2): when agent-aliases.json can't be written, the moved alias is still found by finish and doctor", () => {
	inHome("alias-unwritable", (home) => {
		const bin = join(home, ".config", "tychicus", "tychicus");
		const claude = join(home, ".claude.json");
		put(claude, CLAUDE, 0o600);
		// A folder where the list should be: writing it fails (EISDIR), for root too.
		mkdirSync(join(process.env.TYCHICUS_CONFIG_DIR, "agent-aliases.json"), { recursive: true });
		const plans = planMigration(bin);
		let thrown;
		try {
			applyMigration(plans, new Date("2026-11-17T20:00:00Z"));
		} catch (err) {
			thrown = err;
		}
		assert.equal(JSON.parse(readFileSync(claude, "utf8")).mcpServers.polycarp.command, bin, "the config was written");
		assert.equal(m.liveAlias("claude")?.name, "polycarp", "setup and doctor still see the alias, so they add no second server");
		assert.equal(thrown, undefined, "the move doesn't fail after its config write");
		const plan = plans.find((p) => p.harness === "claude");
		assert.match(plan.aliasWarning, /agent-aliases\.json couldn't be updated .*still find entries named polycarp or tabkyra/);
		// A retry finds nothing to move; the finish finds the alias by name and renames it.
		assert.equal(planMigration(bin).find((p) => p.harness === "claude").status, "unchanged");
		const [finish] = m.planFinish(bin);
		assert.equal(finish.harness, "claude");
		assert.deepEqual(finish.finished, [{ name: "polycarp", action: "renamed" }]);
		applyMigration([finish], new Date("2026-11-17T21:00:00Z"));
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(claude, "utf8")).mcpServers), ["github", "tychicus"]);
		assert.equal(m.liveAlias("claude"), undefined);
	});
});

test("sol-F2 (round 2): setup --agents --finish --dry-run writes nothing, even for an alias whose file is gone", () => {
	inHome("finish-dry", (home) => {
		const record = recordAlias(home, ["cursor", join(home, ".cursor", "mcp.json"), "polycarp"]);
		const text = readFileSync(record, "utf8");
		const env = { HOME: home, PATH: join(home, "no-bin"), TYCHICUS_CONFIG_DIR: process.env.TYCHICUS_CONFIG_DIR, TABKYRA_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
		const run = (...args) => spawnSync(process.execPath, [cli, "setup", "--agents", "--finish", ...args], { encoding: "utf8", env, input: "", timeout: 60000 });
		const dry = run("--dry-run");
		assert.equal(dry.status, 0, dry.stdout + dry.stderr);
		assert.equal(existsSync(record) && readFileSync(record, "utf8"), text, "the dry run leaves agent-aliases.json byte for byte");
		assert.match(dry.stdout, /Dry run: nothing was written/);
		// The real run takes the gone file's alias off the list.
		const real = run("--yes");
		assert.equal(real.status, 0, real.stdout + real.stderr);
		assert.equal(existsSync(record), false);
	});
});

test("setup --agents renames an old name that runs Tychicus to tychicus, and doctor gives that one command", () => {
	inHome("rename-in-setup", (home) => {
		const config = process.env.TYCHICUS_CONFIG_DIR;
		const bin = join(config, "tychicus");
		// A working agent launcher, as `tychicus install` writes it.
		put(bin, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, 0o755);
		const claude = join(home, ".claude.json");
		put(claude, `{\n  "numStartups": 3,\n  "mcpServers": {\n    "polycarp": { "type": "stdio", "command": "${bin}", "args": ["mcp"], "env": { "A": "1" } },\n    "github": { "command": "npx" }\n  }\n}\n`);
		const codex = join(home, ".codex", "config.toml");
		put(codex, `model = "gpt-6.1-sol"\n\n[mcp_servers.polycarp]\ncommand = "${bin}"\nargs = ["mcp"]\n`);
		// OMP keeps a tychicus entry that differs from the alias: the rename's rules leave both for a manual fix.
		const omp = join(home, ".omp", "agent", "mcp.json");
		const ompText = `{\n  "mcpServers": {\n    "tychicus": { "command": "${bin}", "args": ["mcp"], "enabled": false },\n    "polycarp": { "command": "${bin}", "args": ["mcp"], "enabled": true }\n  }\n}\n`;
		put(omp, ompText);
		const env = {
			HOME: home,
			PATH: join(home, "no-bin"),
			TYCHICUS_CONFIG_DIR: config,
			TYCHICUS_SOCKET_DIR: join(home, "sock"),
			TYCHICUS_APPLICATIONS_DIRS: join(home, "apps"),
			TABKYRA_NO_UPDATE_CHECK: "1",
			NO_COLOR: "1",
		};
		const cmd = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, input: "", timeout: 60000 });
		const aliasCheck = () => JSON.parse(cmd("doctor", "--json").stdout).checks.find((c) => c.id === "agents:aliases");

		const before = aliasCheck();
		assert.equal(before?.status, "warn", "doctor flags an agent that reaches Tychicus under an old name");
		assert.equal(before.fix, "tychicus setup --agents", "with one command, no condition attached");

		const dry = cmd("setup", "--agents", "--dry-run");
		assert.match(dry.stdout, /polycarp: renamed to tychicus/, dry.stdout);
		assert.match(readFileSync(claude, "utf8"), /"polycarp"/, "a dry run writes nothing");

		// No terminal and no --yes: nothing can be asked, so nothing changes, the run says so with the command, and fails.
		const claudeBefore = readFileSync(claude, "utf8");
		for (const args of [["setup", "--agents"], ["setup", "--agents", "--finish"]]) {
			const unasked = cmd(...args);
			assert.equal(unasked.status, 1, `${args.join(" ")}:\n${unasked.stdout}`);
			assert.match(unasked.stdout, new RegExp(`Nothing was changed: there is no terminal to ask in\\. To make these changes: tychicus ${args.join(" ")} --yes`));
			assert.equal(readFileSync(claude, "utf8"), claudeBefore);
		}

		const r = cmd("setup", "--agents", "--yes");
		const out = r.stdout + r.stderr;
		// Each renamed entry is named, by agent.
		assert.match(out, /Claude Code: "polycarp" renamed to tychicus/);
		assert.match(out, /Codex: "polycarp" renamed to tychicus/);
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(claude, "utf8")).mcpServers), ["tychicus", "github"], out);
		assert.deepEqual(JSON.parse(readFileSync(claude, "utf8")).mcpServers.tychicus.env, { A: "1" }, "the entry keeps its env");
		assert.deepEqual(Object.keys(parseToml(readFileSync(codex, "utf8")).mcp_servers), ["tychicus"]);
		assert.equal(backups(claude).length, 1, "a backup is made first");
		assert.equal(readFileSync(omp, "utf8"), ompText, "an alias beside a different tychicus entry is left alone");
		assert.match(out, /OMP: "polycarp" runs the same command as the tychicus entry but differs in "enabled"/);
		assert.equal(r.status, 1, "and the step says a manual fix is left");
		assert.match(out, /mcp__polycarp, need the new one/, "rules that named the old server are pointed out");

		// Once OMP is settled by hand, a second run renames nothing more and doctor has nothing to say about names.
		writeFileSync(omp, `{\n  "mcpServers": {\n    "tychicus": { "command": "${bin}", "args": ["mcp"], "enabled": true }\n  }\n}\n`);
		const again = cmd("setup", "--agents", "--yes");
		assert.equal(again.status, 0, again.stdout + again.stderr);
		assert.match(again.stdout, /nothing to change/);
		assert.equal(aliasCheck(), undefined);
	});
});
