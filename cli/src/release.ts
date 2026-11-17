/**
 * `tychicus install --release <folder>`: install from a downloaded GitHub release. Every artifact in the folder is
 * checked against the release's SHA256SUMS, and against its build provenance attestation when the GitHub CLI is on
 * PATH (`gh attestation verify`), before anything is unpacked; one mismatch refuses the whole install. Then the
 * archive for this computer is unpacked into one fixed folder (releaseRoot()), so the host manifests and the unpacked
 * extension keep their paths across upgrades, and the unpacked `tychicus install` registers itself.
 *
 * The check is as strong as the program that runs it: a tampered archive could carry a `tychicus` that skips it. To
 * check before running anything from the download, run
 * `gh attestation verify <archive> --repo baney75/tychicus --signer-workflow baney75/tychicus/.github/workflows/release.yml`
 * first, or run this from a copy already installed (an upgrade does exactly that).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { browserDirs } from "./install.ts";
import { eukheSettingsPath, localStudioPluginsDir, PLUGINS } from "./local-studio.ts";
import { NATIVE_HOST_NAMES } from "../../src/bridge/protocol.ts";
import { c, sym } from "./ui.ts";

/** Where the releases are built and attested. */
export const RELEASE_REPO = "baney75/tychicus";
/** The workflow that builds and attests releases; gh refuses an artifact any other workflow signed. */
export const RELEASE_WORKFLOW = `${RELEASE_REPO}/.github/workflows/release.yml`;

/** A release refused: a missing or wrong checksum, a failed attestation, or no archive for this computer. */
export class ReleaseRefused extends Error {}

/** This computer's archive tag, as the release names it: linux-x64, darwin-arm64, win-x64. */
export function platformTag(platform: string = process.platform, arch: string = process.arch): string {
	return `${platform === "win32" ? "win" : platform}-${arch}`;
}

/** The one folder a release is unpacked into: the `tychicus` program, `extension/` and `plugins/`. */
export function releaseRoot(): string {
	if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Tychicus", "release");
	return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "tychicus", "release");
}

/** The release's program inside releaseRoot(). */
export function releaseProgram(root: string = releaseRoot()): string {
	return join(root, process.platform === "win32" ? "tychicus.exe" : "tychicus");
}

/** SHA256SUMS lines (`<hex>  <name>`, or `<hex> *<name>` in binary mode) as name -> hex. */
export function parseSums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^([0-9a-f]{64}) [ *](.+)$/i);
		if (m) sums.set(m[2], m[1].toLowerCase());
	}
	return sums;
}

export function sha256File(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The GitHub CLI to check attestations with: TYCHICUS_GH (a path, or "none" for no gh), else `gh` on PATH. */
export function findGh(): string | undefined {
	const chosen = process.env.TYCHICUS_GH;
	if (chosen !== undefined && chosen !== "") return chosen === "none" ? undefined : chosen;
	const names = process.platform === "win32" ? ["gh.exe", "gh.cmd"] : ["gh"];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
	}
	return undefined;
}

export interface ReleaseCheck {
	/** The archive for this computer, its version and checksum. */
	archive: string;
	version: string;
	sha256: string;
	/** Every artifact the checksums covered. */
	checked: string[];
	/** How the attestations went: checked by gh, skipped on request, or not checked because gh isn't here. */
	attestation: "verified" | "skipped" | "no-gh";
}

/**
 * Check a downloaded release folder. Throws ReleaseRefused on the first problem; writes nothing. Every `tychicus-*`
 * file (not folder) in the folder must be listed in SHA256SUMS and match it, so a stray or swapped file is refused too.
 */
