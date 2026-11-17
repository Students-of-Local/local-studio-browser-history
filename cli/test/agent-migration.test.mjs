// Moving agents from Polycarp (agent-migration.ts): five harness configs in a fake HOME. Claude Code runs Polycarp's
// browser MCP, Codex has only other servers, Cursor already has tychicus beside an old tabkyra entry, OMP's file is not
// valid JSON, and OpenCode runs Polycarp's old browser launcher. A dry run writes nothing; a real run backs each file up
// first, moves only those entries and keeps every other byte; a second run changes nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { applyMigration, launchesPolycarpBrowser, planMigration, readAliases, unifiedDiff } = await loadTs(
	`export { applyMigration, launchesPolycarpBrowser, planMigration, readAliases, unifiedDiff } from "@src/agent-migration.ts";`,
);

const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "tychicus-migrate-"));
after(() => rmSync(root, { recursive: true, force: true }));

const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TYCHICUS_CONFIG_DIR", "POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR"];

/** Run `fn` with HOME at a fresh folder and the config overrides cleared. */
function inHome(name, fn) {
	const home = join(root, name);
	mkdirSync(home, { recursive: true });
	const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.HOME = home;
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

const backups = (file) => readdirSync(dirname(file)).filter((f) => f.startsWith(`${basename(file)}.tychicus-backup-`));

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

function opencode(home) {
	return `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "polycarp": {
      "type": "local",
      "command": ["${home}/.config/polycarp/browser/polycarp", "mcp"],
      "enabled": true
    }
  }
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

test("five harnesses: dry run, write with backups, every other byte kept, and a second run changes nothing", () => {
	inHome("five", (home) => {
		const { files, dotfile } = fixtures(home);
		process.env.TYCHICUS_CONFIG_DIR = join(home, ".config", "tychicus");
		mkdirSync(process.env.TYCHICUS_CONFIG_DIR, { recursive: true });
		const bin = join(home, ".config", "tychicus", "tychicus");
		const original = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, "utf8")]));

		// Dry run: the plan, and nothing on disk changes.
		const plans = planMigration(bin);
		const by = Object.fromEntries(plans.map((p) => [p.harness, p]));
		assert.equal(by.claude.status, "change");
		assert.deepEqual(by.claude.repointed, [{ name: "polycarp", from: "polycarp browser mcp" }]);
		assert.equal(by.claude.added, true);
		assert.equal(by.codex.status, "unchanged", "an unrelated MCP and the Polycarp app's own server are left alone");
		assert.equal(by.cursor.status, "change");
		assert.deepEqual(by.cursor.repointed, [{ name: "tabkyra", from: "tabkyra mcp" }]);
		assert.equal(by.cursor.added, false, "Cursor already has tychicus");
		assert.equal(by.omp.status, "refused");
		assert.match(by.omp.reason, /isn't valid JSON/);
		assert.equal(by.opencode.status, "change");
		assert.equal(by.opencode.repointed[0].from, `${home}/.config/polycarp/browser/polycarp mcp`);
		assert.equal(by.opencode.added, true);
		for (const [k, f] of Object.entries(files)) {
			assert.equal(readFileSync(f, "utf8"), original[k], `dry run changed ${k}`);
			assert.deepEqual(backups(f), [], `dry run made a backup of ${k}`);
		}

		// The exact before and after for Claude Code, as `diff -u` prints it: only the polycarp entry, then the new tychicus entry.
		assert.equal(
			unifiedDiff(files.claude, by.claude.before, by.claude.after),
			[
				`--- ${files.claude}`,
				`+++ ${files.claude} (after)`,
				"@@ -8,11 +8,16 @@",
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
				'+      "env": {',
				'+        "POLYCARP_SESSION": "claude"',
				"+      }",
				"+    },",
				'+    "tychicus": {',
				'+      "type": "stdio",',
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

		// A real run.
		const stamp = new Date("2026-11-17T20:00:00Z");
		const written = applyMigration(plans, stamp);
		assert.deepEqual(written.map((w) => w.file).sort(), [files.claude, files.cursor, files.opencode].sort());
		for (const { file, backup } of written) {
			assert.equal(backup, `${file}.tychicus-backup-20261117T200000Z`);
			assert.equal(readFileSync(backup, "utf8"), original[Object.keys(files).find((k) => files[k] === file)], "the backup is the file as it was");
		}
		assert.equal(statSync(`${files.claude}.tychicus-backup-20261117T200000Z`).mode & 0o777, 0o600, "the backup keeps the file's permissions");
		assert.equal(statSync(files.claude).mode & 0o777, 0o600, "the file keeps its permissions");

		const claude = JSON.parse(readFileSync(files.claude, "utf8"));
		assert.deepEqual(claude.mcpServers.polycarp, { type: "stdio", command: bin, args: ["mcp"], env: { POLYCARP_SESSION: "claude" } });
		assert.deepEqual(claude.mcpServers.tychicus, claude.mcpServers.polycarp);
		assert.deepEqual(Object.keys(claude.mcpServers), ["github", "polycarp", "tychicus"]);
		assert.deepEqual(claude.mcpServers.github, JSON.parse(CLAUDE).mcpServers.github);
		assert.deepEqual(claude.projects, JSON.parse(CLAUDE).projects, "project scope is not touched");
		assert.equal(claude.numStartups, 412);

		const cursor = JSON.parse(readFileSync(files.cursor, "utf8"));
		assert.deepEqual(cursor.mcpServers.tychicus, { command: "/opt/tychicus/tychicus", args: ["mcp"] }, "an existing tychicus entry is kept as it was");
		assert.deepEqual(cursor.mcpServers.tabkyra, { command: bin, args: ["mcp"] });
		assert.ok(lstatSync(files.cursor).isSymbolicLink(), "a linked config stays a link");
		assert.equal(readFileSync(dotfile, "utf8"), readFileSync(files.cursor, "utf8"));
		assert.match(readFileSync(files.cursor, "utf8"), /^\t\t"tabkyra": \{$/m, "the file's tab indent is kept");

		const oc = JSON.parse(readFileSync(files.opencode, "utf8"));
		assert.deepEqual(oc.mcp.polycarp, { type: "local", command: [bin, "mcp"], enabled: true });
		assert.deepEqual(oc.mcp.tychicus, oc.mcp.polycarp);
		assert.equal(oc.$schema, "https://opencode.ai/config.json");

		assert.equal(readFileSync(files.omp, "utf8"), OMP, "the malformed file is not written");
		assert.deepEqual(backups(files.omp), []);
		assert.equal(readFileSync(files.codex, "utf8"), CODEX);
		assert.deepEqual(backups(files.codex), []);

		// Polycarp's own folder is never created or written.
		assert.equal(existsSync(join(home, ".config", "polycarp")), false);

		// The aliases are recorded as temporary.
		const record = JSON.parse(readFileSync(join(home, ".config", "tychicus", "agent-aliases.json"), "utf8"));
		assert.match(record.note, /^Temporary/);
		assert.deepEqual(
			readAliases().map((a) => `${a.harness}:${a.name}`).sort(),
			["claude:polycarp", "cursor:tabkyra", "opencode:polycarp"],
		);

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
		assert.equal(readAliases().length, 3, "the alias list doesn't grow");
	});
});

test("Codex: a browser MCP table and its env table are copied to tychicus, the rest of the file kept", () => {
	inHome("codex", (home) => {
		process.env.TYCHICUS_CONFIG_DIR = join(home, "tconf");
		mkdirSync(process.env.TYCHICUS_CONFIG_DIR, { recursive: true });
		const file = join(home, ".codex", "config.toml");
		const text = `model = "gpt-6.1-sol"

[mcp_servers.polycarp]
command = "polycarp" # the old helper
args = ["browser", "mcp"]
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
		assert.equal(
			plan.after,
			`model = "gpt-6.1-sol"

[mcp_servers.polycarp]
command = "${bin}"
args = ["mcp"]
startup_timeout_sec = 30

[mcp_servers.polycarp.env]
POLYCARP_SESSION = "codex"

[mcp_servers.tychicus]
command = "${bin}"
args = ["mcp"]
startup_timeout_sec = 30

[mcp_servers.tychicus.env]
POLYCARP_SESSION = "codex"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
`,
		);
		applyMigration([plan], new Date("2026-11-17T20:00:00Z"));
		assert.equal(readFileSync(`${file}.tychicus-backup-20261117T200000Z`, "utf8"), text);
		const [second] = planMigration(bin).filter((p) => p.harness === "codex");
		assert.equal(second.status, "unchanged");
	});
});

