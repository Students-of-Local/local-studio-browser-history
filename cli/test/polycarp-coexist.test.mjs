// Tychicus and Polycarp side by side, against a throwaway HOME with every XDG folder inside it: Tychicus writes only its
// own folders, launchers and host, and leaves every byte of a Polycarp install (its launchers, its host manifest, the
// old tabkyra folders its helper migrates) as it was. A dry run, and an install --release that is refused, change
// nothing on disk at all.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "tychicus-coexist-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const posix = process.platform !== "win32";

let n = 0;
/** A HOME with a Chromium profile folder and a Polycarp install: launchers, host manifest, app config, tabkyra leftovers. */
function polycarpHome() {
	const home = join(scratch, `home-${++n}`);
	const cfg = join(home, ".config");
	const pc = join(cfg, "polycarp", "browser");
	mkdirSync(pc, { recursive: true });
	writeFileSync(join(cfg, "polycarp", "config.toml"), "theme = 'polycarp'\n");
	writeFileSync(join(pc, "polycarp"), '#!/bin/sh\nexec "/opt/polycarp/polycarp-browser" "$@"\n', { mode: 0o755 });
	writeFileSync(join(pc, "polycarp-host"), '#!/bin/sh\nexec "/opt/polycarp/polycarp-browser" host "$@"\n', { mode: 0o755 });
	writeFileSync(join(pc, "remote.json"), '{"polycarp":true}\n', { mode: 0o600 });
	mkdirSync(join(home, ".local", "share", "polycarp", "browser", "threads"), { recursive: true });
	writeFileSync(join(home, ".local", "share", "polycarp", "browser", "threads", "index.json"), "[]\n");
	mkdirSync(join(home, ".cache", "polycarp"), { recursive: true });
	writeFileSync(join(home, ".cache", "polycarp", "x"), "cache\n");
	// Folders from before Polycarp's rename: its own helper moves them, never Tychicus.
	mkdirSync(join(cfg, "tabkyra"), { recursive: true });
	writeFileSync(join(cfg, "tabkyra", "tabkyra"), '#!/bin/sh\nexec "/opt/tabkyra/tabkyra" "$@"\n', { mode: 0o755 });
	writeFileSync(join(cfg, "tabkyra", "settings.json"), '{"old":true}\n');
	mkdirSync(join(home, ".local", "share", "tabkyra"), { recursive: true });
	writeFileSync(join(home, ".local", "share", "tabkyra", "data"), "old data\n");
	const hosts = join(cfg, "chromium", "NativeMessagingHosts");
	mkdirSync(hosts, { recursive: true });
	for (const name of ["com.polycarp.browser", "ai.tabkyra.bridge"])
		writeFileSync(
			join(hosts, `${name}.json`),
			`${JSON.stringify({ name, description: "Polycarp", path: join(pc, "polycarp-host"), type: "stdio", allowed_origins: ["chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/"] }, null, 2)}\n`,
		);
	// Polycarp's commands on PATH.
	const bin = join(home, "bin");
	mkdirSync(bin);
	for (const name of ["polycarp", "polycarp-browser"]) writeFileSync(join(bin, name), `#!/bin/sh\necho ${name}\n`, { mode: 0o755 });
	mkdirSync(join(home, "sock"), { mode: 0o700 });
	return home;
}

