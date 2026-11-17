// The real store zip: scripts/build-store.sh builds it from this checkout, and this reads the manifest and file list back
// out of the zip itself. It fails if the zipped manifest has a `key`, is not named Tychicus, carries another version
// than package.json, misses an icon, or asks for a permission store/permissions.md does not explain.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { askedPermissions, explainedPermissions } from "../scripts/store-package.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("build-store.sh makes a zip the store takes", { skip: process.platform === "win32" && "bash and zip", timeout: 300_000 }, () => {
	const out = mkdtempSync(join(tmpdir(), "store-zip-"));
	try {
		execFileSync("bash", [join(root, "scripts/build-store.sh"), out], { cwd: root, env: { ...process.env, TABKYRA_NO_BUMP: "1" }, stdio: "pipe" });
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const zips = readdirSync(out).filter((n) => n.endsWith(".zip"));
		assert.deepEqual(zips, [`tychicus-${pkg.version}-store.zip`]);
		const zip = join(out, zips[0]);
		const manifest = JSON.parse(execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" }));
		const files = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);

		assert.equal("key" in manifest, false, "the zipped manifest has a key; Google assigns the store id");
		assert.equal(manifest.name, "Tychicus");
		assert.equal(manifest.version, pkg.version);
		assert.ok(manifest.description.length <= 132);
		for (const icon of Object.values(manifest.icons)) assert.ok(files.includes(icon), `${icon} is not in the zip`);
		assert.ok(manifest.icons["128"], "the store needs a 128 px icon");

		const explained = explainedPermissions(readFileSync(join(root, "store/permissions.md"), "utf8"));
		for (const p of askedPermissions(manifest)) assert.ok(explained.includes(p), `${p} has no reason in store/permissions.md`);

		for (const f of files) {
			assert.doesNotMatch(f, /\.map$|^debug\.(html|js)$|\.pem$/, `${f} must not ship`);
		}
		for (const f of ["LICENSE", "NOTICE", "sidepanel.html", "background.js"]) assert.ok(files.includes(f), `${f} is missing`);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});
