// What the Chrome Web Store zip may hold. `prepare` strips a build folder and `check` fails on anything
// left over. test/store-package.test.mjs runs the same functions, and test/store-zip.test.mjs runs them on a real build.
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/** The store listing's name; the zip's manifest must say the same. */
export const STORE_NAME = "Tychicus";

const NOTICE = `Tychicus browser extension. AGPL-3.0: see LICENSE.
Source: https://github.com/baney75/tychicus
Built on 0xSero's agent bridge (https://github.com/0xSero/sitegeist) and Mario Zechner's Sitegeist
(https://github.com/badlogic/sitegeist).
`;

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else yield path;
	}
}

const isStripped = (rel) => rel.endsWith(".map") || /^debug\.(html|js)$/.test(rel);

export function prepare(folder, sourceRoot) {
	for (const path of [...walk(folder)]) if (isStripped(relative(folder, path))) rmSync(path);
	const manifestPath = join(folder, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	delete manifest.key;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	copyFileSync(join(sourceRoot, "LICENSE"), join(folder, "LICENSE"));
	writeFileSync(join(folder, "NOTICE"), NOTICE);
}

/** The permissions store/permissions.md gives a reason for: the first cell of each table row, in backticks. */
export function explainedPermissions(doc) {
	return [...doc.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
}

/** What the manifest asks for, permissions, optional ones and hosts alike. */
export function askedPermissions(manifest) {
	return [
		...(manifest.permissions ?? []),
		...(manifest.optional_permissions ?? []),
		...(manifest.host_permissions ?? []),
		...(manifest.optional_host_permissions ?? []),
	];
}

/**
 * Every problem with a prepared folder; empty when the store may have it. With the source root it also checks the
 * version against package.json and every permission against store/permissions.md, both ways.
 */
export function problems(folder, sourceRoot) {
	const found = [];
	for (const path of walk(folder)) {
		const rel = relative(folder, path);
		if (isStripped(rel)) found.push(`${rel} must not ship`);
		if (rel.endsWith(".pem")) found.push(`${rel} is a key file`);
		if (rel.endsWith(".html") && /debug\.js/.test(readFileSync(path, "utf8")))
			found.push(`${rel} loads the debug page`);
	}
	const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
	if ("key" in manifest) found.push("manifest has a key");
	if ("update_url" in manifest) found.push("manifest has an update_url");
	if (manifest.name !== STORE_NAME) found.push(`manifest name is "${manifest.name}", not "${STORE_NAME}"`);
	if (manifest.description.length > 132) found.push("description is over the store limit of 132 characters");
	const icons = {
		...manifest.icons,
		...(typeof manifest.action?.default_icon === "object" ? manifest.action.default_icon : {}),
	};
	if (!manifest.icons?.["128"]) found.push("manifest has no 128 px icon");
	for (const icon of new Set(Object.values(icons)))
		if (!existsSync(join(folder, icon))) found.push(`icon ${icon} is missing`);
	if (sourceRoot) {
		const pkg = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
		if (manifest.version !== pkg.version)
			found.push(`manifest version ${manifest.version} is not package.json's ${pkg.version}`);
		const explained = explainedPermissions(readFileSync(join(sourceRoot, "store/permissions.md"), "utf8"));
		const asked = askedPermissions(manifest);
		for (const p of asked)
			if (!explained.includes(p)) found.push(`permission ${p} has no reason in store/permissions.md`);
		for (const p of explained)
			if (!asked.includes(p)) found.push(`store/permissions.md explains ${p}, which the manifest does not ask for`);
	}
	for (const file of ["LICENSE", "NOTICE"]) if (!existsSync(join(folder, file))) found.push(`${file} is missing`);
	return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [, , command, folder, sourceRoot] = process.argv;
	if (command === "prepare") prepare(folder, sourceRoot);
	else if (command === "check") {
		const found = problems(folder, sourceRoot);
		for (const p of found) console.error(p);
		if (found.length) process.exit(1);
	} else {
		console.error("usage: store-package.mjs prepare <folder> <source root> | check <folder> [source root]");
		process.exit(2);
	}
}
