/**
 * `remote import-polycarp`: a one-time move of Polycarp's remote connector (its serve, Cloudflare tunnel, hub and link) to
 * Tychicus, so a claude.ai, ChatGPT or grok.com connector added for Polycarp keeps answering at the same address.
 *
 * Polycarp's helper kept its state in <config>/polycarp/browser, or the older <config>/tabkyra, or a folder its service pinned
 * with POLYCARP_BROWSER_CONFIG_DIR or TABKYRA_CONFIG_DIR. Each of Polycarp's services is read (its plist or unit: the program
 * it runs, that launcher's resolved path, its environment) to learn which folder it really uses, and both default folders are
 * looked in, since a setup can be split across them. Files are copied, never moved: nothing under Polycarp's folders or the
 * program a launcher runs is changed. The hostname, tunnel and OAuth state are copied as they are, so the connector's address
 * and every token an assistant holds stay valid. No file's contents are printed; only names and folders.
 *
 * Then the services change hands one at a time: Polycarp's is stopped, Tychicus's is installed and started, and checked; any
 * failure puts every service back the way it was and undoes the copy. On success Polycarp's plists move to
 * ~/Library/LaunchAgents/retired-polycarp/ (Linux: its units are disabled), never deleted.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CLOUDFLARE_SERVICE, cloudflaredBinary } from "./cloudflare.ts";
import { configDir, configHome } from "./files.ts";
import { COMMAND_NAME } from "./self.ts";
import { DEFAULT_PORT } from "./tunnel.ts";
import { HUB_SERVICE, installService, LINK_SERVICE, removeService, SERVE_SERVICE, type ServiceSpec, serviceFile, servicePlatform, serviceRunner, serviceRunning, sleep } from "./service.ts";

export type Role = "serve" | "cloudflared" | "hub" | "link";

/** Polycarp's services, by the names its helper gave them, and the Tychicus service that takes each one's place. */
export const POLYCARP_JOBS: ReadonlyArray<{ role: Role; label: string; unit: string; spec: ServiceSpec }> = [
	{ role: "serve", label: "com.polycarp.serve", unit: "polycarp-serve.service", spec: SERVE_SERVICE },
	{ role: "cloudflared", label: "com.polycarp.cloudflared", unit: "polycarp-cloudflared.service", spec: CLOUDFLARE_SERVICE },
	{ role: "hub", label: "com.polycarp.hub", unit: "polycarp-hub.service", spec: HUB_SERVICE },
	{ role: "link", label: "com.polycarp.link", unit: "polycarp-link.service", spec: LINK_SERVICE },
];

/** Every file of the remote connector, hub and link, and the service that reads it (which decides where a duplicate comes from). */
export const IMPORT_FILES: ReadonlyArray<{ name: string; role: Role }> = [
	{ name: "remote.json", role: "serve" },
	{ name: "oauth.json", role: "serve" },
	{ name: "oauth-codes.json", role: "serve" },
	{ name: "tokens.json", role: "serve" },
	{ name: "connect-mints.json", role: "serve" },
	{ name: "cloudflared.yml", role: "cloudflared" },
	{ name: "cloudflare-tunnel-name", role: "cloudflared" },
	{ name: "cloudflare-zone.json", role: "cloudflared" },
	{ name: "hub.json", role: "hub" },
	{ name: "hub-devices.json", role: "hub" },
	{ name: "hub-codes.json", role: "hub" },
	{ name: "link.json", role: "link" },
];

/** Files whose presence means Tychicus already has remote state of its own, which an import would replace. */
const REMOTE_STATE = ["remote.json", "oauth.json", "tokens.json", "cloudflared.yml", "cloudflare-tunnel-name", "hub.json", "hub-devices.json", "link.json"];

/** cloudflared.yml keys whose value is a file the tunnel reads; one under a Polycarp folder is copied with it. */
const CLOUDFLARED_FILE_KEYS = ["credentials-file", "origincert"];

export interface PolycarpJob {
	role: Role;
	label: string;
	/** The plist or unit file. */
	file: string;
	loaded: boolean;
	/** The program it runs (first argument), and that path with symlinks followed. */
	launcher?: string;
	launcherResolved?: string;
	/** The config folder that program uses, and why this one. */
	folder: string;
	folderWhy: string;
}

