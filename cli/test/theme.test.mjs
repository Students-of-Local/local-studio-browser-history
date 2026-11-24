// Themed pages: every preset's text/background and accent/button-text pairs reach WCAG AA (4.5:1)
// in light and dark, a custom accent gets readable button text, and the consent page follows the theme.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { machine, tempRoot, rmSync } from "./helpers/hub-fixture.mjs";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { pageCss } = await loadTs('export { pageCss } from "@src/theme.ts";');

const root = tempRoot("tabkyra-theme-");
after(() => rmSync(root, { recursive: true, force: true }));

const channel = (v) => {
	const x = v / 255;
	return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
function luminance(hex) {
	const n = Number.parseInt(hex.slice(1), 16);
	return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a, b) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** The pairs a page draws: body text on the page and the card, muted text, the error color, button text on the accent. */
const PAIRS = [
	["text", "bg"],
	["text", "panel"],
	["muted", "panel"],
	["muted", "bg"],
	["danger", "panel"],
	["accentText", "accent"],
];

test("every preset reaches WCAG AA (4.5:1) for text and for button text, in light and dark", () => {
	const m = machine(root, "presets");
	const { presets, palettes } = m.json(["theme", "list", "--json"]);
	assert.deepEqual(presets, ["tabkyra", "slate", "forest", "rose", "midnight"]);
	for (const name of presets) {
		for (const mode of ["light", "dark"]) {
			const palette = palettes[name][mode];
			for (const [fg, bg] of PAIRS) {
				const ratio = contrast(palette[fg], palette[bg]);
				assert.ok(ratio >= 4.5, `${name} ${mode}: ${fg} ${palette[fg]} on ${bg} ${palette[bg]} is ${ratio.toFixed(2)}:1, below 4.5:1`);
			}
		}
	}
});

test("a custom accent gets button text that reaches 4.5:1 in both modes, for any color", () => {
	const m = machine(root, "accent");
	// Dark, light, saturated and mid-range colors: mid-range is where neither black nor white is obvious.
	for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#777777", "#808080", "#3b82f6", "#e3a93b", "#767676", "#ff6600", "#6a0dad"]) {
		const out = m.json(["theme", "accent", hex, "--json"]);
		assert.equal(out.accent, hex);
		for (const mode of ["light", "dark"]) {
			const { accent, accentText } = out.resolved[mode];
			assert.equal(accent, hex);
			const ratio = contrast(accentText, accent);
			assert.ok(ratio >= 4.5, `${hex} ${mode}: button text ${accentText} is ${ratio.toFixed(2)}:1`);
		}
	}
	assert.equal(m.run(["theme", "accent", "blue"]).code, 2, "an accent must be #rrggbb");
	assert.equal(m.run(["theme", "accent", "#12345"]).code, 2);
});

test("theme set, list and reset keep theme.json private and valid", () => {
	const m = machine(root, "set");
	assert.equal(m.json(["theme", "list", "--json"]).preset, "tabkyra");
	assert.equal(m.run(["theme", "set", "nope"]).code, 2);
	assert.equal(m.json(["theme", "set", "forest", "--json"]).preset, "forest");
	assert.deepEqual(JSON.parse(JSON.stringify(m.json(["theme", "list", "--json"]).preset)), "forest");
	m.json(["theme", "accent", "#112233", "--json"]);
	const saved = JSON.parse(readTheme(m));
	assert.deepEqual(saved, { preset: "forest", accent: "#112233" });
	assert.equal(m.json(["theme", "reset", "--json"]).preset, "tabkyra");
});

function readTheme(m) {
	const mode = statSync(m.file("theme.json")).mode & 0o777;
	assert.equal(mode, 0o600, "theme.json is private");
	return readFileSync(m.file("theme.json"), "utf8");
}

/** The variables of one pinned mode, read from the CSS a page gets. */
function pageVars(choice, mode) {
	const css = pageCss({ ...choice, mode });
	const block = /^:root\{color-scheme:[a-z]+;([^}]*)\}/.exec(css)?.[1] ?? "";
	return { css, vars: Object.fromEntries(block.split(";").map((d) => d.split(":"))) };
}

