/**
 * The steps of `remote setup` on the relay route (relay.ts), as relay/deploy.md in baney75/local-studio-tunnels lays them out: the
 * person's own wrangler (one pinned version, through npx, never installed globally) signs them in to their own Cloudflare account in
 * their own browser, deploys the vendored relay bundle (relay-dist.ts) to it, and sets RELAY_KEY as a Worker secret through stdin.
 * Tychicus never reads wrangler's stored credentials and never sees a Cloudflare token. remote-setup.ts runs these in order.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { envVar } from "./env.ts";
import { configDir } from "./files.ts";
import { which } from "./harness.ts";
import { HEALTH_PATH } from "./relay.ts";
import { RELAY_JS, RELAY_WRANGLER } from "./relay-dist.ts";
import { validAccountId } from "./remote-config.ts";
import { sleep, writeAtomic } from "./service.ts";
import { USER_AGENT } from "./version.ts";

/** The wrangler deploy.md was checked with. Every command runs this one. */
export const WRANGLER_VERSION = "4.163.0";

/** The Worker's name when the person picks none: the first label of https://tychicus-relay.<subdomain>.workers.dev. */
export const DEFAULT_RELAY_NAME = "tychicus-relay";

export const relayFolder = () => join(configDir(), "relay");

/** Where a fresh account picks its workers.dev subdomain, the one thing wrangler can't do without a terminal prompt. */
export const onboardingUrl = (accountId: string) => `https://dash.cloudflare.com/${accountId}/workers/onboarding`;

export interface WranglerOptions {
	cwd: string;
	accountId?: string;
	/** More environment for wrangler, such as WRANGLER_OUTPUT_FILE_PATH. */
	env?: Record<string, string>;
	/** Written to stdin, then stdin closes: how the key reaches `secret put` without argv or a file. */
	input?: string;
	/** The person's terminal: wrangler's own output and its browser sign-in. */
	inherit?: boolean;
	timeoutMs: number;
}

export interface RelaySeam {
	/** Runs `npx --yes wrangler@<version> <args>`; tests pass a stand-in. */
	wrangler?: (args: string[], options: WranglerOptions) => Promise<{ code: number; out: string }>;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

/** npx from the person's Node.js, or TYCHICUS_NPX for tests. */
export function npxBinary(): string | undefined {
	return envVar("NPX") || which("npx");
}

function runWrangler(args: string[], options: WranglerOptions): Promise<{ code: number; out: string }> {
	const npx = npxBinary();
	if (!npx) return Promise.resolve({ code: 127, out: "npx isn't on PATH." });
	const env = { ...process.env, WRANGLER_SEND_METRICS: "false", ...(options.accountId ? { CLOUDFLARE_ACCOUNT_ID: options.accountId } : {}), ...options.env };
	return new Promise((resolve) => {
		// npx is a .cmd on Windows, which Node runs only through a shell, so its path is quoted (C:\Program Files). Every argument is
		// fixed here or checked first (a Worker name).
		const windows = process.platform === "win32";
		const child = spawn(windows ? `"${npx}"` : npx, ["--yes", `wrangler@${WRANGLER_VERSION}`, ...args], {
			cwd: options.cwd,
			env,
			stdio: options.inherit ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			shell: windows,
			windowsHide: true,
		});
		let out = "";
		child.stdout?.on("data", (b: Buffer) => (out += b));
		child.stderr?.on("data", (b: Buffer) => (out += b));
		if (options.input !== undefined) child.stdin?.end(options.input);
		const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: 127, out: err.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, out });
		});
	});
}

const wrangler = (seam: RelaySeam) => seam.wrangler ?? runWrangler;

export interface CloudflareAccount {
	id: string;
	name: string;
}

