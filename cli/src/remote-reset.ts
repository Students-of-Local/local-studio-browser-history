/**
 * `remote reset --new-passcode-file <path>`: after a tunnel token leaked (someone ran a second connector with it, so some
 * `/authorize` submissions, which carry the passcode, reached them), rotate the owner passcode and end everything an
 * assistant could still use, before the tunnel comes back:
 *
 * - the passcode, read from a file only the owner can read (never argv, never the environment), set the way `token passcode`
 *   sets one;
 * - every OAuth grant (access and refresh tokens) and every client registration, and the signing key, which ends approval
 *   forms and authorization codes issued before (codes live in serve's memory, bound to the key);
 * - every waiting connect code: approval codes, and a hub's device codes;
 * - every static `tkr_` token but link tokens. A static token never passes through `/authorize`, so the passcode leak doesn't
 *   reach it, but any `/mcp` request relayed through the second connector carried its bearer token, and Tychicus can't tell
 *   which tokens were used through the tunnel. A link token is refused on any serve with a public route, so none that works
 *   ever went through one; they stay, so a hub link keeps working.
 *
 * Each step runs even when one before it failed, then a fresh read of every file proves the result. Exit 0 only when every
 * step is done and read back; 1 when a step or the read-back failed (the report names what is left); 2 when the passcode file
 * or the config folder is refused, before anything changes.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clearConnectCodes, liveConnectCodes } from "./hub-state.ts";
import { clearApprovalCodes, configDir, liveApprovalCodes, oauthCounts, passcodeMatches, passcodeProblem, resetOAuth } from "./oauth.ts";
import { loadTokens, revokeStaticTokens, tokenLive } from "./remote.ts";
import { printReport } from "./remote-state.ts";
import { COMMAND_NAME } from "./self.ts";
import { HUB_SERVICE, SERVE_SERVICE, savedFolders, serviceFile } from "./service.ts";
import { sym } from "./ui.ts";

export const EXIT_RESET_DONE = 0;
export const EXIT_RESET_FAILED = 1;
export const EXIT_RESET_REFUSED = 2;

/** A passcode file this big is not a passcode. */
const MAX_FILE_BYTES = 4096;

export class PasscodeFileError extends Error {}

/**
 * The passcode in `path`. Refused: a link, anything but a regular file, a file group or others can read or write, one that
 * belongs to another account, an empty one, and a passcode `token passcode`'s rules refuse (passcodeProblem). One trailing
 * newline is dropped. On Windows the permission and owner checks are skipped: NTFS access lists aren't in the mode bits.
 */
export function readPasscodeFile(path: string): string {
	const shown = resolve(path);
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new PasscodeFileError(`${shown} doesn't exist.`);
		if (code === "ELOOP" || code === "EMLINK") throw new PasscodeFileError(`${shown} is a symbolic link. Give the file itself.`);
		throw new PasscodeFileError(`${shown} can't be opened (${code ?? (err as Error).message}).`);
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new PasscodeFileError(`${shown} isn't a regular file.`);
		if (process.platform !== "win32") {
			if (st.mode & 0o077) throw new PasscodeFileError(`${shown} can be read or written by others (mode ${(st.mode & 0o777).toString(8).padStart(4, "0")}). Make it the owner's alone: chmod 600 ${shown}`);
			if (process.getuid && st.uid !== process.getuid()) throw new PasscodeFileError(`${shown} belongs to another account.`);
		}
		if (st.size > MAX_FILE_BYTES) throw new PasscodeFileError(`${shown} is ${st.size} bytes; a passcode file holds one line.`);
		const passcode = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
		const problem = passcodeProblem(passcode);
		if (problem) throw new PasscodeFileError(`The passcode in ${shown} can't be used: ${problem}.`);
		return passcode;
	} finally {
		closeSync(fd);
	}
}

/**
 * A serve or hub service set up with its own config folder reads its grants there. A reset of this shell's folder would leave
 * them all working, so it is refused, naming the folder to run it in.
 */
function otherConfigFolder(): string | undefined {
	const here = resolve(configDir());
	for (const spec of [SERVE_SERVICE, HUB_SERVICE]) {
		if (!serviceFile(spec)) continue;
		const folder = savedFolders(spec).config;
		if (folder && resolve(folder) !== here) return folder;
	}
	return undefined;
}

export interface ResetOptions {
	passcodeFile: string | undefined;
	json: boolean;
}

