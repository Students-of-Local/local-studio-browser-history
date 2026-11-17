// The speed check: median ms per verb on the t02 form page, measured the study's way (lib/latency.mjs there):
// navigate, read_page, fill the Full name box, click the Phone radio, N runs, median. Exits 1 when the median click
// is at or over CLICK_MS or the median fill at or over FILL_MS.
//   node evals/tasks/speed.mjs [N=5] [--json]
import { driver, startTychicus } from "./lib.mjs";
import { startSite } from "./server.mjs";

export const CLICK_MS = 150;
export const FILL_MS = 100;

const N = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 5);
const site = await startSite();
const ctx = await startTychicus();
const t = {};
const time = async (k, f) => {
	const s = performance.now();
	const r = await f();
	t[k] ??= [];
	t[k].push(performance.now() - s);
	return r;
};
try {
	for (let i = 0; i < N; i++) {
		site.reset();
		const d = driver(ctx);
		await time("navigate", () => d.open(`${site.origin}/t02-form/`));
		const n = await time("snapshot", () => d.nodes());
		const name = n.find((x) => /textbox/i.test(x.role) && /full name/i.test(x.name) && x.ref);
		await time("fill", () => d.fill(name, `Ada ${i}`));
		const radio = n.find((x) => /radio/i.test(x.role) && /phone/i.test(x.name));
		await time("click", () => d.check(radio));
	}
} finally {
	await ctx.h.stop();
	await site.stop();
}
const med = (a) => Math.round([...a].sort((x, y) => x - y)[a.length >> 1]);
const median = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, med(v)]));
const runs = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.map((x) => Math.round(x))]));
console.log(JSON.stringify({ N, median_ms: median, runs_ms: runs }));
const over = [];
if (median.click >= CLICK_MS) over.push(`median click ${median.click} ms is not under ${CLICK_MS} ms`);
if (median.fill >= FILL_MS) over.push(`median fill ${median.fill} ms is not under ${FILL_MS} ms`);
if (over.length) {
	console.error(`speed check failed: ${over.join("; ")}`);
	process.exit(1);
}
console.log(`speed check holds: click ${median.click} ms < ${CLICK_MS} ms, fill ${median.fill} ms < ${FILL_MS} ms`);
