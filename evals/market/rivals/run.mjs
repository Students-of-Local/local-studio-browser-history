// The same task set and speed check, against a rival tool or Tychicus, by hand. Never in CI (README.md).
//   node evals/market/rivals/run.mjs --tool playwright-mcp|agent-browser|browse|tychicus [--repeat 3] [--only ids]
//        [--speed-n 9] [--no-speed] [--out file.json]
// Prints and writes { tool, scores, speed_ms, detail } in the market eval's format, so rows compare one to one.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driver as tychicusDriver, startTychicus } from "../tasks/lib.mjs";
import { measureSpeed, runTasks } from "../tasks/loop.mjs";
import { startSite } from "../tasks/server.mjs";
import agentBrowser from "./adapters/agent-browser.mjs";
import browse from "./adapters/browse.mjs";
import playwrightMcp from "./adapters/playwright-mcp.mjs";
import { drivers } from "./drivers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const tool = opt("--tool");
const repeat = Number(opt("--repeat", 3));
const speedN = Number(opt("--speed-n", 9));
const out = opt("--out", join(here, "..", "results", `rival-${tool}.json`));

const tychicus = {
	start: async () => startTychicus(),
	stop: (ctx) => ctx.h.stop(),
	between: (ctx) => ctx.call("handle_dialog", { accept: false }).catch(() => {}),
};
const adapters = { "playwright-mcp": playwrightMcp, "agent-browser": agentBrowser, browse, tychicus };
const adapter = adapters[tool];
if (!adapter) {
	console.error(`--tool is one of: ${Object.keys(adapters).join(", ")}`);
	process.exit(2);
}

const site = await startSite();
const t0 = Date.now();
const fixtures = join(here, "..", "tasks", "fixtures");
const ctx = await adapter.start({ fixtures, mode: "scripted", site });
const result = { tool, at: new Date().toISOString(), startMs: Date.now() - t0, scores: {}, speed_ms: {}, detail: {} };
console.error(`${tool}: started in ${result.startMs} ms; site ${site.origin}`);
const makeDriver = () => (tool === "tychicus" ? tychicusDriver(ctx) : drivers[tool](ctx));
try {
	const rows = await runTasks({ site, makeDriver, repeat, only: opt("--only")?.split(","), between: () => adapter.between?.(ctx) });
	result.scores.tasks = { pass: rows.filter((r) => r.pass).length, of: rows.length };
	result.detail.tasks = rows;
	if (!argv.includes("--no-speed")) {
		const s = await measureSpeed({ site, makeDriver, N: speedN });
		result.speed_ms = { click: s.median_ms.click, fill: s.median_ms.fill, firstText: s.median_ms.firstText };
		result.detail.speed = s;
	}
} finally {
	await adapter.stop(ctx).catch((e) => console.error(`stop: ${e.message}`));
	await site.stop();
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, "\t")}\n`);
console.log(JSON.stringify({ tool, scores: result.scores, speed_ms: result.speed_ms }));
