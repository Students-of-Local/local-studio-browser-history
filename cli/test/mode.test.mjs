// `tychicus mode` (docs/decisions.md, D67) against a fake native host: it shows the mode by name, sets Manual and
// Auto at once, and turns on Yolo only for a person at a terminal, after the warning. `ask` and `allow-all` are the
// older names for Manual and Yolo. `tychicus doctor` has a row for the mode, a warning in Yolo.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const frame = (m) => {
	const body = Buffer.from(JSON.stringify(m));
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
};

let root;
let server;
/** The mode the fake extension holds, and every permission.setMode it got. */
let mode = "auto";
let setModes = [];

before(async () => {
	root = mkdtempSync(join(tmpdir(), "tychicus-mode-"));
	mkdirSync(join(root, "sock"), { mode: 0o700 });
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "bin"));
	symlinkSync(process.execPath, join(root, "bin", "node"));
	server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
				const msg = JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32LE(0)).toString());
				buffered = buffered.subarray(4 + buffered.readUInt32LE(0));
				if (msg.type === "hello") {
					socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: true }));
					continue;
				}
				const result =
					msg.method === "status"
						? { mode, permissionMode: { manual: "ask", auto: "by_model", yolo: "allow_all" }[mode], allowedHosts: [] }
						: msg.method === "permission.setMode"
							? (setModes.push(msg.params.mode), (mode = msg.params.mode), { mode })
							: msg.method === "bridge.debug"
								? { version: "9.9.9", workerUptimeS: 60, userScriptsApi: true, userScripts: { state: "ready" }, mode }
								: {};
				socket.write(frame({ type: "response", id: msg.id, result }));
			}
		});
	});
	const path = join(root, "sock", `${process.pid}.sock`);
	await new Promise((resolve) => server.listen(path, resolve));
	chmodSync(path, 0o600);
});
after(() => {
	server.close();
	rmSync(root, { recursive: true, force: true });
});

/** Run the CLI with no terminal (stdin is a pipe), as an agent's shell would. */
async function run(...args) {
	const child = spawn(process.execPath, [cli, ...args], {
		env: {
			HOME: join(root, "home"),
			PATH: join(root, "bin"),
			TABKYRA_SOCKET_DIR: join(root, "sock"),
			TABKYRA_EXTENSION_DIR: join(root, "no-build"),
			NO_COLOR: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.end();
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => {
		out += d;
	});
	child.stderr.on("data", (d) => {
		err += d;
	});
	const code = await new Promise((resolve) => child.on("close", resolve));
	return { code, out, err };
}

test("mode with no argument shows the mode by name", async () => {
	mode = "manual";
	const r = await run("mode");
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /Mode: Manual: agents ask before a site you haven't allowed and before risky actions/);
});

test("mode manual and mode auto set the mode; ask is Manual", async () => {
	setModes = [];
	assert.equal((await run("mode", "auto")).code, 0);
	assert.match((await run("mode", "manual")).out, /Mode: Manual/);
	assert.equal((await run("ask")).code, 0);
	assert.deepEqual(setModes, ["auto", "manual", "manual"]);
});

test("Yolo takes a person at a terminal: from an agent's shell it is refused and nothing is sent", async () => {
	setModes = [];
	for (const args of [["mode", "yolo"], ["allow-all"], ["yolo"]]) {
		const r = await run(...args);
		assert.equal(r.code, 1, args.join(" "));
		assert.match(r.err, /Turning on Yolo takes a person: run tychicus mode yolo in a terminal/);
	}
	assert.deepEqual(setModes, []);
});

test("a mode that isn't one is a usage error", async () => {
	for (const args of [["mode", "full"], ["mode", "YOLO"], ["mode", "auto", "now"]]) assert.equal((await run(...args)).code, 2, args.join(" "));
});

test("doctor has a row for the mode: ok in Manual and Auto, a warning with the way back in Yolo", async () => {
	mode = "auto";
	let checks = JSON.parse((await run("doctor", "--json")).out).checks;
	assert.deepEqual(
		checks.find((c) => c.id === "mode"),
		{ id: "mode", status: "ok", label: "Mode: Auto: frontier models open ordinary sites; sensitive sites and risky actions ask" },
	);
	mode = "yolo";
	checks = JSON.parse((await run("doctor", "--json")).out).checks;
	const row = checks.find((c) => c.id === "mode");
	assert.equal(row.status, "warn");
	assert.equal(row.fix, "tychicus mode auto");
});
