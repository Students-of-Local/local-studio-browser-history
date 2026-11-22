// scripts/install.sh and scripts/install.ps1 against a local stand-in for GitHub's releases pages: each finds the
// latest release (or TYCHICUS_VERSION's), checks the archive against SHA256SUMS and gh attestation verify, and only
// then runs the unpacked `tychicus install --release <folder>`. The release here is fake: its `tychicus` records how it
// was called. CI's clean-install job runs install.sh on a real release (cli/test/clean-install.mjs).
// Uses only Node's own modules, so the cli-windows job runs it with plain node for install.ps1.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "tychicus-install-script-"));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const tag = `${windows ? "win" : process.platform}-${arch}`;
const sha = (data) => createHash("sha256").update(data).digest("hex");

/** version -> { file name: bytes } */
const releases = new Map();
let latest = "";
let base = "";
let server;

/** A release whose archive holds a `tychicus` that writes its arguments and the download folder's files to calls.txt. */
function publish(version, { tamper = false, withArchive = true } = {}) {
	const files = {};
	const top = `tychicus-${version}-${tag}`;
	let archive;
	if (windows) {
		// A zip with no tychicus.exe: install.ps1 gets as far as unpacking, then says the program is missing.
		const src = join(work, `src-${version}`, top);
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, "LICENSE"), "fake\n");
		const zip = join(work, `${top}.zip`);
		execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${src}' -DestinationPath '${zip}' -Force`]);
		archive = { name: `${top}.zip`, data: readFileSync(zip) };
	} else {
		const src = join(work, `src-${version}`);
		mkdirSync(join(src, top), { recursive: true });
		const program = join(src, top, "tychicus");
		writeFileSync(
			program,
			`#!/bin/sh\n{ echo "version ${version}"; echo "args $*"; echo "gh \${TYCHICUS_GH:-}"; ls "$3"; } > "$CALLS"\necho "Load unpacked: $HOME/.local/share/tychicus/extension"\n`,
		);
		chmodSync(program, 0o755);
		execFileSync("tar", ["-czf", join(work, `${top}.tar.gz`), "-C", src, top]);
		archive = { name: `${top}.tar.gz`, data: readFileSync(join(work, `${top}.tar.gz`)) };
	}
	if (withArchive) files[archive.name] = archive.data;
	const listed = withArchive ? archive : { name: `tychicus-${version}-plan9-x64.tar.gz`, data: Buffer.from("other") };
	const extension = Buffer.from(`extension ${version}`);
	files[`tychicus-${version}-extension.zip`] = extension;
	const sums = [
		`${tamper ? sha(Buffer.from("something else")) : sha(listed.data)}  ${listed.name}`,
		`${sha(extension)}  tychicus-${version}-extension.zip`,
	];
	files.SHA256SUMS = Buffer.from(`${sums.sort().join("\n")}\n`);
	for (const script of ["install.sh", "install.ps1"]) files[script] = readFileSync(join(repo, "scripts", script));
	releases.set(version, files);
	latest = version;
}

