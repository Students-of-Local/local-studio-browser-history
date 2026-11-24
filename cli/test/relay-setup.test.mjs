// The steps of `remote setup` on the relay route (cli/src/relay-setup.ts). wrangler is always a stand-in passed through the seam, and
// nothing here reaches Cloudflare: verify's checks go to local servers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = mkdtempSync(join(tmpdir(), "tychicus-relay-setup-"));
after(() => rmSync(root, { recursive: true, force: true }));

const mod = await loadTs(`
export { RELAY_JS, RELAY_WRANGLER } from "@src/relay-dist.ts";
export { deploy, deployedAddress, needsSubdomain, onboardingUrl, parseWhoami, putKey, verify } from "@src/relay-setup.ts";
`);

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ADDRESS = "https://tychicus-relay.test-sub.workers.dev";

/** Run `fn` with TYCHICUS_CONFIG_DIR at a fresh folder. */
async function inConfig(name, fn) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const before = process.env.TYCHICUS_CONFIG_DIR;
	process.env.TYCHICUS_CONFIG_DIR = dir;
	try {
		return await fn(dir);
	} finally {
		if (before === undefined) delete process.env.TYCHICUS_CONFIG_DIR;
		else process.env.TYCHICUS_CONFIG_DIR = before;
	}
}

test("whoami, the deploy output and wrangler's subdomain words are read as wrangler writes them", () => {
	const who = mod.parseWhoami(`npx: installed\n{"loggedIn":true,"accounts":[{"id":"${ACCOUNT}","name":"Mine"},{"id":"not-an-id"}]}`);
	assert.deepEqual(who, { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Mine" }] });
	assert.deepEqual(mod.parseWhoami(`{"loggedIn":false}`), { loggedIn: false, accounts: [] });
	assert.equal(mod.parseWhoami("You are not authenticated."), undefined);
	const lines = [`{"type":"wrangler-session"}`, "not json", `{"type":"deploy","targets":["https://u:p@x.workers.dev","http://y.workers.dev","${ADDRESS}/"]}`].join("\n");
	assert.equal(mod.deployedAddress(lines), ADDRESS);
	assert.equal(mod.deployedAddress(`{"type":"deploy","targets":["https://relay.example.com"]}`), undefined);
	assert.ok(mod.needsSubdomain("You need to register a workers.dev subdomain before publishing to workers.dev"));
	assert.ok(!mod.needsSubdomain("Authentication error [code: 10000]"));
	assert.equal(mod.onboardingUrl(ACCOUNT), `https://dash.cloudflare.com/${ACCOUNT}/workers/onboarding`);
});

test("deploy stages the kit 0600 in a folder of its own and reads the address from wrangler's output file", async () => {
	await inConfig("deploy", async (dir) => {
		const calls = [];
		const wrangler = async (args, options) => {
			calls.push({ args, options });
			writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, `{"type":"deploy","targets":["${ADDRESS}"]}\n`);
			return { code: 0, out: "Deployed" };
		};
		assert.deepEqual(await mod.deploy("tychicus-relay", ACCOUNT, { wrangler }), { ok: true, url: ADDRESS });
		assert.deepEqual(calls[0].args, ["deploy", "--name", "tychicus-relay"]);
		assert.equal(calls[0].options.accountId, ACCOUNT);
		assert.equal(calls[0].options.cwd, join(dir, "relay"));
		if (process.platform !== "win32") {
			assert.equal(statSync(join(dir, "relay")).mode & 0o777, 0o700);
			assert.equal(statSync(join(dir, "relay", "relay.js")).mode & 0o777, 0o600);
		}
		assert.equal(readFileSync(join(dir, "relay", "relay.js"), "utf8"), mod.RELAY_JS);
		assert.equal(readFileSync(join(dir, "relay", "wrangler.jsonc"), "utf8"), mod.RELAY_WRANGLER);
		// No subdomain, and a plain failure, each its own answer.
		const subdomain = await mod.deploy("tychicus-relay", ACCOUNT, { wrangler: async () => ({ code: 1, out: "You need to register a workers.dev subdomain" }) });
		assert.deepEqual(subdomain, { ok: false, subdomain: true });
		const failed = await mod.deploy("tychicus-relay", ACCOUNT, { wrangler: async () => ({ code: 1, out: "Authentication error" }) });
		assert.equal(failed.ok, false);
		assert.match(failed.message, /exit 1.*Authentication error/);
	});
});

test("the key reaches `secret put` on stdin only, and never comes back in an error", async () => {
	await inConfig("put", async () => {
		const key = "s".repeat(43);
		let seen;
		const ok = await mod.putKey("tychicus-relay", key, ACCOUNT, { wrangler: async (args, options) => ((seen = { args, options }), { code: 0, out: "" }) });
		assert.deepEqual(ok, { ok: true });
		assert.deepEqual(seen.args, ["secret", "put", "RELAY_KEY", "--name", "tychicus-relay"]);
		assert.equal(seen.options.input, key);
		assert.ok(!seen.args.join(" ").includes(key));
		const bad = await mod.putKey("tychicus-relay", key, ACCOUNT, { wrangler: async () => ({ code: 1, out: `rejected ${key}` }) });
		assert.equal(bad.ok, false);
		assert.ok(!bad.message.includes(key), bad.message);
		assert.match(bad.message, /rejected <key>/);
	});
});

/** A local stand-in for the relay's two health answers. */
async function healthServer({ connected = true, health = 200 } = {}) {
	const seen = [];
	const srv = createServer((req, res) => {
		seen.push(req.url);
		res.setHeader("content-type", "application/json");
		if (req.url === "/_relay/health") return res.end(JSON.stringify({ ok: true, connected }));
		res.statusCode = health;
		res.end(JSON.stringify({ ok: health === 200 }));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}

test("verify waits for the connector, then needs /v1/health back from serve", async () => {
	const good = await healthServer();
	const none = await healthServer({ connected: false });
	const down = await healthServer({ health: 502 });
	try {
		assert.deepEqual(await mod.verify(good.url, Date.now() + 1000, 10), { ok: true });
		assert.deepEqual(good.seen, ["/_relay/health", "/v1/health"]);
		const waiting = await mod.verify(none.url, Date.now() + 60, 10);
		assert.equal(waiting.code, "relay_connector");
		assert.ok(!none.seen.includes("/v1/health"), "no health check before the connector is there");
		const broken = await mod.verify(down.url, Date.now() + 60, 10);
		assert.equal(broken.code, "relay_health");
		assert.match(broken.message, /answered 502/);
	} finally {
		await Promise.all([good.close(), none.close(), down.close()]);
	}
});
