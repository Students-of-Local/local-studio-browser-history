// The market eval: Tychicus's scores and speeds in one run, gated on floors.json (README.md).
//   npm run evals:market                      # everything, then the floor check; exits 1 below a floor
//   node evals/market/run.mjs --only tasks,speed [--repeat 3] [--speed-n 9] [--out file.json] [--no-check]
// Parts: `tasks` (the ten-task set, 3 reps), `speed` (median click, fill and first page text on t02's form) and
// `dom-bench` (cli/test/dom-bench, its own per-case ratchet too). Needs the root and cli builds and Playwright's
// Chromium (README.md, "Run"). Rivals are not run here: rivals/README.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkScores, formatProblems } from "./check.mjs";
import { driver, startTychicus } from "./tasks/lib.mjs";
import { measureSpeed, runTasks } from "./tasks/loop.mjs";
import { startSite } from "./tasks/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const parts = (opt("--only") ?? "tasks,speed,dom-bench").split(",");
const repeat = Number(opt("--repeat", 3));
const speedN = Number(opt("--speed-n", 9));
const out = opt("--out", join(here, "results", "last.json"));

const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
const results = {
	at: new Date().toISOString(),
	commit: git.stdout.trim() || undefined,
	runner: process.env.GITHUB_ACTIONS ? `github-actions ${process.env.ImageOS ?? ""} ${process.env.RUNNER_ARCH ?? ""}`.trim() : "local",
	node: process.version,
	parts,
	scores: {},
	speed_ms: {},
	detail: {},
};

if (parts.includes("tasks") || parts.includes("speed")) {
	const site = await startSite();
	const ctx = await startTychicus();
	const makeDriver = () => driver(ctx);
	try {
		if (parts.includes("tasks")) {
			const rows = await runTasks({ site, makeDriver, repeat, between: () => ctx.call("handle_dialog", { accept: false }).catch(() => {}) });
			results.scores.tasks = { pass: rows.filter((r) => r.pass).length, of: rows.length };
			results.detail.tasks = rows;
			console.error(`task set: ${results.scores.tasks.pass}/${rows.length} over ${repeat} rep(s)`);
		}
		if (parts.includes("speed")) {
			const s = await measureSpeed({ site, makeDriver, N: speedN });
			results.speed_ms = { click: s.median_ms.click, fill: s.median_ms.fill, firstText: s.median_ms.firstText };
			results.detail.speed = s;
			console.error(`speed (median of ${speedN}): ${JSON.stringify(s.median_ms)}`);
		}
	} finally {
		await ctx.h.stop();
		await site.stop();
	}
}

if (parts.includes("dom-bench")) {
	const cli = join(repo, "cli");
	const r = spawnSync(process.execPath, ["test/dom-bench/run.mjs"], { cwd: cli, stdio: ["ignore", "inherit", "inherit"] });
	const last = JSON.parse(readFileSync(join(cli, "test", "dom-bench", "last-run.json"), "utf8"));
	results.scores.domBench = { pass: last.results.filter((x) => x.pass).length, of: last.results.length };
	// dom-bench's own ratchet (floor.json: each passing id, within its tool-call ceiling) is part of this gate.
	results.domBenchRatchet = r.status === 0;
	results.detail.domBench = last.results.map(({ id, pass, calls, ms, error }) => ({ id, pass, calls, ms, error }));
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(results, null, "\t")}\n`);
console.log(`\nmarket eval: ${JSON.stringify({ scores: results.scores, speed_ms: results.speed_ms })}\nwrote ${out}`);
if (argv.includes("--no-check")) process.exit(0);
const floors = JSON.parse(readFileSync(join(here, "floors.json"), "utf8"));
const problems = checkScores(results, floors);
if (problems.length) {
	console.error(`\nbelow the floor (evals/market/floors.json):\n${formatProblems(problems)}`);
	process.exit(1);
}
console.log("every score is at or above its floor and every speed at or under its ceiling");
