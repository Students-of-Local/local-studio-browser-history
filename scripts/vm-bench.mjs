#!/usr/bin/env node
// The #28 bench for `tychicus vm` on this Mac: cold start, warm start, reset, idle CPU and host focus
// changes, measured through the CLI as a person runs it. Prints the table, appends one JSON line per run to
// $XDG_STATE_HOME/tychicus/vm-bench.jsonl (~/.local/state/...), and exits 1 when a target is missed.
//
//   node scripts/vm-bench.mjs [--runs N] [--idle-seconds S] [--guest NAME] [--force]
//
// It uses its own guest (default "bench"), so a guest you work in is left alone. --force passes the
// battery and load checks of the resource gate, as `vm up --force` does.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "cli", "dist", "index.js");
const opt = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const runs = Number(opt("--runs", "5"));
const idleSeconds = Number(opt("--idle-seconds", "30"));
const guest = opt("--guest", "bench");
const force = process.argv.includes("--force") ? ["--force"] : [];
if (!existsSync(cli)) throw new Error("Build the CLI first: (cd cli && npm run build)");

const vmRoot =
	process.env.TYCHICUS_VM_DIR ||
	join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "tychicus", "vm");
const dir = join(vmRoot, "guests", guest);

/** Run `tychicus vm ...`; return its wall time in ms and its parsed --json output. */
function vm(...args) {
	const t0 = performance.now();
	const res = spawnSync(process.execPath, [cli, "vm", ...args], { encoding: "utf8" });
	const ms = performance.now() - t0;
	if (res.status !== 0) throw new Error(`tychicus vm ${args.join(" ")} exited ${res.status}: ${res.stderr.trim()}`);
	let json;
	try {
		json = JSON.parse(res.stdout);
	} catch {
		json = undefined;
	}
	return { ms, json, stdout: res.stdout };
}

const running = () => vm("list", "--json").json.find((g) => g.name === guest)?.state === "running";

/** CPU seconds a process has used, from ps (minutes:seconds.hundredths). */
function cpuSeconds(pid) {
	const out = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
	const parts = out.split(":").map(Number);
	return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const sec = (ms) => `${(ms / 1000).toFixed(2)} s`;
const spread = (xs) => `${sec(median(xs))} (${sec(Math.min(...xs))} to ${sec(Math.max(...xs))}, ${xs.length} runs)`;

// Host focus: the helper's focus-watch prints a line per app activation on this Mac.
const helper = process.env.TYCHICUS_VM_HELPER || join(vmRoot, "bin", "tychicus-vm");
const activations = [];
let watcher;
function watchFocus() {
	watcher = spawn(helper, ["focus-watch"], { stdio: ["ignore", "pipe", "inherit"] });
	return new Promise((ready) => {
		let buf = "";
		watcher.stdout.on("data", (chunk) => {
			buf += chunk;
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line === "watching") ready();
				else if (line.startsWith("activated ")) activations.push(line.slice(10));
				nl = buf.indexOf("\n");
			}
		});
	});
}

const result = {
	at: new Date().toISOString(),
	runs,
	host: execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim(),
};

if (running()) vm("down", guest);
let provisionMs;
if (!existsSync(join(dir, "ready.vzvmsave"))) {
	// First boot of a new guest: cloud-init, then the ready point. The image download is not timed.
	provisionMs = vm("up", guest, ...force).ms;
	vm("down", guest);
}
if (existsSync(helper)) await watchFocus();

const cold = [];
for (let i = 0; i < runs; i++) {
	cold.push(vm("up", guest, "--cold", ...force).ms);
	vm("down", guest);
}
const warmReady = [];
for (let i = 0; i < runs; i++) {
	vm("reset", guest); // down: drop the saved session, so up restores the ready point
	warmReady.push(vm("up", guest, ...force).ms);
	vm("down", guest);
}
const warmSession = [];
for (let i = 0; i < runs; i++) {
	warmSession.push(vm("up", guest, ...force).ms);
	vm("down", guest);
}

