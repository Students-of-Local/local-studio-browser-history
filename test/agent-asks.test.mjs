// The cards for what agents wait on (src/components/AgentAsks.ts): the side panel shows them above the chat and
// Settings > Agents lists the same ones, one click answers, and no question is lost or left behind.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addPendingRequest, clearPendingRequests, getPendingRequests, PENDING_KEY, recordDecision, removePendingRequest } from "../src/bridge/permissions.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const ask = (id, more = {}) => ({
	requestId: id,
	clientId: "c1",
	clientName: "claude",
	host: "news.example.com",
	url: "https://news.example.com/today",
	createdAt: 1,
	...more,
});
const upload = { files: [{ name: "cv.pdf", bytes: 2048 }] };
/** The card module fresh, as a newly opened panel loads it. */
const panel = () => import(`../src/components/AgentAsks.ts?ctx=${Math.random()}`);
/** storage.onChanged comes a moment after the write. */
const changed = () => new Promise((r) => setTimeout(r, 20));
/** A drawn card's click handlers, in order. */
const clicks = (section, i = 0) =>
	section.values[0][i].values
		.flat(Number.POSITIVE_INFINITY)
		.flatMap((v) => (v?.values ? v.values : [v]))
		.filter((v) => typeof v === "function");

test("each kind of question offers its own answers: an upload is never allowed for a whole site", async () => {
	installFakeChrome();
	const { askChoices, askLine } = await panel();
	assert.deepEqual(
		askChoices(ask("s")).map((c) => [c.decision, c.label]),
		[["allow_host", "Allow site"], ["allow_once", "Allow once"], ["deny", "Deny"]],
	);
	assert.deepEqual(
		askChoices(ask("u", { upload })).map((c) => [c.decision, c.label]),
		[["allow_once", "Upload this once"], ["deny", "Deny"]],
	);
	assert.equal(askLine(ask("s")), "claude wants to open news.example.com");
	assert.equal(askLine(ask("u", { upload })), "claude wants to upload a file from this computer to news.example.com");
	assert.equal(
		askLine(ask("u", { upload: { files: [...upload.files, ...upload.files] } })),
		"claude wants to upload 2 files from this computer to news.example.com",
	);
});

test("the side panel draws a waiting question; one click answers it and takes the card down", async () => {
	installFakeChrome();
	await addPendingRequest(ask("c1:q1"));
	const { agentAsks, watchAgentAsks } = await panel();
	assert.equal(typeof agentAsks(), "symbol", "nothing before it loads");
	let redraws = 0;
	await watchAgentAsks(() => redraws++);
	const buttons = clicks(agentAsks());
	assert.equal(buttons.length, 3);
	const before = redraws;
	await buttons[2]();
	await changed();
	assert.equal((await chrome.storage.session.get("bridge_decision_c1:q1"))["bridge_decision_c1:q1"], "deny");
	assert.equal(typeof agentAsks(), "symbol", "answered: the card is gone");
	assert.ok(redraws > before);
	// A question asked while the panel is open comes up, and one answered in the agent's own prompt goes.
	await addPendingRequest(ask("c1:q2"));
	await changed();
	assert.equal(clicks(agentAsks()).length, 3);
	await removePendingRequest("c1:q2");
	await changed();
	assert.equal(typeof agentAsks(), "symbol");
});

test("a question asked while the panel loads still comes up", async () => {
	installFakeChrome();
	const { agentAsks, watchAgentAsks } = await panel();
	const get = chrome.storage.session.get;
	// The panel's read takes a moment, and the question lands after it looked.
	chrome.storage.session.get = async (keys) => {
		const value = await get.call(chrome.storage.session, keys);
		chrome.storage.session.get = get;
		await addPendingRequest(ask("c1:late"));
		await changed();
		return value;
	};
	await watchAgentAsks(() => undefined);
	assert.notEqual(typeof agentAsks(), "symbol", "the late question is drawn");
});

test("two agents asking at once both get a card, an answer takes only its own, and a new worker starts with none", async () => {
	installFakeChrome();
	await Promise.all(["a", "b", "c"].map((id) => addPendingRequest(ask(id))));
	assert.deepEqual((await getPendingRequests()).map((p) => p.requestId).sort(), ["a", "b", "c"]);
	await Promise.all([recordDecision("a", "deny"), addPendingRequest(ask("d")), removePendingRequest("b")]);
	assert.deepEqual((await getPendingRequests()).map((p) => p.requestId).sort(), ["c", "d"]);
	await clearPendingRequests();
	assert.deepEqual(await getPendingRequests(), []);
	assert.equal((await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY], undefined);
	assert.match(read("src/bridge/native.ts"), /export function startBridge\(\): void \{\s*clearPendingRequests\(\)/);
});

test("the side panel and Settings > Agents draw the same card", () => {
	const side = read("src/sidepanel.ts");
	assert.match(side, /\$\{modeNotice\(\)\}\s*\$\{agentAsks\(\)\}/);
	// Every way the panel opens watches them: a new chat and a saved one.
	assert.equal(side.match(/watchAgentAsks\(renderApp\)/g).length, side.match(/watchBridgeQuestions\(renderApp\)/g).length);
	assert.match(read("src/dialogs/BridgeTab.ts"), /this\.pending\.map\(\(p\) => askCard\(p, \(d\) => this\.decide\(p, d\)\)\)/);
});
