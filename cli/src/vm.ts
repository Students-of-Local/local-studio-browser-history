/**
 * `tychicus vm`: Linux guests on this Mac through Virtualization.framework (docs/decisions.md, D66).
 *
 * The helper `tychicus-vm` (vm/mac) runs each guest with no window and no Dock icon and answers on
 * <guest>/control.sock. This side prepares the guest folder, runs the resource gate, starts the helper
 * and talks to it. Guests live under ~/.local/share/tychicus/vm (TYCHICUS_VM_DIR overrides it):
 *
 *   base/<image>.raw            the Debian image, read-only, never attached to a guest
 *   guests/<name>/disk.raw      an APFS clone of the base the guest runs on
 *   guests/<name>/ready.raw     the disk at the first ready state, with ready.vzvmsave its saved memory
 *   guests/<name>/session.vzvmsave   what `down` saved; `up` resumes it
 */

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	statfsSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createConnection } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { envVar } from "./env.ts";
import { releaseBase, repoRoot } from "./paths.ts";
import { COMMAND_NAME } from "./self.ts";

/** Must match `version` in vm/mac/Sources/tychicus-vm/main.swift; a different helper is rebuilt. */
export const HELPER_VERSION = "0.1.0";

/** Debian 13 genericcloud for arm64, pinned by release and SHA-512 from Debian's SHA512SUMS. */
export const IMAGE = {
	url: "https://cloud.debian.org/images/cloud/trixie/20261123-2671/debian-13-genericcloud-arm64-20261123-2671.tar.xz",
	sha512: "04b5d50a965ab917f444dba839a38056558c51409c473202f5ea746131d361888da3859821db4c55fe92a0122d0ebe20699f5b3e507f7af9435e7378e855e658",
	member: "disk.raw",
	file: "debian-13-arm64-20261123-2671.raw",
};

export const GUEST = { cpus: 2, memoryMiB: 1024, diskGiB: 8, width: 1280, height: 800 };
const GiB = 1024 ** 3;
export const MIN_FREE_DISK = 5 * GiB;
/** Free RAM the host keeps beyond the guest's own. */
export const RAM_HEADROOM = GiB;

export const VM_USAGE = `Usage: ${COMMAND_NAME} vm list [--json] | up <name> [--cold] [--force] [--json] | down <name> [--json] | reset <name> [--json] | shot <name> [--out FILE] | exec <name> -- <command>`;

export type VmSub = "list" | "up" | "down" | "reset" | "shot" | "exec";
export interface VmArgs {
	sub: VmSub;
	name?: string;
	cold: boolean;
	force: boolean;
	json: boolean;
	out?: string;
	cmd?: string;
}

const SUBS: Record<VmSub, string[]> = {
	list: ["--json"],
	up: ["--cold", "--force", "--json"],
	down: ["--json"],
	reset: ["--json"],
	shot: ["--out"],
	exec: [],
};

/** Parse `vm` arguments strictly. Returns the parsed form or the problem to print. */
export function parseVmArgs(args: string[]): VmArgs | string {
	const [sub, ...rest] = args;
	if (!sub || !(sub in SUBS)) return sub ? `Unknown vm command "${sub}".` : "vm needs a command.";
	const out: VmArgs = { sub: sub as VmSub, cold: false, force: false, json: false };
	const dash = rest.indexOf("--");
	const own = dash >= 0 ? rest.slice(0, dash) : rest;
	const tail = dash >= 0 ? rest.slice(dash + 1) : [];
	const positional: string[] = [];
	for (let i = 0; i < own.length; i++) {
		const arg = own[i];
		if (!arg.startsWith("-") || out.sub === "exec") {
			positional.push(arg);
			continue;
		}
		const flag = arg.split("=")[0];
		if (!SUBS[out.sub].includes(flag)) return `vm ${out.sub} takes no option "${flag}".`;
		if (flag === "--out") {
			const value = arg.includes("=") ? arg.slice(6) : own[++i];
			if (!value || value.startsWith("-")) return "--out needs a file name.";
			out.out = value;
		} else if (arg.includes("=")) return `${flag} takes no value.`;
		else if (flag === "--cold") out.cold = true;
		else if (flag === "--force") out.force = true;
		else if (flag === "--json") out.json = true;
	}
	if (out.sub === "list") {
		if (positional.length) return `vm list takes no name.`;
		return out;
	}
	const [name, ...extra] = positional;
	if (!name) return `vm ${out.sub} needs a guest name, for example linux.`;
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return `"${name}" is not a guest name: use lowercase letters, digits and dashes, starting with a letter, up to 32.`;
	out.name = name;
	if (out.sub === "exec") {
		const words = [...extra, ...tail];
		if (!words.length) return "vm exec needs a command after the name, for example: vm exec linux -- uname -a";
		out.cmd = words.join(" ");
	} else if (extra.length || tail.length) return `Unexpected argument "${extra[0] ?? tail[0]}".`;
	return out;
}