/** `wrangler whoami --json`: signed in and which accounts, or undefined when the output isn't that. */
export function parseWhoami(out: string): { loggedIn: boolean; accounts: CloudflareAccount[] } | undefined {
	const start = out.indexOf("{");
	if (start < 0) return undefined;
	let raw: { loggedIn?: unknown; accounts?: unknown };
	try {
		raw = JSON.parse(out.slice(start)) as typeof raw;
	} catch {
		return undefined;
	}
	if (typeof raw?.loggedIn !== "boolean") return undefined;
	const accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
		.filter((a): a is { id: string; name?: unknown } => Boolean(a) && typeof a.id === "string" && validAccountId(a.id))
		.map((a) => ({ id: a.id, name: typeof a.name === "string" ? a.name : a.id }));
	return { loggedIn: raw.loggedIn, accounts };
}

export async function whoami(seam: RelaySeam = {}): Promise<{ loggedIn: boolean; accounts: CloudflareAccount[] } | { error: string }> {
	mkdirSync(relayFolder(), { recursive: true, mode: 0o700 });
	const r = await wrangler(seam)(["whoami", "--json"], { cwd: relayFolder(), timeoutMs: 180_000 });
	const parsed = parseWhoami(r.out);
	if (parsed) return parsed;
	// A signed-out wrangler exits non-zero; it says so in words when --json has nothing to print.
	if (/not authenticated|not logged in|wrangler login/i.test(r.out)) return { loggedIn: false, accounts: [] };
	return { error: `wrangler whoami failed (exit ${r.code})${r.out ? `: ${r.out.trim().slice(-300)}` : ""}` };
}

/** `wrangler login` in the person's terminal: wrangler opens Cloudflare's sign-in page in their browser and waits for it. */
export async function login(seam: RelaySeam = {}): Promise<boolean> {
	mkdirSync(relayFolder(), { recursive: true, mode: 0o700 });
	return (await wrangler(seam)(["login"], { cwd: relayFolder(), inherit: true, timeoutMs: 10 * 60_000 })).code === 0;
}

/** The deploy kit in a folder of its own, holding only the two files, as deploy.md asks. */
export function stageRelay(dir: string = relayFolder()): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeAtomic(join(dir, "relay.js"), RELAY_JS, 0o600);
	writeAtomic(join(dir, "wrangler.jsonc"), RELAY_WRANGLER, 0o600);
}

/** Wrangler's words when the account has no workers.dev subdomain and there is no terminal to ask in. */
export const needsSubdomain = (out: string): boolean => /register a workers\.dev subdomain|\/workers\/onboarding/i.test(out);

/** The deployed workers.dev address from WRANGLER_OUTPUT_FILE_PATH's lines: the `deploy` entry's target on workers.dev. */
export function deployedAddress(ndjson: string): string | undefined {
	for (const line of ndjson.split("\n")) {
		let entry: { type?: unknown; targets?: unknown };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry?.type !== "deploy" || !Array.isArray(entry.targets)) continue;
		for (const target of entry.targets) {
			if (typeof target !== "string") continue;
			try {
				const url = new URL(target);
				if (url.protocol === "https:" && url.hostname.endsWith(".workers.dev") && !url.username && !url.password) return url.origin;
			} catch {
				// Not a URL; the next one may be.
			}
		}
	}
	return undefined;
}

export type DeployResult = { ok: true; url: string } | { ok: false; subdomain: true } | { ok: false; subdomain?: false; message: string };

/** `wrangler deploy --name <name>` with the staged kit. With no terminal, wrangler asks nothing; a missing subdomain is its own answer. */
export async function deploy(name: string, accountId: string | undefined, seam: RelaySeam = {}): Promise<DeployResult> {
	const dir = relayFolder();
	stageRelay(dir);
	const output = join(dir, "deploy-output.ndjson");
	rmSync(output, { force: true });
	const r = await wrangler(seam)(["deploy", "--name", name], { cwd: dir, accountId, env: { WRANGLER_OUTPUT_FILE_PATH: output }, timeoutMs: 5 * 60_000 });
	let lines = "";
	try {
		lines = readFileSync(output, "utf8");
	} catch {
		// No output file: the deploy never got that far.
	}
	const url = r.code === 0 ? deployedAddress(lines) : undefined;
	if (url) return { ok: true, url };
	if (needsSubdomain(r.out)) return { ok: false, subdomain: true };
	return { ok: false, message: r.code === 0 ? "wrangler deploy finished but named no workers.dev address." : `wrangler deploy failed (exit ${r.code})${r.out ? `: ${r.out.trim().slice(-400)}` : ""}` };
}

