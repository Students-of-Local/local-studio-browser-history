// Install time from nothing, and the install steps each tool's README gives, by hand (README.md, "Rivals, by hand").
//   node evals/market/rivals/install-time.mjs [--reps 3] [--out file.json]
// Each rep installs into a new temporary folder with an empty npm cache, so every byte is downloaded. Tychicus runs its
// release's one command (README.md, "Install") with a throwaway HOME, so nothing lands in the real home folder, and
// TYCHICUS_GH=none, as on a computer without the GitHub CLI. No tool's browser download is timed: each drives a
// Chromium already on the computer. browse's own install script is not run (it installs into the home folder and
// registers with the browser); its npm package, which `npx @opencode/browse install` downloads, is timed instead.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const reps = Number(opt("--reps", 3));
const out = opt("--out", join(here, "..", "results", "install.json"));
const TYCHICUS_INSTALL = "https://github.com/baney75/tychicus/releases/latest/download/install.sh";

/** What is installed, and the steps from nothing to an agent driving a page, as each README (at that version) writes them. */
const TOOLS = {
	tychicus: {
		what: `curl -fsSL ${TYCHICUS_INSTALL} | sh`,
		steps: ["run the one install command", "load the unpacked extension", "add the MCP server to the agent"],
		source: "https://github.com/baney75/tychicus#install",
	},
	"playwright-mcp": { npm: "@playwright/mcp@0.0.85", steps: ["add the MCP server to the agent with npx"], source: "https://github.com/microsoft/playwright-mcp#getting-started" },
	"chrome-devtools-mcp": { npm: "chrome-devtools-mcp@1.13.0", steps: ["add the MCP server to the agent with npx"], source: "https://github.com/ChromeDevTools/chrome-devtools-mcp#getting-started" },
	"agent-browser": {
		npm: "agent-browser@0.43.0",
		steps: ["npm install -g agent-browser", "agent-browser install, which downloads Chrome for Testing", "add its skill or an AGENTS.md line to the agent"],
		source: "https://github.com/vercel-labs/agent-browser#install",
	},
	browse: {
		npm: "@opencode/browse@0.1.5",
		steps: ["run the install script, which adds the MCP server to the agent", "add the extension from the Chrome Web Store"],
		source: "https://github.com/anomalyco/browse#install",
	},
};

function timeOnce(tool, spec) {
	const dir = mkdtempSync(join(tmpdir(), `market-install-${tool}-`));
	try {
		const t0 = performance.now();
		let r;
		if (spec.npm) {
			r = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--cache", join(dir, "cache"), spec.npm], { cwd: (mkdirSync(join(dir, "p")), join(dir, "p")), encoding: "utf8" });
		} else {
			// Only what a fresh shell has: no config folder override or other variable from this one reaches the installer.
			const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: process.env.LANG ?? "C", HOME: join(dir, "home"), TYCHICUS_GH: "none" };
			// A browser has run once, as clean-install.mjs sets it up: the installer registers with the browsers it finds.
			mkdirSync(join(env.HOME, "Library", "Application Support", "Chromium"), { recursive: true });
			mkdirSync(join(env.HOME, ".config", "chromium"), { recursive: true });
			r = spawnSync("sh", ["-c", `curl -fsSL ${TYCHICUS_INSTALL} | sh -s -- --no-restart`], { cwd: dir, env, encoding: "utf8" });
		}
		const ms = Math.round(performance.now() - t0);
		if (r.status !== 0) throw new Error(`${tool} install failed (${r.status}): ${(r.stderr || r.stdout).slice(-400)}`);
		// The release the one command installed, as its last lines name it.
		const version = /Tychicus (\S+) is installed/.exec(r.stdout)?.[1];
		return { ms, version };
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const result = { at: new Date().toISOString(), reps, tools: {} };
for (const [tool, spec] of Object.entries(TOOLS)) {
	const runs = [];
	let version;
	for (let i = 0; i < reps; i++) {
		const r = timeOnce(tool, spec);
		runs.push(r.ms);
		version ??= r.version;
	}
	result.tools[tool] = { installed: spec.npm ?? spec.what, ...(version ? { release: version } : {}), ms: median(runs), runs_ms: runs, steps: spec.steps.length, stepList: spec.steps, source: spec.source };
	console.error(`${tool}: median ${median(runs)} ms over ${reps} (${runs.join(", ")}), ${spec.steps.length} step(s)`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, "\t")}\n`);
console.log(`wrote ${out}`);
