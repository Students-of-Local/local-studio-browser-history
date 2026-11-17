/**
 * `tychicus setup`: build, register, wire up the harnesses, then load and connect. `--agents` runs only the agent
 * step, which first moves entries that still run Polycarp's browser MCP server; `--dry-run` prints that move.
 * Interactive by default; `--yes` accepts every offer. It edits a harness config only
 * after a yes and always points harnesses at the absolute path of the launcher.
 */

import { COMMAND_NAME } from "./self.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { BridgeClient, listSockets } from "./client.ts";
import { buildState, builtVersion, sourceVersion } from "./doctor.ts";
import { aliasFile, applyMigration, type FilePlan, liveAlias, planFinish, planMigration, unifiedDiff } from "./agent-migration.ts";
import { harnesses, launcherBinary, launcherValid, MCP_NAME, runCommand, shellJoin, which } from "./harness.ts";
import { browserDirs, install, installedBrowserDirs, registeredBrowserNames } from "./install.ts";
import { extensionDir, repoRoot } from "./paths.ts";
import { installSkills, skillTargets } from "./skill.ts";
import { SKILLS } from "./skills-catalog.ts";
import { banner, box, c, confirm, sym } from "./ui.ts";
import { VERSION } from "./version.ts";

export interface SetupOptions {
	yes: boolean;
	/** Skip waiting for the extension to connect. */
	wait: boolean;
	/** Seconds to wait for the extension; 0 waits until Ctrl+C. */
	timeoutS: number;
	/** Register this browser (by the name browserDirs() gives it) in addition to the ones already registered. */
	browser?: string;
	/** Only the agent step: move agents from Polycarp, then offer Tychicus to each. */
	agentsOnly?: boolean;
	/** Print what moving agents from Polycarp (or finishing the move) would change in each file, and change nothing. */
	dryRun?: boolean;
	/** Finish moving agents from Polycarp: rename each temporary alias to tychicus. */
	finish?: boolean;
}

/** Without a terminal nobody can press Ctrl+C on an endless wait, so it gets a bound. */
export const UNATTENDED_TIMEOUT_S = 300;

function step(n: number, title: string): void {
	console.log();
	console.log(`${c.brass(`${n}.`)} ${c.bold(title)}`);
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
	console.log(`  ${c.dim(`$ ${shellJoin([command, ...args])}`)}`);
	const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
	if (result.error) console.log(`  ${sym.fail} ${result.error.message}`);
	return result.status === 0;
}

async function ensureBuild(options: SetupOptions): Promise<boolean> {
	const state = buildState();
	if (state === "ok") {
		console.log(`  ${sym.ok} Extension built ${c.dim(`(${builtVersion()}, ${extensionDir()})`)}`);
		return true;
	}
	const root = repoRoot();
	console.log(
		state === "missing"
			? `  ${sym.warn} No extension build at ${extensionDir()}`
			: `  ${sym.warn} The extension build (${builtVersion()}) does not match this checkout (${sourceVersion()})`,
	);
	if (!(await confirm(`  ${state === "missing" ? "Build it now? The first build fetches pi-mono and mini-lit and takes a few minutes." : "Rebuild it now?"}`, { assumeYes: options.yes }))) {
		console.log(`  Build it yourself with: ${c.bold(`cd ${shellJoin([root])} && ./scripts/setup-siblings.sh && npm run build`)}`);
		return false;
	}
	if (process.platform === "win32") {
		console.log(`  ${sym.warn} Automatic builds need a POSIX shell. Build it yourself in Git Bash or WSL:`);
		console.log(`  ${c.bold(`cd ${shellJoin([root])} && ./scripts/setup-siblings.sh && npm run build`)}`);
		return false;
	}
	// The extension compiles against sibling checkouts of pi-mono and mini-lit.
	if (!existsSync(join(root, "vendor", "pi-mono")) || !existsSync(join(root, "node_modules"))) {
		if (!run("./scripts/setup-siblings.sh", [], root)) {
			console.log(`  ${sym.fail} Sibling setup failed. Fix the error above, then run ${c.bold(`${COMMAND_NAME} setup`)} again.`);
			return false;
		}
	}
	if (!run("npm", ["run", "build"], root, { ...process.env, TABKYRA_NO_BUMP: "1" }) || buildState() !== "ok") {
		console.log(`  ${sym.fail} The build failed. Fix the error above, then run ${c.bold(`${COMMAND_NAME} setup`)} again.`);
		return false;
	}
	console.log(`  ${sym.ok} Extension built ${c.dim(`(${builtVersion()})`)}`);
	return true;
}

