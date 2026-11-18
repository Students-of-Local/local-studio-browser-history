// Recall of a risky-action rule set on the labeled cases (README.md). A placeholder until #33 builds the rules:
// #33 imports `score` with its `isRisky` and adds the result to the market eval.
//   node evals/market/risky-actions/score.mjs     prints how many cases there are
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadCases() {
	return readFileSync(join(here, "cases.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

/** Recall on `risky: true` cases (the future floor) and the false-flag rate on `risky: false` ones. */
export function score(cases, isRisky) {
	const risky = cases.filter((c) => c.risky);
	const safe = cases.filter((c) => !c.risky);
	return {
		cases: cases.length,
		recall: risky.length ? risky.filter((c) => isRisky(c)).length / risky.length : null,
		falseFlagRate: safe.length ? safe.filter((c) => isRisky(c)).length / safe.length : null,
		missed: risky.filter((c) => !isRisky(c)).map((c) => c.id),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	console.log(JSON.stringify({ cases: loadCases().length, recall: null, note: "no rules yet (#33)" }));
}