test("the pages' focus ring and control edges reach 3:1 on the page and the card: every preset, both modes, custom accents including #000000 and #ffffff", () => {
	for (const preset of ["tabkyra", "slate", "forest", "rose", "midnight"]) {
		for (const accent of [undefined, "#e3a93b", "#000000", "#ffffff", "#777777", "#3b82f6"]) {
			for (const mode of ["light", "dark"]) {
				const { css, vars } = pageVars({ preset, ...(accent ? { accent } : {}) }, mode);
				for (const shape of ["--ring", "--edge"]) {
					for (const surface of ["--bg", "--panel"]) {
						const ratio = contrast(vars[shape], vars[surface]);
						assert.ok(ratio >= 3, `${preset} ${accent ?? "preset"} ${mode}: ${shape} ${vars[shape]} on ${surface} ${vars[surface]} is ${ratio.toFixed(2)}:1`);
					}
				}
				assert.match(css, /focus-visible[^}]*outline:3px solid var\(--ring\)/);
				assert.match(css, /input\.secret\{[^}]*border:1px solid var\(--edge\)/);
				assert.match(css, /button\{[^}]*border:1px solid var\(--edge\)/);
			}
		}
	}
});

// ---------- no Polycarp app theme ----------

const own = await loadTs('export { themeCss, pageCss as pageCssDefault, runTheme, saveTheme } from "@src/theme.ts";');

function say(fn) {
	const lines = [];
	const log = console.log;
	console.log = (...a) => lines.push(a.join(" "));
	try {
		fn();
	} finally {
		console.log = log;
	}
	return lines.join("\n");
}

// A valid theme from the Polycarp app, where it writes one. Tychicus reads only its own theme.json.
const POLYCARP_THEME = {
	schema: 1,
	name: "evening",
	title: "Evening",
	mode: "dark",
	surfaces: {
		browser: {
			light: { background: "#fbf7ef", surface: "#ffffff", foreground: "#1f1a14", muted: "#5c5246", border: "#d9cfbf", accent: "#8a3b12", on_accent: "#ffffff", urgent: "#a3261d" },
			dark: { background: "#14110d", surface: "#1d1914", foreground: "#efe7da", muted: "#b5a893", border: "#3b342b", accent: "#e39a5c", on_accent: "#14110d", urgent: "#ff8a80" },
			shape: { radius_small: 2, radius: 4, radius_large: 6 },
			type: { ui: "Georgia, serif", display: "Georgia, serif", mono: "Menlo, monospace", size: 18 },
			motion: { fast: 0, normal: 0, slow: 0, easing: "linear", reduced: true },
		},
	},
};

test("a Polycarp app theme file changes nothing: pages, theme list and --json use only Tychicus's saved choice", () => {
	const dir = tempRoot("tychicus-no-polycarp-");
	const saved = { p: process.env.POLYCARP_CONFIG_DIR, t: process.env.TABKYRA_CONFIG_DIR };
	process.env.POLYCARP_CONFIG_DIR = join(dir, "polycarp");
	process.env.TABKYRA_CONFIG_DIR = join(dir, "tychicus");
	try {
		own.saveTheme("forest", undefined, "dark");
		const before = own.pageCssDefault();
		mkdirSync(join(dir, "polycarp", "current"), { recursive: true });
		writeFileSync(join(dir, "polycarp", "current", "theme.json"), JSON.stringify(POLYCARP_THEME));
		assert.equal(own.pageCssDefault(), before, "the pages are the same with the Polycarp file present");
		assert.match(before, /--accent:#7fd39a/, "the saved forest preset");
		assert.doesNotMatch(before, /#e39a5c|Georgia|html\{font-size/);
		const list = say(() => assert.equal(own.runTheme(["list"], false), 0));
		assert.doesNotMatch(list, /Polycarp/i);
		assert.match(list, /\* forest/);
		assert.doesNotMatch(say(() => own.runTheme(["set", "rose"], false)), /Polycarp/i);
		const json = JSON.parse(say(() => own.runTheme(["list"], true)));
		assert.equal(json.preset, "rose");
		assert.equal("polycarp" in json, false);
		assert.equal("polycarpRefused" in json, false);
	} finally {
		for (const [k, v] of [["POLYCARP_CONFIG_DIR", saved.p], ["TABKYRA_CONFIG_DIR", saved.t]]) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli/src/theme.ts reads no Polycarp theme file and exports no Polycarp reader", () => {
	const src = readFileSync(new URL("../src/theme.ts", import.meta.url), "utf8");
	assert.doesNotMatch(src, /olycarp/);
	assert.doesNotMatch(src, /current["'\/]/);
});
