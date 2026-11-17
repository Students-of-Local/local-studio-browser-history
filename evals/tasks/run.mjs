// Run the scripted task set against Tychicus. Exits 1 unless every run passes.
//   node evals/tasks/run.mjs [--only t01-read,t02-form] [--repeat 3] [--out file.jsonl]
// Each task: fresh site state, start page loaded, solve, then the check reads what the page posted (README.md).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driver, startTychicus } from "./lib.mjs";
import { startSite } from "./server.mjs";
import { solves } from "./solves.mjs";
import { tasks } from "./tasks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const only = opt("--only")?.split(",");
const repeat = Number(opt("--repeat", 1));
const out = opt("--out");
const fixtures = join(here, "fixtures");
if (out) mkdirSync(dirname(out), { recursive: true });

const site = await startSite();
const t0 = Date.now();
const ctx = await startTychicus();
console.error(`tychicus: started in ${Date.now() - t0} ms; site ${site.origin}`);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms))]);

const rows = [];
try {
	for (let rep = 0; rep < repeat; rep++) {
		for (const task of tasks.filter((t) => !only || only.includes(t.id))) {
			site.reset();
			const start = Date.now();
			let answer;
			let error;
			const d = driver(ctx);
			try {
				await withTimeout(d.open(`${site.origin}${task.start}`), 30_000);
				answer = await withTimeout(solves[task.id](d, { fixtures, site }), 90_000);
			} catch (e) {
				error = String(e.message ?? e).split("\n")[0].slice(0, 300);
			} finally {
				d.s.cancel();
			}
			let verdict = { pass: false, why: "" };
			const end = Date.now() + 3000;
			for (;;) {
				verdict = task.check({ state: site.state(task.id), answer, site });
				if (verdict.pass || Date.now() > end) break;
				await new Promise((r) => setTimeout(r, 200));
			}
			const row = { task: task.id, rep, pass: verdict.pass, steps: d.s.calls, ms: Date.now() - start, error, why: verdict.pass ? undefined : verdict.why };
			rows.push(row);
			if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
			console.error(`${verdict.pass ? "ok  " : "FAIL"} rep ${rep} ${task.id} steps=${row.steps} ${row.ms}ms${error ? ` err=${error}` : ""}${verdict.pass ? "" : ` why=${verdict.why.slice(0, 160)}`}`);
			// A dialog left open would freeze the next task's navigation.
			await ctx.call("handle_dialog", { accept: false }).catch(() => {});
		}
	}
} finally {
	await ctx.h.stop();
	await site.stop();
}
const passed = rows.filter((r) => r.pass).length;
const ms = rows.reduce((a, r) => a + r.ms, 0);
console.log(`task set: ${passed}/${rows.length} passed over ${repeat} rep(s), ${rows.reduce((a, r) => a + r.steps, 0)} tool calls, ${ms} ms`);
process.exit(passed === rows.length && rows.length > 0 ? 0 : 1);