export interface PickedFile {
	name: string;
	from: string;
	/** The other folders that also had this file, which were not used. */
	alsoIn: string[];
	/** Where the copy goes. */
	to: string;
}

export interface ImportPlan {
	target: string;
	jobs: PolycarpJob[];
	folders: string[];
	files: PickedFile[];
	/** Files cloudflared.yml names (tunnel credentials, origin certificate): copied when under a Polycarp folder, else left. */
	extras: Array<{ key: string; path: string; copyTo?: string; program?: boolean }>;
	/** The Tychicus services to start, in order. */
	swaps: Array<{ role: Role; spec: ServiceSpec; polycarp?: PolycarpJob }>;
	port?: number;
}

export interface ImportOptions {
	dryRun?: boolean;
	force?: boolean;
	say?: (line: string) => void;
	/** For tests: the local MCP check (status code, or undefined when nothing answers), and how long to wait. */
	probe?: (port: number) => Promise<number | undefined>;
	waitMs?: number;
	/** How long a started tunnel, hub or link must stay up before it counts as running. */
	settleMs?: number;
	/** For tests: where Tychicus finds cloudflared (defaults to cloudflaredBinary()). */
	cloudflared?: () => string | undefined;
}

/** serve answers an unauthenticated /mcp request with 401 and a sign-in challenge: up, and guarding the door. */
export const EXPECTED_MCP_STATUS = 401;

class ImportError extends Error {}