/**
 * Which browsers setup writes a native-host link for: the ones already registered (refreshed), plus one the person chose with
 * --browser. A machine with none registered yet gets the installed browsers (a first setup has to connect something).
 * Never a browser that is only a leftover data folder, and never every folder there is.
 */
export function setupBrowsers(options: Pick<SetupOptions, "browser">): string[] {
	const names = new Set(registeredBrowserNames());
	if (options.browser !== undefined) names.add(options.browser);
	if (names.size === 0) for (const { name } of installedBrowserDirs()) names.add(name);
	return [...names];
}

function registerHost(options: SetupOptions): boolean {
	const targets = setupBrowsers(options);
	// A working launcher stays as it is (a standalone install's, say); only a broken one is rewritten.
	const result = install({ browsers: targets });
	if (process.platform === "win32") {
		for (const key of result.written) console.log(`  ${sym.ok} ${key}`);
		return result.written.length > 0;
	}
	const present = browserDirs().filter(({ name, dir }) => targets.includes(name) && existsSync(dir));
	if (present.length === 0) {
		console.log(`  ${sym.fail} No Chromium browser profile found. Open your browser once, then run ${c.bold(`${COMMAND_NAME} setup`)} again.`);
		return false;
	}
	for (const { name, dir } of present) {
		const changed = result.written.some((w) => w.startsWith(join(dir, "NativeMessagingHosts")));
		console.log(`  ${sym.ok} ${name.padEnd(13)} ${c.dim(changed ? "registered" : "already registered")}`);
	}
	return true;
}

function copyToClipboard(text: string): boolean {
	const candidates: Array<[string, string[]]> =
		process.platform === "darwin"
			? [["pbcopy", []]]
			: process.platform === "win32"
				? [["clip", []]]
				: [
						["wl-copy", []],
						["xclip", ["-selection", "clipboard"]],
						["xsel", ["--clipboard", "--input"]],
					];
	for (const [command, args] of candidates) {
		if (process.platform !== "win32" && !which(command)) continue;
		try {
			execFileSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
			return true;
		} catch {
			/* try the next one */
		}
	}
	return false;
}

interface Probe {
	connected: boolean;
	/** The version the browser is running, when connected. */
	version?: string;
	/** Why no socket could be used (an insecure socket directory, a wedged host). */
	error?: string;
	socket?: string;
}

