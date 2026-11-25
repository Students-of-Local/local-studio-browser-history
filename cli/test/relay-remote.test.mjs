// The relay route from the command line: `remote setup`, `status`, `off` and `fix` (the relay parts of remote-setup.ts and
// remote-fix.ts), on a throwaway machine with a wrangler stand-in (helpers/relay-machine.mjs). Nothing here reaches Cloudflare.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ADDRESS, machine, serveStandIn, unix } from "./helpers/relay-machine.mjs";

const root = mkdtempSync(join(tmpdir(), "tychicus-relay-remote-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("remote status names the connector's state, and remote off removes the connector and says the Worker stays", { skip: !unix }, async () => {
	const m = machine(root, "status-off");
	const key = "k".repeat(43);
	const stateFile = join(m.cfg, "relay-state.json");
	writeFileSync(join(m.cfg, "remote.json"), JSON.stringify({ publicUrl: ADDRESS, port: 18787, route: "relay", relay: { name: "my-relay", key } }), { mode: 0o600 });
	const view = async () => (await m.run(["remote", "status", "--json"])).json();
	assert.deepEqual((await view()).relay, { state: "stopped", since: null }, "no state file: the connector never ran");
	writeFileSync(stateFile, JSON.stringify({ state: "connected", at: 1790000000000, pid: process.pid }));
	const status = await view();
	assert.equal(status.route, "relay");
	assert.deepEqual(status.relay, { state: "connected", since: 1790000000000 });
	const check = status.checks.find((c) => c.name === "relay");
	assert.equal(check.status, "fail", "a state file with no service behind it isn't up");
	assert.match(check.detail, /service is gone/);
	const off = await m.run(["remote", "off"]);
	assert.equal(off.code, 0, off.stdout + off.stderr);
	assert.match(off.stdout + off.stderr, /my-relay stays on your Cloudflare account.*npx wrangler@4\.163\.0 delete my-relay/s);
	assert.equal(m.remoteJson(), undefined);
	assert.equal(existsSync(stateFile), false);
	assert.deepEqual(m.wrangler(), [], "off never runs wrangler");
	assert.ok(![JSON.stringify(status), off.stdout, off.stderr].some((t) => t.includes(key)), "the key is never printed");
});

test("remote fix on the relay route: a refused key means setup again, and a connector that isn't running is restarted", { skip: !unix }, async () => {
	const m = machine(root, "fix");
	const serve = await serveStandIn();
	try {
		writeFileSync(join(m.cfg, "remote.json"), JSON.stringify({ publicUrl: ADDRESS, port: serve.port, route: "relay", relay: { name: "tychicus-relay", key: "k".repeat(43) } }), { mode: 0o600 });
		writeFileSync(join(m.cfg, "relay-state.json"), JSON.stringify({ state: "unauthorized", at: Date.now(), pid: process.pid }));
		const refused = await m.run(["remote", "fix", "--dry-run", "--json"]);
		assert.equal(refused.json().code, "relay_unauthorized", refused.stdout);
		assert.match(refused.json().message, /refused its key/);
		assert.match(refused.json().message, /tychicus remote off && tychicus remote setup\./, "what fix prints is a command setup takes");
		const setup = await m.run(["remote", "setup", "--json"]);
		assert.notEqual(setup.code, 0, "setup alone refuses to replace a relay route");
		assert.match(setup.stdout, /remote off/);
		rmSync(join(m.cfg, "relay-state.json"));
		const down = await m.run(["remote", "fix", "--dry-run", "--json"]);
		assert.ok(down.json().actions.some((a) => a.kind === "restart_relay"), down.stdout);
		assert.deepEqual(m.wrangler(), []);
	} finally {
		await serve.close();
	}
});