/** How many of each the reset ended. */
interface Ended {
	clients: number;
	grants: number;
	approvalCodes: number;
	deviceCodes: number;
	staticRevoked: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function remoteReset(options: ResetOptions): Promise<number> {
	const say = (line: string) => {
		if (!options.json) console.log(line);
	};
	const refuse = (code: string, message: string) => {
		if (options.json) printReport({ ok: false, state: "refused", code, message: `${message} Nothing was changed.` });
		else console.error(`${sym.fail} ${message} Nothing was changed.`);
		return EXIT_RESET_REFUSED;
	};
	if (!options.passcodeFile) return refuse("usage", `Usage: ${COMMAND_NAME} remote reset --new-passcode-file <path> [--json]`);
	let passcode: string;
	try {
		passcode = readPasscodeFile(options.passcodeFile);
	} catch (err) {
		if (err instanceof PasscodeFileError) return refuse("passcode_file", err.message);
		throw err;
	}
	const other = otherConfigFolder();
	if (other) return refuse("config_folder", `The service reads ${other}, and this shell uses ${configDir()}. Run it there: TYCHICUS_CONFIG_DIR="${other}" ${COMMAND_NAME} remote reset --new-passcode-file <path>`);

	const ended: Ended = { clients: 0, grants: 0, approvalCodes: 0, deviceCodes: 0, staticRevoked: 0 };
	const failed: { step: string; detail: string }[] = [];
	const step = (name: string, fn: () => void) => {
		try {
			fn();
		} catch (err) {
			failed.push({ step: name, detail: err instanceof Error ? err.message : String(err) });
		}
	};
	step("oauth", () => {
		const r = resetOAuth(passcode);
		ended.clients = r.clients;
		ended.grants = r.grants;
	});
	step("approval_codes", () => {
		ended.approvalCodes = clearApprovalCodes();
	});
	step("device_codes", () => {
		ended.deviceCodes = clearConnectCodes();
	});
	step("static_tokens", () => {
		ended.staticRevoked = revokeStaticTokens();
	});

	// The read-back: a fresh read of every file, whatever the steps reported.
	const left: { name: string; detail: string }[] = [];
	const check = (name: string, fn: () => string | undefined) => {
		try {
			const detail = fn();
			if (detail) left.push({ name, detail });
		} catch (err) {
			left.push({ name, detail: `couldn't be read back: ${err instanceof Error ? err.message : String(err)}` });
		}
	};
	check("passcode", () => (passcodeMatches(passcode) ? undefined : "the stored passcode isn't the new one"));
	check("oauth", () => {
		const c = oauthCounts();
		return c.clients || c.tokens ? `oauth.json still holds ${plural(c.clients, "client")} and ${plural(c.tokens, "token")}` : undefined;
	});
	check("approval_codes", () => {
		const n = liveApprovalCodes();
		return n ? `${plural(n, "approval code")} still live` : undefined;
	});
	check("device_codes", () => {
		const n = liveConnectCodes();
		return n ? `${plural(n, "device connect code")} still live` : undefined;
	});
	let linkKept = 0;
	check("static_tokens", () => {
		const live = loadTokens().filter((t) => tokenLive(t));
		linkKept = live.filter((t) => t.kind === "link").length;
		const still = live.filter((t) => t.kind !== "link");
		return still.length ? `${plural(still.length, "static token")} still live: ${still.map((t) => t.id).join(", ")}` : undefined;
	});

	const ok = failed.length === 0 && left.length === 0;
	const message = ok
		? "The passcode is replaced, and every grant, client registration, connect code and static token is ended and read back. Every assistant must connect again with a new connect code."
		: `Reset isn't complete: ${[...failed.map((f) => `${f.step} failed (${f.detail})`), ...left.map((l) => `${l.name}: ${l.detail}`)].join("; ")}. Run ${COMMAND_NAME} remote reset again before the tunnel comes back.`;
	if (options.json) {
		printReport({ ok, state: ok ? "done" : "failed", message, ended, kept: { linkTokens: linkKept }, failed, left });
		return ok ? EXIT_RESET_DONE : EXIT_RESET_FAILED;
	}
	if (!failed.some((f) => f.step === "oauth")) {
		say(`${sym.ok} New passcode set from the file.`);
		say(`${sym.ok} Ended ${plural(ended.grants, "OAuth grant")} and ${plural(ended.clients, "client registration")}.`);
	}
	if (!failed.some((f) => f.step === "approval_codes" || f.step === "device_codes")) say(`${sym.ok} Ended ${plural(ended.approvalCodes + ended.deviceCodes, "waiting connect code")}.`);
	if (!failed.some((f) => f.step === "static_tokens")) say(`${sym.ok} Revoked ${plural(ended.staticRevoked, "static token")}${linkKept ? `; kept ${plural(linkKept, "link token")}, which no public route accepts` : ""}.`);
	if (ok) say(`${sym.ok} ${message} A running serve refuses the old tokens at once and closes their sessions within a second.`);
	else console.error(`${sym.fail} ${message}`);
	return ok ? EXIT_RESET_DONE : EXIT_RESET_FAILED;
}
