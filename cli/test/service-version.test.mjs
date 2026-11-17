// Which version a Tychicus service runs, read on any computer: a stand-in replaces launchctl, lsof and ps, so nothing here
// starts or restarts a service. The release layout is real folders and a real `release` symlink.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const mod = await loadTs(`
export { restartStaleServices, staleServices } from "@src/service-version.ts";
export * as service from "@src/service.ts";
`);
const { staleServices, restartStaleServices } = mod;
const { setServiceSeamForTests, SERVE_SERVICE, plistText, unitText } = mod.service;

const dir = mkdtempSync(join(tmpdir(), "tychicus-svcver-"));
after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setServiceSeamForTests({}));

const OLD = "1.0.0-aaaaaaaaaaaa";
const NEW = "2.0.0-bbbbbbbbbbbb";

/** A release base whose pointer already names NEW, as after install moved it, and a Mac HOME with serve's plist. */
function layout(name) {
	const home = join(dir, name);
	const base = join(home, ".local", "share", "tychicus");
	for (const v of [OLD, NEW]) {
		mkdirSync(join(base, "versions", v), { recursive: true });
		writeFileSync(join(base, "versions", v, "tychicus"), "");
	}
	symlinkSync(join("versions", NEW), join(base, "release"));
	mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
	writeFileSync(join(home, "Library", "LaunchAgents", `${SERVE_SERVICE.label}.plist`), "<plist/>");
	return { home, base, root: join(base, "release"), current: join(base, "versions", NEW), old: join(base, "versions", OLD) };
}

/** launchctl names pid 4242; lsof and ps answer as given (undefined: the command fails). */
function macSeam({ lsof, ps }) {
	const calls = [];
	const exec = (cmd, args) => {
		calls.push([cmd, ...args]);
		if (cmd === "launchctl" && args[0] === "print") return args[1].endsWith(SERVE_SERVICE.label) ? { code: 0, out: "\tstate = running\n\tpid = 4242\n" } : { code: 113, out: "" };
		if (cmd === "/usr/sbin/lsof") return lsof ? { code: 0, out: `p4242\nn${lsof}\n` } : { code: 1, out: "" };
		if (cmd === "/bin/ps") return ps ? { code: 0, out: `${ps}\n` } : { code: 1, out: "" };
		return { code: 0, out: "" };
	};
	setServiceSeamForTests({ platform: "darwin", exec });
	return calls;
}

function withHome(home, fn) {
	const was = process.env.HOME;
	process.env.HOME = home;
	try {
		return fn();
	} finally {
		process.env.HOME = was;
	}
}

test("on a Mac, a serve that ps names by the release pointer but lsof shows in the old version folder is stale", () => {
	const l = layout("mac-lsof");
	macSeam({ ps: join(l.root, "tychicus"), lsof: join(l.old, "tychicus") });
	const stale = withHome(l.home, () => staleServices(l.current, { root: l.root }));
	assert.deepEqual(
		stale.map((s) => [s.spec.label, s.pid, s.running, s.release]),
		[[SERVE_SERVICE.label, 4242, "1.0.0", "2.0.0"]],
	);
});

test("on a Mac, a serve that lsof shows in the release's own folder is not stale", () => {
	const l = layout("mac-current");
	macSeam({ ps: join(l.root, "tychicus"), lsof: join(l.current, "tychicus") });
	assert.deepEqual(withHome(l.home, () => staleServices(l.current, { root: l.root })), []);
});

test("without lsof, a program named by the pointer runs what the pointer named before install moved it", () => {
	const l = layout("mac-ps");
	macSeam({ ps: join(l.root, "tychicus") });
	const stale = withHome(l.home, () => staleServices(l.current, { root: l.root, before: l.old }));
	assert.deepEqual(stale.map((s) => s.running), ["1.0.0"]);
	// Not knowing what it named before, the version can't be told, so it isn't counted (resolving the pointer now would say 2.0.0).
	assert.deepEqual(withHome(l.home, () => staleServices(l.current, { root: l.root })), []);
});

// ---------- A restart keeps the folders the service was set up with ----------

const FOLDER_KEYS = ["POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR", "TYCHICUS_CONFIG_DIR", "XDG_CONFIG_HOME", "TYCHICUS_SOCKET_DIR", "POLYCARP_SOCKET_DIR", "TYCHICUS_SERVE_WAIT_MS", "TYCHICUS_RELEASE_BEFORE"];

/** HOME as given, this shell with no config folder of its own (so it would pick the default one), and quick read-backs. */
async function asShell(home, fn) {
	const was = Object.fromEntries(["HOME", ...FOLDER_KEYS].map((k) => [k, process.env[k]]));
	for (const k of FOLDER_KEYS) delete process.env[k];
	process.env.HOME = home;
	process.env.TYCHICUS_SERVE_WAIT_MS = "2000";
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(was)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** A config folder of the service's own, with a launcher that runs the old version, as setup left it. */
function customFolder(l) {
	const config = join(l.home, "Custom Config");
	mkdirSync(config, { recursive: true });
	const launcher = join(config, "tychicus");
	writeFileSync(launcher, `#!/bin/sh\nexec "${join(l.old, "tychicus")}" "$@"\n`, { mode: 0o755 });
	return { config, launcher };
}

