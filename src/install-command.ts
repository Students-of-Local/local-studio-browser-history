/**
 * The one command that installs Tychicus's helper, per OS. This module is the one place the strings live: the welcome
 * screen shows them, the updater names them, and README.md and store/listing.md quote them word for word
 * (test/install-command.test.mjs fails when a copy drifts). scripts/install.sh and scripts/install.ps1 are what they
 * run; .github/workflows/release.yml uploads both to every release.
 */

/** Where every release's install scripts are, under GitHub's "latest release" redirect. */
export const INSTALL_SCRIPT_BASE = "https://github.com/baney75/tychicus/releases/latest/download";

/** macOS and Linux, in a terminal. */
export const INSTALL_COMMAND_SH = `curl -fsSL ${INSTALL_SCRIPT_BASE}/install.sh | sh`;

/** Windows, in PowerShell. */
export const INSTALL_COMMAND_PS1 = `irm ${INSTALL_SCRIPT_BASE}/install.ps1 | iex`;

export interface InstallCommand {
	command: string;
	/** Where to paste it, for the line above the command. */
	shell: "Terminal" | "PowerShell";
}

/**
 * The command for an OS, named the way chrome.runtime.getPlatformInfo() (`mac`, `win`, `linux`) or Node's
 * process.platform (`darwin`, `win32`, `linux`) names it. Undefined where the helper doesn't run (ChromeOS, Android).
 */
export function installCommandFor(os: string): InstallCommand | undefined {
	if (os === "win" || os === "win32") return { command: INSTALL_COMMAND_PS1, shell: "PowerShell" };
	if (os === "mac" || os === "darwin" || os === "linux") return { command: INSTALL_COMMAND_SH, shell: "Terminal" };
	return undefined;
}
