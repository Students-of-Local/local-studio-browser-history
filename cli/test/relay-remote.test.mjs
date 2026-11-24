// The relay route from the command line: `remote setup`, `status`, `off` and `fix` (the relay parts of remote-setup.ts and
// remote-fix.ts), on a throwaway machine with a wrangler stand-in (helpers/relay-machine.mjs). Nothing here reaches Cloudflare.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ACCOUNT, ADDRESS, machine, serveStandIn, unix } from "./helpers/relay-machine.mjs";

const OTHER = "fedcba9876543210fedcba9876543210";
const root = mkdtempSync(join(tmpdir(), "tychicus-relay-remote-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("signed out with no terminal: setup asks for the sign-in, runs no login and saves nothing", { skip: !unix }, async () => {
	const m = machine(root, "signed-out", { whoami: "out" });
	const r = await m.run(["remote", "setup", "--relay", "--json"]);
	assert.equal(r.code, 3, r.stdout + r.stderr);
	const report = r.json();
	assert.equal(report.code, "cloudflare_login");
	assert.equal(report.step, "needs_signin");
	assert.deepEqual(report.next, { kind: "sign_in", command: "tychicus remote setup --relay" });
	assert.deepEqual(
		m.wrangler().map((l) => l.split(" ")[3]),
		["whoami"],
	);
	assert.match(m.wrangler()[0], /^npx --yes wrangler@4\.163\.0 whoami --json account= metrics=false$/);
	assert.equal(m.remoteJson(), undefined);
});

