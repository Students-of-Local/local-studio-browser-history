// The helper's cold start against spaces/spec/speed.json. The comparison is always tested; the real measurement runs when
// POLYCARP_SPEED_HELPER names a built helper (the bundle check and CI set it), because timings only mean something on the
// machine that recorded them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { needsPolycarp } from "../../test/polycarp-root.mjs";

// The speed spec and its script are Polycarp's (spaces/); this runs when POLYCARP_ROOT names a checkout.
const skip = needsPolycarp("spaces/scripts/browser-speed.mjs");
const { measure, regressions, speedFile, TOLERANCE } = skip ? {} : await import(pathToFileURL(join(process.env.POLYCARP_ROOT, "spaces/scripts/browser-speed.mjs")).href);

test("a slowdown over 25% is a regression, 25% is not", { skip }, () => {
	const recorded = { versionMs: 100, toolsListMs: 200 };
	assert.equal(TOLERANCE, 0.25);
	assert.deepEqual(regressions(recorded, { versionMs: 125, toolsListMs: 250 }), []);
	assert.equal(regressions(recorded, { versionMs: 125.1, toolsListMs: 200 }).length, 1);
	assert.equal(regressions(recorded, { versionMs: 100, toolsListMs: 251 }).length, 1);
	assert.equal(regressions(recorded, { versionMs: 126, toolsListMs: 260 }).length, 2);
	assert.deepEqual(regressions(undefined, { versionMs: 9999, toolsListMs: 9999 }), [], "nothing recorded, nothing to regress from");
});

test("speed.json records the browser helper's numbers", { skip }, () => {
	const speed = JSON.parse(readFileSync(speedFile, "utf8"));
	assert.equal(typeof speed.browser.versionMs, "number");
	assert.equal(typeof speed.browser.toolsListMs, "number");
	assert.ok(speed.browser.versionMs > 0 && speed.browser.toolsListMs > 0);
});

const helper = process.env.POLYCARP_SPEED_HELPER;
test("the built helper starts within 25% of the recorded time", { skip: skip || (!helper && "set POLYCARP_SPEED_HELPER to a built helper") }, async () => {
	const recorded = JSON.parse(readFileSync(speedFile, "utf8")).browser;
	let last;
	for (let i = 0; i < 3; i++) {
		last = await measure(helper);
		if (regressions(recorded, last).length === 0) return;
	}
	assert.fail(`slower than recorded: ${regressions(recorded, last).join("; ")}`);
});