before(async () => {
	server = createServer((req, res) => {
		const path = new URL(req.url, "http://x").pathname;
		const m = /^\/releases\/(?:latest\/download|download\/v([^/]+))\/([^/]+)$/.exec(path);
		const data = m && releases.get(m[1] ?? latest)?.[m[2]];
		if (!data) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, { "content-length": data.length }).end(data);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}/releases`;
});

after(() => {
	server?.close();
	rmSync(work, { recursive: true, force: true });
});

let runs = 0;
/** Run a program without blocking this process, which serves the release it downloads. */
function run(command, args, env) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { env });
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		child.on("close", (status) => resolve({ status, out }));
	});
}

/** Run an installer from an empty home; `fetchScript` runs the README's own pipe from curl, as a person would. */
async function install({ env = {}, args = [], fetchScript = false } = {}) {
	const home = join(work, `home-${++runs}`);
	mkdirSync(home, { recursive: true });
	const calls = join(home, "calls.txt");
	const environment = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		CALLS: calls,
		TYCHICUS_GH: "none",
		TYCHICUS_INSTALL_BASE_URL: base,
		TYCHICUS_VERSION: "",
		...env,
	};
	let r;
	if (windows) {
		r = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "scripts", "install.ps1"), "--allow-root", ...args], environment);
	} else if (fetchScript) {
		r = await run("sh", ["-c", `curl -fsSL ${base}/latest/download/install.sh | sh -s -- ${args.join(" ")}`], environment);
	} else {
		r = await run("sh", [join(repo, "scripts", "install.sh"), ...args], environment);
	}
	return { ...r, calls: existsSync(calls) ? readFileSync(calls, "utf8") : undefined, home };
}

test("installs the latest release: hash checked, attestation skip said, then tychicus install --release", { skip: windows }, async () => {
	publish("9.8.6");
	publish("9.8.7");
	const r = await install({ fetchScript: true, args: ["--local-studio"] });
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /tychicus-9\.8\.7-.* matches SHA256SUMS/);
	assert.match(r.out, /Skipped the build attestation check/);
	assert.match(r.calls, /^version 9\.8\.7$/m);
	// The program got the download folder, holding the archive and SHA256SUMS, and the options passed on.
	assert.match(r.calls, /^args install --release \S+ --local-studio$/m);
	assert.match(r.calls, /^SHA256SUMS$/m);
	assert.match(r.calls, new RegExp(`^tychicus-9\\.8\\.7-${tag}\\.tar\\.gz$`, "m"));
	assert.match(r.out, /Next: .*\n.*tychicus setup/);
});

test("TYCHICUS_VERSION picks that release", { skip: windows }, async () => {
	publish("9.8.6");
	publish("9.8.7");
	const r = await install({ env: { TYCHICUS_VERSION: "v9.8.6" } });
	assert.equal(r.status, 0, r.out);
	assert.match(r.calls, /^version 9\.8\.6$/m);
});

test("a hash mismatch stops it before anything runs", async () => {
	publish("9.8.8", { tamper: true });
	const r = await install();
	assert.notEqual(r.status, 0, r.out);
	assert.match(r.out, /does not match SHA256SUMS/);
	assert.match(r.out, /nothing was installed/);
	assert.equal(r.calls, undefined, "the program ran after a mismatch");
});

test("a release with no archive for this computer is refused by name", async () => {
	publish("9.8.9", { withArchive: false });
	const r = await install();
	assert.notEqual(r.status, 0, r.out);
	assert.match(r.out, new RegExp(`no archive for ${tag}`));
});

/**
 * A stand-in gh that logs each call to gh.txt in the home folder. `auth status` exits `auth` (0: signed in, 1: no
 * account); `attestation verify` exits `verify`. Each writes a line on stderr, as gh does: Windows PowerShell 5.1 turns
 * that into a terminating error under 'Stop', so only the exit code may decide.
 */
function fakeGh(auth, verify) {
	if (windows) {
		const file = join(work, `gh-${auth}-${verify}.cmd`);
		writeFileSync(file, `@echo %* >> "%USERPROFILE%\\gh.txt"\r\n@echo Loaded digest for the archive 1>&2\r\n@if "%1"=="auth" exit /b ${auth}\r\n@exit /b ${verify}\r\n`);
		return file;
	}
	const file = join(work, `gh-${auth}-${verify}`);
	writeFileSync(file, `#!/bin/sh\necho "$*" >> "$HOME/gh.txt"\necho "Loaded digest for the archive" >&2\nif [ "$1" = auth ]; then exit ${auth}; fi\nexit ${verify}\n`);
	chmodSync(file, 0o755);
	return file;
}

test("a failed gh attestation verify stops it; a passing one is reported, even when gh writes to stderr", async () => {
	publish("9.9.0");
	const refused = await install({ env: { TYCHICUS_GH: fakeGh(0, 1) } });
	assert.notEqual(refused.status, 0, refused.out);
	assert.match(refused.out, /gh attestation verify refused/);
	assert.equal(refused.calls, undefined, "the program ran after a failed attestation");

	const ok = await install({ env: { TYCHICUS_GH: fakeGh(0, 0) } });
	assert.match(ok.out, /built by baney75\/tychicus's release workflow/, ok.out);
	assert.doesNotMatch(ok.out, /refused|NativeCommandError/);
	assert.match(
		readFileSync(join(ok.home, "gh.txt"), "utf8"),
		/^attestation verify \S+tychicus-9\.9\.0-\S+ --repo baney75\/tychicus --signer-workflow baney75\/tychicus\/\.github\/workflows\/release\.yml\s*$/m,
	);
	// On Windows the fake archive holds no tychicus.exe, so getting past gh ends at that check.
	if (windows) assert.match(ok.out, /holds no tychicus\.exe/);
	else {
		assert.equal(ok.status, 0, ok.out);
		assert.match(ok.calls, /^gh \S*gh-0-0$/m, "a signed-in gh is passed on to the program");
	}
});

test("a gh that is not signed in is treated like no gh: SHA256SUMS only, with a note, and the install goes on", async () => {
	publish("9.9.3");
	// verify would refuse: reaching the program proves it was never asked.
	const r = await install({ env: { TYCHICUS_GH: fakeGh(1, 1) } });
	assert.match(r.out, /matches SHA256SUMS/, r.out);
	assert.match(r.out, /gh\) is installed but not signed in, so the build attestation was not checked\. Run gh auth login to turn the check on\./);
	assert.doesNotMatch(r.out, /refused|NativeCommandError/);
	const gh = readFileSync(join(r.home, "gh.txt"), "utf8");
	assert.match(gh, /^auth status --hostname github\.com\s*$/m);
	assert.doesNotMatch(gh, /attestation/, "a signed-out gh was asked to verify");
	if (windows) assert.match(r.out, /holds no tychicus\.exe/);
	else {
		assert.equal(r.status, 0, r.out);
		// The program checks again; it is told not to try gh, which just said it can't.
		assert.match(r.calls, /^gh none$/m);
		assert.match(r.calls, /^args install --release \S+$/m);
	}
});

test("as root it refuses unless --allow-root", { skip: windows }, async () => {
	publish("9.9.1");
	const bin = join(work, "root-bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "id"), "#!/bin/sh\necho 0\n");
	chmodSync(join(bin, "id"), 0o755);
	const env = { PATH: `${bin}:${process.env.PATH}` };
	const refused = await install({ env });
	assert.notEqual(refused.status, 0, refused.out);
	assert.match(refused.out, /refusing to run as root/);
	assert.equal(refused.calls, undefined);
	const allowed = await install({ env, args: ["--allow-root"] });
	assert.equal(allowed.status, 0, allowed.out);
	assert.match(allowed.calls, /^args install --release \S+$/m, "--allow-root is the script's own flag, not passed on");
});

test("the test-only base URL must be loopback", async () => {
	// The second starts with a loopback prefix but its host is example.invalid (127.0.0.1:1 is userinfo).
	for (const url of ["https://example.com/releases", "http://127.0.0.1:1@example.invalid/releases", "http://localhost.example.invalid/releases"]) {
		const r = await install({ env: { TYCHICUS_INSTALL_BASE_URL: url } });
		assert.notEqual(r.status, 0, `${url}: ${r.out}`);
		assert.match(r.out, /TYCHICUS_INSTALL_BASE_URL is for tests/, url);
	}
});

test("install.ps1 downloads, checks and unpacks the Windows archive", { skip: !windows }, async () => {
	publish("9.9.2");
	const r = await install();
	assert.match(r.out, /matches SHA256SUMS/, r.out);
	assert.match(r.out, /Skipped the build attestation check/);
	// The fake archive has no tychicus.exe: reaching that check means it unpacked.
	assert.match(r.out, /holds no tychicus\.exe/);
	assert.notEqual(r.status, 0);
});
