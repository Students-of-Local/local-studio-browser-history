// Tychicus listens only in its own socket folder, /tmp/tychicus-bridge-<user>. Polycarp's folder (polycarp-bridge) and
// the one from before its rename (tabkyra-bridge) belong to Polycarp: a Tychicus host never listens there, so a Polycarp
// client never reaches the wrong browser helper.
import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const EXTENSION_ID = extensionId.id;

const posix = process.platform !== "win32";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

test("a host listens in Tychicus's own folder only, never in Polycarp's or the tabkyra one", { skip: !posix && "pipes on Windows", timeout: 30_000 }, async (t) => {
	const home = mkdtempSync(join(tmpdir(), "socket-dirs-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache") };
	for (const k of ["TYCHICUS_SOCKET_DIR", "POLYCARP_SOCKET_DIR", "TABKYRA_SOCKET_DIR"]) delete env[k];
	const host = spawn(process.execPath, [cli, "host", `chrome-extension://${EXTENSION_ID}/`], { env, stdio: ["pipe", "ignore", "pipe"] });
	t.after(() => host.kill("SIGKILL"));
	const user = userInfo().username;
	const own = `/tmp/tychicus-bridge-${user}/${host.pid}.sock`;
	const others = [`/tmp/polycarp-bridge-${user}/${host.pid}.sock`, `/tmp/tabkyra-bridge-${user}/${host.pid}.sock`];
	for (let i = 0; i < 200 && !existsSync(own); i++) await new Promise((r) => setTimeout(r, 50));
	assert.ok(existsSync(own), "the host listens in its own folder");
	await new Promise((resolve, reject) => {
		const sock = connect(own, () => {
			sock.destroy();
			resolve();
		});
		sock.on("error", reject);
	});
	for (const other of others) assert.equal(existsSync(other), false, `${other} belongs to Polycarp`);
	const exited = new Promise((r) => host.once("exit", r));
	host.stdin.end();
	await exited;
	assert.equal(existsSync(own), false, "the socket is gone when the host stops");
});