/** What the gate reads from the host. */
export interface HostSnapshot {
	/** undefined where there is no battery to ask about. */
	onAC: boolean | undefined;
	availableRam: number;
	freeDisk: number;
	load1: number;
	cpus: number;
}

/** `pmset -g batt`: true on AC, false on battery, undefined if it doesn't say. */
export function parsePmset(text: string): boolean | undefined {
	if (/drawing from 'AC Power'/.test(text)) return true;
	if (/drawing from 'Battery Power'/.test(text)) return false;
	return undefined;
}

/** `vm_stat`: memory the system can hand out now (free, inactive and speculative pages). */
export function parseVmStat(text: string): number {
	const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 0);
	const pages = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
	return (pages("free") + pages("inactive") + pages("speculative")) * pageSize;
}

const gib = (bytes: number) => `${(bytes / GiB).toFixed(1)} GB`;

/**
 * The resource gate before `up`. Disk and RAM refuse always: a full disk corrupts the guest and a
 * guest without RAM swaps the host. Battery and load refuse unless --force.
 */
export function gateProblems(host: HostSnapshot, memoryBytes: number, force: boolean): string[] {
	const problems: string[] = [];
	if (host.freeDisk < MIN_FREE_DISK) problems.push(`only ${gib(host.freeDisk)} free on disk; a guest needs at least ${gib(MIN_FREE_DISK)}`);
	if (host.availableRam < memoryBytes + RAM_HEADROOM)
		problems.push(`only ${gib(host.availableRam)} of RAM available; the guest needs ${gib(memoryBytes)} plus ${gib(RAM_HEADROOM)} for the host`);
	if (!force && host.onAC === false) problems.push("this Mac is on battery; plug it in, or pass --force");
	if (!force && host.load1 > host.cpus) problems.push(`load is ${host.load1.toFixed(1)} on ${host.cpus} cores; wait for it to drop, or pass --force`);
	return problems;
}

export function vmRoot(): string {
	return envVar("VM_DIR") || join(releaseBase(), "vm");
}

