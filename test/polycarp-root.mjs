// Some tests hold this repo to files that live in Polycarp, not here: the Mac app's Swift copy of the panel's words,
// the brand folder's logo and the user guide. They were written while this code was Polycarp's browser/ folder.
// They run when POLYCARP_ROOT names a Polycarp checkout and are skipped, with the reason, when it doesn't.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.POLYCARP_ROOT;

/** A test's `skip` option: false when every file is there, otherwise the reason. */
export function needsPolycarp(...files) {
	if (!root) return "needs a Polycarp checkout: set POLYCARP_ROOT";
	const missing = files.find((f) => !existsSync(join(root, f)));
	return missing ? `POLYCARP_ROOT has no ${missing}` : false;
}

/** A file from the Polycarp checkout, by its path there. */
export function polycarpFile(file) {
	return readFileSync(join(root ?? "", file), "utf8");
}
