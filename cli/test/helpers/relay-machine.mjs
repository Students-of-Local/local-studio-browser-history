// A throwaway machine for the CLI's relay route tests: node alone on PATH, stub service managers, and TYCHICUS_NPX at a script that
// answers like `npx --yes wrangler@<version>` and logs each call. Nothing here reaches Cloudflare.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "dist", "index.js");
const HOOKS = join(here, "relay-hooks.mjs");

export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export const ADDRESS = "https://tychicus-relay.test-sub.workers.dev";
export const unix = process.platform === "linux" || process.platform === "darwin";

/**
 * A machine with node alone on PATH, stub service managers, and TYCHICUS_NPX at a script that answers like wrangler. A `login` writes
 * a signed-in file, and whoami answers `afterLogin` from then on when one is given; `loginCode` is what it exits with.
 * `subdomainAfter` is how many deploys fail for want of a workers.dev subdomain before one works. The browser opener logs its URL.
 */
export function machine(root, name, { whoami = { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Mine" }] }, afterLogin, loginCode = 0, deploy = "ok", subdomainAfter = 0 } = {}) {
	const dir = join(root, name);
	const bin = join(dir, "bin");
	const home = join(dir, "home");
	const cfg = join(home, "cfg");
	const log = join(dir, "calls.log");
	mkdirSync(bin, { recursive: true });
	mkdirSync(cfg, { recursive: true, mode: 0o700 });
	symlinkSync(process.execPath, join(bin, "node"));
	const script = (path, body) => {
		writeFileSync(path, body);
		chmodSync(path, 0o755);
	};
	script(join(bin, "launchctl"), `#!/bin/sh\necho "launchctl $*" >> ${log}\ncase "$1" in\nprint) exit 1 ;;\nesac\n`);
	script(join(bin, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> ${log}\n`);
	for (const opener of ["xdg-open", "open"]) script(join(bin, opener), `#!/bin/sh\necho "open $*" >> ${log}\n`);
	const npx = join(dir, "npx.mjs");
	script(
		npx,
		`#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [yes, pkg, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, ["npx", yes, pkg, ...args, "account=" + (process.env.CLOUDFLARE_ACCOUNT_ID ?? ""), "metrics=" + process.env.WRANGLER_SEND_METRICS].join(" ") + "\\n");
const signedIn = ${JSON.stringify(join(dir, "signed-in"))};
const whoami = existsSync(signedIn) ? ${JSON.stringify(afterLogin ?? whoami)} : ${JSON.stringify(whoami)};
if (args[0] === "login") {
	writeFileSync(signedIn, "");
	process.exit(${loginCode});
} else if (args[0] === "whoami") {
	if (whoami === "out") { console.log("You are not authenticated. Please run wrangler login."); process.exit(1); }
	console.log(JSON.stringify(whoami));
} else if (args[0] === "deploy") {
	const tries = readFileSync(${JSON.stringify(log)}, "utf8").split("\\n").filter((l) => l.startsWith("npx ") && l.includes(" deploy ")).length;
	if (${JSON.stringify(deploy)} === "subdomain" || tries <= ${subdomainAfter}) { console.error("You need to register a workers.dev subdomain before publishing to workers.dev"); process.exit(1); }
	writeFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type: "deploy", targets: ["https://" + args[2] + ".test-sub.workers.dev"] }) + "\\n");
} else if (args[0] === "secret") {
	writeFileSync(${JSON.stringify(join(dir, "secret"))}, readFileSync(0, "utf8"));
}
`,
	);
	const env = { HOME: home, TYCHICUS_CONFIG_DIR: cfg, TABKYRA_CONFIG_DIR: cfg, NO_COLOR: "1", PATH: bin, TYCHICUS_NPX: npx, TABKYRA_APPLICATIONS_DIR: join(dir, "apps"), TABKYRA_DOH_URL: "http://127.0.0.1:9/dns-query" };
	/** `hooks` preloads relay-hooks.mjs; `input` is stdin, a pipe the person "types" into (with TABKYRA_ASSUME_TTY for a terminal). A run still going after 30 s (a question asked forever) is killed, and its code is null. */
	const run = (args, extra = {}, { hooks = false, input } = {}) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [...(hooks ? ["--import", HOOKS] : []), cli, ...args], { env: { ...env, ...extra }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 30_000 });
			child.stdin?.end(input);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("close", (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) }));
		});
	return {
		dir,
		cfg,
		run,
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		wrangler: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("npx ")) : []),
		secret: () => (existsSync(join(dir, "secret")) ? readFileSync(join(dir, "secret"), "utf8") : undefined),
		remoteJson: () => (existsSync(join(cfg, "remote.json")) ? JSON.parse(readFileSync(join(cfg, "remote.json"), "utf8")) : undefined),
		launcher: () => script(join(cfg, "tychicus"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`),
	};
}

/** serve as setup finds it: OAuth metadata for the relay address, and the health check. */
export async function serveStandIn() {
	const srv = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/v1/health") return res.end(`{"ok":true}`);
		if (req.url === "/.well-known/oauth-protected-resource/mcp") return res.end(JSON.stringify({ resource: `${ADDRESS}/mcp` }));
		res.statusCode = 404;
		res.end("{}");
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}