function hostSnapshot(dir: string): HostSnapshot {
	const fs = statfsSync(dir);
	return {
		onAC: parsePmset(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" })),
		availableRam: parseVmStat(execFileSync("vm_stat", { encoding: "utf8" })),
		freeDisk: fs.bavail * fs.bsize,
		load1: loadavg()[0],
		cpus: cpus().length,
	};
}

/** The signed helper. TYCHICUS_VM_HELPER names one; otherwise a checkout builds and installs it. */
export function helperPath(log: (line: string) => void): string {
	const named = envVar("VM_HELPER");
	if (named) return named;
	const installed = join(vmRoot(), "bin", "tychicus-vm");
	const version = () => {
		try {
			return execFileSync(installed, ["version"], { encoding: "utf8" }).trim();
		} catch {
			return "";
		}
	};
	if (existsSync(installed) && version() === HELPER_VERSION) return installed;
	const build = join(repoRoot(), "vm", "mac", "build.sh");
	if (!existsSync(build)) throw new Error(`tychicus-vm ${HELPER_VERSION} is not installed at ${installed}, and this install has no vm/mac sources to build it.`);
	log("Building tychicus-vm (Swift, once per helper version)...");
	const built = execFileSync(build, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").pop() ?? "";
	mkdirSync(join(vmRoot(), "bin"), { recursive: true });
	copyFileSync(built, `${installed}.tmp`);
	chmodSync(`${installed}.tmp`, 0o755);
	renameSync(`${installed}.tmp`, installed);
	if (version() !== HELPER_VERSION) throw new Error(`the built helper does not report version ${HELPER_VERSION}`);
	return installed;
}

/** Write `src` to `out`, leaving holes for all-zero 64 KiB blocks, so the 3 GB image takes about 1 GB on disk. */
export async function writeSparse(src: Readable, out: string): Promise<number> {
	const BLOCK = 64 * 1024;
	const zero = Buffer.alloc(BLOCK);
	const block = Buffer.alloc(BLOCK);
	const fd = openSync(out, "w", 0o644);
	let fill = 0;
	let offset = 0;
	let end = 0;
	const flush = (length: number) => {
		if (!block.subarray(0, length).equals(zero.subarray(0, length))) {
			// APFS fills a gap a write skips over with zeros; a file grown by ftruncate keeps it a hole.
			if (offset > end) ftruncateSync(fd, offset);
			writeSync(fd, block, 0, length, offset);
			end = offset + length;
		}
		offset += length;
	};
	try {
		for await (const chunk of src as AsyncIterable<Buffer>) {
			let at = 0;
			while (at < chunk.length) {
				const n = Math.min(BLOCK - fill, chunk.length - at);
				chunk.copy(block, fill, at, at + n);
				fill += n;
				at += n;
				if (fill === BLOCK) {
					flush(BLOCK);
					fill = 0;
				}
			}
		}
		if (fill) flush(fill);
		ftruncateSync(fd, offset);
	} finally {
		closeSync(fd);
	}
	return offset;
}

/** Download the pinned image, check its SHA-512, and keep it read-only under base/. */
async function ensureBase(log: (line: string) => void): Promise<string> {
	const base = join(vmRoot(), "base", IMAGE.file);
	if (existsSync(base)) return base;
	mkdirSync(join(vmRoot(), "base"), { recursive: true });
	const work = mkdtempSync(join(vmRoot(), "download-"));
	try {
		const archive = join(work, "image.tar.xz");
		log(`Downloading the Debian 13 arm64 cloud image (about 210 MB) from cloud.debian.org...`);
		const res = await fetch(IMAGE.url);
		if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${IMAGE.url}`);
		const hash = createHash("sha512");
		const hasher = new Transform({
			transform(chunk, _enc, done) {
				hash.update(chunk);
				done(null, chunk);
			},
		});
		await pipeline(Readable.fromWeb(res.body as WebReadableStream), hasher, createWriteStream(archive));
		const got = hash.digest("hex");
		if (got !== IMAGE.sha512) throw new Error(`the image's SHA-512 is ${got}, expected ${IMAGE.sha512}; refusing it`);
		const tar = spawn("tar", ["-xOf", archive, IMAGE.member], { stdio: ["ignore", "pipe", "inherit"] });
		const exited = new Promise<number>((done) => tar.on("close", (code) => done(code ?? 1)));
		const raw = join(work, "disk.raw");
		await writeSparse(tar.stdout, raw);
		if ((await exited) !== 0) throw new Error("tar could not extract the image");
		chmodSync(raw, 0o444);
		renameSync(raw, base);
		return base;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** The guest agent cloud-init installs: one JSON command per vsock connection on port 1024, run as root. */
const AGENT = `#!/usr/bin/python3
# Tychicus guest agent: one JSON command per vsock connection on port 1024.
import json, socket, subprocess, threading
def serve(conn):
    with conn:
        try:
            req = json.loads(conn.makefile("rb").readline())
            p = subprocess.run(req["cmd"], shell=True, capture_output=True, timeout=float(req.get("timeout", 60)))
            out = {"code": p.returncode, "stdout": p.stdout.decode(errors="replace"), "stderr": p.stderr.decode(errors="replace")}
        except subprocess.TimeoutExpired:
            out = {"code": 124, "stdout": "", "stderr": "timed out"}
        except Exception as e:
            out = {"code": 125, "stdout": "", "stderr": str(e)}
        conn.sendall(json.dumps(out).encode() + b"\\n")
s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
s.bind((socket.VMADDR_CID_ANY, 1024))
s.listen(16)
while True:
    c, _ = s.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
`;

const indent = (text: string, by: string) =>
	text
		.split("\n")
		.map((line) => (line ? by + line : line))
		.join("\n");

/** NoCloud user-data: no users, no SSH, the agent, and a kernel console on hvc0 from the second boot. */
export function userData(name: string): string {
	return `#cloud-config
hostname: ${name}
users: []
ssh_pwauth: false
disable_root: true
write_files:
  - path: /usr/local/sbin/tychicus-agent
    permissions: "0755"
    content: |
${indent(AGENT, "      ")}
  - path: /etc/systemd/system/tychicus-agent.service
    content: |
      [Unit]
      Description=Tychicus guest agent on vsock port 1024
      DefaultDependencies=no
      After=local-fs.target
      [Service]
      ExecStart=/usr/local/sbin/tychicus-agent
      Restart=always
      [Install]
      WantedBy=sysinit.target
  - path: /etc/default/grub.d/90-tychicus.cfg
    content: |
      GRUB_TIMEOUT=0
      GRUB_CMDLINE_LINUX_DEFAULT="console=hvc0 console=tty0"
runcmd:
  - [systemctl, disable, --now, ssh.service, ssh.socket]
  - [update-grub]
  - [systemctl, enable, --now, tychicus-agent.service]
`;
}

/** A new guest: an APFS clone of the base grown to GUEST.diskGiB, the seed ISO and machine.json. */
async function ensureGuest(name: string, log: (line: string) => void): Promise<string> {
	const dir = join(vmRoot(), "guests", name);
	if (existsSync(join(dir, "disk.raw")) || existsSync(join(dir, "ready.raw"))) return dir;
	const base = await ensureBase(log);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const disk = join(dir, "disk.raw");
	execFileSync("cp", ["-c", base, `${disk}.tmp`]);
	chmodSync(`${disk}.tmp`, 0o600);
	execFileSync("truncate", ["-s", `${GUEST.diskGiB}g`, `${disk}.tmp`]);
	const seed = mkdtempSync(join(tmpdir(), "tychicus-seed-"));
	try {
		writeFileSync(join(seed, "user-data"), userData(name));
		writeFileSync(join(seed, "meta-data"), `instance-id: tychicus-${name}\nlocal-hostname: ${name}\n`);
		rmSync(join(dir, "seed.iso"), { force: true });
		execFileSync("hdiutil", ["makehybrid", "-quiet", "-iso", "-joliet", "-default-volume-name", "cidata", "-o", join(dir, "seed.iso"), seed]);
	} finally {
		rmSync(seed, { recursive: true, force: true });
	}
	const { cpus: c, memoryMiB, width, height } = GUEST;
	writeFileSync(join(dir, "machine.json"), `${JSON.stringify({ cpus: c, memoryMiB, width, height })}\n`);
	renameSync(`${disk}.tmp`, disk);
	return dir;
}

export interface Status {
	ok: boolean;
	state?: string;
	boot?: string;
	error?: string;
	notes?: string[];
	timings?: Record<string, number>;
	[key: string]: unknown;
}

/** One request on a guest's control socket. */
export function request(dir: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<Status> {
	return new Promise((done, fail) => {
		const socket = createConnection(join(dir, "control.sock"));
		let data = "";
		const timer = setTimeout(() => {
			socket.destroy();
			fail(new Error(`the helper did not answer ${String(body.op)} within ${timeoutMs / 1000} s`));
		}, timeoutMs);
		socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
		socket.on("data", (chunk) => {
			data += chunk;
			const nl = data.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			socket.end();
			try {
				done(JSON.parse(data.slice(0, nl)) as Status);
			} catch (err) {
				fail(err);
			}
		});
		socket.on("error", (err) => {
			clearTimeout(timer);
			fail(err);
		});
	});
}

/** The guest's status, or undefined when no helper answers. */
async function running(dir: string): Promise<Status | undefined> {
	if (!existsSync(join(dir, "control.sock"))) return undefined;
	try {
		return await request(dir, { op: "status" }, 2000);
	} catch {
		return undefined;
	}
}

const seconds = (ms: number | undefined) => (ms === undefined ? "?" : `${(ms / 1000).toFixed(2)} s`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function bootLine(name: string, status: Status, wallMs: number): string {
	const how =
		status.boot === "session"
			? "resumed the session `down` saved"
			: status.boot === "ready"
				? "restored its ready point"
				: "cold boot";
	const capture = status.timings?.captureMs !== undefined ? `; saved the ready point in ${seconds(status.timings.captureMs)}` : "";
	return `${name} is up: ${how} in ${seconds(wallMs)}${capture}.`;
}

/** Run `tychicus vm ...`. Returns the exit code. */
export async function runVm(args: VmArgs, out: { log: (line: string) => void; err: (line: string) => void }): Promise<number> {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		out.err(`${COMMAND_NAME} vm runs on Apple silicon Macs for now.`);
		return 1;
	}
	const root = vmRoot();
	mkdirSync(root, { recursive: true });
	if (args.sub === "list") {
		const guests = existsSync(join(root, "guests")) ? readdirSync(join(root, "guests")).sort() : [];
		const rows = [];
		for (const name of guests) {
			const dir = join(root, "guests", name);
			const status = await running(dir);
			rows.push({
				name,
				state: status?.state ?? "down",
				boot: status?.boot,
				session: existsSync(join(dir, "session.vzvmsave")),
				readyPoint: existsSync(join(dir, "ready.vzvmsave")),
			});
		}
		if (args.json) out.log(JSON.stringify(rows));
		else if (!rows.length) out.log(`No guests yet. Start one with \`${COMMAND_NAME} vm up linux\`.`);
		else
			for (const row of rows)
				out.log(`${row.name}  ${row.state}${row.session ? "  (saved session)" : ""}${row.readyPoint ? "" : "  (no ready point yet)"}`);
		return 0;
	}
	const name = args.name!;
	const dir = join(root, "guests", name);
	const current = await running(dir);
	const report = (status: Status, line: string) => out.log(args.json ? JSON.stringify(status) : line);

	if (args.sub === "up") {
		if (current) {
			report(current, `${name} is already ${current.state}.`);
			return 0;
		}
		const problems = gateProblems(hostSnapshot(root), GUEST.memoryMiB * 1024 * 1024, args.force);
		if (problems.length) {
			for (const problem of problems) out.err(`Not starting ${name}: ${problem}.`);
			return 1;
		}
		const helper = helperPath(out.err);
		await ensureGuest(name, out.err);
		const t0 = performance.now();
		const logFd = openSync(join(dir, "helper.log"), "w", 0o600);
		const child = spawn(helper, ["serve", dir, ...(args.cold ? ["--cold"] : [])], { detached: true, stdio: ["ignore", logFd, logFd] });
		closeSync(logFd);
		let exited: number | null | undefined;
		child.on("exit", (code) => {
			exited = code;
		});
		child.unref();
		const deadline = Date.now() + 300_000;
		while (Date.now() < deadline) {
			const status = await running(dir);
			if (status?.state === "running") {
				report(status, bootLine(name, status, performance.now() - t0));
				for (const note of status.notes ?? []) out.err(note);
				return 0;
			}
			if (status?.state === "failed" || exited !== undefined) {
				out.err(`${name} did not start: ${status?.error ?? `the helper exited (${exited}); see ${join(dir, "helper.log")}`}`);
				return 1;
			}
			await sleep(20);
		}
		out.err(`${name} did not become ready in 300 s; see ${join(dir, "helper.log")} and ${join(dir, "console.log")}.`);
		return 1;
	}

	if (args.sub === "reset" && !current) {
		if (!existsSync(join(dir, "ready.raw"))) {
			out.err(`${name} has no ready point yet: run \`${COMMAND_NAME} vm up ${name}\` once.`);
			return 1;
		}
		rmSync(join(dir, "session.vzvmsave"), { force: true });
		report({ ok: true, state: "down" }, `${name} is down; its next \`up\` starts from the ready point.`);
		return 0;
	}
	if (!current) {
		out.err(`${name} is not running.${args.sub === "down" ? "" : ` Start it with \`${COMMAND_NAME} vm up ${name}\`.`}`);
		return args.sub === "down" ? 0 : 1;
	}

	if (args.sub === "down") {
		const status = await request(dir, { op: "down" }, 120_000);
		if (!status.ok) throw new Error(status.error ?? "down failed");
		for (let i = 0; i < 100 && existsSync(join(dir, "control.sock")); i++) await sleep(20);
		report(status, `${name} is down; saved its session in ${seconds(status.downMs as number)}.`);
		return 0;
	}
	if (args.sub === "reset") {
		const t0 = performance.now();
		const status = await request(dir, { op: "reset" }, 300_000);
		if (!status.ok) throw new Error(status.error ?? "reset failed");
		report(status, `${name} is back at its ready point in ${seconds(performance.now() - t0)}.`);
		for (const note of status.notes ?? []) out.err(note);
		return 0;
	}
	if (args.sub === "shot") {
		const path = resolve(args.out ?? `${name}-${Date.now()}.png`);
		const status = await request(dir, { op: "shot", path }, 60_000);
		if (!status.ok) {
			out.err(`No screenshot: ${status.error}.`);
			return 1;
		}
		out.log(`Saved ${path} (${status.width}x${status.height}).`);
		return 0;
	}
	// exec
	const status = await request(dir, { op: "exec", cmd: args.cmd, timeout: 600 }, 610_000);
	if (!status.ok) throw new Error(status.error ?? "exec failed");
	process.stdout.write(String(status.stdout ?? ""));
	process.stderr.write(String(status.stderr ?? ""));
	return Number(status.code ?? 1);
}