vm("up", guest, ...force);
const reset = [];
let resetClean = true;
for (let i = 0; i < runs; i++) {
	vm("exec", guest, "--", "echo bench > /root/bench-marker");
	reset.push(vm("reset", guest).ms);
	const check = spawnSync(process.execPath, [cli, "vm", "exec", guest, "--", "test ! -e /root/bench-marker"]);
	if (check.status !== 0) resetClean = false;
}

// Idle: the helper, and the Virtualization process that holds this guest's disk (the guest itself).
const status = vm("up", guest, "--json").json;
const helperPid = status.pid;
const guestPid = Number(
	execFileSync("lsof", ["-t", join(dir, "disk.raw")], { encoding: "utf8" })
		.trim()
		.split("\n")[0],
);
await new Promise((done) => setTimeout(done, 5000));
const h0 = cpuSeconds(helperPid);
const g0 = cpuSeconds(guestPid);
await new Promise((done) => setTimeout(done, idleSeconds * 1000));
const helperIdle = ((cpuSeconds(helperPid) - h0) / idleSeconds) * 100;
const guestIdle = ((cpuSeconds(guestPid) - g0) / idleSeconds) * 100;
// Telemetry: the helper opens no network socket (the guest's NAT traffic belongs to the guest).
const sockets = spawnSync("lsof", ["-a", "-p", String(helperPid), "-i"], { encoding: "utf8" }).stdout.trim();
vm("down", guest);
watcher?.kill("SIGTERM");

Object.assign(result, {
	provisionMs,
	coldMs: cold,
	warmReadyMs: warmReady,
	warmSessionMs: warmSession,
	resetMs: reset,
	resetClean,
	helperIdlePct: helperIdle,
	guestIdlePct: guestIdle,
	helperNetworkSockets: sockets ? sockets.split("\n").length - 1 : 0,
	focusChanges: activations.length,
	focusApps: activations,
});

const rows = [
	["Linux cold start", "8 s or less", spread(cold), "14.5 s", median(cold) <= 8000],
	["Linux warm start, ready point", "1 s or less", spread(warmReady), "1.1 to 1.9 s", median(warmReady) <= 1000],
	["Linux warm start, saved session", "1 s or less", spread(warmSession), "1.1 to 1.9 s", median(warmSession) <= 1000],
	[
		"Linux reset to clean",
		"1 s or less",
		`${spread(reset)}${resetClean ? "" : ", NOT CLEAN"}`,
		"fork in ms (SDK)",
		median(reset) <= 1000 && resetClean,
	],
	[
		"Idle CPU of the helper",
		"5% or less",
		`${helperIdle.toFixed(2)}% over ${idleSeconds} s`,
		"about 50%",
		helperIdle <= 5,
	],
	[
		"Telemetry",
		"off, nothing sent",
		`${result.helperNetworkSockets} network sockets in the helper`,
		"on by default",
		result.helperNetworkSockets === 0,
	],
	[
		"Focus changes on the host",
		"0",
		watcher ? String(activations.length) : "not measured",
		"not measured",
		watcher ? activations.length === 0 : false,
	],
];
const info = [
	[
		"Idle CPU of the guest's VM process",
		`${guestIdle.toFixed(2)}% over ${idleSeconds} s (the guest kernel and its services)`,
	],
	[
		"First boot of a new guest",
		provisionMs === undefined
			? "not run (the guest had a ready point)"
			: `${sec(provisionMs)} (cloud-init, then saving the ready point; download not timed)`,
	],
];

console.log("| Measure | Target | Ours (median, range) | Cua today | Pass |");
console.log("| --- | --- | --- | --- | --- |");
for (const [measure, target, ours, cua, pass] of rows)
	console.log(`| ${measure} | ${target} | ${ours} | ${cua} | ${pass ? "yes" : "NO"} |`);
console.log("");
for (const [measure, value] of info) console.log(`${measure}: ${value}`);
console.log(
	`Times are wall clock through \`tychicus vm\`, including Node's start (about 0.14 s). Host: ${result.host}.`,
);

const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "tychicus");
mkdirSync(stateDir, { recursive: true });
appendFileSync(join(stateDir, "vm-bench.jsonl"), `${JSON.stringify(result)}\n`);
console.log(`Logged to ${join(stateDir, "vm-bench.jsonl")}`);
process.exitCode = rows.every((row) => row[4]) ? 0 : 1;