const unxml = (text: string) =>
	text.replace(/&(#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => (e.startsWith("#") ? String.fromCharCode(Number(e.slice(1))) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e]));

/** ProgramArguments and EnvironmentVariables of a launchd plist. */
export function parsePlist(text: string): { args: string[]; env: Record<string, string> } {
	const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
	const args = [...argsBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
	const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "";
	const env: Record<string, string> = {};
	for (const m of envBlock.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) env[unxml(m[1])] = unxml(m[2]);
	return { args, env };
}

/** ExecStart's program and the Environment= lines of a systemd unit. */
export function parseUnit(text: string): { args: string[]; env: Record<string, string> } {
	const env: Record<string, string> = {};
	for (const m of text.matchAll(/^Environment=(.*)$/gm)) {
		let line = m[1].trim();
		if (line.startsWith('"') && line.endsWith('"')) line = line.slice(1, -1).replace(/\\(["\\])/g, "$1");
		const eq = line.indexOf("=");
		if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1).replace(/%%/g, "%");
	}
	const exec = /^ExecStart=(.*)$/m.exec(text)?.[1]?.trim() ?? "";
	const args: string[] = [];
	for (const m of exec.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) args.push((m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2]).replace(/\$\$/g, "$").replace(/%%/g, "%"));
	return { args, env };
}

const isDir = (path: string) => {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
};
const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};
const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};
const sameDir = (a: string, b: string) => real(a) === real(b);

/** Polycarp's two default folders: <config>/polycarp/browser, and the older <config>/tabkyra. */
export const polycarpFolders = () => ({ fresh: join(configHome(), "polycarp", "browser"), legacy: join(configHome(), "tabkyra") });

/** The folder Polycarp's helper chose with no variable set: the new one, unless it is absent and the old one is a real folder. */
function polycarpDefaultFolder(): string {
	const { fresh, legacy } = polycarpFolders();
	return !existsSync(fresh) && isDir(legacy) ? legacy : fresh;
}

/** A config folder a launcher script sets itself (`export POLYCARP_BROWSER_CONFIG_DIR=...`), if any. Only small shell scripts are read. */
function launcherPinnedFolder(launcher: string): string | undefined {
	try {
		if (statSync(launcher).size > 64 * 1024) return undefined;
		const text = readFileSync(launcher, "utf8");
		if (!text.startsWith("#!")) return undefined;
		for (const name of ["POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR"]) {
			const m = new RegExp(`(?:^|[\\s;])(?:export\\s+)?${name}=["']?([^"'\\s;]+)`, "m").exec(text);
			if (m && isAbsolute(m[1])) return m[1];
		}
	} catch {
		/* unreadable: not a pin */
	}
	return undefined;
}

const launchdTarget = (label: string) => `gui/${process.getuid?.() ?? 0}/${label}`;
const polycarpServiceFile = (job: { label: string; unit: string }) =>
	servicePlatform() === "darwin" ? join(homedir(), "Library", "LaunchAgents", `${job.label}.plist`) : join(homedir(), ".config", "systemd", "user", job.unit);

/** Is a service loaded right now? launchd lists it, or systemd says active. */
function loaded(label: string, unit: string): boolean {
	const exec = serviceRunner();
	if (servicePlatform() === "darwin") return exec("launchctl", ["print", launchdTarget(label)]).code === 0;
	return exec("systemctl", ["--user", "is-active", unit]).out.trim() === "active";
}

/** Polycarp's services installed here, each with the folder its program uses. */
export function findPolycarpJobs(): PolycarpJob[] {
	const jobs: PolycarpJob[] = [];
	for (const job of POLYCARP_JOBS) {
		const file = polycarpServiceFile(job);
		if (!isFile(file)) continue;
		let parsed: { args: string[]; env: Record<string, string> };
		try {
			const text = readFileSync(file, "utf8");
			parsed = servicePlatform() === "darwin" ? parsePlist(text) : parseUnit(text);
		} catch {
			parsed = { args: [], env: {} };
		}
		const launcher = parsed.args[0];
		const launcherResolved = launcher && isAbsolute(launcher) ? real(launcher) : undefined;
		let folder: string | undefined;
		let folderWhy = "";
		for (const name of ["POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR"]) {
			const value = parsed.env[name];
			if (!folder && value && isAbsolute(value)) {
				folder = value;
				folderWhy = `${name} in its service file`;
			}
		}
		if (!folder && launcherResolved) {
			const pinned = launcherPinnedFolder(launcherResolved);
			if (pinned) {
				folder = pinned;
				folderWhy = `set by its launcher ${launcherResolved}`;
			}
		}
		if (!folder) {
			folder = polycarpDefaultFolder();
			folderWhy = "Polycarp's default (no folder variable set)";
		}
		jobs.push({ role: job.role, label: job.label, file, loaded: loaded(job.label, job.unit), ...(launcher ? { launcher } : {}), ...(launcherResolved ? { launcherResolved } : {}), folder, folderWhy });
	}
	return jobs;
}

const ROLE_ORDER: Role[] = ["serve", "cloudflared", "hub", "link"];

/** Text with every path into one of `roots` moved to `target`. Roots match whole: /a/b never matches inside /a/bc. */
export function rewritePaths(text: string, roots: string[], target: string): { text: string; count: number } {
	let count = 0;
	let out = text;
	for (const root of [...new Set(roots)].sort((a, b) => b.length - a.length)) {
		if (root === target) continue;
		const pattern = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/\\\\"'\\s,}\\]]|$)`, "gm");
		out = out.replace(pattern, () => {
			count++;
			return target;
		});
	}
	return { text: out, count };
}

/** The value of each `key: value` line of cloudflared.yml, unquoted. */
function yamlValues(text: string, keys: string[]): Array<{ key: string; value: string }> {
	const out: Array<{ key: string; value: string }> = [];
	for (const key of keys) {
		const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(text);
		if (m) out.push({ key, value: m[1].replace(/^(["'])(.*)\1$/, "$2") });
	}
	return out;
}

/** `path` inside one of `roots`: the path relative to that root, else undefined. */
function under(path: string, roots: string[]): string | undefined {
	for (const root of roots) {
		const rel = relative(root, path);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	}
	return undefined;
}

/** Every path a folder goes by: as written, resolved, and with symlinks followed. */
const spellings = (folder: string) => [...new Set([folder, resolve(folder), real(folder)])];

/** Work out what an import would do. Reads only. */
export function planImport(findCloudflared: () => string | undefined = cloudflaredBinary): ImportPlan {
	const target = resolve(configDir());
	const jobs = findPolycarpJobs();
	const { fresh, legacy } = polycarpFolders();
	const candidates: string[] = [];
	const add = (folder: string | undefined) => {
		if (folder && isDir(folder) && !candidates.some((c) => sameDir(c, folder))) candidates.push(folder);
	};
	for (const role of ROLE_ORDER) add(jobs.find((j) => j.role === role)?.folder);
	// A launcher sits in the folder its install wrote it to; that folder counts when it holds remote state.
	for (const job of jobs) {
		for (const path of [job.launcher, job.launcherResolved]) {
			const dir = path && isAbsolute(path) ? dirname(path) : undefined;
			if (dir && ["remote.json", "cloudflared.yml", "oauth.json", "hub.json", "link.json"].some((n) => isFile(join(dir, n)))) add(dir);
		}
	}
	add(fresh);
	add(legacy);
	const clash = candidates.find((c) => sameDir(c, target));
	if (clash) {
		throw new ImportError(
			`Tychicus's config folder is ${target}, which is one of Polycarp's (${clash}), so there is nothing to copy it into. Unset POLYCARP_BROWSER_CONFIG_DIR and TABKYRA_CONFIG_DIR in this shell (or set TYCHICUS_CONFIG_DIR to Tychicus's own folder) and run this again.`,
		);
	}
	const files: PickedFile[] = [];
	for (const { name, role } of IMPORT_FILES) {
		const holders = candidates.filter((c) => isFile(join(c, name)));
		if (!holders.length) continue;
		// The folder of the service that reads this file wins, then the other services' folders, then the defaults.
		const owner = jobs.find((j) => j.role === role)?.folder;
		const from = (owner && holders.find((h) => sameDir(h, owner))) || holders[0];
		files.push({ name, from, alsoIn: holders.filter((h) => h !== from), to: join(target, name) });
	}
	if (!files.some((f) => ["remote.json", "cloudflared.yml", "hub.json", "link.json"].includes(f.name))) {
		throw new ImportError(`No Polycarp remote setup was found: none of ${candidates.length ? candidates.join(", ") : `${fresh} or ${legacy}`} has remote.json, cloudflared.yml, hub.json or link.json.`);
	}
	const roots = candidates.flatMap(spellings);
	const extras: ImportPlan["extras"] = [];
	const yml = files.find((f) => f.name === "cloudflared.yml");
	if (yml) {
		for (const { key, value } of yamlValues(readFileSync(join(yml.from, yml.name), "utf8"), CLOUDFLARED_FILE_KEYS)) {
			if (!isAbsolute(value)) continue;
			const rel = under(value, roots);
			if (rel !== undefined && !isFile(value)) throw new ImportError(`cloudflared.yml names ${value} for ${key}, and that file is missing, so the tunnel couldn't start. Nothing was changed.`);
			if (rel === undefined && key === "credentials-file" && !isFile(value)) throw new ImportError(`cloudflared.yml names ${value} for its tunnel credentials, and that file is missing, so the tunnel couldn't start. Nothing was changed.`);
			extras.push({ key, path: value, ...(rel !== undefined ? { copyTo: join(target, rel) } : {}) });
		}
	}
	// Polycarp's remote.json leaves the port out when it is the default, and serve then listens on DEFAULT_PORT.
	let port: number | undefined;
	const remote = files.find((f) => f.name === "remote.json");
	if (remote) {
		try {
			const raw = JSON.parse(readFileSync(join(remote.from, remote.name), "utf8")) as { port?: unknown };
			port = typeof raw.port === "number" && Number.isInteger(raw.port) ? raw.port : DEFAULT_PORT;
		} catch {
			throw new ImportError(`${join(remote.from, remote.name)} isn't valid JSON, so it can't be imported. Nothing was changed.`);
		}
	}
	const has = (name: string) => files.some((f) => f.name === name);
	const swaps: ImportPlan["swaps"] = [];
	for (const { role, spec } of POLYCARP_JOBS) {
		const polycarp = jobs.find((j) => j.role === role);
		const wanted = role === "serve" ? has("remote.json") : role === "cloudflared" ? has("cloudflared.yml") || Boolean(polycarp?.loaded) : Boolean(polycarp?.loaded);
		if (wanted) swaps.push({ role, spec, ...(polycarp ? { polycarp } : {}) });
	}
	// Tychicus's tunnel service runs cloudflared too. Polycarp may have used a copy it downloaded into its own folder, which
	// Tychicus doesn't look in: copy that one, or stop here before anything is changed.
	if (swaps.some((s) => s.role === "cloudflared") && !findCloudflared()) {
		const own = candidates.map((c) => join(c, "bin", "cloudflared")).find(isFile);
		if (!own) {
			throw new ImportError(
				`Tychicus's tunnel needs cloudflared, and it isn't on PATH, in Homebrew's folders or in Tychicus's own bin folder, nor in Polycarp's. Install it (brew install cloudflared) and run this again. Nothing was changed.`,
			);
		}
		extras.push({ key: "cloudflared program", path: own, copyTo: join(target, "bin", "cloudflared"), program: true });
	}
	return { target, jobs, folders: candidates, files, extras, swaps, ...(port !== undefined ? { port } : {}) };
}

/** A plain GET of /mcp on this computer: the status code, or undefined when nothing answers. */
export function probeLocalMcp(port: number, timeoutMs = 2000): Promise<number | undefined> {
	return new Promise((done) => {
		const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "GET", timeout: timeoutMs }, (res) => {
			res.resume();
			done(res.statusCode);
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => done(undefined));
		req.end();
	});
}

/** Stop one of Polycarp's services, leaving its file where it is. Returns the failure, if any. */
async function stopPolycarp(job: PolycarpJob): Promise<string | undefined> {
	const exec = serviceRunner();
	const unit = POLYCARP_JOBS.find((j) => j.label === job.label)?.unit ?? "";
	if (servicePlatform() === "darwin") {
		const r = exec("launchctl", ["bootout", launchdTarget(job.label)]);
		const deadline = Date.now() + 5000;
		while (exec("launchctl", ["print", launchdTarget(job.label)]).code === 0) {
			if (Date.now() > deadline) return `launchctl bootout ${launchdTarget(job.label)} didn't stop it: ${r.out}`;
			await sleep(250);
		}
		return undefined;
	}
	const r = exec("systemctl", ["--user", "stop", unit]);
	return r.code === 0 ? undefined : `systemctl --user stop ${unit} failed: ${r.out}`;
}

/** Start one of Polycarp's services again from its own file. Returns the failure, if any. */
function startPolycarp(job: PolycarpJob): string | undefined {
	const exec = serviceRunner();
	const unit = POLYCARP_JOBS.find((j) => j.label === job.label)?.unit ?? "";
	const uid = process.getuid?.() ?? 0;
	const r = servicePlatform() === "darwin" ? exec("launchctl", ["bootstrap", `gui/${uid}`, job.file]) : exec("systemctl", ["--user", "start", unit]);
	return r.code === 0 ? undefined : `${servicePlatform() === "darwin" ? `launchctl bootstrap gui/${uid} ${job.file}` : `systemctl --user start ${unit}`} failed: ${r.out}`;
}

/** Retire one of Polycarp's services for good: the plist moves to retired-polycarp/, or the unit is disabled. Never deleted. */
function retirePolycarp(job: PolycarpJob): string {
	if (servicePlatform() === "darwin") {
		const dir = join(dirname(job.file), "retired-polycarp");
		mkdirSync(dir, { recursive: true });
		let to = join(dir, `${job.label}.plist`);
		if (existsSync(to)) to = join(dir, `${job.label}.${new Date().toISOString().replace(/[:.]/g, "-")}.plist`);
		renameSync(job.file, to);
		return `Moved ${job.file} to ${to}.`;
	}
	const unit = POLYCARP_JOBS.find((j) => j.label === job.label)?.unit ?? "";
	const r = serviceRunner()("systemctl", ["--user", "disable", unit]);
	return r.code === 0 ? `Disabled ${unit} (its unit file stays at ${job.file}).` : `systemctl --user disable ${unit} failed: ${r.out}. Run it yourself so it doesn't start at your next login.`;
}

/** Is the new service answering? serve: /mcp gives the expected status. The rest: running, and still running after a moment. */
async function confirm(role: Role, spec: ServiceSpec, plan: ImportPlan, o: ImportOptions): Promise<string | undefined> {
	const probe = o.probe ?? ((port: number) => probeLocalMcp(port));
	const deadline = Date.now() + (o.waitMs ?? 20_000);
	if (role === "serve") {
		if (plan.port === undefined) return "remote.json has no port to check";
		let last: number | undefined;
		for (;;) {
			last = await probe(plan.port);
			// The answer must come from Tychicus's serve: a 401 while it isn't running is some other program on the port.
			if (last === EXPECTED_MCP_STATUS) return serviceRunning(spec) ? undefined : `http://127.0.0.1:${plan.port}/mcp answered, but ${spec.label} isn't running, so another program holds the port`;
			if (Date.now() >= deadline) break;
			await sleep(500);
		}
		return last === undefined ? `nothing answered on http://127.0.0.1:${plan.port}/mcp` : `http://127.0.0.1:${plan.port}/mcp answered ${last}, not ${EXPECTED_MCP_STATUS}`;
	}
	for (;;) {
		if (serviceRunning(spec)) break;
		if (Date.now() >= deadline) return `${spec.label} isn't running (log: ${servicePlatform() === "darwin" ? join(homedir(), "Library", "Logs", spec.logName) : `journalctl --user -u ${spec.unit}`})`;
		await sleep(500);
	}
	await sleep(o.settleMs ?? 5000);
	return serviceRunning(spec) ? undefined : `${spec.label} started, then stopped`;
}

/** After Polycarp's serve stops, its port must go quiet; a program still answering there would take Tychicus's place. */
async function portFree(plan: ImportPlan, o: ImportOptions): Promise<string | undefined> {
	if (plan.port === undefined) return undefined;
	const probe = o.probe ?? ((port: number) => probeLocalMcp(port));
	const deadline = Date.now() + (o.waitMs ?? 20_000);
	for (;;) {
		const status = await probe(plan.port);
		if (status === undefined) return undefined;
		if (Date.now() >= deadline) return `another program still answers on http://127.0.0.1:${plan.port}/mcp (status ${status}) with Polycarp's serve stopped, so Tychicus's serve couldn't use the port. Stop that program and run this again`;
		await sleep(500);
	}
}

/** Copy the planned files. Returns how to undo it. */
function copyFiles(plan: ImportPlan, force: boolean, say: (line: string) => void): () => void {
	const roots = plan.folders.flatMap(spellings);
	const written: string[] = [];
	const backups: Array<{ from: string; to: string }> = [];
	mkdirSync(plan.target, { recursive: true, mode: 0o700 });
	if (force) {
		const backupDir = join(plan.target, `pre-import-${new Date().toISOString().replace(/[:.]/g, "-")}`);
		for (const path of [...plan.files.map((f) => f.to), ...plan.extras.flatMap((e) => (e.copyTo ? [e.copyTo] : []))]) {
			if (!existsSync(path)) continue;
			const to = join(backupDir, relative(plan.target, path));
			mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
			renameSync(path, to);
			backups.push({ from: path, to });
		}
		if (backups.length) say(`Saved Tychicus's earlier files to ${backupDir}.`);
	}
	const undo = () => {
		for (const path of written) rmSync(path, { force: true });
		for (const b of backups) {
			try {
				renameSync(b.to, b.from);
			} catch {
				/* it stays in the backup folder, which the message names */
			}
		}
	};
	const put = (to: string, data: Buffer, fileMode = 0o600) => {
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		const tmp = `${to}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, data, { mode: fileMode });
			chmodSync(tmp, fileMode);
			renameSync(tmp, to);
		} catch (err) {
			rmSync(tmp, { force: true });
			throw err;
		}
		written.push(to);
	};
	try {
		for (const f of plan.files) {
			const raw = readFileSync(join(f.from, f.name));
			const { text, count } = rewritePaths(raw.toString("utf8"), roots, plan.target);
			put(f.to, count ? Buffer.from(text, "utf8") : raw);
			say(`Copied ${f.name} from ${f.from}${count ? ` (${count} path${count === 1 ? "" : "s"} moved to ${plan.target})` : ""}.`);
		}
		for (const e of plan.extras) {
			if (!e.copyTo) continue;
			put(e.copyTo, readFileSync(e.path), e.program ? 0o755 : 0o600);
			say(`Copied the ${e.key} file ${e.path} to ${e.copyTo}.`);
		}
	} catch (err) {
		// A copy that fails partway leaves nothing behind: what was written goes, what was set aside comes back.
		undo();
		throw err;
	}
	return undo;
}

function describe(plan: ImportPlan, say: (line: string) => void): void {
	say(`Tychicus's folder: ${plan.target}`);
	if (!plan.jobs.length) say("Polycarp's services: none installed here.");
	for (const j of plan.jobs) {
		say(`Polycarp service ${j.label} (${j.loaded ? "loaded" : "not loaded"}), ${j.file}`);
		if (j.launcher) say(`  runs ${j.launcher}${j.launcherResolved && j.launcherResolved !== j.launcher ? ` -> ${j.launcherResolved}` : ""}`);
		say(`  uses ${j.folder} (${j.folderWhy})`);
	}
	say(`Looked in: ${plan.folders.join(", ")}`);
	for (const f of plan.files) say(`  ${f.name}: from ${f.from}${f.alsoIn.length ? ` (also in ${f.alsoIn.join(", ")}, not used)` : ""}`);
	for (const e of plan.extras) say(`  ${e.key} ${e.path}: ${e.copyTo ? `copied to ${e.copyTo}` : "left where it is (path kept)"}`);
}

/** Which services are loaded, and what local /mcp answers. */
async function readBack(plan: ImportPlan, o: ImportOptions, say: (line: string) => void): Promise<boolean> {
	say("Read back:");
	for (const { label, unit, spec } of POLYCARP_JOBS) {
		const ours = serviceFile(spec);
		if (ours && existsSync(ours)) say(`  ${spec.label}: ${loaded(spec.label, spec.unit) ? "loaded" : "not loaded"}`);
		const known = plan.jobs.some((j) => j.label === label) || existsSync(polycarpServiceFile({ label, unit }));
		if (known || loaded(label, unit)) say(`  ${label}: ${loaded(label, unit) ? "loaded" : "not loaded"}`);
	}
	if (plan.port === undefined) return true;
	const status = await (o.probe ?? ((port: number) => probeLocalMcp(port)))(plan.port);
	const ok = status === EXPECTED_MCP_STATUS;
	say(`  GET http://127.0.0.1:${plan.port}/mcp: ${status ?? "no answer"} (${ok ? "expected" : `expected ${EXPECTED_MCP_STATUS}`})`);
	return ok;
}

/** `remote import-polycarp`. Returns the exit code: 0 done (or planned, with --dry-run), 1 refused or failed, all put back. */
export async function importPolycarp(o: ImportOptions = {}): Promise<number> {
	const say = o.say ?? ((line: string) => console.log(line));
	const platform = servicePlatform();
	if (platform !== "darwin" && platform !== "linux") {
		say(`${COMMAND_NAME} remote import-polycarp runs on macOS and Linux, where Polycarp's helper ran its services. Nothing was changed.`);
		return 1;
	}
	let plan: ImportPlan;
	try {
		plan = planImport(o.cloudflared);
	} catch (err) {
		if (!(err instanceof ImportError)) throw err;
		say(err.message);
		return 1;
	}
	const existing = REMOTE_STATE.filter((name) => existsSync(join(plan.target, name)));
	if (existing.length && !o.force) {
		say(
			`Tychicus already has remote state in ${plan.target} (${existing.join(", ")}), so nothing was imported. Keep it, or run ${COMMAND_NAME} remote off to clear it and then this again, or run ${COMMAND_NAME} remote import-polycarp --force to replace it (Tychicus's files are saved to a pre-import folder first).`,
		);
		return 1;
	}
	// A failed move removes the Tychicus services it installed. One already installed would be lost with it, so --force waits for remote off.
	const installed = plan.swaps.flatMap((sw) => {
		const file = serviceFile(sw.spec);
		return file && existsSync(file) ? [sw.spec.label] : [];
	});
	if (installed.length) {
		say(`Tychicus already runs ${installed.join(", ")}, which a failed move would remove. Run ${COMMAND_NAME} remote off first (it keeps nothing of Polycarp's), then this again. Nothing was changed.`);
		return 1;
	}
	if (o.dryRun) {
		say("Dry run: nothing is changed.");
		describe(plan, say);
		if (existing.length) say(`Would save Tychicus's ${existing.join(", ")} to a pre-import folder in ${plan.target} first (--force).`);
		for (const s of plan.swaps) {
			say(`Would ${s.polycarp?.loaded ? `stop ${s.polycarp.label}, then ` : ""}install and start ${s.spec.label}${s.role === "serve" && plan.port !== undefined ? ` and check http://127.0.0.1:${plan.port}/mcp answers ${EXPECTED_MCP_STATUS}` : ""}`);
		}
		const retire = plan.swaps.flatMap((s) => (s.polycarp ? [s.polycarp] : []));
		for (const j of retire) say(platform === "darwin" ? `Would move ${j.file} to ${join(dirname(j.file), "retired-polycarp")}/ once all are running` : `Would disable ${j.label}'s unit once all are running (not delete it)`);
		return 0;
	}
	describe(plan, say);
	let undoCopy: () => void;
	try {
		undoCopy = copyFiles(plan, Boolean(o.force), say);
	} catch (err) {
		say(`Copying failed: ${err instanceof Error ? err.message : String(err)}. The files copied so far were removed; no service was touched.`);
		return 1;
	}
	const done: Array<{ spec: ServiceSpec; polycarp?: PolycarpJob; stopped: boolean }> = [];
	const rollback = (): string[] => {
		const problems: string[] = [];
		for (const step of done.reverse()) {
			const removed = removeService(step.spec);
			if (!removed.ok) problems.push(removed.failure ?? `${step.spec.label} could not be removed`);
			if (step.polycarp && step.stopped) {
				const back = startPolycarp(step.polycarp);
				if (back) problems.push(back);
			}
		}
		undoCopy();
		return problems;
	};
	try {
		for (const s of plan.swaps) {
			const step = { spec: s.spec, polycarp: s.polycarp, stopped: false };
			done.push(step);
			if (s.polycarp?.loaded) {
				const stuck = await stopPolycarp(s.polycarp);
				if (stuck) {
					const problems = rollback();
					say(`${stuck}. Everything was put back${problems.length ? `, except: ${problems.join("; ")}` : ""}.`);
					return 1;
				}
				step.stopped = true;
				say(`Stopped ${s.polycarp.label}.`);
			}
			const held = s.role === "serve" ? await portFree(plan, o) : undefined;
			const installed = held ? { ok: false as const, message: held } : await installService(s.spec);
			const problem = installed.ok ? await confirm(s.role, s.spec, plan, o) : installed.message;
			if (problem) {
				const problems = rollback();
				say(`${s.spec.label} didn't take over: ${problem}. Polycarp's services were started again and the copied files removed${problems.length ? `, except: ${problems.join("; ")}` : ""}.`);
				return 1;
			}
			say(`Started ${s.spec.label}.`);
		}
	} catch (err) {
		// Whatever threw, Polycarp's stopped services must run again: the connector can't be left down.
		const problems = rollback();
		say(`The move stopped on an error: ${err instanceof Error ? err.message : String(err)}. Polycarp's services were started again and the copied files removed${problems.length ? `, except: ${problems.join("; ")}` : ""}.`);
		return 1;
	}
	for (const s of plan.swaps) if (s.polycarp) say(retirePolycarp(s.polycarp));
	const ok = await readBack(plan, o, say);
	if (ok) say(`Done. The connector keeps its address; claude.ai, ChatGPT and grok.com need no change.`);
	return ok ? 0 : 1;
}

/** For `install`: a one-line hint when Polycarp has a remote setup and Tychicus has none yet. */
export function importHint(): string | undefined {
	const { fresh, legacy } = polycarpFolders();
	if (existsSync(join(configDir(), "remote.json"))) return undefined;
	if (!existsSync(join(fresh, "remote.json")) && !existsSync(join(legacy, "remote.json"))) return undefined;
	return `Polycarp has a remote connector on this computer. To move it to Tychicus with the same address: ${COMMAND_NAME} remote import-polycarp --dry-run, then without --dry-run.`;
}