test("signed out at a terminal: setup runs wrangler login, then deploys with the new sign-in; a login that fails saves nothing", { skip: !unix }, async () => {
	const mine = { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Mine" }] };
	const m = machine(root, "login", { whoami: "out", afterLogin: mine, deploy: "subdomain" });
	const r = await m.run(["remote", "setup", "--relay", "--no-passcode"], { TABKYRA_ASSUME_TTY: "1" }, { input: "" });
	assert.equal(r.code, 3, r.stdout + r.stderr);
	assert.deepEqual(
		m.wrangler().map((l) => l.split(" ")[3]),
		["whoami", "login", "whoami", "secret", "deploy"],
	);
	assert.match(r.stdout, /Signed in to Cloudflare/);
	assert.ok(m.wrangler().at(-1).includes(`account=${ACCOUNT} `), "the deploy goes to the account of the new sign-in");
	for (const [name, how] of [
		["login-refused", { loginCode: 1, afterLogin: mine }],
		["login-unfinished", { afterLogin: "out" }],
	]) {
		const bad = machine(root, name, { whoami: "out", ...how });
		const b = await bad.run(["remote", "setup", "--relay", "--no-passcode"], { TABKYRA_ASSUME_TTY: "1" }, { input: "" });
		assert.equal(b.code, 3, b.stdout + b.stderr);
		assert.match(b.stdout + b.stderr, /sign-in didn't finish, so nothing was changed/);
		assert.ok(!bad.wrangler().some((l) => l.includes(" deploy ")));
		assert.equal(bad.remoteJson(), undefined);
	}
});

test("no workers.dev subdomain: setup names the onboarding page for the account and saves nothing", { skip: !unix }, async () => {
	const m = machine(root, "subdomain", { deploy: "subdomain" });
	const r = await m.run(["remote", "setup", "--relay", "--json"]);
	assert.equal(r.code, 3, r.stdout + r.stderr);
	const report = r.json();
	assert.equal(report.code, "workers_subdomain");
	assert.deepEqual(report.next, { kind: "open_page", url: `https://dash.cloudflare.com/${ACCOUNT}/workers/onboarding` });
	assert.ok(m.wrangler().some((l) => l.includes(` deploy --name tychicus-relay account=${ACCOUNT} `)));
	assert.equal(m.secret(), undefined, "no key is set");
	assert.equal(m.remoteJson(), undefined);
});

test("a sign-in with two accounts needs --account, and --account picks the one wrangler deploys to", { skip: !unix }, async () => {
	const whoami = { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Mine" }, { id: OTHER, name: "Work" }] };
	const m = machine(root, "two-accounts", { whoami, deploy: "subdomain" });
	const r = await m.run(["remote", "setup", "--relay", "--json"]);
	assert.equal(r.code, 3);
	assert.equal(r.json().code, "cloudflare_account");
	assert.deepEqual(r.json().next, { kind: "run_command", command: "tychicus remote setup --relay --account <id>" });
	assert.ok(!m.wrangler().some((l) => l.includes(" deploy ")));
	const picked = await m.run(["remote", "setup", "--json", "--relay", "my-relay", "--account", OTHER]);
	assert.equal(picked.json().code, "workers_subdomain");
	assert.ok(m.wrangler().some((l) => l.includes(` deploy --name my-relay account=${OTHER} `)), m.wrangler().join("\n"));
	const unknown = await m.run(["remote", "setup", "--relay", "--json", "--account", "a".repeat(32)]);
	assert.equal(unknown.json().code, "cloudflare_account");
});

test("route flags and the relay's own refusals change nothing", { skip: !unix }, async () => {
	const m = machine(root, "refusals");
	assert.equal((await m.run(["remote", "setup", "--relay", "--tailscale"])).code, 2);
	assert.equal((await m.run(["remote", "setup", "--account", "nope"])).code, 2);
	assert.equal((await m.run(["remote", "setup", "--tailscale", "--account", ACCOUNT])).code, 2);
	const named = await m.run(["remote", "setup", "--json", "--relay", "Bad_Name"]);
	assert.equal(named.json().code, "relay_name");
	const noService = await m.run(["remote", "setup", "--relay", "--json", "--no-service"]);
	assert.match(noService.json().message, /runs as a service/);
	const noNpx = await m.run(["remote", "setup", "--relay", "--json"], { TYCHICUS_NPX: "" });
	assert.equal(noNpx.code, 3);
	assert.equal(noNpx.json().code, "npx");
	assert.equal(noNpx.json().next.kind, "install");
	writeFileSync(join(m.cfg, "remote.json"), JSON.stringify({ publicUrl: "https://box.example.ts.net:8443", port: 8787, route: "funnel" }), { mode: 0o600 });
	const other = await m.run(["remote", "setup", "--json", "--relay"]);
	assert.match(other.json().message, /funnel route from an earlier setup is on/);
	assert.deepEqual(m.wrangler(), [], "wrangler never ran");
	assert.equal(m.remoteJson().route, "funnel");
});

test("setup end to end: deploy, a new key on stdin, saved 0600, the connector's service, and /v1/health back through the relay", { skip: !unix }, async () => {
	const m = machine(root, "happy");
	m.launcher();
	const serve = await serveStandIn();
	try {
		const extra = { RELAY_HOOK_PORT: String(serve.port), TYCHICUS_PUBLIC_WAIT_MS: "2000", TYCHICUS_PUBLIC_POLL_MS: "50" };
		const r = await m.run(["remote", "setup", "--relay", "--json", "--port", String(serve.port)], extra, { hooks: true });
		assert.equal(r.code, 0, r.stdout + r.stderr);
		const report = r.json();
		assert.equal(report.state, "on");
		assert.equal(report.connectorUrl, `${ADDRESS}/mcp`);
		const saved = m.remoteJson();
		assert.equal(saved.route, "relay");
		assert.equal(saved.publicUrl, ADDRESS);
		assert.equal(saved.relay.name, "tychicus-relay");
		assert.equal(saved.relay.accountId, ACCOUNT);
		assert.match(saved.relay.key, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(m.secret(), saved.relay.key, "the key on the Worker is the one in remote.json");
		assert.equal(statSync(join(m.cfg, "remote.json")).mode & 0o777, 0o600);
		assert.ok(!r.stdout.includes(saved.relay.key) && !r.stderr.includes(saved.relay.key), "the key is never printed");
		assert.ok(m.wrangler().every((l) => l.endsWith("metrics=false") && !l.includes(saved.relay.key)));
		assert.ok(m.calls().some((l) => /^(launchctl|systemctl) .*tychicus[.-]relay/.test(l)), m.calls().join("\n"));
		// Every run sets a new key.
		const again = await m.run(["remote", "setup", "--json", "--port", String(serve.port)], extra, { hooks: true });
		assert.equal(again.code, 0, again.stdout);
		assert.notEqual(m.remoteJson().relay.key, saved.relay.key);
		assert.equal(m.secret(), m.remoteJson().relay.key);
		// Status names the connector's state; off removes its service and says the Worker stays.
		const status = (await m.run(["remote", "status", "--json"])).json();
		assert.equal(status.route, "relay");
		assert.equal(status.relay.state, "stopped", "the stub service manager never ran the connector");
		const off = await m.run(["remote", "off"]);
		assert.equal(off.code, 0, off.stdout + off.stderr);
		assert.match(off.stdout + off.stderr, /npx wrangler@4\.163\.0 delete tychicus-relay/);
		assert.equal(m.remoteJson(), undefined);
		// The Worker that stayed is this computer's own, so setup takes it again.
		const back = await m.run(["remote", "setup", "--relay", "--json", "--port", String(serve.port)], extra, { hooks: true });
		assert.equal(back.code, 0, back.stdout);
	} finally {
		await serve.close();
	}
});

test("a relay of the default name with a key from elsewhere is left alone; naming it takes it over", { skip: !unix }, async () => {
	const m = machine(root, "taken", { keyed: true, deploy: "subdomain" });
	const r = await m.run(["remote", "setup", "--relay", "--json"]);
	assert.equal(r.code, 3, r.stdout + r.stderr);
	assert.equal(r.json().code, "relay_taken");
	assert.match(r.json().next.command, /^tychicus remote setup --relay tychicus-relay-[a-z0-9][a-z0-9-]*[a-z0-9]$|-2$/);
	assert.ok(!m.wrangler().some((l) => l.includes(" deploy ")), "nothing is deployed");
	assert.equal(m.secret(), undefined);
	const named = await m.run(["remote", "setup", "--relay", "tychicus-relay", "--json"]);
	assert.equal(named.json().code, "workers_subdomain", "it went on to deploy");
});

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
		rmSync(join(m.cfg, "relay-state.json"));
		const down = await m.run(["remote", "fix", "--dry-run", "--json"]);
		assert.ok(down.json().actions.some((a) => a.kind === "restart_relay"), down.stdout);
		assert.deepEqual(m.wrangler(), []);
	} finally {
		await serve.close();
	}
});
