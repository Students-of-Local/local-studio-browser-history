// first-F1 (PR 3): the new manifest key changed the extension ID from kenehmggpggpiolepbjojeenmeapgfoc (Polycarp's) to
// igjafcggmahiboobmnhfkndodphjdnhg. Chrome keys chrome.storage and IndexedDB by the extension's origin, so the new ID
// starts empty, and removing the old extension deletes its chats, keys and settings. The README and the changelog must
// say so and give the order that keeps the data readable, and nothing may let Polycarp's ID into Tychicus's host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import extensionId from "../src/bridge/extension-id.json" with { type: "json" };

const root = join(import.meta.dirname, "..");
const OLD_ID = "kenehmggpggpiolepbjojeenmeapgfoc";
const readme = readFileSync(join(root, "README.md"), "utf8");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

test("the README never claims stored data carried over, and says what the ID change does to it", () => {
	assert.doesNotMatch(readme, /Stored data did not change/i);
	const section = readme.slice(readme.indexOf("### Upgrading from a build with the old ID"));
	assert.ok(section.length > 0, "README needs an 'Upgrading from a build with the old ID' section");
	for (const want of [OLD_ID, extensionId.id, /starts? (with )?empty/i, /remov\w+ the old extension deletes/i, /threads export/, /keys?/i])
		assert.match(section.slice(0, 2500), want instanceof RegExp ? want : new RegExp(want));
});

test("the changelog's ID entry warns that the new ID starts empty", () => {
	// Newest first: the entry sits under [Unreleased] until a release moves it under its version.
	const entry = changelog.split("\n").find((l) => l.startsWith("- ") && l.includes(extensionId.id));
	assert.ok(entry, "a changelog entry names the new ID");
	assert.match(entry, new RegExp(OLD_ID));
	assert.match(entry, /starts? (with )?empty/i);
	assert.doesNotMatch(entry, /must be loaded again\.$/);
});

test("Tychicus's host never allows Polycarp's extension ID", () => {
	for (const file of ["cli/src/install.ts", "src/bridge/extension-id.json"]) assert.doesNotMatch(readFileSync(join(root, file), "utf8"), new RegExp(OLD_ID), file);
});