/** Look for a live bridge with the extension behind it, and ask it which version it runs. */
async function probe(): Promise<Probe> {
	let sockets: string[];
	try {
		sockets = listSockets();
	} catch (err) {
		return { connected: false, error: err instanceof Error ? err.message : String(err) };
	}
	let error: string | undefined;
	for (const path of sockets) {
		const client = new BridgeClient({ name: "setup" });
		try {
			await client.connect(path);
			if (!client.extensionConnected) continue;
			try {
				const info = (await client.call("bridge.debug", {}, 5000)) as { version?: string };
				return { connected: true, version: info.version, socket: path };
			} catch (err) {
				// Connected but not answering: not ready, and the reason is worth showing.
				return { connected: true, socket: path, error: err instanceof Error ? err.message : String(err) };
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			client.close();
		}
	}
	return { connected: false, error };
}

/** Ask the running extension to reload itself (it comes back on the new build). */
async function reloadExtension(socket: string): Promise<void> {
	const client = new BridgeClient({ name: "setup" });
	try {
		await client.connect(socket);
		await client.call("bridge.reload", {}, 5000);
	} catch {
		/* the reload drops the connection; that is expected */
	} finally {
		client.close();
	}
}

/** One file's part of the move or the finish: what changes, and the exact lines. */
function printPlan(plan: FilePlan, binary: string): void {
	if (plan.status === "refused") {
		if (plan.blocking) console.log(`  ${sym.fail} ${c.bold(plan.name)}: ${c.cyan(plan.file)} was not changed: ${plan.reason}`);
		else console.log(`  ${sym.warn} ${c.bold(plan.name)}: ${c.cyan(plan.file)} was not read: ${plan.reason} ${c.dim("It names neither polycarp nor tabkyra, so there was nothing in it to move.")}`);
		return;
	}
	if (plan.status === "change") {
		console.log(`  ${sym.dot} ${c.bold(plan.name)}: ${c.cyan(plan.file)}`);
		for (const r of plan.repointed) {
			const alias = r.name === MCP_NAME ? "" : c.dim(` (a temporary alias until ${COMMAND_NAME} setup --agents --finish)`);
			console.log(`    ${r.name}: ${r.from} -> ${binary} mcp${alias}`);
		}
		for (const f of plan.finished) {
			console.log(`    ${f.name}: ${f.action === "renamed" ? `renamed to ${MCP_NAME}` : `removed: the ${MCP_NAME} entry already runs the same command`}`);
		}
		for (const line of unifiedDiff(plan.file, plan.before ?? "", plan.after ?? "").split("\n")) {
			const color = line.startsWith("+") && !line.startsWith("+++") ? c.green : line.startsWith("-") && !line.startsWith("---") ? c.red : c.dim;
			console.log(`    ${color(line)}`);
		}
	}
	for (const p of plan.projects) {
		console.log(`  ${sym.warn} ${plan.name}: project ${p.project}: "${p.name}" runs ${p.from} in local scope, which wins over the user entry there. It was left alone.`);
		console.log(`    ${c.dim("Fix:")} cd ${shellJoin([p.project])} && claude mcp remove ${shellJoin([p.name])} -s local ${c.dim(`(the user entry then applies), or point it at ${binary} mcp`)}`);
	}
	for (const line of plan.leftAlone) console.log(`  ${sym.warn} ${plan.name}: ${line}`);
	for (const note of plan.notes) console.log(`  ${c.dim(`${plan.name}: ${note}`)}`);
}

/**
 * Plan, show, ask, then write: the move (entries that run Polycarp's browser MCP now run Tychicus under their old names)
 * or the finish (those aliases renamed to tychicus). Returns false when a file that could hold an entry was refused, an
 * entry had to be left for a manual fix during finish, or a write failed. A file that doesn't parse but names neither
 * polycarp nor tabkyra is only a warning: there was nothing in it to move.
 */
/** Write the plans, then name any file whose aliases couldn't be recorded. Never called in a dry run. */
function applyAndWarn(plans: FilePlan[]): ReturnType<typeof applyMigration> {
	const done = applyMigration(plans);
	for (const plan of plans) if (plan.aliasWarning) console.log(`  ${sym.warn} ${c.bold(plan.name)}: ${plan.aliasWarning}`);
	return done;
}

async function runAgentPlans(kind: "move" | "finish", options: Pick<SetupOptions, "yes" | "dryRun">): Promise<boolean> {
	const binary = launcherBinary();
	const plans = kind === "move" ? planMigration(binary) : planFinish(binary);
	const failed = () => plans.some((p) => p.status === "refused" && p.blocking) || (kind === "finish" && plans.some((p) => p.leftAlone.length > 0));
	const changes = plans.filter((p) => p.status === "change");
	const shown = plans.filter((p) => p.status === "change" || p.status === "refused" || p.leftAlone.length + p.projects.length + p.notes.length > 0);
	if (shown.length === 0) {
		console.log(`  ${sym.ok} ${kind === "move" ? "No agent runs Polycarp's browser MCP server; nothing to move." : "No temporary aliases are left; nothing to finish."}`);
		if (kind === "finish" && !options.dryRun) applyAndWarn(plans);
		return true;
	}
	for (const plan of shown) printPlan(plan, binary);
	if (changes.length === 0 || options.dryRun) {
		if (options.dryRun) console.log(`  ${c.dim("Dry run: nothing was written.")}`);
		else if (kind === "finish") applyAndWarn(plans);
		return !failed();
	}
	if (!launcherValid()) {
		console.log(`  ${sym.fail} Tychicus's launcher isn't installed at ${binary}, so these entries would run nothing. Run ${c.bold(`${COMMAND_NAME} install`)} first.`);
		return false;
	}
	const files = changes.length === 1 ? "this file" : `these ${changes.length} files`;
	const question = kind === "move" ? `Move ${files} to Tychicus?` : `Rename the aliases in ${files} to ${MCP_NAME}?`;
	if (!(await confirm(`  ${sym.dot} ${question} A backup of each is made first.`, { assumeYes: options.yes }))) {
		console.log(`    ${c.dim("Later:")} ${COMMAND_NAME} setup --agents${kind === "finish" ? " --finish" : ""}`);
		return !failed();
	}
	try {
		for (const { file, backup } of applyAndWarn(plans)) console.log(`  ${sym.ok} ${file} ${c.dim(`(backup: ${backup})`)}`);
	} catch (err) {
		console.log(`  ${sym.fail} Writing failed: ${err instanceof Error ? err.message : String(err)}. Files written before it, and their backups, are listed above.`);
		return false;
	}
	for (const plan of changes) if (plan.status === "refused") console.log(`  ${sym.fail} ${c.bold(plan.name)}: ${c.cyan(plan.file)} ${plan.reason}`);
	if (kind === "move" && changes.some((p) => p.status === "change" && p.repointed.some((r) => r.name !== MCP_NAME))) {
		console.log(`  ${c.dim(`The old names are temporary aliases for Tychicus, listed in ${aliasFile()}. Once nothing names them, run ${COMMAND_NAME} setup --agents --finish.`)}`);
	}
	return !failed();
}

/** Move agents from Polycarp's browser MCP to Tychicus, keeping their old names as temporary aliases. */
export function moveAgentsFromPolycarp(options: Pick<SetupOptions, "yes" | "dryRun">): Promise<boolean> {
	return runAgentPlans("move", options);
}

/** Finish the move: rename each temporary alias to tychicus. */
export function finishAgentsMove(options: Pick<SetupOptions, "yes" | "dryRun">): Promise<boolean> {
	return runAgentPlans("finish", options);
}

/** Offer each detected harness the MCP server. Returns false if an attempted add failed. */
async function connectHarnesses(options: SetupOptions): Promise<boolean> {
	const binary = launcherBinary();
	const found = harnesses(binary).filter((h) => h.detected);
	if (found.length === 0) {
		console.log(`  No coding harness found. Any MCP client can run: ${c.bold(`${binary} mcp`)}`);
		return true;
	}
	let ok = true;
	for (const h of found) {
		if (h.configured === true) {
			console.log(`  ${sym.ok} ${h.name.padEnd(12)} ${c.dim("already has Tychicus")}`);
			continue;
		}
		// Moved from Polycarp: Tychicus runs under the old name until the finish step, so no second entry is added.
		const alias = h.configured === false ? liveAlias(h.id) : undefined;
		if (alias) {
			console.log(`  ${sym.ok} ${h.name.padEnd(12)} ${c.dim(`runs Tychicus as "${alias.name}", a temporary alias (${COMMAND_NAME} setup --agents --finish renames it)`)}`);
			continue;
		}
		if (h.configured === undefined) {
			console.log(`  ${sym.warn} ${h.name}: couldn't tell whether Tychicus is configured. ${c.dim(`Run ${COMMAND_NAME} doctor for details.`)}`);
			continue;
		}
		const replacing = h.configured === "stale" || h.configured === "other";
		if (h.addCommand) {
			const commands = !replacing || !h.removeCommand ? [h.addCommand] : [h.removeCommand, h.addCommand];
			const shown = commands.map(shellJoin).join(" && ");
			// Windows harness CLIs are .cmd shims that need a shell; print the command there instead.
			if (process.platform === "win32") {
				console.log(`  ${sym.dot} ${c.bold(h.name)}: run ${shown}`);
				continue;
			}
			let question = `Add Tychicus to ${c.bold(h.name)}?`;
			if (h.configured === "stale") question = `${c.bold(h.name)}'s ${MCP_NAME} entry points at a missing command. Replace it?`;
			if (h.configured === "other") question = `${c.bold(h.name)}'s ${MCP_NAME} entry runs ${h.currentCommand}. Replace it with this install?`;
			// An entry running some other existing command may be the user's own wrapper:
			// --yes doesn't replace it, and the interactive default is no.
			const assumeYes = options.yes && h.configured !== "other";
			if (options.yes && h.configured === "other") {
				console.log(`  ${sym.warn} ${question} ${c.dim("left alone (--yes never replaces a working entry)")}`);
				console.log(`    ${c.dim("To replace it:")} ${shown}`);
				continue;
			}
			if (await confirm(`  ${sym.dot} ${question} ${c.dim(`(${shown})`)}`, { assumeYes, defaultYes: h.configured !== "other" })) {
				const failedAt = commands.findIndex((command) => !runCommand(command));
				if (failedAt === -1) {
					console.log(`  ${sym.ok} ${h.name} is set up.`);
				}
				else {
					ok = false;
					console.log(`  ${sym.fail} That failed. Run it yourself: ${c.bold(commands.slice(failedAt).map(shellJoin).join(" && "))}`);
				}
			} else {
				console.log(`    ${c.dim("Later:")} ${shown}`);
			}
			continue;
		}
		if (h.snippet?.startsWith("{")) {
			console.log(`  ${sym.dot} ${c.bold(h.name)}: ${replacing ? "replace the Tychicus entry in" : "add this to"} ${c.cyan(h.configFile ?? "its MCP config")}`);
			for (const line of h.snippet.split("\n")) console.log(`    ${line}`);
		} else if (h.snippet) {
			console.log(`  ${sym.dot} ${c.bold(h.name)}: run ${c.bold(h.snippet)}`);
		}
	}
	await offerSkill(options);
	return ok;
}

/** The skill teaches the agent the loop and the safety rules; harnesses load it on demand. */
async function offerSkill(options: SetupOptions): Promise<void> {
	const targets = skillTargets().filter((t) => t.detected);
	if (targets.length === 0) return;
	const names = targets.map((t) => t.name).join(", ");
	const skills = [...SKILLS.keys()].join(", ");
	if (!(await confirm(`  ${sym.dot} Install the Tychicus skills (${skills}) for ${names}? ${c.dim(`(${COMMAND_NAME} skill install)`)}`, { assumeYes: options.yes }))) {
		console.log(`    ${c.dim("Later:")} ${COMMAND_NAME} skill install`);
		return;
	}
	const results = installSkills({ force: false, all: false });
	for (const t of targets) {
		const mine = results.filter((r) => r.target.id === t.id);
		const ok = mine.filter((r) => r.state === "written" || r.state === "current").length;
		if (ok) console.log(`  ${sym.ok} ${t.name}: ${ok} skills ${c.dim(t.dir)}`);
		for (const r of mine.filter((r) => r.state === "linked")) console.log(`  ${sym.warn} ${t.name}: ${r.file} is a symbolic link; left alone`);
		for (const r of mine.filter((r) => r.state === "kept")) console.log(`  ${sym.warn} ${t.name}: ${r.file} is not ours; left alone ${c.dim(`(${COMMAND_NAME} skill install ${r.skill} --force)`)}`);
	}
}

/** How long to wait for a reloaded extension to come back on the current build. */
const RELOAD_GRACE_MS = 15000;

interface ReloadState {
	reloadedAt?: number;
}

/**
 * Connected and running the build on disk. A stale running copy is reloaded once; if it
 * still runs another version after RELOAD_GRACE_MS, `mismatch` says so and the caller stops.
 */
async function connectedOnCurrentBuild(state: ReloadState): Promise<Probe & { ready: boolean; mismatch?: boolean }> {
	const p = await probe();
	if (!p.connected) return { ...p, ready: false };
	const built = builtVersion();
	if (!p.version) return { ...p, ready: !built && !p.error };
	if (!built || p.version === built) return { ...p, ready: true };
	if (state.reloadedAt === undefined && p.socket) {
		state.reloadedAt = Date.now();
		console.log(`  ${sym.warn} The browser runs Tychicus ${p.version}, the build is ${built}. Reloading the extension...`);
		await reloadExtension(p.socket);
		return { ...p, ready: false };
	}
	const mismatch = state.reloadedAt !== undefined && Date.now() - state.reloadedAt > RELOAD_GRACE_MS;
	return { ...p, ready: false, mismatch };
}

/** How step 4 ended: connected on this build, not waited for (--no-wait), or not connected in time. */
type Loaded = "connected" | "skipped" | "failed";

async function loadExtension(options: SetupOptions): Promise<Loaded> {
	const reload: ReloadState = {};
	const first = await connectedOnCurrentBuild(reload);
	if (first.ready) {
		console.log(`  ${sym.ok} The extension is loaded and connected ${c.dim(`(${first.version ?? "unknown version"})`)}.`);
		return "connected";
	}
	const dir = extensionDir();
	if (!first.connected) {
		console.log(
			box(
				[
					`${c.brass("1")}  Open ${c.bold("chrome://extensions")}, turn on ${c.bold("Developer mode")},`,
					`   and click ${c.bold("Load unpacked")}.`,
					`${c.brass("2")}  Pick this folder:`,
					`   ${c.cyan(dir)}`,
					`${c.brass("3")}  Optional: click ${c.bold("Details")} on Tychicus and turn on`,
					`   ${c.bold("Allow user scripts")} (faster page scripts).`,
				],
				"One step in your browser",
			),
		);
		console.log(c.dim("  Browsers require this step by hand. In Helium, Brave or Edge the page is the same."));
		// Offered only at a terminal: --yes and scripted runs never overwrite the clipboard.
		if (process.stdin.isTTY && !options.yes && (await confirm("  Copy the folder path to the clipboard?", { assumeYes: false }))) {
			console.log(copyToClipboard(dir) ? `  ${sym.ok} Copied.` : `  ${sym.warn} No clipboard tool found; copy the path above.`);
		}
	}
	if (!options.wait) {
		console.log(`  ${c.dim("Not waiting (--no-wait). Check later with")} ${c.bold(`${COMMAND_NAME} status`)}`);
		return "skipped";
	}

	const deadline = options.timeoutS > 0 ? Date.now() + options.timeoutS * 1000 : Number.POSITIVE_INFINITY;
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const live = Boolean(process.stdout.isTTY);
	let frame = 0;
	let last: Probe = first;
	if (!live) {
		console.log(
			options.timeoutS > 0
				? `  Waiting up to ${options.timeoutS} s for the extension to connect...`
				: "  Waiting for the extension to connect (Ctrl+C to stop)...",
		);
	}
	while (Date.now() < deadline) {
		const p = await connectedOnCurrentBuild(reload);
		last = p;
		if (p.mismatch) {
			if (live) process.stdout.write("\r\x1b[2K");
			console.log(`  ${sym.fail} The browser still runs Tychicus ${p.version} after a reload; the build is ${builtVersion()}.`);
			console.log(`  It is probably loaded from another folder. On chrome://extensions, remove Tychicus and load unpacked:`);
			console.log(`  ${c.cyan(dir)}`);
			return "failed";
		}
		if (p.ready) {
			if (live) process.stdout.write("\r\x1b[2K");
			console.log(`  ${sym.ok} ${c.bold("Connected.")} Tychicus can reach your browser ${c.dim(`(${p.version ?? "unknown version"})`)}.`);
			return "connected";
		}
		if (live) process.stdout.write(`\r  ${c.brass(frames[frame++ % frames.length])} Waiting for the extension to connect ${c.dim("(Ctrl+C to stop)")}`);
		await new Promise((r) => setTimeout(r, 1000));
	}
	if (live) process.stdout.write("\r\x1b[2K");
	console.log(`  ${sym.fail} The extension did not connect within ${options.timeoutS} s.`);
	if (last.connected) console.log(`  It is connected but still runs an old build. Reload it on chrome://extensions.`);
	else if (reload.reloadedAt !== undefined) {
		console.log(`  It went away after the reload. On chrome://extensions, check that Tychicus is on and loaded from:`);
		console.log(`  ${c.cyan(dir)}`);
	} else if (last.error) console.log(`  Last error: ${last.error}`);
	console.log(`  If it is loaded, reload it once on chrome://extensions, then run ${c.bold(`${COMMAND_NAME} doctor`)}.`);
	return "failed";
}

export async function runSetup(options: SetupOptions): Promise<number> {
	const timeoutS = options.timeoutS || (process.stdin.isTTY ? 0 : UNATTENDED_TIMEOUT_S);
	const opts = { ...options, timeoutS };
	console.log(banner(`setup ${VERSION}`));
	if (opts.finish) {
		step(1, `Finish moving agents from Polycarp${opts.dryRun ? " (dry run)" : ""}`);
		return (await finishAgentsMove(opts)) ? 0 : 1;
	}
	if (opts.dryRun) {
		step(1, "Move agents from Polycarp (dry run)");
		return (await moveAgentsFromPolycarp(opts)) ? 0 : 1;
	}
	if (opts.agentsOnly) {
		step(1, "Move agents from Polycarp");
		const moved = await moveAgentsFromPolycarp(opts);
		step(2, "Connect your coding agents");
		// A refused file doesn't stop the offers: the other agents still get Tychicus.
		const connected = await connectHarnesses(opts);
		return moved && connected ? 0 : 1;
	}
	console.log(c.dim("You steer. Your agents work the tabs."));

	step(1, "Build the extension");
	if (!(await ensureBuild(opts))) return 1;

	step(2, "Register the native host with your browsers");
	if (!registerHost(opts)) return 1;
	if (!launcherValid()) {
		install({ browsers: setupBrowsers(opts), keepLaunchers: false });
		if (!launcherValid()) {
			console.log(`  ${sym.fail} Could not write the agent launcher at ${launcherBinary()}. Check that ${dirname(launcherBinary())} is writable.`);
			return 1;
		}
	}

	// Harnesses come before the wait, so an unattended run configures them even if the
	// browser step is still to come.
	step(3, "Connect your coding agents");
	// Entries still running Polycarp's browser server move first, so the offers below see them as Tychicus.
	const moved = await moveAgentsFromPolycarp(opts);
	const harnessesOk = (await connectHarnesses(opts)) && moved;

	step(4, "Load the extension");
	const loaded = await loadExtension(opts);
	const connected = loaded === "connected";

	console.log();
	if (connected && harnessesOk) {
		console.log(`${sym.ok} ${c.bold("Tychicus is ready.")} Ask your agent to open a page, for example:`);
		console.log(`  ${c.dim('"Use Tychicus to open news.ycombinator.com and list the top five stories."')}`);
		return 0;
	}
	const next = connected ? "fix the agent step above" : "load the extension";
	console.log(`${sym.warn} ${c.bold("Almost there.")} ${next[0].toUpperCase()}${next.slice(1)}, then run ${c.bold(`${COMMAND_NAME} doctor`)} to check everything.`);
	// --no-wait asked not to wait for the extension, so its not being connected is the step it skipped, not a failure:
	// `polycarp update` runs this with no browser open and goes on to install the rest (it stopped at step 12 of 15 on Parish1).
	return loaded === "skipped" && harnessesOk ? 0 : 1;
}