test("an entry with extra arguments after mcp is named, not moved", () => {
	inHome("extra", (home) => {
		const file = join(home, ".cursor", "mcp.json");
		const text = `{\n  "mcpServers": {\n    "polycarp": { "command": "polycarp-browser", "args": ["mcp", "--session", "cursor"] }\n  }\n}\n`;
		put(file, text);
		const [plan] = planMigration("/t/tychicus").filter((p) => p.harness === "cursor");
		assert.equal(plan.status, "unchanged");
		assert.match(plan.notes[0], /extra arguments, so it was left alone/);
	});
});

test("a minified config is edited in place on its one line", () => {
	inHome("minified", (home) => {
		const file = join(home, ".omp", "agent", "mcp.json");
		put(file, `{"mcpServers":{"polycarp":{"type":"stdio","command":"polycarp","args":["browser","mcp"],"enabled":true}}}`);
		const [plan] = planMigration("/t/tychicus").filter((p) => p.harness === "omp");
		assert.equal(plan.status, "change");
		assert.equal(
			plan.after,
			`{"mcpServers":{"polycarp":{"type":"stdio","command":"/t/tychicus","args":["mcp"],"enabled":true}, "tychicus": {"type":"stdio","command":"/t/tychicus","args":["mcp"],"enabled":true}}}`,
		);
	});
});

test("an entry written on one line stays on one line, and so does the tychicus entry beside it", () => {
	inHome("one-line", (home) => {
		const file = join(home, ".cursor", "mcp.json");
		put(file, `{\n  "mcpServers": {\n    "polycarp": { "command": "polycarp", "args": ["browser", "mcp"] },\n    "other": { "command": "x" }\n  }\n}\n`);
		const [plan] = planMigration("/t/tychicus").filter((p) => p.harness === "cursor");
		assert.equal(
			plan.after,
			`{\n  "mcpServers": {\n    "polycarp": { "command": "/t/tychicus", "args": ["mcp"] },\n    "tychicus": { "command": "/t/tychicus", "args": ["mcp"] },\n    "other": { "command": "x" }\n  }\n}\n`,
		);
	});
});
