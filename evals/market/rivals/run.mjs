// The same task set and speed check, against a rival tool or Tychicus, by hand. Never in CI (README.md).
//   node evals/market/rivals/run.mjs --tool playwright-mcp|agent-browser|browse|tychicus [--repeat 3] [--only ids]
//        [--speed-n 9] [--no-speed] [--no-start] [--out file.json]
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
const fixtures = join(here, "..", "tasks", "fixtures");
const result = { tool, at: new Date().toISOString(), scores: {}, speed_ms: {}, detail: {} };
// Each part gets its own tool session: a rival whose session a task broke (Playwright MCP 0.0.85 hangs every call
// after t10's confirm() once a second tab exists; tasks/README.md in the study) still gets its speed measured.
const driverFor = (ctx) => (tool === "tychicus" ? tychicusDriver(ctx) : drivers[tool](ctx));
async function session(part, f) {
	const t0 = Date.now();
	const ctx = await adapter.start({ fixtures, mode: "scripted", site });
	console.error(`${tool} (${part}): started in ${Date.now() - t0} ms; site ${site.origin}`);
	try {
		await f(ctx, () => driverFor(ctx));
	} catch (e) {
		result.detail[`${part}Error`] = String(e.message ?? e).split("\n")[0];
		console.error(`${part} failed: ${result.detail[`${part}Error`]}`);
	} finally {
		await adapter.stop(ctx).catch((e) => console.error(`stop: ${e.message}`));
	}
}
/**
 * startMs: from nothing running to the first page's text, timed the same way for every tool, in a session of its own.
 * Timing start() alone favored a tool that launches its browser on the first command (agent-browser's start() only
 * makes a folder, so it read 0) over one that launches it in start() (Tychicus). launchMs is start() alone.
 */
async function coldStart() {
	const t0 = Date.now();
	const ctx = await adapter.start({ fixtures, mode: "scripted", site });
	const launchMs = Date.now() - t0;
	try {
		const d = driverFor(ctx);
		await d.open(`${site.origin}/t01-read/`);
		const text = String(await d.text());
		if (!text.trim()) throw new Error("the first page read no text");
		result.startMs = Date.now() - t0;
		result.detail.start = { launchMs, firstTextMs: result.startMs - launchMs };
		console.error(`${tool}: first page text ${result.startMs} ms after start (start() took ${launchMs} ms)`);
	} catch (e) {
		result.detail.startError = String(e.message ?? e).split("\n")[0];
		console.error(`start failed: ${result.detail.startError}`);
	} finally {
		await adapter.stop(ctx).catch((e) => console.error(`stop: ${e.message}`));
	}
}
try {
	if (!argv.includes("--no-start")) await coldStart();
	await session("tasks", async (ctx, makeDriver) => {
		const rows = await runTasks({ site, makeDriver, repeat, only: opt("--only")?.split(","), between: () => adapter.between?.(ctx) });
		result.scores.tasks = { pass: rows.filter((r) => r.pass).length, of: rows.length };
		result.detail.tasks = rows;
	});
	if (!argv.includes("--no-speed")) {
		await session("speed", async (_ctx, makeDriver) => {
			const s = await measureSpeed({ site, makeDriver, N: speedN });
			result.speed_ms = { click: s.median_ms.click, fill: s.median_ms.fill, firstText: s.median_ms.firstText };
			result.detail.speed = s;
		});
	}
} finally {
	await site.stop();
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, "\t")}\n`);
console.log(JSON.stringify({ tool, startMs: result.startMs, scores: result.scores, speed_ms: result.speed_ms }));