/** The Worker this computer last set a key on. It outlives `remote off`, so setting up again takes the same one. */
const mineFile = () => join(relayFolder(), "mine.json");

/**
 * Whether a Worker of this name already has a key this computer didn't set, so it is most likely another computer's relay: deploying over
 * it and setting a new key would cut that computer off. A Worker with no key yet is a setup that never finished.
 */
export async function someoneElses(name: string, accountId: string | undefined, seam: RelaySeam = {}): Promise<boolean> {
	try {
		const mine = JSON.parse(readFileSync(mineFile(), "utf8")) as { name?: unknown; accountId?: unknown };
		if (mine.name === name && mine.accountId === accountId) return false;
	} catch {
		// No key set from here yet.
	}
	const r = await wrangler(seam)(["secret", "list", "--name", name], { cwd: relayFolder(), accountId, timeoutMs: 180_000 });
	return r.code === 0 && r.out.includes("RELAY_KEY");
}

/** `wrangler secret put RELAY_KEY` with the key on stdin, so it never touches argv, a file or a log. */
export async function putKey(name: string, key: string, accountId: string | undefined, seam: RelaySeam = {}): Promise<{ ok: true } | { ok: false; message: string }> {
	const r = await wrangler(seam)(["secret", "put", "RELAY_KEY", "--name", name], { cwd: relayFolder(), accountId, input: key, timeoutMs: 3 * 60_000 });
	if (r.code === 0) {
		writeAtomic(mineFile(), JSON.stringify({ name, accountId }), 0o600);
		return { ok: true };
	}
	return { ok: false, message: `wrangler secret put RELAY_KEY failed (exit ${r.code})${r.out ? `: ${r.out.replaceAll(key, "<key>").trim().slice(-300)}` : ""}` };
}

/**
 * The end-to-end check: the relay reports the connector, then GET /v1/health through it comes back from serve as {"ok":true}.
 * A new subdomain can take minutes to resolve and the connector a few seconds to dial, so it retries until `deadline`.
 */
export async function verify(url: string, deadline: number, every: number, seam: RelaySeam = {}): Promise<{ ok: true } | { ok: false; code: "relay_connector" | "relay_health"; message: string }> {
	const get = seam.fetch ?? fetch;
	const wait = seam.sleep ?? sleep;
	const headers = { "user-agent": USER_AGENT };
	let last = "";
	let connected = false;
	for (;;) {
		try {
			if (!connected) {
				const res = await get(`${url}/_relay/health`, { headers, signal: AbortSignal.timeout(10_000) });
				const body = (await res.json().catch(() => undefined)) as { connected?: unknown } | undefined;
				connected = res.ok && body?.connected === true;
				last = connected ? "" : res.ok ? "the relay answers but no connector is connected" : `the relay answered ${res.status}`;
			}
			if (connected) {
				const res = await get(`${url}${HEALTH_PATH}`, { headers, signal: AbortSignal.timeout(10_000) });
				const body = (await res.json().catch(() => undefined)) as { ok?: unknown } | undefined;
				if (res.status === 200 && body?.ok === true) return { ok: true };
				last = `${HEALTH_PATH} through the relay answered ${res.status}`;
			}
		} catch (err) {
			last = err instanceof Error ? err.message : String(err);
		}
		if (Date.now() + every > deadline) break;
		await wait(every);
	}
	return connected
		? { ok: false, code: "relay_health", message: `The relay reaches this computer, but serve didn't answer ${HEALTH_PATH} through it (${last}).` }
		: { ok: false, code: "relay_connector", message: `The relay at ${url} didn't report this computer's connector (${last}).` };
}
