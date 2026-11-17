import { UPDATE_STATUS_KEY } from "./protocol.js";

/**
 * What a person types to run the helper: `tychicus`, the name a release and an npm link both answer to. An older helper
 * may report the name it was started under ("polycarp-browser" from a checkout made before the rename, or "tabkyra"),
 * and that is shown as it reports it. Someone who just installed from the store has no helper yet, so the screens that
 * show this also say how to get it.
 */
let command = "tychicus";

function take(status: unknown): void {
	const named = (status as { command?: unknown } | undefined)?.command;
	if (named === "tychicus" || named === "polycarp-browser" || named === "tabkyra") command = named;
}

try {
	void chrome.storage.local.get(UPDATE_STATUS_KEY).then((r) => take(r[UPDATE_STATUS_KEY]));
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes[UPDATE_STATUS_KEY]) take(changes[UPDATE_STATUS_KEY].newValue);
	});
} catch {
	/* not an extension page (tests) */
}

export function hostCommand(): string {
	return command;
}

/** The command for a sentence. */
export function hostCommandText(subcommand: string): string {
	return `${command} ${subcommand}`;
}
