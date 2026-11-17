/**
 * Services left on an old version. `install --release` moves the `release` pointer, but a service keeps the program it was
 * started with until it is restarted: launchd, systemd and the Windows task run the launcher once, and the launcher execs
 * <base>/versions/<version>-<sha>/tychicus. This reads which version folder each Tychicus service's process runs from, and
 * restarts the ones that are not the release (restartService), keeping the folders each was set up with.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CLOUDFLARE_SERVICE } from "./cloudflare.ts";
import { envVar } from "./env.ts";
import { configDir } from "./files.ts";
import { loadRemoteConfig, waitForServe } from "./remote-setup.ts";
import { HUB_SERVICE, LINK_SERVICE, processProgram, restartService, SERVE_SERVICE, type ServiceSpec, savedFolders, serviceFile, servicePid, servicePlatform, sleep } from "./service.ts";
import { c, sym } from "./ui.ts";

/** Every service Tychicus installs, in the order they restart: serve before the tunnel in front of it, then hub and link. */
export const OWNED_SERVICES: ServiceSpec[] = [SERVE_SERVICE, CLOUDFLARE_SERVICE, HUB_SERVICE, LINK_SERVICE];

export interface StaleService {
	spec: ServiceSpec;
	pid: number;
	/** The version the service runs, and the one `release` names. */
	running: string;
	release: string;
}

/** The name the person's service manager knows a service by: the systemd unit on Linux, the label elsewhere. */
export const serviceName = (spec: ServiceSpec) => (servicePlatform() === "linux" ? spec.unit : spec.label);

/** "1.2.1" from a version folder named 1.2.1-<first 12 hex of the archive's SHA-256>. */
export const versionName = (folder: string) => basename(folder).replace(/-[0-9a-f]{12}$/, "");

const real = (path: string): string | undefined => {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
};

/** The version folder the `release` pointer at `root` names, or undefined when there is none. */
export const currentRelease = (root: string): string | undefined => real(root);

/**
 * The version folder a program runs from, or undefined when that can't be told. A program in <base>/versions/<folder>/ is that
 * folder (the versions folder resolved, never the version folder itself). A program in the `release` pointer runs what the
 * pointer named when it started, which only `pointer.before` knows: the pointer itself is never resolved here, since after
 * install moves it, it names the new version whatever the process runs.
 */
function versionFolder(program: string, pointer: Pointer): string | undefined {
	const dir = dirname(program);
	if (basename(dirname(dir)) === "versions") return join(real(dirname(dir)) ?? dirname(dir), basename(dir));
	const root = pointer.root;
	const sameDir = resolve(dir) === resolve(root) || join(real(dirname(dir)) ?? dirname(dir), basename(dir)) === join(real(dirname(root)) ?? dirname(root), basename(root));
	return sameDir ? pointer.before : undefined;
}

/** The `release` pointer's path, and the version folder it named when the services were started (undefined: not known). */
export interface Pointer {
	root: string;
	before?: string;
}

/**
 * Read-only: each installed Tychicus service whose process runs from a version folder other than `current`. A service that
 * isn't running, or runs a program outside versions/ (a checkout, an npm link), is not counted: its version can't be told
 * from the release.
 */
export function staleServices(current: string | undefined, pointer: Pointer, specs: ServiceSpec[] = OWNED_SERVICES): StaleService[] {
	if (!current) return [];
	const stale: StaleService[] = [];
	for (const spec of specs) {
		const file = serviceFile(spec);
		if (!file || !existsSync(file)) continue;
		const pid = servicePid(spec);
		const program = pid ? processProgram(pid, spec) : undefined;
		const folder = program ? versionFolder(program, pointer) : undefined;
		if (!pid || !folder || folder === current) continue;
		stale.push({ spec, pid, running: versionName(folder), release: versionName(current) });
	}
	return stale;
}

/**
 * The command that restarts every stale service: `install --restart-services`, run by the release's own program so the
 * launcher the services run names it.
 */
export const restartCommand = (program: string) => `${program} install --restart-services`;

/** One line per stale service, naming the command that restarts it. */
export const staleLines = (stale: StaleService[], program: string) =>
	stale.map((s) => `${serviceName(s.spec)} still runs ${s.running} (pid ${s.pid}); release is ${s.release}. Restart it: ${restartCommand(program)}`);

/** How long to wait for a restarted service to run the release, in ms. TYCHICUS_SERVE_WAIT_MS changes it for tests. */
const waitMs = () => {
	const n = Number(envVar("SERVE_WAIT_MS"));
	return Number.isFinite(n) && n > 0 ? n : 15_000;
};

/** Wait until the service's process runs from `current`. Returns its pid, or undefined at the deadline. */
async function readBack(spec: ServiceSpec, current: string, root: string): Promise<number | undefined> {
	const deadline = Date.now() + waitMs();
	for (;;) {
		const pid = servicePid(spec);
		const program = pid ? processProgram(pid, spec) : undefined;
		// Restarted after the pointer moved: a program started through it runs `current`.
		if (pid && program && versionFolder(program, { root, before: current }) === current) return pid;
		if (Date.now() >= deadline) return undefined;
		await sleep(250);
	}
}

/**
 * `install --restart-services`: restart each Tychicus service that runs a version other than the release, serve first, then
 * read back that its process runs the release (and that serve answers again, when remote.json says where). Returns the exit
 * code: 0 when every service runs the release, 1 when a restart or its read-back failed.
 */
export async function restartStaleServices(root: string, program: string, say: (line: string) => void = console.log): Promise<number> {
	const current = currentRelease(root);
	if (!current) {
		say(`${sym.fail} No release is installed here (${root}), so there is no version to restart the services on.`);
		return 1;
	}
	// The parent install says what the pointer named before it moved it, for a program ps names by the pointer.
	const before = envVar("RELEASE_BEFORE");
	const stale = staleServices(current, { root, before: before ? (real(before) ?? before) : undefined });
	if (!stale.length) {
		say(`${sym.ok} Every running Tychicus service runs ${versionName(current)}`);
		return 0;
	}
	for (const s of stale) {
		const name = serviceName(s.spec);
		const failed = (why: string) => {
			say(`${sym.fail} ${name}: ${why}`);
			say(`  Run: ${restartCommand(program)}`);
			return 1;
		};
		// Restart only: the service keeps the config folder it was set up with.
		const r = await restartService(s.spec);
		if (!r.ok) return failed(`restart failed: ${r.message}`);
		const pid = await readBack(s.spec, current, root);
		if (!pid) return failed(`restarted, but it doesn't run ${s.release} after ${Math.round(waitMs() / 1000)} seconds`);
		if (s.spec === SERVE_SERVICE) {
			let config: ReturnType<typeof loadRemoteConfig>;
			try {
				// remote.json in the folder the service reads, which may not be this shell's.
				config = loadRemoteConfig(join(savedFolders(s.spec).config ?? configDir(), "remote.json"));
			} catch {
				config = undefined;
			}
			if (config && !(await waitForServe(config.port, config.publicUrl, waitMs()))) return failed(`restarted on ${s.release}, but 127.0.0.1:${config.port} doesn't answer for ${config.publicUrl}`);
		}
		say(`${sym.ok} Restarted ${name}: ${s.running} -> ${s.release} ${c.dim(`(pid ${pid})`)}`);
	}
	return 0;
}
