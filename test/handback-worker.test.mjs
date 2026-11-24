// The hand-back in the service worker (src/handback/worker.ts): an agent that gave up before its hand-back arrived never
// shows a card, and one that gives up while it arrives neither.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const record = { label: "Agent · claude", color: "blue" };

// Long enough for every step here; a wait nothing ends fails its test instead of holding it.
globalThis.__TYCHICUS_HANDBACK_MS = 3_000;
let ctx = 0;
async function start() {
	const fake = installFakeChrome();
	await chrome.tabs.create({ url: "https://example.com/" });
	const [tab] = await chrome.tabs.query({});
	const session = { id: "s1", tabIds: [tab.id], currentTabId: tab.id, record };
	const worker = await import(`../src/handback/worker.ts?ctx=${++ctx}`);
	worker.startHandback();
	return { fake, tab, worker, ask: (clientId, waitId) => worker.handleHandback({ clientId, session }, { reason: "Sign in", waitId }) };
}

const pending = async () => (await chrome.storage.session.get("handback_pending")).handback_pending ?? [];

test("a cancel that beats its hand-back in ends it unseen, for that client and call alone", async () => {
	const b = await start();
	assert.equal(b.worker.cancelHandback("c1", "w"), 0);
	assert.equal((await b.ask("c1", "w")).status, "aborted");
	assert.deepEqual(await pending(), []);

	b.worker.cancelHandback("c1", "w2");
	const theirs = b.ask("c2", "w2");
	await new Promise((r) => setTimeout(r, 100));
	assert.equal((await pending()).length, 1, "another client's call of the same name waits");
	assert.equal((await b.ask("c1", "w2")).status, "aborted");
	assert.equal((await pending()).length, 1, "a call already given up takes no other call's place");
	assert.equal(b.worker.cancelHandback("c2", "w2"), 1);
	assert.equal((await theirs).status, "aborted");

	b.worker.cancelHandback("c1", "w3");
	b.worker.cancelHandbacksFor("c1");
	const after = b.ask("c1", "w3");
	await new Promise((r) => setTimeout(r, 100));
	assert.equal((await pending()).length, 1, "a client that left takes its cancels with it");
	b.worker.cancelHandbacksFor(undefined);
	assert.equal((await after).status, "disconnected");
});

test("a cancel that lands while the hand-back looks its tab up ends it unseen", async () => {
	const b = await start();
	const get = chrome.tabs.get;
	chrome.tabs.get = async (id) => {
		b.worker.cancelHandback("c1", "w");
		return get(id);
	};
	assert.equal((await b.ask("c1", "w")).status, "aborted");
	assert.deepEqual(await pending(), []);
});