function run(home, args, extra = {}) {
	const env = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PATH: [join(home, "bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
		TYCHICUS_SOCKET_DIR: join(home, "sock"),
		TABKYRA_SOCKET_DIR: join(home, "sock"),
		TYCHICUS_GH: "none",
		...extra,
	};
	for (const k of ["POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR", "TYCHICUS_CONFIG_DIR", "POLYCARP_HOME", "TABKYRA_HOME", "POLYCARP_CACHE_DIR", "TABKYRA_CACHE_DIR", "EUKHE_CODING_AGENT_DIR", "LOCAL_STUDIO_DATA_DIR"]) {
		if (!(k in extra)) delete env[k];
	}
	const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Every path under `root` with its type, mode and content hash (or link target), sorted. */
function tree(root) {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const st = lstatSync(path);
			const rel = path.slice(root.length);
			if (st.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(path)}`);
			else if (st.isDirectory()) {
				out.push(`${rel}/`);
				walk(path);
			} else out.push(`${rel} ${(st.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(root);
	return out;
}

/** Everything Polycarp owns in this HOME. */
function polycarpTree(home) {
	const parts = [join(home, ".config", "polycarp"), join(home, ".config", "tabkyra"), join(home, ".local", "share", "polycarp"), join(home, ".local", "share", "tabkyra"), join(home, ".cache", "polycarp"), join(home, "bin")];
	const hosts = join(home, ".config", "chromium", "NativeMessagingHosts");
	return [
		...parts.flatMap((p) => (existsSync(p) ? [p, ...tree(p)] : [`${p} missing`])),
		...["com.polycarp.browser.json", "ai.tabkyra.bridge.json"].map((f) => `${f} ${createHash("sha256").update(readFileSync(join(hosts, f))).digest("hex")}`),
	];
}

test("install leaves a Polycarp install byte-identical and writes Tychicus's own launchers, host and folders", { skip: !posix && "launchers are .cmd files there" }, () => {
	const home = polycarpHome();
	const before = polycarpTree(home);
	for (const args of [["install"], ["install", "--force"], ["status", "--json"]]) {
		const r = run(home, args);
		assert.ok(args[0] === "status" || r.status === 0, `${args.join(" ")}: ${r.out}`);
	}
	assert.deepEqual(polycarpTree(home), before, "a Polycarp file changed");
	const own = join(home, ".config", "tychicus");
	const manifest = JSON.parse(readFileSync(join(home, ".config", "chromium", "NativeMessagingHosts", "com.tychicus.browser.json"), "utf8"));
	assert.equal(manifest.path, join(own, "tychicus-host"));
	assert.match(readFileSync(join(own, "tychicus-host"), "utf8"), / host /);
	assert.ok(existsSync(join(own, "tychicus")), "the agent launcher");
});

test("the npm package puts no polycarp or tabkyra command on PATH", () => {
	const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
	assert.deepEqual(Object.keys(pkg.bin), ["tychicus"]);
});

test("install --dry-run and a refused install --release change nothing on disk, old tabkyra folders included", { skip: !posix && "tar and sh fixtures" }, () => {
	// Only the folders from before Polycarp's rename: the case where its migration would move them.
	const home = join(scratch, `home-${++n}`);
	mkdirSync(join(home, ".config", "tabkyra"), { recursive: true });
	mkdirSync(join(home, ".config", "chromium"), { recursive: true });
	writeFileSync(join(home, ".config", "tabkyra", "tabkyra"), '#!/bin/sh\nexec "/opt/tabkyra/tabkyra" "$@"\n', { mode: 0o755 });
	writeFileSync(join(home, ".config", "tabkyra", "settings.json"), '{"old":true}\n');
	mkdirSync(join(home, ".local", "share", "tabkyra"), { recursive: true });
	writeFileSync(join(home, ".local", "share", "tabkyra", "data"), "old data\n");
	mkdirSync(join(home, "bin"));
	mkdirSync(join(home, "sock"), { mode: 0o700 });
	const before = tree(home);
	const dry = run(home, ["install", "--dry-run"]);
	assert.equal(dry.status, 0, dry.out);
	assert.deepEqual(tree(home), before, "install --dry-run wrote to disk");
	// A release folder whose checksums don't match: refused before anything is unpacked.
	const rel = join(scratch, `release-${++n}`);
	mkdirSync(rel);
	const tag = `${process.platform}-${process.arch}`;
	writeFileSync(join(rel, `tychicus-9.9.9-${tag}.tar.gz`), "not the archive");
	writeFileSync(join(rel, "SHA256SUMS"), `${"0".repeat(64)}  tychicus-9.9.9-${tag}.tar.gz\n`);
	for (const args of [["install", "--release", rel], ["install", "--release", rel, "--dry-run"]]) {
		const r = run(home, args);
		assert.notEqual(r.status, 0, r.out);
		assert.match(r.out, /does not match/);
		assert.deepEqual(tree(home), before, `${args.join(" ")} wrote to disk`);
	}
});
