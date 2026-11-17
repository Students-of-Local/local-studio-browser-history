// `remote import-polycarp`, proved in a throwaway HOME and XDG folders with a stand-in for launchctl and systemctl: nothing
// here reads or writes the real ~/.config/polycarp, ~/.config/tabkyra or ~/.config/tychicus, or touches launchd or systemd.
// The fixture is the split setup seen on a real Mac: remote.json and OAuth state in <config>/polycarp/browser, the tunnel's
// config and credentials in <config>/tabkyra, the tunnel's service running <config>/tabkyra/tabkyra, a symlink to
// <config>/tabkyra/polycarp, which execs node on a working tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const mod = await loadTs(`
export { importPolycarp, planImport, rewritePaths, parsePlist, parseUnit, importHint } from "@src/import-polycarp.ts";
export { setServiceSeamForTests } from "@src/service.ts";
`);
const { importPolycarp, rewritePaths, importHint, setServiceSeamForTests } = mod;

const root = mkdtempSync(join(tmpdir(), "tychicus-import-"));
after(() => rmSync(root, { recursive: true, force: true }));

const KEYS = ["HOME", "XDG_CONFIG_HOME", "TYCHICUS_CONFIG_DIR", "POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR", "TYCHICUS_HOME", "POLYCARP_HOME", "TABKYRA_HOME"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
	setServiceSeamForTests({});
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const TUNNEL_ID = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
const PORT = 8787;
let n = 0;
let F;

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function plist(label, args, env) {
	const vars = Object.entries(env)
		.map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${xml(v)}</string>\n`)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>${label}</string>\n\t<key>ProgramArguments</key>\n\t<array>\n${args.map((a) => `\t\t<string>${xml(a)}</string>`).join("\n")}\n\t</array>\n${vars ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${vars}\t</dict>\n` : ""}</dict>\n</plist>\n`;
}

/**
 * A HOME with Polycarp's split setup. `pinned`: the tunnel's service file names its folder (as Polycarp's setup wrote it), and a
 * stale cloudflared.yml sits in polycarp/browser too, which must not be used. `cloudflaredHome`: the credentials live in
 * ~/.cloudflared, so their path is kept.
 */
