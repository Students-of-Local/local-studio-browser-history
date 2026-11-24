// `tychicus install` from a downloaded release, against a throwaway HOME: the release is checked against SHA256SUMS
// and, when gh is there, its attestations, before anything is unpacked; a tampered artifact is refused and nothing
// is written. The host manifests it writes name only Tychicus's host and allow only the one pinned extension id,
// and a second run changes nothing. `--local-studio` adds the plugins and Eukhe's mcpServers entry.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const repo = join(here, "..", "..");
const EXTENSION_ID = JSON.parse(readFileSync(join(repo, "src", "bridge", "extension-id.json"), "utf8")).id;
const HOST = "com.tychicus.browser";
const scratch = mkdtempSync(join(tmpdir(), "tychicus-release-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const tag = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;

let n = 0;
/** A fresh HOME with a Chromium profile folder, as on a machine where Chromium was opened once. */
function freshHome() {
	const home = join(scratch, `home-${++n}`);
	mkdirSync(join(home, ".config", "chromium"), { recursive: true });
	mkdirSync(join(home, "sock"), { mode: 0o700 });
	return home;
}

function run(home, args, extra = {}) {
	const env = { ...process.env, HOME: home, TABKYRA_SOCKET_DIR: join(home, "sock"), TYCHICUS_GH: "none", ...extra };
	for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "EUKHE_CODING_AGENT_DIR", "LOCAL_STUDIO_DATA_DIR", "POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR"]) {
		if (!(k in extra)) delete env[k];
	}
	const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * A release folder as a user downloads it: the platform archive (a stand-in `tychicus` that records how it was run,
 * the extension and the plugins) and SHA256SUMS. `hands` is the Mac computer-use helper's bytes, put in bin/ as a release does.
 */
function makeRelease(version = "9.9.9", program = `#!/bin/sh\necho "$@" > "$(dirname "$0")/ran-with"\n`, { hands } = {}) {
	const dir = join(scratch, `release-${++n}`);
	const top = `tychicus-${version}-${tag}`;
	const stage = join(dir, "stage", top);
	mkdirSync(join(stage, "extension"), { recursive: true });
	writeFileSync(join(stage, "extension", "manifest.json"), JSON.stringify({ name: "Tychicus", version }));
	writeFileSync(join(stage, "tychicus"), program);
	chmodSync(join(stage, "tychicus"), 0o755);
	if (hands !== undefined) {
		mkdirSync(join(stage, "bin"));
		writeFileSync(join(stage, "bin", "tychicus-hands"), hands);
		chmodSync(join(stage, "bin", "tychicus-hands"), 0o755);
	}
	const archive = `${top}.tar.gz`;
	const tar = spawnSync("tar", ["-czf", join(dir, archive), "-C", join(dir, "stage"), top]);
	assert.equal(tar.status, 0, String(tar.stderr));
	rmSync(join(dir, "stage"), { recursive: true });
	writeFileSync(join(dir, `tychicus-${version}-extension.zip`), "zip bytes");
	writeFileSync(
		join(dir, "SHA256SUMS"),
		readdirSync(dir)
			.map((f) => `${sha256(join(dir, f))}  ${f}\n`)
			.join(""),
	);
	return { dir, archive, top };
}

const releaseRoot = (home) => join(home, ".local", "share", "tychicus", "release");

test("a clean release verifies, unpacks into the install folder and runs the unpacked tychicus install", { skip: process.platform === "win32" }, () => {
	const home = freshHome();
	const { dir } = makeRelease();
	const r = run(home, ["install", "--release", dir]);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /SHA256SUMS/);
	assert.match(r.out, /gh is not on PATH|attestation/i);
	assert.ok(existsSync(join(releaseRoot(home), "extension", "manifest.json")), r.out);
	assert.equal(readFileSync(join(releaseRoot(home), "ran-with"), "utf8").trim(), "install");
	// How to load the extension: the unpacked folder's path.
	// The browser loads the extension from a fixed real folder: Chrome stores the path a symlink resolves to.
	const extension = join(home, ".local", "share", "tychicus", "extension");
	assert.ok(r.out.includes(extension), r.out);
	assert.ok(lstatSync(extension).isDirectory() && !lstatSync(extension).isSymbolicLink());
	assert.equal(JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8")).version, "9.9.9");
});

test("a second run of the same release unpacks nothing again", { skip: process.platform === "win32" }, () => {
	const home = freshHome();
	const { dir } = makeRelease();
	assert.equal(run(home, ["install", "--release", dir]).status, 0);
	writeFileSync(join(releaseRoot(home), "sentinel"), "kept");
	const again = run(home, ["install", "--release", dir]);
	assert.equal(again.status, 0, again.out);
	assert.ok(existsSync(join(releaseRoot(home), "sentinel")), "the second run re-extracted the release");
	assert.match(again.out, /already installed|Current/i);
});

// A stand-in for tychicus-hands: answers initialize as the Mac helper does, so doctor can name it.
const fakeHands = (version) => `#!/usr/bin/env node
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "tychicus-hands", version: "${version}" } } }) + "\\n");
});
`;
const handsPath = (home) => join(home, ".local", "bin", "tychicus-hands");
const noHelperEnv = { TYCHICUS_HANDS_BIN: "", POLYCARP_SPACES_BIN: "", PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };

test("on a Mac, install puts the release's tychicus-hands in ~/.local/bin, says to re-allow it, and doctor names it", { skip: process.platform !== "darwin" }, () => {
	const home = freshHome();
	const { dir } = makeRelease("9.9.9", undefined, { hands: fakeHands("1.0.0") });
	const r = run(home, ["install", "--release", dir], noHelperEnv);
	assert.equal(r.status, 0, r.out);
	const installed = handsPath(home);
	assert.equal(readFileSync(installed, "utf8"), fakeHands("1.0.0"), "the same bytes as the archive's bin/tychicus-hands");
	assert.ok(lstatSync(installed).isFile() && !lstatSync(installed).isSymbolicLink(), "a copy at one fixed path, not a link into versions/");
	assert.equal(statSync(installed).mode & 0o111, 0o111, "executable");
	assert.ok(r.out.includes(`Computer-use helper ${installed}`), r.out);
	assert.match(r.out, /Privacy & Security > Accessibility/);
	assert.match(r.out, /signed ad hoc/);
	const doctor = spawnSync(process.execPath, [cli, "doctor", "--json"], {
		env: { ...process.env, HOME: home, TABKYRA_SOCKET_DIR: join(home, "sock"), TYCHICUS_GH: "none", ...noHelperEnv },
		encoding: "utf8",
		timeout: 60_000,
	});
	const computer = JSON.parse(doctor.stdout).checks.find((c) => c.id === "computer");
	assert.equal(computer.status, "ok", JSON.stringify(computer));
	assert.ok(computer.label.includes(`tychicus-hands (${installed})`), computer.label);
	assert.match(computer.label, /answered as tychicus-hands 1\.0\.0/);
});

test("on a Mac, the same helper again is left alone, and a new one replaces it", { skip: process.platform !== "darwin" }, () => {
	const home = freshHome();
	const first = makeRelease("9.9.9", undefined, { hands: fakeHands("1.0.0") });
	assert.equal(run(home, ["install", "--release", first.dir], noHelperEnv).status, 0);
	const before = statSync(handsPath(home)).ino;
	const again = run(home, ["install", "--release", first.dir], noHelperEnv);
	assert.equal(again.status, 0, again.out);
	assert.match(again.out, /is already this version/);
	assert.doesNotMatch(again.out, /signed ad hoc/, "no re-allow note when nothing changed");
	assert.equal(statSync(handsPath(home)).ino, before, "the same file: macOS keeps its grant");
	const next = makeRelease("9.9.10", undefined, { hands: fakeHands("1.0.1") });
	const upgraded = run(home, ["install", "--release", next.dir], noHelperEnv);
	assert.equal(upgraded.status, 0, upgraded.out);
	assert.equal(readFileSync(handsPath(home), "utf8"), fakeHands("1.0.1"));
	assert.match(upgraded.out, /signed ad hoc/);
});

test("off a Mac, a release's tychicus-hands is not put in ~/.local/bin", { skip: process.platform === "darwin" || process.platform === "win32" }, () => {
	const home = freshHome();
	const { dir } = makeRelease("9.9.9", undefined, { hands: fakeHands("1.0.0") });
	const r = run(home, ["install", "--release", dir], noHelperEnv);
	assert.equal(r.status, 0, r.out);
	assert.ok(!existsSync(handsPath(home)), r.out);
});

for (const [name, tamper, why] of [
	["a changed byte in the archive", (rel) => {
		const file = join(rel.dir, rel.archive);
		const bytes = readFileSync(file);
		bytes[bytes.length - 5] ^= 0xff;
		writeFileSync(file, bytes);
	}, /mismatch|does not match/i],
	["a missing SHA256SUMS", (rel) => rmSync(join(rel.dir, "SHA256SUMS")), /SHA256SUMS/],
	["an archive SHA256SUMS does not list", (rel) => {
		const sums = readFileSync(join(rel.dir, "SHA256SUMS"), "utf8").split("\n").filter((l) => !l.includes(rel.archive));
		writeFileSync(join(rel.dir, "SHA256SUMS"), sums.join("\n"));
	}, /not listed|SHA256SUMS/],
	["a changed extension zip", (rel) => writeFileSync(join(rel.dir, "tychicus-9.9.9-extension.zip"), "other bytes"), /mismatch|does not match/i],
]) {
	test(`install refuses ${name} and writes nothing`, () => {
		const home = freshHome();
		const rel = makeRelease();
		tamper(rel);
		const r = run(home, ["install", "--release", rel.dir]);
		assert.notEqual(r.status, 0, r.out);
		assert.match(r.out, why);
		assert.equal(existsSync(join(home, ".local", "share", "tychicus")), false, "something was unpacked");
		assert.equal(existsSync(join(home, ".config", "chromium", "NativeMessagingHosts")), false, "a host manifest was written");
	});
}

/** A stand-in gh: `auth status` exits `auth` (0: signed in, 1: no account), `attestation verify` exits `verify`. */
function fakeGh(auth, verify) {
	const bin = join(scratch, "fake-gh");
	mkdirSync(bin, { recursive: true });
	const file = join(bin, `gh-${auth}-${verify}`);
	const calls = join(bin, `calls-${auth}-${verify}`);
	writeFileSync(file, `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1" = auth ]; then exit ${auth}; fi\nexit ${verify}\n`);
	chmodSync(file, 0o755);
	return { file, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
}

test("install refuses a release whose attestation a signed-in gh rejects, and accepts one gh verifies", { skip: process.platform === "win32" }, () => {
	const refused = freshHome();
	const rel = makeRelease();
	const rejecting = fakeGh(0, 1);
	const bad = run(refused, ["install", "--release", rel.dir], { TYCHICUS_GH: rejecting.file });
	assert.notEqual(bad.status, 0, bad.out);
	assert.match(bad.out, /gh attestation verify refused/);
	assert.match(rejecting.calls(), /^auth status --hostname github\.com$/m);
	assert.equal(existsSync(join(refused, ".local", "share", "tychicus")), false);
	const verifying = fakeGh(0, 0);
	const ok = run(freshHome(), ["install", "--release", rel.dir], { TYCHICUS_GH: verifying.file });
	assert.equal(ok.status, 0, ok.out);
	assert.match(verifying.calls(), /attestation verify .*tychicus-9\.9\.9-.*--repo baney75\/tychicus --signer-workflow baney75\/tychicus\/.github\/workflows\/release.yml/);
});

test("a gh that is not signed in is treated like no gh: SHA256SUMS only, with a note, and the install goes on", { skip: process.platform === "win32" }, () => {
	const home = freshHome();
	const { dir } = makeRelease();
	// verify would refuse: a finished install proves it was never asked.
	const signedOut = fakeGh(1, 1);
	const r = run(home, ["install", "--release", dir], { TYCHICUS_GH: signedOut.file });
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /gh is installed but not signed in, so the build attestations were not checked: SHA256SUMS only\. Run gh auth login to turn the check on\./);
	assert.doesNotMatch(signedOut.calls(), /attestation/, "a signed-out gh was asked to verify");
	assert.ok(existsSync(join(releaseRoot(home), "extension", "manifest.json")), r.out);
});

test("--dry-run checks the release and lists what it would write, writing nothing", () => {
	const home = freshHome();
	const { dir } = makeRelease();
	const r = run(home, ["install", "--release", dir, "--dry-run", "--local-studio"]);
	assert.equal(r.status, 0, r.out);
	assert.ok(r.out.includes(releaseRoot(home)), r.out);
	assert.ok(r.out.includes(join(home, ".config", "chromium", "NativeMessagingHosts", `${HOST}.json`)), r.out);
	assert.ok(r.out.includes(join(home, ".local-studio", "plugins", "tychicus-browser")), r.out);
	assert.ok(r.out.includes(join(home, ".eukhe", "settings.json")), r.out);
	assert.deepEqual(readdirSync(home).sort(), [".config", "sock"]);
	assert.deepEqual(readdirSync(join(home, ".config")), ["chromium"]);
	assert.deepEqual(readdirSync(join(home, ".config", "chromium")), []);
});

test("install writes only Tychicus's host, pinned to the one extension id, and leaves Polycarp's manifest alone", () => {
	const home = freshHome();
	const hosts = join(home, ".config", "chromium", "NativeMessagingHosts");
	mkdirSync(hosts, { recursive: true });
	const polycarp = `${JSON.stringify({ name: "com.polycarp.browser", path: "/opt/polycarp/host", type: "stdio", allowed_origins: ["chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/"] })}\n`;
	writeFileSync(join(hosts, "com.polycarp.browser.json"), polycarp);
	const r = run(home, ["install"]);
	assert.equal(r.status, 0, r.out);
	assert.deepEqual(readdirSync(hosts).sort(), ["com.polycarp.browser.json", `${HOST}.json`]);
	assert.equal(readFileSync(join(hosts, "com.polycarp.browser.json"), "utf8"), polycarp);
	const m = JSON.parse(readFileSync(join(hosts, `${HOST}.json`), "utf8"));
	assert.equal(m.name, HOST);
	assert.deepEqual(m.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
});

test("install is idempotent: a second run writes no file", () => {
	const home = freshHome();
	assert.equal(run(home, ["install"]).status, 0);
	const file = join(home, ".config", "chromium", "NativeMessagingHosts", `${HOST}.json`);
	const before = statSync(file).mtimeMs;
	const again = run(home, ["install"]);
	assert.equal(again.status, 0, again.out);
	assert.doesNotMatch(again.out, /Wrote/);
	assert.equal(statSync(file).mtimeMs, before);
});

test("install --release with --restart-services installs the release and its services restart on it; --dry-run with them writes nothing", { skip: process.platform === "win32" }, () => {
	// No service file in this HOME: nothing asks this computer's service manager about a real service.
	const home = freshHome();
	const { dir } = makeRelease();
	const dry = run(home, ["install", "--release", dir, "--restart-services", "--dry-run"]);
	assert.equal(dry.status, 0, dry.out);
	assert.match(dry.out, /Would unpack/);
	assert.deepEqual(readdirSync(home).sort(), [".config", "sock"], "the dry run wrote nothing");
	const r = run(home, ["install", "--release", dir, "--restart-services"]);
	assert.equal(r.status, 0, r.out);
	assert.ok(existsSync(join(releaseRoot(home), "extension", "manifest.json")), "--release was installed, not ignored");
	assert.equal(readFileSync(join(releaseRoot(home), "ran-with"), "utf8").trim(), "install", "the release's install isn't asked to restart again");
	// Later, alone: it lists what it would restart and restarts nothing.
	const later = run(home, ["install", "--restart-services", "--dry-run"]);
	assert.equal(later.status, 0, later.out);
	assert.match(later.out, /Every running Tychicus service runs 9\.9\.9/);
});

test("install --restart-services refuses --no-restart, and alone refuses the flags that belong to an install", () => {
	const home = freshHome();
	for (const args of [["--restart-services", "--no-restart"], ["--restart-services", "--force"], ["--restart-services", "--local-studio"], ["--restart-services", "--skip-attestation"]]) {
		const r = run(home, ["install", ...args]);
		assert.equal(r.status, 2, `${args.join(" ")}: ${r.out}`);
		assert.match(r.out, args[1] === "--no-restart" ? /opposite things/ : /only restarts services/);
	}
	const { dir } = makeRelease();
	const both = run(home, ["install", "--release", dir, "--restart-services", "--no-restart"]);
	assert.equal(both.status, 2, both.out);
	assert.deepEqual(readdirSync(home).sort(), [".config", "sock"], "nothing was written");
});

test("install --dry-run on a clean HOME writes nothing and names each manifest", () => {
	const home = freshHome();
	const r = run(home, ["install", "--dry-run"]);
	assert.equal(r.status, 0, r.out);
	assert.ok(r.out.includes(join(home, ".config", "chromium", "NativeMessagingHosts", `${HOST}.json`)), r.out);
	assert.deepEqual(readdirSync(join(home, ".config")), ["chromium"]);
	assert.deepEqual(readdirSync(join(home, ".config", "chromium")), []);
});

test("--local-studio copies both plugins and adds the Eukhe entry, keeping other servers and settings, with a backup", () => {
	const home = freshHome();
	const eukhe = join(home, ".eukhe");
	mkdirSync(eukhe, { recursive: true });
	const settings = { theme: "dark", mcpServers: { other: { type: "stdio", command: "/bin/other", args: ["x"] } } };
	writeFileSync(join(eukhe, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	const r = run(home, ["install", "--local-studio"]);
	assert.equal(r.status, 0, r.out);
	for (const id of ["tychicus-browser", "tychicus-computer"]) {
		const toml = readFileSync(join(home, ".local-studio", "plugins", id, "plugin.toml"), "utf8");
		assert.match(toml, new RegExp(`^id = "${id}"$`, "m"));
		assert.ok(existsSync(join(home, ".local-studio", "plugins", id, "skills", id, "SKILL.md")));
	}
	const after = JSON.parse(readFileSync(join(eukhe, "settings.json"), "utf8"));
	assert.equal(after.theme, "dark");
	assert.deepEqual(after.mcpServers.other, settings.mcpServers.other);
	const entry = after.mcpServers.tychicus;
	assert.equal(entry.type, "stdio");
	assert.ok(entry.command.startsWith("/") && existsSync(entry.command), entry.command);
	assert.deepEqual(entry.args, ["mcp", "--name", "tychicus", "--profile", "small"]);
	const backups = readdirSync(eukhe).filter((f) => f.startsWith("settings.json.tychicus-backup-"));
	assert.equal(backups.length, 1);
	assert.deepEqual(JSON.parse(readFileSync(join(eukhe, backups[0]), "utf8")), settings);
	// Again: nothing changes, so no second backup.
	const again = run(home, ["install", "--local-studio"]);
	assert.equal(again.status, 0, again.out);
	assert.equal(readdirSync(eukhe).filter((f) => f.startsWith("settings.json.tychicus-backup-")).length, 1);
});

test("--local-studio follows EUKHE_CODING_AGENT_DIR and LOCAL_STUDIO_DATA_DIR, and refuses a settings file that is not JSON", () => {
	const home = freshHome();
	const agent = join(home, "agent");
	const data = join(home, "studio");
	mkdirSync(agent, { recursive: true });
	const ok = run(home, ["install", "--local-studio"], { EUKHE_CODING_AGENT_DIR: agent, LOCAL_STUDIO_DATA_DIR: data });
	assert.equal(ok.status, 0, ok.out);
	assert.ok(existsSync(join(data, "plugins", "tychicus-browser", "plugin.toml")));
	assert.ok(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).mcpServers.tychicus);
	const broken = freshHome();
	mkdirSync(join(broken, ".eukhe"));
	writeFileSync(join(broken, ".eukhe", "settings.json"), "{ not json");
	const r = run(broken, ["install", "--local-studio"]);
	assert.notEqual(r.status, 0, r.out);
	assert.equal(readFileSync(join(broken, ".eukhe", "settings.json"), "utf8"), "{ not json");
});

test("the extension id constant is the id the manifest key produces", () => {
	const manifest = JSON.parse(readFileSync(join(repo, "static", "manifest.chrome.json"), "utf8"));
	const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
	const id = [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
	assert.equal(id, EXTENSION_ID);
	// Not Polycarp's: the two extensions install side by side.
	assert.notEqual(id, "kenehmggpggpiolepbjojeenmeapgfoc");
});

test("the archive unpacked in the download folder, as README's command leaves it, is not taken for an extra file", { skip: process.platform === "win32" }, () => {
	const home = freshHome();
	const { dir, archive, top } = makeRelease();
	assert.equal(spawnSync("tar", ["-xzf", archive], { cwd: dir }).status, 0);
	assert.ok(statSync(join(dir, top)).isDirectory());
	const r = run(home, ["install", "--release", dir]);
	assert.equal(r.status, 0, r.out);
	assert.ok(existsSync(join(releaseRoot(home), "tychicus")));
	// A stray file is still refused.
	writeFileSync(join(dir, `tychicus-9.9.9-notes.txt`), "not in the release");
	const stray = run(freshHome(), ["install", "--release", dir]);
	assert.notEqual(stray.status, 0);
	assert.match(stray.out, /tychicus-9\.9\.9-notes\.txt is not listed in SHA256SUMS/);
});

/** A copy of a small real program inside a release, so a test can run it from there the way a browser runs the host. */
function withSleeper(rel) {
	const stage = join(scratch, `restage-${++n}`);
	mkdirSync(stage);
	assert.equal(spawnSync("tar", ["-xzf", join(rel.dir, rel.archive), "-C", stage]).status, 0);
	copyFileSync("/bin/sleep", join(stage, rel.top, "sleeper"));
	chmodSync(join(stage, rel.top, "sleeper"), 0o755);
	assert.equal(spawnSync("tar", ["-czf", join(rel.dir, rel.archive), "-C", stage, rel.top]).status, 0);
	rmSync(stage, { recursive: true });
	writeFileSync(
		join(rel.dir, "SHA256SUMS"),
		readdirSync(rel.dir)
			.filter((f) => f !== "SHA256SUMS")
			.map((f) => `${sha256(join(rel.dir, f))}  ${f}\n`)
			.join(""),
	);
	return rel;
}

// sol-F3 (PR 3): the browser keeps the native host running from the installed release, and an MCP server runs from it
// too. An upgrade must not delete or replace the folder a running copy was started from; it installs the new version
// beside it, switches the release pointer, and removes the old folder only once nothing runs from it.
test("an upgrade while the installed copy runs keeps that copy's files, switches to the new version, and prunes the old one after it stops", { skip: process.platform !== "linux" }, async () => {
	const home = freshHome();
	const first = withSleeper(makeRelease("9.9.8"));
	assert.equal(run(home, ["install", "--release", first.dir]).status, 0);
	const sleeper = spawn(join(releaseRoot(home), "sleeper"), ["600"], { stdio: "ignore" });
	try {
		const exe = () => readlinkSync(`/proc/${sleeper.pid}/exe`);
		for (let i = 0; i < 100 && !exe().endsWith("sleeper"); i++) await new Promise((r) => setTimeout(r, 20));
		const runningFrom = dirname(exe());
		const second = withSleeper(makeRelease("9.9.9"));
		const r = run(home, ["install", "--release", second.dir]);
		assert.equal(r.status, 0, r.out);
		assert.doesNotMatch(exe(), /\(deleted\)$/, "the running copy's program was deleted");
		assert.equal(JSON.parse(readFileSync(join(runningFrom, "extension", "manifest.json"), "utf8")).version, "9.9.8", "the running copy's folder was replaced");
		assert.equal(JSON.parse(readFileSync(join(releaseRoot(home), "extension", "manifest.json"), "utf8")).version, "9.9.9");
		assert.equal(readFileSync(join(releaseRoot(home), "ran-with"), "utf8").trim(), "install");
		sleeper.kill("SIGKILL");
		await new Promise((r) => sleeper.once("exit", r));
		const again = run(home, ["install", "--release", withSleeper(makeRelease("9.9.10")).dir]);
		assert.equal(again.status, 0, again.out);
		assert.equal(existsSync(runningFrom), false, "the stopped old version was not removed");
	} finally {
		sleeper.kill("SIGKILL");
	}
});

/**
 * Issue 23: a service started before `install --release` keeps running the old version. A stub systemctl stands in for the
 * service manager: its serve service is a real process (the release's `sleeper`) whose pid it reports as MainPID, so the
 * install reads /proc/<pid>/exe as it would for the real serve. `restart` starts it again through the `release` pointer, as
 * the real unit does through the launcher. `failRestart` makes `restart` fail.
 */
function serviceStub(home, { failRestart = false } = {}) {
	const bin = join(home, "bin");
	const state = join(home, "serve.pid");
	mkdirSync(bin, { recursive: true });
	const unit = join(home, ".config", "systemd", "user", "tychicus-serve.service");
	mkdirSync(dirname(unit), { recursive: true });
	writeFileSync(unit, "left by remote setup\n");
	const start = `"${releaseRoot(home)}/sleeper" 600 >/dev/null 2>&1 </dev/null & echo $! > "${state}"`;
	const stop = `if [ -f "${state}" ]; then read p < "${state}"; kill $p 2>/dev/null; /bin/rm -f "${state}"; fi`;
	writeFileSync(
		join(bin, "systemctl"),
		`#!/bin/sh\necho "systemctl $*" >> "${home}/calls.log"\nlast=$(eval echo \\$$#)\n[ "$last" = tychicus-serve.service ] || { echo 0; exit 0; }\ncase "$2" in\nshow) if [ -f "${state}" ]; then cat "${state}"; else echo 0; fi ;;\nis-active) if [ -f "${state}" ]; then echo active; else echo inactive; exit 3; fi ;;\nrestart) ${failRestart ? 'echo "Job for tychicus-serve.service failed."; exit 1' : `${stop}; ${start}`} ;;\nesac\n`,
	);
	chmodSync(join(bin, "systemctl"), 0o755);
	const pid = () => (existsSync(state) ? Number(readFileSync(state, "utf8").trim()) : undefined);
	return {
		env: { PATH: `${bin}:${process.env.PATH}`, TYCHICUS_SERVE_WAIT_MS: "5000" },
		start: () => spawnSync("/bin/sh", ["-c", start]),
		pid,
		exe: () => readlinkSync(`/proc/${pid()}/exe`),
		calls: () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8") : ""),
		stop: () => spawnSync("/bin/sh", ["-c", stop]),
	};
}

/** The new release's program runs this CLI for `install --restart-services`, the step under test; anything else is recorded. */
const restartingProgram = `#!/bin/sh\nif [ "$1" = install ] && [ "$2" = --restart-services ]; then exec "${process.execPath}" "${cli}" "$@"; fi\necho "$@" > "$(dirname "$0")/ran-with"\n`;

const linuxOnly = { skip: process.platform !== "linux" };

test("install --release --no-restart names the service still on the old version and the command that restarts it", linuxOnly, () => {
	const home = freshHome();
	const svc = serviceStub(home);
	assert.equal(run(home, ["install", "--release", withSleeper(makeRelease("9.9.8")).dir], svc.env).status, 0);
	svc.start();
	try {
		const r = run(home, ["install", "--release", withSleeper(makeRelease("9.9.9")).dir, "--no-restart"], svc.env);
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /tychicus-serve\.service still runs 9\.9\.8 \(pid \d+\); release is 9\.9\.9\. Restart it: \S+\/release\/tychicus install --restart-services/);
		assert.doesNotMatch(svc.calls(), /restart/, "--no-restart restarted the service");
		assert.match(svc.exe(), /versions\/9\.9\.8-[0-9a-f]{12}\/sleeper$/);
	} finally {
		svc.stop();
	}
});

test("install --release restarts the service still on the old version and reads back that it runs the new one", linuxOnly, () => {
	const home = freshHome();
	const svc = serviceStub(home);
	assert.equal(run(home, ["install", "--release", withSleeper(makeRelease("9.9.8")).dir], svc.env).status, 0);
	svc.start();
	try {
		const before = svc.pid();
		const r = run(home, ["install", "--release", withSleeper(makeRelease("9.9.9", restartingProgram)).dir], svc.env);
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /Restarted tychicus-serve\.service: 9\.9\.8 -> 9\.9\.9/);
		assert.notEqual(svc.pid(), before);
		assert.match(svc.exe(), /versions\/9\.9\.9-[0-9a-f]{12}\/sleeper$/, "the service doesn't run the new version");
		assert.match(svc.calls(), /systemctl --user restart tychicus-serve\.service/);
		// Once nothing runs from it, the old version is removed.
		assert.match(r.out, /Removed 1 older version/);
	} finally {
		svc.stop();
	}
});

test("a restart whose serve doesn't answer points at remote status and remote fix, not at restarting again", linuxOnly, async () => {
	const home = freshHome();
	const svc = serviceStub(home);
	assert.equal(run(home, ["install", "--release", withSleeper(makeRelease("9.9.8")).dir], svc.env).status, 0);
	// remote.json names a port nothing answers on.
	const port = await new Promise((done) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => done(port));
		});
	});
	mkdirSync(join(home, ".config", "tychicus"), { recursive: true });
	writeFileSync(join(home, ".config", "tychicus", "remote.json"), JSON.stringify({ publicUrl: "https://serve.example.com", port, route: "custom" }));
	svc.start();
	try {
		const r = run(home, ["install", "--release", withSleeper(makeRelease("9.9.9", restartingProgram)).dir], { ...svc.env, TYCHICUS_SERVE_WAIT_MS: "1500" });
		assert.notEqual(r.status, 0, r.out);
		assert.match(r.out, /The services were restarted on 9\.9\.9, but tychicus serve doesn't answer\. Run: tychicus remote status, then tychicus remote fix/);
		assert.doesNotMatch(r.out, /weren't all restarted/);
		assert.match(svc.exe(), /versions\/9\.9\.9-[0-9a-f]{12}\/sleeper$/);
	} finally {
		svc.stop();
	}
});

test("a failed restart prints the command that restarts it and exits non-zero", linuxOnly, () => {
	const home = freshHome();
	const svc = serviceStub(home, { failRestart: true });
	assert.equal(run(home, ["install", "--release", withSleeper(makeRelease("9.9.8")).dir], svc.env).status, 0);
	svc.start();
	try {
		const r = run(home, ["install", "--release", withSleeper(makeRelease("9.9.9", restartingProgram)).dir], svc.env);
		assert.notEqual(r.status, 0, r.out);
		assert.match(r.out, /Job for tychicus-serve\.service failed/);
		assert.match(r.out, /Run: \S+\/release\/tychicus install --restart-services/);
		// The pointer still moved: the new version is installed; only the service is behind.
		assert.match(readlinkSync(releaseRoot(home)), /9\.9\.9/);
	} finally {
		svc.stop();
	}
});
