// Where hosts listen and clients look. Tychicus has its own folder, /tmp/tychicus-bridge-<user>; listSockets can still search
// several folders (an override names one), newest host first.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listSockets } from "../cli/src/client.ts";
import { socketDir, socketDirs } from "../cli/src/paths.ts";

const posix = process.platform !== "win32";

test("clients find a live host in a second folder, newest first across both", { skip: !posix && "pipes on Windows" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "socket-dirs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fresh = join(root, "polycarp-bridge");
	const old = join(root, "tabkyra-bridge");
	for (const dir of [fresh, old]) {
		mkdirSync(dir);
		chmodSync(dir, 0o700);
	}
	// listSockets keeps names whose pid is alive; this process and its parent are.
	const oldSock = join(old, `${process.pid}.sock`);
	writeFileSync(oldSock, "");
	assert.deepEqual(listSockets([fresh, old]), [oldSock], "a host only in the old folder is found");
	const newSock = join(fresh, `${process.ppid}.sock`);
	writeFileSync(newSock, "");
	const past = new Date(Date.now() - 60_000);
	utimesSync(oldSock, past, past);
	assert.deepEqual(listSockets([fresh, old]), [newSock, oldSock]);
	// An old folder anyone could have planted is skipped, not trusted.
	chmodSync(old, 0o755);
	assert.deepEqual(listSockets([fresh, old]), [newSock]);
	chmodSync(fresh, 0o755);
	assert.throws(() => listSockets([fresh, old]), /mode 755/, "the current folder still has to be private");
});

test("a host in both folders is listed once, from the new one", { skip: !posix && "pipes on Windows" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "socket-dirs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fresh = join(root, "polycarp-bridge");
	const old = join(root, "tabkyra-bridge");
	for (const dir of [fresh, old]) {
		mkdirSync(dir);
		chmodSync(dir, 0o700);
		writeFileSync(join(dir, `${process.pid}.sock`), "");
	}
	assert.deepEqual(listSockets([fresh, old]), [join(fresh, `${process.pid}.sock`)]);
});

// second-F6: the npm `tabkyra` bin is gone. An agent entry that still runs a bare `tabkyra mcp` is stale, so doctor flags it
// and setup rewrites it, instead of the agent failing with "command not found".
test("an agent entry running the removed bare tabkyra command is stale", async () => {
	const { classify } = await import("../cli/src/harness.ts");
	const saved = process.env.PATH;
	process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
	try {
		assert.equal(classify("tabkyra", ["mcp"]), "stale");
	} finally {
		process.env.PATH = saved;
	}
});

// sol-F1 (PR 3): Tychicus's host listens only in its own folder, and its clients look only there, so a Polycarp helper
// running on the same computer is never found by Tychicus and never finds Tychicus.
test("the socket folder is Tychicus's own: no Polycarp or tabkyra folder is searched or listened in", { skip: !posix && "pipes on Windows" }, () => {
	const names = ["TYCHICUS_SOCKET_DIR", "POLYCARP_SOCKET_DIR", "TABKYRA_SOCKET_DIR"];
	const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
	for (const k of names) delete process.env[k];
	try {
		const user = userInfo().username;
		assert.deepEqual(socketDirs(), [`/tmp/tychicus-bridge-${user}`]);
		assert.equal(socketDir(), `/tmp/tychicus-bridge-${user}`);
		process.env.TYCHICUS_SOCKET_DIR = "/x/override";
		assert.deepEqual(socketDirs(), ["/x/override"]);
	} finally {
		for (const k of names) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
});