function fixture({ pinned = true, cloudflaredHome = false, platform = "darwin" } = {}) {
	const base = join(root, `case-${++n}`);
	const home = join(base, "home");
	const config = join(home, ".config");
	const P = join(config, "polycarp", "browser");
	const T = join(config, "tabkyra");
	const work = join(base, "Projects", "_work", "polycarp-weak-model", "browser", "cli", "dist");
	for (const d of [P, T, work]) mkdirSync(d, { recursive: true });
	writeFileSync(join(work, "index.js"), "// the working tree's program\n");
	const shim = `#!/bin/sh\nexec "/usr/local/bin/node" "${join(work, "index.js")}" "$@"\n`;
	writeFileSync(join(P, "polycarp"), shim, { mode: 0o755 });
	writeFileSync(join(T, "polycarp"), shim, { mode: 0o755 });
	symlinkSync(join(T, "polycarp"), join(T, "tabkyra"));
	// polycarp/browser: the connector, its sign-ins and tokens. The values stand in for secrets; the import never prints them.
	writeFileSync(join(P, "remote.json"), `${JSON.stringify({ publicUrl: "https://polycarp.example.com", port: PORT, route: "cloudflare" }, null, "\t")}\n`, { mode: 0o600 });
	writeFileSync(join(P, "oauth.json"), `{"passcode":"scrypt$fake-passcode-hash","clients":[{"id":"claude-ai"}],"grants":[{"family":"f1","hash":"aa11"}]}\n`, { mode: 0o600 });
	writeFileSync(join(P, "oauth-codes.json"), `{"codes":[]}\n`, { mode: 0o644 });
	writeFileSync(join(P, "tokens.json"), `{"tokens":[{"id":"t1","hash":"bb22"}]}\n`, { mode: 0o600 });
	writeFileSync(join(P, "connect-mints.json"), `{"minted":[1]}\n`, { mode: 0o600 });
	writeFileSync(join(P, "hub-codes.json"), `{"codes":[]}\n`, { mode: 0o600 });
	// tabkyra: the tunnel. Its config names its credentials and log inside this folder.
	const credentials = cloudflaredHome ? join(home, ".cloudflared", `${TUNNEL_ID}.json`) : join(T, `${TUNNEL_ID}.json`);
	mkdirSync(join(credentials, ".."), { recursive: true });
	writeFileSync(credentials, `{"AccountTag":"fake","TunnelSecret":"fake-tunnel-secret","TunnelID":"${TUNNEL_ID}"}\n`, { mode: 0o600 });
	const yml = [`tunnel: ${TUNNEL_ID}`, `credentials-file: ${credentials}`, `logfile: ${join(T, "cloudflared.log")}`, "no-autoupdate: true", "ingress:", "  - hostname: polycarp.example.com", `    service: http://127.0.0.1:${PORT}`, "  - service: http_status:404", ""].join("\n");
	writeFileSync(join(T, "cloudflared.yml"), yml, { mode: 0o600 });
	writeFileSync(join(T, "cloudflare-tunnel-name"), "polycarp-mac-1a2b\n", { mode: 0o600 });
	writeFileSync(join(T, "cloudflare-zone.json"), `{"zone":"example.com","cert":1}\n`, { mode: 0o600 });
	if (pinned) writeFileSync(join(P, "cloudflared.yml"), "tunnel: stale-other-tunnel\ncredentials-file: /nowhere/stale.json\n", { mode: 0o600 });
	const agents = join(home, "Library", "LaunchAgents");
	const units = join(home, ".config", "systemd", "user");
	if (platform === "darwin") {
		mkdirSync(agents, { recursive: true });
		writeFileSync(join(agents, "com.polycarp.serve.plist"), plist("com.polycarp.serve", [join(P, "polycarp"), "serve"], { POLYCARP_BROWSER_CONFIG_DIR: P, TABKYRA_CONFIG_DIR: P }));
		writeFileSync(join(agents, "com.polycarp.cloudflared.plist"), plist("com.polycarp.cloudflared", [join(T, "tabkyra"), "remote", "cloudflare", "run"], pinned ? { POLYCARP_BROWSER_CONFIG_DIR: T, TABKYRA_CONFIG_DIR: T } : {}));
	} else {
		mkdirSync(units, { recursive: true });
		writeFileSync(join(units, "polycarp-serve.service"), `[Service]\nExecStart=${join(P, "polycarp")} serve\nEnvironment=POLYCARP_BROWSER_CONFIG_DIR=${P}\n`);
		writeFileSync(join(units, "polycarp-cloudflared.service"), `[Service]\nExecStart=${join(T, "tabkyra")} remote cloudflare run\n${pinned ? `Environment=TABKYRA_CONFIG_DIR=${T}\n` : ""}`);
	}
	process.env.HOME = home;
	process.env.XDG_CONFIG_HOME = config;
	for (const k of ["TYCHICUS_CONFIG_DIR", "POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR", "TYCHICUS_HOME", "POLYCARP_HOME", "TABKYRA_HOME"]) delete process.env[k];
	F = { base, home, config, P, T, work, target: join(config, "tychicus"), agents, units, credentials };
	return F;
}

/** launchctl or systemctl, played by a set of loaded services. `answers` can override any call. */
function fakeManager(platform, loadedAtStart, answers = () => undefined) {
	const loaded = new Set(loadedAtStart);
	const calls = [];
	const exec = (cmd, args) => {
		calls.push([cmd, ...args].join(" "));
		const special = answers(cmd, args, loaded);
		if (special) return special;
		if (cmd === "launchctl") {
			const label = (args[1] ?? "").split("/").pop();
			if (args[0] === "print") return loaded.has(label) ? { code: 0, out: "state = running" } : { code: 113, out: "Could not find service" };
			if (args[0] === "bootout") return loaded.delete(label) ? { code: 0, out: "" } : { code: 3, out: "No such process" };
			if (args[0] === "bootstrap") {
				loaded.add(basename(args[2], ".plist"));
				return { code: 0, out: "" };
			}
		}
		if (cmd === "systemctl") {
			const [, verb, unit] = args;
			const label = unit?.replace(/\.service$/, "");
			if (verb === "is-active") return { code: loaded.has(label) ? 0 : 3, out: loaded.has(label) ? "active" : "inactive" };
			if (verb === "stop" || (verb === "disable" && args.includes("--now"))) loaded.delete(args.at(-1).replace(/\.service$/, ""));
			if (verb === "start" || verb === "restart") loaded.add(label);
			return { code: 0, out: "" };
		}
		return { code: 0, out: "" };
	};
	return { exec, calls, loaded };
}

