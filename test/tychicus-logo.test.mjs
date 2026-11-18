// The extension's logo is Tychicus's pointer mark in Local Studio's blue: the code matches the source files in media/brand,
// each manifest icon is a real PNG of its size, and nothing of the old helm, the sealed letter or Polycarp's olive is left.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TYCHICUS_ICON, TYCHICUS_ICON_16, TYCHICUS_MARK } from "../src/components/tychicus-svg.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

test("the logo in the code is the one in media/brand", () => {
	assert.equal(TYCHICUS_ICON, read("media/brand/icon.svg").trim());
	assert.equal(TYCHICUS_ICON_16, read("media/brand/icon-16.svg").trim());
	// The site and the video use the same drawing.
	assert.equal(read("site/src/frontend/public/img/icon.svg").trim(), TYCHICUS_ICON);
	assert.equal(read("media/video/public/brand/icon.svg").trim(), TYCHICUS_ICON);
	assert.equal(read("site/src/frontend/public/img/favicon.svg").trim(), TYCHICUS_ICON_16);
	assert.match(TYCHICUS_MARK, /currentColor/);
	assert.doesNotMatch(TYCHICUS_MARK, /#[0-9a-f]{3,6}\b/i, "the mark takes its color from the text around it");
});

test("the old helm and the olive branch are gone from the extension", () => {
	// git grep exits 1 when it finds nothing, which is the pass.
	const found = spawnSync("git", ["grep", "-il", "helmMark\\|helm-svg\\|HELM_ICON\\|polycarp-svg\\|POLYCARP_ICON\\|POLYCARP_MARK", "--", "src", "static", "scripts/check-theme.mjs"], { cwd: root, encoding: "utf8" });
	assert.equal(found.stdout.trim(), "");
	for (const svg of [TYCHICUS_ICON, TYCHICUS_ICON_16, TYCHICUS_MARK]) assert.doesNotMatch(svg, /Polycarp/);
});

test("the default colors are Local Studio's blue, without Polycarp's olive or the old amber and navy", () => {
	const css = read("src/app.css");
	assert.match(css, /--tk-brass: #1b4ed8;/);
	assert.match(TYCHICUS_ICON, /#5b84ff/, "the icon is in Local Studio's glass gradient");
	const files = [css, TYCHICUS_ICON, TYCHICUS_ICON_16, read("media/brand/icon.svg"), read("media/brand/icon-16.svg")];
	for (const text of files) assert.doesNotMatch(text, /#e3a93b|#0f1b24/i, "the old amber and navy");
	// palettes.ts names the old brass once, in a comment on the contrast math, so only the olive is checked there.
	for (const text of [...files, read("src/appearance/palettes.ts")])
		assert.doesNotMatch(text, /#59693f|#4b5935|#a9bb8a|#b8642e/i, "Polycarp's olive and the sealed letter's rust");
});

test("each manifest icon is a real PNG of its size", () => {
	const manifest = JSON.parse(read("static/manifest.chrome.json"));
	assert.deepEqual(Object.keys(manifest.icons).sort((a, b) => a - b), ["16", "32", "48", "128"]);
	for (const [size, file] of Object.entries(manifest.icons)) {
		const png = readFileSync(join(root, "static", file));
		assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is a PNG`);
		assert.equal(png.toString("latin1", 12, 16), "IHDR", file);
		assert.equal(png.readUInt32BE(16), Number(size), `${file} width`);
		assert.equal(png.readUInt32BE(20), Number(size), `${file} height`);
	}
});
