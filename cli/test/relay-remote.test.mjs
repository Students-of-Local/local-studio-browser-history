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
	const r = await m.run(["remote", "setup", "--json"]);
	assert.equal(r.code, 3, r.stdout + r.stderr);
	const report = r.json();
	assert.equal(report.code, "cloudflare_login");
	assert.equal(report.step, "needs_signin");
	assert.deepEqual(report.next, { kind: "sign_in", command: "tychicus remote setup" });
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
		["whoami", "login", "whoami", "versions", "deploy"],
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
	assert.ok(m.wrangler().some((l) => / deploy --tag tychicus-[0-9a-f]{12} --name tychicus-relay account=/.test(l) && l.includes(`account=${ACCOUNT} `)));
	assert.equal(m.secret(), undefined, "no key is set");
	assert.equal(m.remoteJson(), undefined);
});

test("a sign-in with two accounts needs --account, and --account picks the one wrangler deploys to", { skip: !unix }, async () => {
	const whoami = { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Mine" }, { id: OTHER, name: "Work" }] };
	const m = machine(root, "two-accounts", { whoami, deploy: "subdomain" });
	const r = await m.run(["remote", "setup", "--json"]);
	assert.equal(r.code, 3);
	assert.equal(r.json().code, "cloudflare_account");
	assert.deepEqual(r.json().next, { kind: "run_command", command: "tychicus remote setup --account <id>" });
	assert.ok(!m.wrangler().some((l) => l.includes(" deploy ")));
	const picked = await m.run(["remote", "setup", "--json", "--relay", "my-relay", "--account", OTHER]);
	assert.equal(picked.json().code, "workers_subdomain");
	assert.ok(m.wrangler().some((l) => / deploy --tag tychicus-[0-9a-f]{12} --name my-relay account=/.test(l) && l.includes(`account=${OTHER} `)), m.wrangler().join("\n"));
	const unknown = await m.run(["remote", "setup", "--relay", "--json", "--account", "a".repeat(32)]);
	assert.equal(unknown.json().code, "cloudflare_account");
});

const TERMINAL = { TABKYRA_ASSUME_TTY: "1" };
const twoAccounts = { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Mine" }, { id: OTHER, name: "Work" }] };
const deploys = (m) => m.wrangler().filter((l) => l.includes(" deploy "));

test("at a terminal, a sign-in with two accounts is asked about until the answer is one of them", { skip: !unix }, async () => {
	const m = machine(root, "ask-account", { whoami: twoAccounts, deploy: "subdomain" });
	const r = await m.run(["remote", "setup", "--relay", "--no-passcode"], TERMINAL, { input: "3\nwork\n\n2\nq\n" });
	assert.equal(r.code, 3, r.stdout + r.stderr);
	assert.match(r.stdout, /Which Cloudflare account/);
	assert.ok(r.stdout.includes(`  1  Mine (${ACCOUNT})`) && r.stdout.includes(`  2  Work (${OTHER})`), r.stdout);
	assert.equal(r.stdout.split("Type 1 to 2: ").length - 1, 4, "3, work and an empty line are asked again");
	assert.equal(deploys(m).length, 1);
	assert.ok(deploys(m)[0].includes(`account=${OTHER} `), deploys(m)[0]);
});

test("at a terminal, no answer to the account question deploys nothing and saves nothing", { skip: !unix }, async () => {
	const m = machine(root, "ask-account-end", { whoami: twoAccounts, deploy: "subdomain" });
	const r = await m.run(["remote", "setup", "--relay", "--no-passcode"], TERMINAL, { input: "9\n" });
	assert.equal(r.code, 1, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /No account was chosen, so nothing was changed/);
	assert.deepEqual(deploys(m), []);
	assert.equal(m.remoteJson(), undefined);
});

test("at a terminal, a missing workers.dev subdomain opens the page, waits for Enter and deploys again until it works", { skip: !unix }, async () => {
	const m = machine(root, "wait-subdomain", { subdomainAfter: 2 });
	m.launcher();
	const serve = await serveStandIn();
	try {
		const extra = { ...TERMINAL, RELAY_HOOK_PORT: String(serve.port), TYCHICUS_PUBLIC_WAIT_MS: "2000", TYCHICUS_PUBLIC_POLL_MS: "50" };
		const r = await m.run(["remote", "setup", "--relay", "--no-passcode", "--port", String(serve.port)], extra, { hooks: true, input: "\n\n" });
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.equal(deploys(m).length, 3, "one deploy, then one after each Enter");
		assert.deepEqual(
			m.calls().filter((l) => l.startsWith("open ")),
			Array(2).fill(`open https://dash.cloudflare.com/${ACCOUNT}/workers/onboarding`),
		);
		assert.match(r.stdout, /Your browser opened it\..*Relay deployed at /s);
		assert.equal(m.remoteJson().publicUrl, ADDRESS);
		assert.equal(m.secret(), m.remoteJson().relay.key);
	} finally {
		await serve.close();
	}
});

test("at a terminal, q or the end of input at the subdomain wait stops, and nothing is saved", { skip: !unix }, async () => {
	for (const [name, input] of [["q", "q\n"], ["end", ""]]) {
		const m = machine(root, `subdomain-${name}`, { subdomainAfter: 1 });
		const r = await m.run(["remote", "setup", "--relay", "--no-passcode"], TERMINAL, { input });
		assert.equal(r.code, 3, r.stdout + r.stderr);
		assert.match(r.stdout + r.stderr, /run tychicus remote setup --relay again\. Nothing was saved/);
		assert.equal(deploys(m).length, 1, name);
		assert.equal(m.secret(), undefined);
		assert.equal(m.remoteJson(), undefined);
	}
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
		const r = await m.run(["remote", "setup", "--json", "--port", String(serve.port)], extra, { hooks: true });
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

test("a Worker that isn't a relay is never replaced, named or not", { skip: !unix }, async () => {
	const m = machine(root, "not-a-relay", { worker: true });
	for (const name of [[], ["api"]]) {
		const r = await m.run(["remote", "setup", "--relay", ...name, "--json"]);
		assert.equal(r.code, 3, r.stdout + r.stderr);
		assert.equal(r.json().code, "relay_name_used");
		assert.match(r.json().next.command, /^tychicus remote setup --relay tychicus-relay-/);
	}
	assert.ok(!m.wrangler().some((l) => l.includes(" deploy ")), "nothing is deployed");
	assert.equal(m.secret(), undefined);
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
		assert.equal(refused.json().next.command, "tychicus remote setup --relay tychicus-relay", "fix keeps the relay's own name");
		rmSync(join(m.cfg, "relay-state.json"));
		const down = await m.run(["remote", "fix", "--dry-run", "--json"]);
		assert.ok(down.json().actions.some((a) => a.kind === "restart_relay"), down.stdout);
		const before = m.calls().length;
		const started = await m.run(["remote", "fix", "--yes", "--json"], { TYCHICUS_FIX_SERVICE_WAIT_MS: "300" });
		assert.notEqual(started.code, 0, "a connector that never reached the relay isn't a fix");
		assert.equal(started.json().code, "restart_relay", started.stdout);
		assert.ok(m.calls().slice(before).some((l) => /^(systemctl .*(enable|restart|start) .*tychicus-relay|launchctl (bootstrap|kickstart) .*relay)/.test(l)), "the service manager was asked to start the connector");
		const check = async (state) => {
			writeFileSync(join(m.cfg, "relay-state.json"), JSON.stringify({ state, at: Date.now(), pid: process.pid }));
			return (await m.run(["remote", "status", "--json"])).json().checks.find((c) => c.name === "relay");
		};
		assert.equal((await check("connected")).status, "ok");
		assert.equal((await check("disconnected")).status, "warn");
		for (const [state, advice] of [["unauthorized", /remote setup --relay tychicus-relay\./], ["replaced", /remote setup --relay tychicus-relay\./], ["outdated", /remote fix\./], ["stopped", /remote fix\./]]) {
			const c = await check(state);
			assert.equal(c.status, "fail", state);
			assert.match(c.detail, advice);
		}
		assert.deepEqual(m.wrangler(), []);
	} finally {
		await serve.close();
	}
});

test("remote fix on an outdated relay restarts the connector first, and names setup only when it is still outdated", { skip: !unix }, async () => {
	const serve = await serveStandIn();
	try {
		for (const starts of ["connected", "outdated"]) {
			const m = machine(root, `fix-outdated-${starts}`, { starts });
			writeFileSync(join(m.cfg, "remote.json"), JSON.stringify({ publicUrl: ADDRESS, port: serve.port, route: "relay", relay: { name: "my-relay", key: "k".repeat(43) } }), { mode: 0o600 });
			writeFileSync(join(m.cfg, "relay-state.json"), JSON.stringify({ state: "outdated", at: Date.now() - 60_000, pid: process.pid }));
			const r = (await m.run(["remote", "fix", "--yes", "--json"], { TYCHICUS_FIX_SERVICE_WAIT_MS: "2000" })).json();
			assert.equal(r.actions[0]?.kind, "restart_relay", JSON.stringify(r));
			assert.equal(r.actions[0].status, starts === "connected" ? "done" : "failed", JSON.stringify(r));
			if (starts === "outdated") assert.equal(r.next.command, "tychicus remote setup --relay my-relay");
		}
	} finally {
		await serve.close();
	}
});
