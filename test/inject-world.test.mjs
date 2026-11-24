// injectScript on the debugger path (src/browser/inject.ts): the code, the binding it messages through and the replies all
// stay in an isolated world of the page, never in the page's own. Fake chrome with no userScripts.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
delete chrome.userScripts;
const sent = [];
const onEvent = [];
chrome.debugger.onEvent.addListener = (fn) => onEvent.push(fn);
let worldFails;
let evaluate = () => ({ result: { value: 2 } });
let context = 40;
chrome.debugger.sendCommand = async (_target, method, params) => {
	sent.push({ method, params });
	if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top" } } };
	if (method === "Page.createIsolatedWorld") {
		if (worldFails) throw new Error("No frame for given id found");
		return { executionContextId: ++context };
	}
	return method === "Runtime.evaluate" ? evaluate(params) : {};
};
const { injectScript, setCdpMessageHandler } = await import("../src/browser/inject.ts");
const tabId = (await chrome.tabs.create({ url: "https://shop.example.com/" })).id;
const of = (method) => sent.filter((c) => c.method === method).map((c) => c.params);

beforeEach(() => {
	sent.length = 0;
	worldFails = false;
	evaluate = () => ({ result: { value: 2 } });
});

test("the code runs in an isolated world of the page's top frame, and the binding is that world's only", async () => {
	const fresh = (await chrome.tabs.create({ url: "https://shop.example.com/two" })).id;
	assert.equal(await injectScript(fresh, "1 + 1"), 2);
	const [world] = of("Page.createIsolatedWorld");
	assert.equal(world.frameId, "top");
	assert.equal(world.grantUniveralAccess, false);
	const [binding] = of("Runtime.addBinding");
	assert.equal(binding.executionContextName, world.worldName);
	assert.ok(world.worldName);
	assert.deepEqual(of("Runtime.evaluate").map((p) => p.contextId), [context]);
});

test("a world of its own in each document: every run asks for the current one", async () => {
	await injectScript(tabId, "1");
	const first = context;
	await injectScript(tabId, "1");
	assert.deepEqual(of("Runtime.evaluate").map((p) => p.contextId), [first, first + 1]);
});

test("without a world nothing runs", async () => {
	worldFails = true;
	await assert.rejects(injectScript(tabId, "1 + 1"), /No frame for given id/);
	assert.deepEqual(of("Runtime.evaluate"), []);
});

test("a document that went before the code reached it: not run, and said so", async () => {
	evaluate = () => {
		throw new Error("Cannot find context with specified id");
	};
	await assert.rejects(injectScript(tabId, "1 + 1"), /Not run: the page changed/);
});

test("a message's reply goes back to the world it came from", async () => {
	setCdpMessageHandler(async () => ({ ok: true }));
	await injectScript(tabId, "1");
	sent.length = 0;
	const params = { name: "__tabkyraSend", payload: JSON.stringify({ id: 3, message: { type: "x" } }), executionContextId: 99 };
	for (const fn of onEvent) fn({ tabId }, "Runtime.bindingCalled", params);
	for (let i = 0; i < 100 && !of("Runtime.evaluate").length; i++) await new Promise((ok) => setTimeout(ok, 5));
	const [reply] = of("Runtime.evaluate");
	assert.equal(reply.contextId, 99);
	assert.match(reply.expression, /__tabkyraReceive\(3, \{"ok":true\}/);
});
