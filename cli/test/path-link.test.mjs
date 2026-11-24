// After a release install, `tychicus` on PATH runs the release (path-link.ts): ~/.local/bin/tychicus is made, or repointed
// when it ran a Tychicus program (an old checkout, an older version) or nothing, and left alone, with the one command
// that repoints it, when it runs something else and there is no terminal to ask in. It also says when ~/.local/bin is not
// on PATH or another tychicus comes first. Each case runs in a throwaway HOME.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { inspectLink, linkOnPath } = await loadTs(`export { inspectLink, linkOnPath } from "@src/path-link.ts";`);

const root = mkdtempSync(join(tmpdir(), "tychicus-path-link-"));
after(() => rmSync(root, { recursive: true, force: true }));

// No terminal to ask in, whatever runs the tests.
Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

const ENV_KEYS = ["HOME", "XDG_DATA_HOME", "PATH", "SHELL"];

/** Run `fn` in a fresh HOME with a release installed, PATH set by `path(home)`, and the log lines it printed. */
async function inHome(name, path, fn) {
	const home = join(root, name);
	const release = join(home, ".local", "share", "tychicus");
	const version = join(release, "versions", "9.9.9-abc");
	mkdirSync(version, { recursive: true });
	writeFileSync(join(version, "tychicus"), "#!/bin/sh\n");
	chmodSync(join(version, "tychicus"), 0o755);
	symlinkSync(join("versions", "9.9.9-abc"), join(release, "release"));
	const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
	process.env.HOME = home;
	delete process.env.XDG_DATA_HOME;
	process.env.PATH = path(home);
	process.env.SHELL = "/bin/zsh";
	const lines = [];
	try {
		return await fn({ home, bin: join(home, ".local", "bin"), target: join(release, "release", "tychicus"), lines, log: (l) => lines.push(l) });
	} finally {
		for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
}

const onPath = (home) => `${join(home, ".local", "bin")}:/usr/bin:/bin`;

/** Put `~/.local/bin/tychicus` there as a link to `to`. */
function linkTo(bin, to) {
	mkdirSync(bin, { recursive: true });
	symlinkSync(to, join(bin, "tychicus"));
}

test("a fresh home gets ~/.local/bin/tychicus, a link to the release pointer", { skip: process.platform === "win32" }, async () => {
	await inHome("fresh", onPath, async ({ bin, target, lines, log }) => {
		assert.equal(inspectLink().state, "missing");
		await linkOnPath({ log });
		assert.equal(readlinkSync(join(bin, "tychicus")), target, "it names the pointer, so later installs move it too");
		assert.equal(inspectLink().state, "current");
		assert.match(lines.join("\n"), /Linked .*\.local\/bin\/tychicus -> .*release\/tychicus/);
		assert.doesNotMatch(lines.join("\n"), /isn't on your PATH|comes first/);
		// A second run leaves it as it is.
		await linkOnPath({ log });
		assert.equal(readlinkSync(join(bin, "tychicus")), target);
	});
});

test("a link to an old dev checkout's CLI is repointed at the release", { skip: process.platform === "win32" }, async () => {
	await inHome("checkout", onPath, async ({ home, bin, target, lines, log }) => {
		const checkout = join(home, "Projects", "tychicus");
		mkdirSync(join(checkout, "cli", "dist"), { recursive: true });
		writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "tabkyra" }));
		writeFileSync(join(checkout, "cli", "package.json"), JSON.stringify({ name: "tychicus" }));
		writeFileSync(join(checkout, "cli", "dist", "index.js"), "#!/usr/bin/env node\n");
		linkTo(bin, join(checkout, "cli", "dist", "index.js"));
		assert.equal(inspectLink().state, "ours");
		await linkOnPath({ log });
		assert.equal(readlinkSync(join(bin, "tychicus")), target);
		assert.match(lines.join("\n"), /Linked .* \(it ran .*Projects\/tychicus\/cli\/dist\/index\.js\)/);
	});
});

test("a link to an older version or to nothing is repointed", { skip: process.platform === "win32" }, async () => {
	for (const [name, to] of [
		["older", (home) => join(home, ".local", "share", "tychicus", "versions", "9.9.9-abc", "tychicus")],
		["dangling", (home) => join(home, "gone", "tychicus")],
	]) {
		await inHome(name, onPath, async ({ home, bin, target, log }) => {
			linkTo(bin, to(home));
			await linkOnPath({ log });
			assert.equal(readlinkSync(join(bin, "tychicus")), target, name);
		});
	}
});

test("someone else's tychicus is left alone without a terminal, with the one command that repoints it", { skip: process.platform === "win32" }, async () => {
	await inHome("other", onPath, async ({ bin, target, lines, log }) => {
		linkTo(bin, "/usr/bin/true");
		await linkOnPath({ log });
		assert.equal(readlinkSync(join(bin, "tychicus")), "/usr/bin/true", "it is not replaced");
		const out = lines.join("\n");
		assert.match(out, /runs \/usr\/bin\/true, which isn't Tychicus, so it was left alone/);
		assert.ok(out.includes(`ln -sf '${target}' '${join(bin, "tychicus")}'`), out);
	});
	await inHome("file", onPath, async ({ bin, lines, log }) => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "tychicus"), "#!/bin/sh\necho mine\n");
		await linkOnPath({ log });
		assert.equal(lstatSync(join(bin, "tychicus")).isSymbolicLink(), false);
		assert.match(lines.join("\n"), /is a file Tychicus didn't make, so it was left alone/);
	});
});

test("it says when ~/.local/bin isn't on PATH, and when another tychicus comes first", { skip: process.platform === "win32" }, async () => {
	await inHome("no-path", () => "/usr/bin:/bin", async ({ lines, log }) => {
		await linkOnPath({ log });
		assert.match(lines.join("\n"), /\.local\/bin isn't on your PATH, so typing tychicus won't find it\. Add it: echo 'export PATH="\$HOME\/\.local\/bin:\$PATH"' >> ~\/\.zshrc/);
	});
	await inHome("shadowed", (home) => `${join(home, "npm", "bin")}:${join(home, ".local", "bin")}:/usr/bin`, async ({ home, lines, log }) => {
		mkdirSync(join(home, "npm", "bin"), { recursive: true });
		writeFileSync(join(home, "npm", "bin", "tychicus"), "#!/bin/sh\n");
		await linkOnPath({ log });
		assert.match(lines.join("\n"), /Another tychicus comes first on your PATH: .*npm\/bin\/tychicus/);
	});
});

test("a dry run writes nothing", { skip: process.platform === "win32" }, async () => {
	await inHome("dry", onPath, async ({ bin, lines, log }) => {
		await linkOnPath({ dryRun: true, log });
		assert.equal(existsSync(join(bin, "tychicus")), false);
		assert.equal(existsSync(dirname(join(bin, "tychicus"))), false);
		assert.match(lines.join("\n"), /Would link/);
	});
});