export function verifyRelease(dir: string, options: { skipAttestation?: boolean; log?: (line: string) => void } = {}): ReleaseCheck {
	const log = options.log ?? (() => {});
	const sumsFile = join(dir, "SHA256SUMS");
	if (!existsSync(sumsFile)) throw new ReleaseRefused(`No SHA256SUMS in ${dir}. Download it with the release; without it nothing here can be checked.`);
	const sums = parseSums(readFileSync(sumsFile, "utf8"));
	// Files only: unpacking the archive in the download folder, as README.md says to, leaves its folder beside it.
	const artifacts = readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.startsWith("tychicus-"))
		.map((e) => e.name)
		.sort();
	const tag = platformTag();
	const pattern = new RegExp(`^tychicus-(\\d+\\.\\d+\\.\\d+)-${tag}\\.(tar\\.gz|zip)$`);
	const archives = artifacts.filter((f) => pattern.test(f));
	if (archives.length !== 1)
		throw new ReleaseRefused(
			archives.length === 0
				? `No tychicus-<version>-${tag} archive in ${dir}. Download the one for this computer from https://github.com/${RELEASE_REPO}/releases.`
				: `More than one archive for this computer in ${dir}: ${archives.join(", ")}. Keep one release per folder.`,
		);
	const archive = archives[0];
	let archiveSha = "";
	for (const file of artifacts) {
		const want = sums.get(file);
		if (!want) throw new ReleaseRefused(`${file} is not listed in SHA256SUMS. It is not part of this release; remove it or download the release again.`);
		const got = sha256File(join(dir, file));
		if (got !== want) throw new ReleaseRefused(`The SHA-256 of ${file} does not match SHA256SUMS (got ${got}, want ${want}). The download is damaged or was changed; download it again.`);
		if (file === archive) archiveSha = got;
		log(`${file} matches SHA256SUMS`);
	}
	let attestation: ReleaseCheck["attestation"];
	const gh = findGh();
	if (options.skipAttestation) {
		attestation = "skipped";
		log("Attestations not checked (--skip-attestation): SHA256SUMS only.");
	} else if (!gh) {
		attestation = "no-gh";
		log(`gh is not on PATH, so the build attestations were not checked: SHA256SUMS only. With the GitHub CLI installed, this also runs gh attestation verify --repo ${RELEASE_REPO}.`);
	} else {
		for (const file of artifacts) {
			const r = spawnSync(gh, ["attestation", "verify", join(dir, file), "--repo", RELEASE_REPO, "--signer-workflow", RELEASE_WORKFLOW], { encoding: "utf8" });
			if (r.status !== 0) {
				const why = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" ");
				throw new ReleaseRefused(`gh attestation verify refused ${file}: ${why || `exit ${r.status ?? r.signal}`}. It was not built by ${RELEASE_REPO}'s release workflow; nothing was installed.`);
			}
			log(`${file}: build attestation verified (${RELEASE_REPO})`);
		}
		attestation = "verified";
	}
	const version = archive.match(pattern)?.[1] ?? "";
	return { archive, version, sha256: archiveSha, checked: artifacts, attestation };
}

const MARKER = ".release-sha256";

/** True when releaseRoot() already holds this exact archive. */
export function releaseCurrent(sha: string, root: string = releaseRoot()): boolean {
	try {
		return readFileSync(join(root, MARKER), "utf8").trim() === sha && existsSync(releaseProgram(root));
	} catch {
		return false;
	}
}

/**
 * Unpack the checked archive into `root`, replacing what was there in one rename. Every entry must sit under the
 * archive's one top folder, with no `..` and no absolute path.
 */
