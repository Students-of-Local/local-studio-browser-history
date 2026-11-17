import { realpathSync } from "node:fs";
/**
 * How this program starts a copy of itself. From source or the npm bundle that is
 * `node <script> <args>`; inside Polycarp the helper is one compiled executable (`polycarp-browser`,
 * built by spaces/scripts/build-browser.sh with __POLYCARP_COMPILED__ set), so it is `<helper> <args>`
 * and there is no Node and no script path to point at.
 */

import { basename, delimiter, dirname, join } from "node:path";

declare const __POLYCARP_COMPILED__: boolean | undefined;

/** True in the single-executable build. */
export const COMPILED: boolean = typeof __POLYCARP_COMPILED__ !== "undefined" && __POLYCARP_COMPILED__ === true;

/**
 * A Tychicus release's executable (`tychicus`, from scripts/package-release.mjs) rather than the helper inside the
 * Polycarp app (`polycarp-browser`): it calls itself `tychicus`, and `tychicus install --release` updates it.
 */
export const RELEASE_BUILD: boolean = COMPILED && /^tychicus(\.exe)?$/i.test(basename(process.execPath));

/**
 * The path a long-lived entry (Eukhe's mcpServers) should name for `program`. A release runs from
 * <base>/versions/<version>-<sha>/, and a later `install --release` removes that folder once nothing runs from it, so
 * a program there is named through <base>/release, the pointer every install moves to the newest version. Any other
 * path is returned as is.
 */
export function stableReleaseProgram(program: string): string {
	const versions = dirname(dirname(program));
	if (basename(versions) !== "versions") return program;
	return join(dirname(versions), "release", basename(program));
}

/** The file a launcher or manifest must run: the helper itself when compiled, else Node. */
export function selfExec(): string {
	return process.execPath;
}

/** The arguments that make `selfExec()` run this program, before the command's own. */
export function selfPrefix(script: string | undefined = process.argv[1]): string[] {
	return COMPILED || !script ? [] : [script];
}

/**
 * Where the bundled extension folder sits: next to the helper (Polycarp.app/Contents/Resources/browser/extension). A
 * release installed by `install --release` runs from <base>/versions/<version>/, and the browser loads the copy in the
 * fixed folder <base>/extension, which outlives each version folder.
 */
export function bundledExtensionDir(): string | undefined {
	if (!COMPILED) return undefined;
	const dir = dirname(process.execPath);
	if (RELEASE_BUILD && basename(dirname(dir)) === "versions") return join(dirname(dirname(dir)), "extension");
	return join(dir, "extension");
}

/** The name this program was started under: `tychicus`, or an old alias such as `polycarp-browser`. */
const INVOKED = basename(process.argv[1] ?? "").replace(/\.(?:js|cmd|exe)$/, "");

/**
 * The command a person types for this program: `tychicus`, or the alias it was started as (`polycarp-browser`),
 * `polycarp browser` inside the Polycarp app. A plain `node dist/index.js` keeps the old name until the fleet moves over.
 */
export const COMMAND_NAME: string = COMPILED
	? RELEASE_BUILD
		? "tychicus"
		: "polycarp browser"
	: INVOKED === "tychicus" || INVOKED === "polycarp-browser"
		? INVOKED
		: linkedAs("tychicus")
			? "tychicus"
			: !linkedAs("polycarp-browser") && linkedAs("tabkyra")
				? "tabkyra"
				: "polycarp-browser";

/**
 * The MCP server's name when `mcp --name` is not given: `tychicus`, and `polycarp` under an old command name, so
 * configs written for Polycarp keep seeing the server they know.
 */
export const DEFAULT_MCP_NAME: string = COMMAND_NAME === "tychicus" ? "tychicus" : "polycarp";

/** Whether `name` on PATH is this program. An npm link made before the rename answers only to `tabkyra`. */
function linkedAs(name: string): boolean {
	const script = process.argv[1];
	if (!script) return false;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		try {
			if (realpathSync(join(dir, name)) === realpathSync(script)) return true;
		} catch {
			/* not in this folder */
		}
	}
	return false;
}