function useManager(platform, loadedAtStart, answers) {
	const m = fakeManager(platform, loadedAtStart, answers);
	setServiceSeamForTests({ platform, exec: m.exec, launcher: join(F.target, "tychicus") });
	return m;
}

/** Every path under `dir` with its kind, mode and contents (or link target), to prove nothing changed. */
function snapshot(dir) {
	const out = {};
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = lstatSync(p);
			if (st.isSymbolicLink()) out[p] = `link ${readlinkSync(p)}`;
			else if (st.isDirectory()) {
				out[p] = `dir ${st.mode & 0o777}`;
				walk(p);
			} else out[p] = `file ${st.mode & 0o777} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
}

const lines = () => {
	const said = [];
	return { said, say: (line) => said.push(line) };
};
const mode = (p) => statSync(p).mode & 0o777;
/** cloudflared counts as installed unless a test says otherwise, so the host running the tests doesn't decide. */
const fast = { waitMs: 50, settleMs: 0, cloudflared: () => "/opt/homebrew/bin/cloudflared" };
/** serve answers 401 while com.tychicus.serve is loaded, as the real one does to a request with no token. */
const probeFor = (m) => async () => (m.loaded.has("com.tychicus.serve") || m.loaded.has("tychicus-serve") ? 401 : undefined);

beforeEach(() => setServiceSeamForTests({}));

test("a split Polycarp setup becomes the same files in Tychicus's folder, private, with paths moved", async () => {
	fixture();
	const sources = { ...snapshot(F.P), ...snapshot(F.T), ...snapshot(F.work) };
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const { said, say } = lines();
	const code = await importPolycarp({ say, probe: probeFor(m), ...fast });
	assert.equal(code, 0, said.join("\n"));
	// Polycarp's folders and the working tree are exactly as they were: the import only copies.
	assert.deepEqual({ ...snapshot(F.P), ...snapshot(F.T), ...snapshot(F.work) }, sources);
	for (const name of ["remote.json", "oauth.json", "oauth-codes.json", "tokens.json", "connect-mints.json", "hub-codes.json"]) {
		assert.deepEqual(readFileSync(join(F.target, name)), readFileSync(join(F.P, name)), name);
		assert.equal(mode(join(F.target, name)), 0o600, name);
	}
	for (const name of ["cloudflare-tunnel-name", "cloudflare-zone.json"]) {
		assert.deepEqual(readFileSync(join(F.target, name)), readFileSync(join(F.T, name)), name);
		assert.equal(mode(join(F.target, name)), 0o600, name);
	}
	// The tunnel's config came from tabkyra (the folder its service uses), not the stale copy in polycarp/browser,
	// with its credentials and log paths moved into Tychicus's folder and the hostname untouched.
	const yml = readFileSync(join(F.target, "cloudflared.yml"), "utf8");
	assert.equal(yml, readFileSync(join(F.T, "cloudflared.yml"), "utf8").replaceAll(F.T, F.target));
	assert.match(yml, new RegExp(`credentials-file: ${join(F.target, `${TUNNEL_ID}.json`)}`));
	assert.match(yml, /hostname: polycarp\.example\.com/);
	assert.doesNotMatch(yml, /tabkyra/);
	assert.deepEqual(readFileSync(join(F.target, `${TUNNEL_ID}.json`)), readFileSync(F.credentials));
	assert.equal(mode(join(F.target, `${TUNNEL_ID}.json`)), 0o600);
	assert.equal(readFileSync(join(F.target, "cloudflare-tunnel-name"), "utf8").trim(), "polycarp-mac-1a2b");
	// No secret reached the output.
	const out = said.join("\n");
	for (const secret of ["fake-tunnel-secret", "fake-passcode-hash", "bb22", "aa11"]) assert.doesNotMatch(out, new RegExp(secret));
	assert.match(out, new RegExp(`cloudflared\\.yml: from ${F.T.replace(/[.]/g, "\\.")}`));
	assert.match(out, /tabkyra -> .*tabkyra\/polycarp/);
	// Safe order: each Polycarp service stops before its Tychicus one starts; serve before the tunnel.
	const serveDown = m.calls.findIndex((c) => c === `launchctl bootout gui/${process.getuid()}/com.polycarp.serve`);
	const serveUp = m.calls.findIndex((c) => c.startsWith("launchctl bootstrap") && c.endsWith("com.tychicus.serve.plist"));
	const tunnelDown = m.calls.findIndex((c) => c === `launchctl bootout gui/${process.getuid()}/com.polycarp.cloudflared`);
	const tunnelUp = m.calls.findIndex((c) => c.startsWith("launchctl bootstrap") && c.endsWith("com.tychicus.cloudflared.plist"));
	assert.ok(serveDown >= 0 && serveDown < serveUp && serveUp < tunnelDown && tunnelDown < tunnelUp, m.calls.join("\n"));
	assert.deepEqual([...m.loaded].sort(), ["com.tychicus.cloudflared", "com.tychicus.serve"]);
	// Polycarp's plists are retired, not deleted.
	assert.ok(!existsSync(join(F.agents, "com.polycarp.serve.plist")));
	assert.ok(existsSync(join(F.agents, "retired-polycarp", "com.polycarp.serve.plist")));
	assert.ok(existsSync(join(F.agents, "retired-polycarp", "com.polycarp.cloudflared.plist")));
	// Read back.
	assert.match(out, /com\.tychicus\.serve: loaded/);
	assert.match(out, /com\.polycarp\.serve: not loaded/);
	assert.match(out, /GET http:\/\/127\.0\.0\.1:8787\/mcp: 401 \(expected\)/);
});

test("files found in only one folder are picked up from it, and credentials in ~/.cloudflared keep their path", async () => {
	fixture({ pinned: false, cloudflaredHome: true });
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe: probeFor(m), ...fast }), 0, said.join("\n"));
	assert.deepEqual(readFileSync(join(F.target, "remote.json")), readFileSync(join(F.P, "remote.json")));
	const yml = readFileSync(join(F.target, "cloudflared.yml"), "utf8");
	assert.match(yml, new RegExp(`credentials-file: ${F.credentials}`));
	assert.ok(!existsSync(join(F.target, `${TUNNEL_ID}.json`)));
	assert.match(yml, new RegExp(`logfile: ${join(F.target, "cloudflared.log")}`));
	assert.match(said.join("\n"), /left where it is/);
});

test("refuses when Tychicus already has remote state, unless --force", async () => {
	fixture();
	mkdirSync(F.target, { recursive: true });
	writeFileSync(join(F.target, "remote.json"), `{"publicUrl":"https://mine.example","port":9000,"route":"custom"}\n`, { mode: 0o600 });
	const before = { ...snapshot(F.base) };
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe: probeFor(m), ...fast }), 1);
	assert.match(said.join("\n"), /already has remote state.*remote\.json.*--force/s);
	assert.deepEqual(snapshot(F.base), before);
	assert.ok(m.calls.every((c) => c.startsWith("launchctl print")), m.calls.join("\n"));
	// --force replaces it, keeping Tychicus's old file in a pre-import folder.
	const forced = lines();
	assert.equal(await importPolycarp({ say: forced.say, force: true, probe: probeFor(m), ...fast }), 0, forced.said.join("\n"));
	assert.deepEqual(readFileSync(join(F.target, "remote.json")), readFileSync(join(F.P, "remote.json")));
	const backup = readdirSync(F.target).find((name) => name.startsWith("pre-import-"));
	assert.ok(backup);
	assert.match(readFileSync(join(F.target, backup, "remote.json"), "utf8"), /mine\.example/);
});

test("--dry-run changes nothing and names each file's source folder", async () => {
	fixture();
	const before = snapshot(F.base);
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, dryRun: true, probe: probeFor(m), ...fast }), 0);
	assert.deepEqual(snapshot(F.base), before);
	assert.ok(m.calls.every((c) => c.startsWith("launchctl print")), m.calls.join("\n"));
	const out = said.join("\n");
	const esc = (s) => s.replace(/[.]/g, "\\.");
	assert.match(out, new RegExp(`remote\\.json: from ${esc(F.P)}`));
	assert.match(out, new RegExp(`cloudflared\\.yml: from ${esc(F.T)} \\(also in ${esc(F.P)}, not used\\)`));
	assert.match(out, new RegExp(`credentials-file ${esc(F.T)}/${TUNNEL_ID}\\.json: copied to ${esc(F.target)}`));
	assert.match(out, /Would stop com\.polycarp\.serve, then install and start com\.tychicus\.serve/);
	assert.match(out, /retired-polycarp/);
});

test("a new serve that doesn't answer puts Polycarp's back and exits non-zero with the reason", async () => {
	fixture();
	const sources = { ...snapshot(F.P), ...snapshot(F.T) };
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const { said, say } = lines();
	const code = await importPolycarp({ say, probe: async () => undefined, ...fast });
	assert.equal(code, 1);
	const out = said.join("\n");
	assert.match(out, /com\.tychicus\.serve didn't take over: nothing answered on http:\/\/127\.0\.0\.1:8787\/mcp/);
	// Polycarp's serve runs again from its own plist; its tunnel was never touched.
	assert.deepEqual([...m.loaded].sort(), ["com.polycarp.cloudflared", "com.polycarp.serve"]);
	assert.ok(m.calls.some((c) => c === `launchctl bootstrap gui/${process.getuid()} ${join(F.agents, "com.polycarp.serve.plist")}`), m.calls.join("\n"));
	assert.ok(!m.calls.some((c) => c.includes("bootout") && c.includes("com.polycarp.cloudflared")));
	assert.ok(existsSync(join(F.agents, "com.polycarp.serve.plist")));
	assert.ok(!existsSync(join(F.agents, "retired-polycarp")));
	assert.ok(!existsSync(join(F.agents, "com.tychicus.serve.plist")));
	// The copy is undone, so a second try needs no --force; Polycarp's files are as they were.
	assert.ok(!existsSync(join(F.target, "remote.json")));
	assert.ok(!existsSync(join(F.target, "oauth.json")));
	assert.deepEqual({ ...snapshot(F.P), ...snapshot(F.T) }, sources);
});

test("a tunnel that fails after serve took over puts both of Polycarp's services back", async () => {
	fixture();
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"], (cmd, args) =>
		cmd === "launchctl" && args[0] === "bootstrap" && args[2].endsWith("com.tychicus.cloudflared.plist") ? { code: 1, out: "Bootstrap failed: 5: Input/output error" } : undefined,
	);
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe: probeFor(m), ...fast }), 1);
	assert.match(said.join("\n"), /com\.tychicus\.cloudflared didn't take over: launchctl bootstrap failed/);
	assert.deepEqual([...m.loaded].sort(), ["com.polycarp.cloudflared", "com.polycarp.serve"]);
	assert.ok(!existsSync(join(F.agents, "com.tychicus.serve.plist")));
	assert.ok(!existsSync(join(F.target, "cloudflared.yml")));
});

test("on Linux Polycarp's units are stopped, then disabled, never deleted", async () => {
	fixture({ platform: "linux" });
	const m = useManager("linux", ["polycarp-serve", "polycarp-cloudflared"]);
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe: probeFor(m), ...fast }), 0, said.join("\n"));
	assert.ok(m.calls.includes("systemctl --user stop polycarp-serve.service"));
	assert.ok(m.calls.includes("systemctl --user disable polycarp-serve.service"));
	assert.ok(m.calls.includes("systemctl --user disable polycarp-cloudflared.service"));
	assert.ok(existsSync(join(F.units, "polycarp-serve.service")));
	assert.ok(existsSync(join(F.units, "tychicus-serve.service")));
	assert.deepEqual(readFileSync(join(F.target, "cloudflared.yml"), "utf8"), readFileSync(join(F.T, "cloudflared.yml"), "utf8").replaceAll(F.T, F.target));
});

test("install's hint shows only when Polycarp has remote.json and Tychicus doesn't", () => {
	fixture();
	assert.match(importHint(), /remote import-polycarp --dry-run/);
	mkdirSync(F.target, { recursive: true });
	writeFileSync(join(F.target, "remote.json"), "{}\n");
	assert.equal(importHint(), undefined);
});

test("path rewriting matches whole folders only", () => {
	const r = rewritePaths("a: /x/tabkyra/c.json\nb: /x/tabkyra-other/d\nc: /x/tabkyra\n", ["/x/tabkyra"], "/x/tychicus");
	assert.equal(r.text, "a: /x/tychicus/c.json\nb: /x/tabkyra-other/d\nc: /x/tychicus\n");
	assert.equal(r.count, 2);
});

test("review-r1 first-F3: remote.json with no port is checked on the default port, not rolled back", async () => {
	fixture();
	writeFileSync(join(F.P, "remote.json"), `${JSON.stringify({ publicUrl: "https://polycarp.example.com", route: "cloudflare" })}\n`, { mode: 0o600 });
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const asked = [];
	const probe = async (port) => {
		asked.push(port);
		return probeFor(m)();
	};
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe, ...fast }), 0, said.join("\n"));
	assert.ok(asked.length && asked.every((p) => p === PORT), asked.join(","));
	assert.doesNotMatch(said.join("\n"), /no port to check/);
});

test("review-r1 first-F4: an exception mid-swap still starts Polycarp's serve again and undoes the copy", async () => {
	fixture();
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"], (cmd, args) => {
		if (cmd === "launchctl" && args[0] === "bootstrap" && args[2].endsWith("com.tychicus.cloudflared.plist")) throw new Error("spawn launchctl EAGAIN");
		return undefined;
	});
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe: probeFor(m), ...fast }), 1);
	assert.match(said.join("\n"), /stopped on an error: spawn launchctl EAGAIN/);
	assert.deepEqual([...m.loaded].sort(), ["com.polycarp.cloudflared", "com.polycarp.serve"]);
	assert.ok(!existsSync(join(F.target, "remote.json")));
	assert.ok(!existsSync(join(F.agents, "com.tychicus.serve.plist")));
});

test("review-r1 first-F4: a copy that fails partway leaves no copied files and touches no service", { skip: process.getuid?.() === 0 && "root reads any file" }, async () => {
	fixture();
	// The tunnel credentials are unreadable, so the copy fails after remote.json and the rest were written.
	chmodSync(join(F.T, `${TUNNEL_ID}.json`), 0);
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const { said, say } = lines();
	const code = await importPolycarp({ say, probe: probeFor(m), ...fast }).catch((err) => err);
	assert.equal(code, 1, String(code));
	assert.match(said.join("\n"), /Copying failed/);
	assert.ok(!existsSync(join(F.target, "remote.json")));
	assert.ok(!m.calls.some((c) => c.includes("bootout")), m.calls.join("\n"));
});

test("review-r1 first-F2: another program answering on the port is not taken for Tychicus's serve", async () => {
	fixture();
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const { said, say } = lines();
	// Something outside both services answers 401 on the port the whole time.
	assert.equal(await importPolycarp({ say, probe: async () => 401, ...fast }), 1);
	assert.match(said.join("\n"), /another program still answers on http:\/\/127\.0\.0\.1:8787\/mcp/);
	assert.deepEqual([...m.loaded].sort(), ["com.polycarp.cloudflared", "com.polycarp.serve"]);
	assert.ok(!existsSync(join(F.agents, "com.tychicus.serve.plist")));
});

test("review-r1 first-F2: a 401 while Tychicus's serve isn't running doesn't count", async () => {
	fixture();
	let stopped = false;
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"], (cmd, args, loaded) => {
		// Tychicus's serve loads, then dies at once; launchd keeps reporting it as not running.
		if (cmd === "launchctl" && args[0] === "print" && (args[1] ?? "").endsWith("com.tychicus.serve")) return { code: 113, out: "Could not find service" };
		return undefined;
	});
	// The port is quiet right after Polycarp's serve stops, then a stray program answers 401.
	const probe = async () => {
		if (!stopped) {
			stopped = !m.loaded.has("com.polycarp.serve");
			return undefined;
		}
		return 401;
	};
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe, ...fast }), 1);
	assert.match(said.join("\n"), /com\.tychicus\.serve isn't running, so another program holds the port/);
	assert.deepEqual([...m.loaded].filter((l) => l.startsWith("com.polycarp")).sort(), ["com.polycarp.cloudflared", "com.polycarp.serve"]);
});

test("review-r1 first-F5: with no cloudflared for Tychicus, Polycarp's downloaded copy is copied in, runnable", async () => {
	fixture();
	mkdirSync(join(F.T, "bin"));
	writeFileSync(join(F.T, "bin", "cloudflared"), "#!/bin/sh\necho cloudflared\n", { mode: 0o755 });
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe: probeFor(m), ...fast, cloudflared: () => undefined }), 0, said.join("\n"));
	assert.equal(mode(join(F.target, "bin", "cloudflared")), 0o755);
	assert.ok(existsSync(join(F.T, "bin", "cloudflared")));
});

test("review-r1 first-F5: with no cloudflared anywhere, nothing is stopped and the fix is named", async () => {
	fixture();
	const before = snapshot(F.base);
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe: probeFor(m), ...fast, cloudflared: () => undefined }), 1);
	assert.match(said.join("\n"), /needs cloudflared.*brew install cloudflared.*Nothing was changed/);
	assert.ok(!m.calls.some((c) => c.includes("bootout")), m.calls.join("\n"));
	assert.deepEqual(snapshot(F.base), before);
});

test("review-r1 first-F1: --force is refused while a Tychicus service is installed, so a failed move can't remove it", async () => {
	fixture();
	mkdirSync(F.target, { recursive: true });
	writeFileSync(join(F.target, "remote.json"), "{}\n", { mode: 0o600 });
	writeFileSync(join(F.agents, "com.tychicus.serve.plist"), plist("com.tychicus.serve", ["/x/tychicus", "serve"], {}));
	const before = snapshot(F.base);
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared", "com.tychicus.serve"]);
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, force: true, probe: probeFor(m), ...fast }), 1);
	assert.match(said.join("\n"), /already runs com\.tychicus\.serve.*remote off first/);
	assert.deepEqual(snapshot(F.base), before);
	assert.ok(!m.calls.some((c) => c.includes("bootout")), m.calls.join("\n"));
});

test("review-r2 second-S1: an interrupt mid-swap starts Polycarp's serve again and undoes the copy", async () => {
	fixture();
	let exited;
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"], (cmd, args) => {
		// Ctrl-C arrives while Tychicus's serve is being installed, after Polycarp's was stopped.
		if (cmd === "launchctl" && args[0] === "bootstrap" && args[2].endsWith("com.tychicus.serve.plist")) process.emit("SIGINT", "SIGINT");
		return undefined;
	});
	const { said, say } = lines();
	const exit = (code) => {
		exited = code;
		throw new Error("exited");
	};
	assert.equal(await importPolycarp({ say, probe: probeFor(m), ...fast, exit }), 1);
	assert.equal(exited, 1);
	assert.match(said.join("\n"), /Interrupted \(SIGINT\)/);
	assert.ok(m.loaded.has("com.polycarp.serve"), [...m.loaded].join(","));
	assert.ok(!m.loaded.has("com.tychicus.serve"));
	assert.ok(!existsSync(join(F.target, "remote.json")));
	assert.equal(process.listenerCount("SIGINT"), 0);
});

test("review-r2 first-F2: a slow last probe after every swap was confirmed still exits 0 and says how to check", async () => {
	fixture();
	const m = useManager("darwin", ["com.polycarp.serve", "com.polycarp.cloudflared"]);
	let retired = false;
	const probe = async () => {
		retired ||= existsSync(join(F.agents, "retired-polycarp"));
		return retired ? undefined : probeFor(m)();
	};
	const { said, say } = lines();
	assert.equal(await importPolycarp({ say, probe, ...fast }), 0, said.join("\n"));
	assert.match(said.join("\n"), /every service was confirmed, but the last check/);
});
