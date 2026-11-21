// The one install command lives in src/install-command.ts. The welcome screen shows it from there; README.md, the store
// listing and the scripts' own usage lines quote it word for word, and no other source file spells it out.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INSTALL_COMMAND_PS1, INSTALL_COMMAND_SH, installCommandFor } from "../src/install-command.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

test("the commands fetch the release's own scripts", () => {
	assert.equal(INSTALL_COMMAND_SH, "curl -fsSL https://github.com/baney75/tychicus/releases/latest/download/install.sh | sh");
	assert.equal(INSTALL_COMMAND_PS1, "irm https://github.com/baney75/tychicus/releases/latest/download/install.ps1 | iex");
});

test("each OS gets its command, and an OS the helper doesn't run on gets none", () => {
	for (const os of ["mac", "darwin", "linux"]) assert.deepEqual(installCommandFor(os), { command: INSTALL_COMMAND_SH, shell: "Terminal" });
	for (const os of ["win", "win32"]) assert.deepEqual(installCommandFor(os), { command: INSTALL_COMMAND_PS1, shell: "PowerShell" });
	for (const os of ["cros", "android", "fuchsia", "openbsd"]) assert.equal(installCommandFor(os), undefined);
});

test("README.md and the store listing quote both commands as the module writes them", () => {
	for (const file of ["README.md", "store/listing.md"]) {
		const text = read(file);
		assert.ok(text.includes(INSTALL_COMMAND_SH), `${file} does not quote: ${INSTALL_COMMAND_SH}`);
		assert.ok(text.includes(INSTALL_COMMAND_PS1), `${file} does not quote: ${INSTALL_COMMAND_PS1}`);
	}
	// The README leads its install section with the command, before the steps by hand.
	const readme = read("README.md");
	const install = readme.indexOf("\n## Install\n");
	assert.ok(install >= 0, 'README.md has no "## Install" section');
	assert.ok(readme.indexOf(INSTALL_COMMAND_SH, install) < readme.indexOf("### Install from a release by hand", install));
});

test("each script names the command that runs it", () => {
	assert.ok(read("scripts/install.sh").includes(INSTALL_COMMAND_SH));
	assert.ok(read("scripts/install.ps1").includes(INSTALL_COMMAND_PS1));
});

test("no other extension or helper source spells the command out", () => {
	const found = [];
	const walk = (dir) => {
		for (const name of readdirSync(join(root, dir))) {
			const rel = join(dir, name);
			if (statSync(join(root, rel)).isDirectory()) walk(rel);
			else if (/\.(ts|mjs|js)$/.test(name) && /releases\/latest\/download|install\.sh \| sh|install\.ps1 \| iex/.test(read(rel))) found.push(relative(root, join(root, rel)));
		}
	};
	walk("src");
	walk(join("cli", "src"));
	assert.deepEqual(found, [join("src", "install-command.ts")]);
});