export function unpackRelease(archivePath: string, sha: string, root: string = releaseRoot()): void {
	const zip = archivePath.endsWith(".zip");
	const listing = execFileSync("tar", [zip ? "-tf" : "-tzf", archivePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split(/\r?\n/)
		.filter(Boolean);
	const top = listing[0]?.split("/")[0];
	if (!top || listing.some((p) => p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes("..") || p.split("/")[0] !== top))
		throw new ReleaseRefused(`${archivePath} is not laid out as one release folder; nothing was installed.`);
	const parent = dirname(root);
	mkdirSync(parent, { recursive: true });
	const staging = join(parent, `.unpack-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging);
	try {
		execFileSync("tar", [zip ? "-xf" : "-xzf", archivePath, "-C", staging], { stdio: ["ignore", "ignore", "pipe"] });
		const unpacked = join(staging, top);
		writeFileSync(join(unpacked, MARKER), `${sha}\n`);
		const old = join(parent, `.old-${process.pid}`);
		if (existsSync(root)) renameSync(root, old);
		renameSync(unpacked, root);
		rmSync(old, { recursive: true, force: true });
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/** How to load the unpacked extension, printed after an install. */
export function loadSteps(extensionDir: string): string[] {
	return [
		"Load the extension once in each browser you use:",
		"  Open chrome://extensions (brave://extensions, edge://extensions), turn on Developer mode, choose Load unpacked, and pick",
		`  ${extensionDir}`,
		"Its id stays the same, so the host manifests above already allow it. A Chrome Web Store listing comes later.",
	];
}

/** Flags `install --release` hands to the unpacked program's own `install`. */
const PASSED_ON = new Set(["--force", "--local-studio", "--browser"]);

/**
 * Check, unpack and register a downloaded release. Returns the exit code. A dry run checks the release, then lists
 * what an install would write; it unpacks and writes nothing.
 */
export async function installFromRelease(dir: string, options: { dryRun?: boolean; skipAttestation?: boolean; passOn?: string[] }): Promise<number> {
	let check: ReleaseCheck;
	try {
		check = verifyRelease(dir, { skipAttestation: options.skipAttestation, log: (line) => console.log(`${sym.ok} ${line}`) });
	} catch (err) {
		if (!(err instanceof ReleaseRefused)) throw err;
		console.log(`${sym.fail} ${err.message}`);
		return 1;
	}
	const root = releaseRoot();
	const program = releaseProgram(root);
	const args = ["install"];
	const given = options.passOn ?? [];
	for (let i = 0; i < given.length; i++) {
		const name = given[i].split("=")[0];
		if (!PASSED_ON.has(name)) continue;
		args.push(given[i]);
		if (name === "--browser" && !given[i].includes("=") && given[i + 1] !== undefined) args.push(given[++i]);
	}
	if (options.dryRun) {
		const current = releaseCurrent(check.sha256, root);
		console.log(`${sym.ok} ${current ? "Current" : "Would unpack"} ${c.dim(`${check.archive} -> ${root}`)}`);
		console.log(`${sym.ok} Would run ${c.dim(`${program} ${args.join(" ")}`)}, which writes:`);
		for (const { dir: browserDir } of browserDirs()) {
			if (!existsSync(browserDir)) continue;
			for (const host of NATIVE_HOST_NAMES) console.log(`  ${join(browserDir, "NativeMessagingHosts", `${host}.json`)}`);
		}
		if (args.includes("--local-studio")) {
			for (const id of Object.keys(PLUGINS)) console.log(`  ${join(localStudioPluginsDir(), id)}`);
			console.log(`  ${eukheSettingsPath()} (mcpServers.tychicus)`);
		}
		return 0;
	}
	if (releaseCurrent(check.sha256, root)) console.log(`${sym.ok} ${check.archive} is already installed in ${c.dim(root)}`);
	else {
		try {
			unpackRelease(join(dir, check.archive), check.sha256, root);
		} catch (err) {
			console.log(`${sym.fail} ${(err as Error).message}`);
			return 1;
		}
		console.log(`${sym.ok} Unpacked ${check.archive} into ${c.dim(root)}`);
	}
	const r = spawnSync(program, args, { stdio: "inherit", env: { ...process.env, TYCHICUS_RELEASE_PARENT: "1" } });
	if (r.status !== 0) {
		console.log(`${sym.fail} ${program} ${args.join(" ")} failed (${r.status ?? r.signal ?? r.error?.message}).`);
		return 1;
	}
	for (const line of loadSteps(join(root, "extension"))) console.log(line);
	return 0;
}