test("on a Mac, restarting a stale serve keeps the plist and its own config folder, and only asks launchd to restart it", async () => {
	const l = layout("mac-restart");
	const { config, launcher } = customFolder(l);
	const plist = join(l.home, "Library", "LaunchAgents", `${SERVE_SERVICE.label}.plist`);
	const text = plistText(launcher, { POLYCARP_BROWSER_CONFIG_DIR: config, TABKYRA_CONFIG_DIR: config }, join(l.home, "Library", "Logs", "tychicus-serve.log"), SERVE_SERVICE);
	writeFileSync(plist, text);
	// Until launchd restarts it, pid 4242 runs the old version (ps names that folder too); after, pid 4343 runs the release.
	let restarted = false;
	const calls = [];
	setServiceSeamForTests({
		platform: "darwin",
		exec: (cmd, args) => {
			calls.push([cmd, ...args].join(" "));
			const pid = restarted ? 4343 : 4242;
			const folder = restarted ? l.current : l.old;
			if (cmd === "launchctl" && args[0] === "print") return args[1].endsWith(SERVE_SERVICE.label) ? { code: 0, out: `\tpid = ${pid}\n` } : { code: 113, out: "" };
			if (cmd === "launchctl" && (args[0] === "kickstart" || args[0] === "bootstrap")) restarted = true;
			if (cmd === "/usr/sbin/lsof") return { code: 0, out: `p${pid}\nn${join(folder, "tychicus")}\n` };
			if (cmd === "/bin/ps") return { code: 0, out: `${join(folder, "tychicus")}\n` };
			return { code: 0, out: "" };
		},
	});
	const said = [];
	const code = await asShell(l.home, () => restartStaleServices(l.root, join(l.root, "tychicus"), (line) => said.push(line)));
	assert.equal(code, 0, said.join("\n"));
	assert.match(said.join("\n"), /Restarted com\.tychicus\.serve: 1\.0\.0 -> 2\.0\.0/);
	assert.equal(readFileSync(plist, "utf8"), text, "the plist, with its config folder, is as setup wrote it");
	assert.ok(calls.some((c) => c.startsWith("launchctl kickstart -k gui/") && c.endsWith(`/${SERVE_SERVICE.label}`)), calls.join("\n"));
	assert.ok(!calls.some((c) => c.startsWith("launchctl bootout") || c.startsWith("launchctl bootstrap")), calls.join("\n"));
	// The launcher in the service's own folder no longer runs the old version.
	assert.doesNotMatch(readFileSync(launcher, "utf8"), new RegExp(OLD));
});

test("on Linux, restarting a serve keeps its unit and config folder, and only runs systemctl restart", async () => {
	const l = layout("linux-restart");
	const { config, launcher } = customFolder(l);
	const unit = join(l.home, ".config", "systemd", "user", SERVE_SERVICE.unit);
	mkdirSync(join(l.home, ".config", "systemd", "user"), { recursive: true });
	const text = unitText(launcher, { POLYCARP_BROWSER_CONFIG_DIR: config, TABKYRA_CONFIG_DIR: config }, SERVE_SERVICE);
	writeFileSync(unit, text);
	const calls = [];
	setServiceSeamForTests({ platform: "linux", exec: (cmd, args) => (calls.push([cmd, ...args].join(" ")), { code: 0, out: "" }) });
	const r = await asShell(l.home, () => mod.service.restartService(SERVE_SERVICE));
	assert.equal(r.ok, true, r.message);
	assert.equal(readFileSync(unit, "utf8"), text);
	assert.deepEqual(calls, [`systemctl --user restart ${SERVE_SERVICE.unit}`]);
});

test("a unit that names a version folder's program directly is written again with the config folder it had saved", async () => {
	const l = layout("linux-direct");
	const { config } = customFolder(l);
	const unit = join(l.home, ".config", "systemd", "user", SERVE_SERVICE.unit);
	mkdirSync(join(l.home, ".config", "systemd", "user"), { recursive: true });
	writeFileSync(unit, unitText(join(l.old, "tychicus"), { POLYCARP_BROWSER_CONFIG_DIR: config, TABKYRA_CONFIG_DIR: config }, SERVE_SERVICE));
	const calls = [];
	setServiceSeamForTests({ platform: "linux", launcher: join(l.home, ".config", "tychicus", "tychicus"), exec: (cmd, args) => (calls.push([cmd, ...args].join(" ")), { code: 0, out: "" }) });
	const r = await asShell(l.home, () => mod.service.restartService(SERVE_SERVICE));
	assert.equal(r.ok, true, r.message);
	const now = readFileSync(unit, "utf8");
	assert.doesNotMatch(now, new RegExp(OLD), "the unit no longer names the old version");
	assert.match(now, new RegExp(`^Environment="POLYCARP_BROWSER_CONFIG_DIR=${config}"$`, "m"));
	assert.deepEqual(calls.slice(-1), [`systemctl --user restart ${SERVE_SERVICE.unit}`]);
});
