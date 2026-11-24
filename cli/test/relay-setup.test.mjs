// The steps of `remote setup` on the relay route (cli/src/relay-setup.ts). wrangler is always a stand-in: nothing here reaches Cloudflare.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = mkdtempSync(join(tmpdir(), "tychicus-relay-setup-"));
after(() => rmSync(root, { recursive: true, force: true }));

const mod = await loadTs(`
export { RELAY_JS, RELAY_WRANGLER } from "@src/relay-dist.ts";
export { deploy, deployedAddress, needsSubdomain, onboardingUrl, parseWhoami, putKey, runWrangler, whoami } from "@src/relay-setup.ts";
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

/** A wrangler whose account holds the Workers in `there` (name to secret names), and what it was asked. */
function cloudflare(there = {}, deploys = () => ({ code: 0, out: "Deployed", stdout: "" })) {
	const calls = [];
	const wrangler = async (args, options) => {
		calls.push({ args, options });
		const name = args.at(-1);
		if (args[1] === "list") {
			if (!there[name]) return { code: 1, out: `Worker "${name}" not found.`, stdout: "" };
			const stdout = JSON.stringify(there[name].map((secret) => ({ name: secret, type: "secret_text" })));
			return { code: 0, out: stdout, stdout };
		}
		if (args[0] === "deploy") {
			const result = deploys();
			if (result.code === 0) writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, `{"type":"deploy","targets":["${ADDRESS}"]}\n`);
			there[name] ??= [];
			return result;
		}
		there[name] = ["RELAY_KEY"];
		return { code: 0, out: "", stdout: "" };
	};
	return { wrangler, calls, ran: () => calls.map((c) => c.args.slice(0, 2).join(" ").replace(" --name", "")) };
}

test("deploy stages the kit 0600 in a folder of its own and reads the address from wrangler's output file", async () => {
	await inConfig("deploy", async (dir) => {
		mkdirSync(join(dir, "relay"), { mode: 0o755 });
		const cf = cloudflare();
		assert.deepEqual(await mod.deploy("tychicus-relay", ACCOUNT, {}, cf), { ok: true, url: ADDRESS });
		assert.deepEqual(cf.calls[1].args, ["deploy", "--name", "tychicus-relay"]);
		assert.equal(cf.calls[1].options.accountId, ACCOUNT);
		assert.equal(cf.calls[1].options.cwd, join(dir, "relay"));
		if (process.platform !== "win32") {
			assert.equal(statSync(join(dir, "relay")).mode & 0o777, 0o700);
			assert.equal(statSync(join(dir, "relay", "relay.js")).mode & 0o777, 0o600);
		}
		assert.equal(readFileSync(join(dir, "relay", "relay.js"), "utf8"), mod.RELAY_JS);
		assert.equal(readFileSync(join(dir, "relay", "wrangler.jsonc"), "utf8"), mod.RELAY_WRANGLER);
		// No subdomain, and a plain failure, each its own answer.
		const subdomain = await mod.deploy("tychicus-relay", ACCOUNT, {}, cloudflare({}, () => ({ code: 1, out: "You need to register a workers.dev subdomain", stdout: "" })));
		assert.deepEqual(subdomain, { ok: false, why: "subdomain" });
		const failed = await mod.deploy("tychicus-relay", ACCOUNT, {}, cloudflare({}, () => ({ code: 1, out: "Authentication error", stdout: "" })));
		assert.equal(failed.why, "failed");
		assert.match(failed.message, /exit 1.*Authentication error/);
	});
});

test("a Worker already on the account is never replaced, save this computer's own or a relay taken over on purpose", async () => {
	await inConfig("taken", async () => {
		const cf = cloudflare({ api: [], "api-keyed": ["DB_URL"], theirs: ["RELAY_KEY"] });
		for (const name of ["api", "api-keyed"]) {
			assert.deepEqual(await mod.deploy(name, ACCOUNT, {}, cf), { ok: false, why: "other" });
			assert.deepEqual(await mod.deploy(name, ACCOUNT, { takeOver: true }, cf), { ok: false, why: "other" }, "no relay, so nothing to take over");
		}
		assert.deepEqual(await mod.deploy("theirs", ACCOUNT, {}, cf), { ok: false, why: "relay" });
		assert.ok(!cf.ran().includes("deploy"), "nothing was deployed");
		// An account that can't be read is not an empty one.
		const unread = await mod.deploy("tychicus-relay", ACCOUNT, {}, { wrangler: async () => ({ code: 1, out: "Authentication error [code: 10000]", stdout: "" }) });
		assert.match(unread.message, /secret list failed.*10000/);
		assert.equal((await mod.deploy("theirs", ACCOUNT, { takeOver: true }, cf)).ok, true);
		// Taken over, it is this computer's: no question the next time, on this account alone.
		assert.equal((await mod.deploy("theirs", ACCOUNT, {}, cf)).ok, true);
		assert.deepEqual(await mod.deploy("theirs", "f".repeat(32), {}, cf), { ok: false, why: "relay" });
	});
	// A first setup that stopped for a subdomain left its Worker there with no key: it is ours to finish.
	await inConfig("stopped", async () => {
		let first = true;
		const cf = cloudflare({}, () => (first ? ((first = false), { code: 1, out: "You need to register a workers.dev subdomain", stdout: "" }) : { code: 0, out: "", stdout: "" }));
		assert.equal((await mod.deploy("tychicus-relay", ACCOUNT, {}, cf)).why, "subdomain");
		assert.equal((await mod.deploy("tychicus-relay", ACCOUNT, {}, cf)).ok, true);
	});
});

test("a name that isn't a Worker name never reaches wrangler", async () => {
	await inConfig("names", async () => {
		const cf = cloudflare();
		for (const name of ["x & calc", "-x", "x-", "X", "", "a".repeat(64), "--env=x"]) {
			assert.equal((await mod.deploy(name, ACCOUNT, {}, cf)).ok, false, name);
			assert.equal((await mod.putKey(name, "k", ACCOUNT, cf)).ok, false);
		}
		assert.equal(cf.calls.length, 0);
	});
});

test("the key reaches `secret put` on stdin only, and never comes back in an error", async () => {
	await inConfig("put", async () => {
		const key = "s".repeat(43);
		const cf = cloudflare();
		assert.deepEqual(await mod.putKey("tychicus-relay", key, ACCOUNT, cf), { ok: true });
		const [seen] = cf.calls;
		assert.deepEqual(seen.args, ["secret", "put", "RELAY_KEY", "--name", "tychicus-relay"]);
		assert.equal(seen.options.input, key);
		assert.ok(!seen.args.join(" ").includes(key));
		const bad = await mod.putKey("tychicus-relay", key, ACCOUNT, { wrangler: async () => ({ code: 1, out: `rejected ${key}`, stdout: "" }) });
		assert.equal(bad.ok, false);
		assert.ok(!bad.message.includes(key), bad.message);
		assert.match(bad.message, /rejected <key>/);
	});
});

test("npx gets the pinned wrangler, the key on stdin and no Cloudflare token of the person's", { skip: process.platform === "win32" }, async () => {
	await inConfig("npx", async (dir) => {
		const npx = join(dir, "npx.mjs");
		const set = { TYCHICUS_NPX: npx, CLOUDFLARE_API_TOKEN: "t", CF_API_KEY: "k", CLOUDFLARE_ACCOUNT_ID: "e".repeat(32), WRANGLER_CI_OVERRIDE_NAME: "api" };
		const before = Object.fromEntries(Object.keys(set).map((key) => [key, process.env[key]]));
		Object.assign(process.env, set);
		const fake = (body) => {
			writeFileSync(npx, `#!${process.execPath}\n${body}`);
			chmodSync(npx, 0o755);
		};
		try {
			fake(`import { readFileSync } from "node:fs";
const env = Object.keys(process.env).filter((k) => /^(CLOUDFLARE|CF|WRANGLER)_/.test(k)).sort().map((k) => k + "=" + process.env[k]);
console.log(JSON.stringify({ args: process.argv.slice(2), env, stdin: readFileSync(0, "utf8") }));`);
			const r = await mod.runWrangler(["secret", "put"], { cwd: dir, accountId: ACCOUNT, input: "the key", timeoutMs: 30_000 });
			assert.deepEqual(JSON.parse(r.stdout), {
				args: ["--yes", "wrangler@4.163.0", "secret", "put"],
				env: [`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`, "WRANGLER_SEND_METRICS=false"],
				stdin: "the key",
			});
			// npm's notice goes to stderr after the answer, and says nothing about it.
			fake(`console.log(JSON.stringify({ loggedIn: true, accounts: [{ id: "${ACCOUNT}", name: "Mine" }] })); setTimeout(() => console.error("npm notice {new} version; not wrangler login"), 20);`);
			assert.deepEqual(await mod.whoami(), { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Mine" }] });
			// One that hangs takes its children with it, and the wait ends.
			fake(`import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
console.log(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }).pid);`);
			const hung = await mod.runWrangler(["deploy"], { cwd: dir, timeoutMs: 1_500 });
			assert.equal(hung.code, 124);
			assert.match(hung.out, /Timed out after 2 s/);
			const grandchild = Number(hung.stdout);
			assert.ok(grandchild > 0);
			const gone = () => {
				try {
					process.kill(grandchild, 0);
					return false;
				} catch {
					return true;
				}
			};
			for (const end = Date.now() + 5_000; !gone() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
			assert.ok(gone(), "wrangler is still running");
			// Nothing to run, with input waiting.
			process.env.TYCHICUS_NPX = join(dir, "missing");
			assert.equal((await mod.runWrangler(["secret", "put"], { cwd: dir, input: "k", timeoutMs: 5_000 })).code, 127);
		} finally {
			for (const [key, value] of Object.entries(before)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
