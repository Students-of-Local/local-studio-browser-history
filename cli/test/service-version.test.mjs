// Which version a Tychicus service runs, read on any computer: a stand-in replaces launchctl, lsof and ps, so nothing here
// starts or restarts a service. The release layout is real folders and a real `release` symlink.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { staleServices, setServiceSeamForTests, SERVE_SERVICE } = await loadTs(`
export { staleServices } from "@src/service-version.ts";
export { setServiceSeamForTests, SERVE_SERVICE } from "@src/service.ts";
`);

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
