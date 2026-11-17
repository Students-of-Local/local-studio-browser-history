// `tychicus install` from a downloaded release, against a throwaway HOME: the release is checked against SHA256SUMS
// and, when gh is there, its attestations, before anything is unpacked; a tampered artifact is refused and nothing
// is written. The host manifests it writes name only Tychicus's host and allow only the one pinned extension id,
// and a second run changes nothing. `--local-studio` adds the plugins and Eukhe's mcpServers entry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * the extension and the plugins) and SHA256SUMS.
 */
function makeRelease(version = "9.9.9") {
	const dir = join(scratch, `release-${++n}`);
	const top = `tychicus-${version}-${tag}`;
	const stage = join(dir, "stage", top);
	mkdirSync(join(stage, "extension"), { recursive: true });
	writeFileSync(join(stage, "extension", "manifest.json"), JSON.stringify({ name: "Tychicus", version }));
	writeFileSync(join(stage, "tychicus"), `#!/bin/sh\necho "$@" > "$(dirname "$0")/ran-with"\n`);
	chmodSync(join(stage, "tychicus"), 0o755);
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
	assert.ok(r.out.includes(join(releaseRoot(home), "extension")), r.out);
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

test("install refuses a release whose attestation gh rejects, and accepts one gh verifies", { skip: process.platform === "win32" }, () => {
	const bin = join(scratch, "fake-gh");
	mkdirSync(bin, { recursive: true });
	const gh = (code) => {
		const file = join(bin, `gh-${code}`);
		writeFileSync(file, `#!/bin/sh\necho "$@" >> "${bin}/calls-${code}"\nexit ${code}\n`);
		chmodSync(file, 0o755);
		return file;
	};
	const refused = freshHome();
	const rel = makeRelease();
	const bad = run(refused, ["install", "--release", rel.dir], { TYCHICUS_GH: gh(1) });
	assert.notEqual(bad.status, 0, bad.out);
	assert.match(bad.out, /attestation/i);
	assert.equal(existsSync(join(refused, ".local", "share", "tychicus")), false);
	const ok = run(freshHome(), ["install", "--release", rel.dir], { TYCHICUS_GH: gh(0) });
	assert.equal(ok.status, 0, ok.out);
	const calls = readFileSync(join(bin, "calls-0"), "utf8");
	assert.match(calls, /attestation verify .*tychicus-9\.9\.9-.*--repo baney75\/tychicus --signer-workflow baney75\/tychicus\/.github\/workflows\/release.yml/);
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
