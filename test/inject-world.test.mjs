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
let announce;
let evaluate;
let context = 40;
/** What a context's unique id is in these tests: the integer id can be another page's, this can't. */
const unique = (id, page = "page") => `${page}.${id}`;
const emit = (tabId, method, params, sessionId) => {
	for (const fn of onEvent) fn({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params);
};
const created = (tabId, id, page, name, sessionId) =>
	emit(tabId, "Runtime.executionContextCreated", { context: { id, name, uniqueId: unique(id, page) } }, sessionId);
/** The name the runs' world goes by, as Chrome is asked for it. */
let worldName;
chrome.debugger.sendCommand = async ({ tabId }, method, params) => {
	sent.push({ method, params });
	if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top" } } };
	if (method === "Page.createIsolatedWorld") {
		if (worldFails) throw new Error("No frame for given id found");
		worldName = params.worldName;
		const id = ++context;
		announce(tabId, id, worldName);
		return { executionContextId: id };
	}
	return method === "Runtime.evaluate" ? evaluate(params, tabId) : {};
};
const { injectScript, setCdpMessageHandler } = await import("../src/browser/inject.ts");
const tabId = (await chrome.tabs.create({ url: "https://shop.example.com/" })).id;
const of = (method) => sent.filter((c) => c.method === method).map((c) => c.params);

beforeEach(() => {
	sent.length = 0;
	worldFails = false;
	announce = (id, context, name) => created(id, context, "page", name);
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
	assert.deepEqual(of("Runtime.evaluate").map((p) => [p.contextId, p.uniqueContextId]), [[undefined, unique(context)]]);
});

test("a world of its own in each document: every run asks for the current one", async () => {
	await injectScript(tabId, "1");
	const first = context;
	await injectScript(tabId, "1");
	assert.deepEqual(of("Runtime.evaluate").map((p) => p.uniqueContextId), [unique(first), unique(first + 1)]);
});

test("without a world nothing runs", async () => {
	worldFails = true;
	await assert.rejects(injectScript(tabId, "1 + 1"), /Not run: the page changed.*No frame for given id/);
	assert.deepEqual(of("Runtime.evaluate"), []);
});

test("the event that names the world can land after the answer", async () => {
	announce = (id, context, name) => void setTimeout(() => created(id, context, "page", name), 30);
	await injectScript(tabId, "1");
	assert.equal(of("Runtime.evaluate")[0].uniqueContextId, unique(context));
});

test("a world no event named runs nothing: another world, or a frame's own session, with its integer id is not it", async () => {
	announce = (id, context, name) => {
		created(id, context, "page", "someone-else");
		created(id, context, "frame", name, "frame-session");
	};
	await assert.rejects(injectScript(tabId, "1"), /Not run: the page changed/);
	assert.deepEqual(of("Runtime.evaluate"), []);
});

test("first-F2: the document went before the code reached it, and another took its integer id: not run, and said so", async () => {
	evaluate = (params) => {
		// Chrome runs by the integer id in whatever context holds it now, and by the unique id in that context only.
		if (params.contextId !== undefined) return { result: { value: "ran in the next page" } };
		throw new Error('{"code":-32602,"message":"uniqueContextId not found"}');
	};
	await assert.rejects(injectScript(tabId, "1 + 1"), /Not run: the page changed/);
});

test("cut off after it was sent: it may have acted, never not run", async () => {
	for (const why of ["Cannot find context with specified id", "Execution context was destroyed."]) {
		evaluate = () => {
			throw new Error(why);
		};
		const failed = injectScript(tabId, "1 + 1");
		await assert.rejects(failed, /sent to the page, then cut off.*may have acted/);
		await failed.catch((err) => assert.doesNotMatch(err.message, /Not run/));
	}
});

const ask = (id, executionContextId) =>
	emit(tabId, "Runtime.bindingCalled", { name: "__tabkyraSend", payload: JSON.stringify({ id, message: { type: "x" } }), executionContextId });
const settle = () => new Promise((ok) => setTimeout(ok, 50));

test("a message's reply goes back to the world it came from", async () => {
	setCdpMessageHandler(async () => ({ ok: true }));
	await injectScript(tabId, "1");
	sent.length = 0;
	ask(3, context);
	await settle();
	const [reply] = of("Runtime.evaluate");
	assert.deepEqual([reply.contextId, reply.uniqueContextId], [undefined, unique(context)]);
	assert.match(reply.expression, /__tabkyraReceive\(3, \{"ok":true\}/);
});

test("first-F1: the page went while its message was answered: the reply is still for that world only", async () => {
	let answer;
	setCdpMessageHandler(() => new Promise((ok) => (answer = ok)));
	await injectScript(tabId, "1");
	const asked = context;
	sent.length = 0;
	ask(4, asked);
	emit(tabId, "Runtime.executionContextsCleared", {});
	created(tabId, asked, "next", worldName);
	answer({ ok: true });
	await settle();
	assert.deepEqual(of("Runtime.evaluate").map((p) => [p.contextId, p.uniqueContextId]), [[undefined, unique(asked)]]);
});

test("a message from a context that is no live run world gets no reply, and is not handled", async () => {
	let handled = 0;
	setCdpMessageHandler(async () => void handled++);
	await injectScript(tabId, "1");
	sent.length = 0;
	ask(5, 99);
	emit(tabId, "Runtime.executionContextDestroyed", { executionContextId: context });
	ask(6, context);
	await settle();
	assert.equal(handled, 0);
	assert.deepEqual(of("Runtime.evaluate"), []);
});
