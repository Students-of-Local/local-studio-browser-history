// The side panel's "Local Studio" provider: the picker lists Eukhe's local models before its subscriptions, each
// labeled; a turn sends only what is new; the daemon's session events become streamed text and tool steps; and stop
// sends Abort and ends the turn as aborted. The extension holds no key for any of it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EukheTurn, eukheTarget, LOCAL_STUDIO_API, LOCAL_STUDIO_PROVIDER, panelModels, turnPrompt } from "../src/eukhe/models.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const MODELS = [
	{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
	{ id: "lfm2.5-8b", name: "LFM 2.5 8B", provider: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1" },
	{ id: "claude-opus-5-5", provider: "anthropic", baseUrl: "https://api.anthropic.com" },
	{ id: "qwen", provider: "fleet", baseUrl: "http://192.168.1.20:8000/v1" },
];

test("local models come first, then the sign-ins, each labeled, under the Local Studio provider", () => {
	const models = panelModels(MODELS);
	assert.deepEqual(
		models.map((m) => m.name),
		["LFM 2.5 8B (local)", "qwen (local network)", "GPT-5.5 (ChatGPT plan)", "claude-opus-5-5 (Claude sign-in)"],
	);
	for (const m of models) {
		assert.equal(m.provider, LOCAL_STUDIO_PROVIDER);
		assert.equal(m.api, LOCAL_STUDIO_API);
	}
	// The real base URL rides along, so private mode judges where prompts really go.
	assert.equal(models[0].baseUrl, "http://127.0.0.1:8080/v1");
	assert.deepEqual(eukheTarget(models[0].id), { provider: "llamacpp", model: "lfm2.5-8b" });
	assert.deepEqual(eukheTarget("openai-codex/gpt-5.5"), { provider: "openai-codex", model: "gpt-5.5" });
});

test("a turn sends what is new; a fresh session for an old chat gets the earlier turns first", () => {
	const nav = {
		role: "user",
		content: "<browser-context>\nNavigation succeeded: Example Domain\nURL: https://example.com/\nSkills: a, b\n</browser-context>",
	};
	const context = {
		messages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
			nav,
			{ role: "user", content: [{ type: "text", text: "read this page" }] },
		],
	};
	assert.equal(turnPrompt(context, false), "Current tab: Example Domain https://example.com/\n\nread this page");
	assert.equal(
		turnPrompt(context, true),
		"Earlier in this chat:\n\nUser: hi\n\nAssistant: Hello.\n\nNow:\n\nCurrent tab: Example Domain https://example.com/\n\nread this page",
	);
});

const MODEL = panelModels(MODELS)[0];
const event = (e) => ({ type: "session_event", activeSessionId: "s1", event: e });
const textDelta = (delta) => event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });

test("session events become streamed text, and each tool the session ran becomes a step", () => {
	const pushed = [];
	const turn = new EukheTurn(MODEL, (e) => pushed.push(e));
	turn.take(textDelta("Reading "));
	turn.take(textDelta("the page."));
	turn.take(event({ type: "tool_execution_start", toolCallId: "t1", toolName: "get_page_text", args: { tabId: 3 } }));
	turn.take(event({ type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: "Hello world" }] }, isError: false }));
	turn.take({ type: "shell_refused", activeSessionId: "s1", command: "rm -rf /" });
	turn.take(textDelta("It says hello."));
	turn.take(event({ type: "agent_end" }));
	assert.deepEqual(
		pushed.map((e) => e.type),
		[
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		],
	);
	assert.deepEqual(turn.output.content, [
		{ type: "text", text: "Reading the page." },
		{ type: "thinking", thinking: 'Ran get_page_text {"tabId":3}\nDone: Hello world' },
		{ type: "thinking", thinking: "Shell step refused: the side panel runs no shell commands (rm -rf /)" },
		{ type: "text", text: "It says hello." },
	]);
	// No tool call reaches the panel's agent: Eukhe ran the tools already.
	assert.ok(turn.output.content.every((c) => c.type !== "toolCall"));
	assert.equal(turn.output.stopReason, "stop");
});

test("a failed turn and a closed session end the stream with an error", () => {
	const pushed = [];
	const turn = new EukheTurn(MODEL, (e) => pushed.push(e));
	turn.take(event({ type: "turn_end", error: "model refused" }));
	turn.take(event({ type: "agent_end" }));
	assert.equal(pushed.at(-1).type, "error");
	assert.equal(turn.output.errorMessage, "model refused");

	const closed = new EukheTurn(MODEL, () => {});
	closed.take({ type: "session_closed", reason: "killed" });
	assert.equal(closed.output.stopReason, "error");
	assert.match(closed.output.errorMessage, /closed the session \(killed\)/);
});

/**
 * A fake background port: answers the panel's Eukhe requests the way the host relay does, with a turn that streams
 * until it is aborted.
 */
let runtime;
/** One fake for the whole file: the panel's client keeps the port it first opened. */
function fakeRuntime() {
	if (runtime) {
		runtime.sent.length = 0;
		return runtime;
	}
	const sent = [];
	const messageListeners = [];
	const reply = (r) => setTimeout(() => messageListeners.forEach((l) => l(r)), 1);
	const aborted = new Set();
	let sessions = 0;
	const port = {
		postMessage(req) {
			sent.push(req);
			const c = req.command ?? {};
			if (req.op === "probe") return reply({ id: req.id, conversation: req.conversation, result: { reachable: true } });
			if (c.type === "create") return reply({ id: req.id, conversation: req.conversation, result: { activeSessionId: `s${++sessions}` } });
			if (c.type === "attach") return reply({ id: req.id, conversation: req.conversation, result: {} });
			if (c.type === "get_available_models") return reply({ id: req.id, conversation: req.conversation, result: { models: MODELS } });
			if (c.type === "kill" || req.op === "close") return req.id && reply({ id: req.id, conversation: req.conversation, result: {} });
			if (c.type === "abort") {
				aborted.add(req.conversation);
				reply({ id: req.id, conversation: req.conversation, result: {} });
				return reply({ conversation: req.conversation, event: event({ type: "agent_end" }) });
			}
			if (c.type === "prompt") {
				aborted.delete(req.conversation);
				reply({ id: req.id, conversation: req.conversation, result: { accepted: true } });
				let n = 0;
				const tick = setInterval(() => {
					if (aborted.has(req.conversation) || n > 200) return clearInterval(tick);
					reply({ conversation: req.conversation, event: textDelta(`word${n++} `) });
				}, 5);
			}
		},
		onMessage: { addListener: (l) => messageListeners.push(l) },
		onDisconnect: { addListener: () => {} },
	};
	globalThis.chrome = { runtime: { connect: () => port } };
	runtime = { sent };
	return runtime;
}

test("a chat runs as Create, Attach, Prompt in its own session, and stop sends Abort and ends the turn as aborted", async () => {
	const { sent } = fakeRuntime();
	const { streamLocalStudio } = await import("../src/eukhe/stream.ts");
	const controller = new AbortController();
	const context = { systemPrompt: "sys", messages: [{ role: "user", content: "read this page", timestamp: 1 }] };
	const stream = streamLocalStudio(MODEL, context, { signal: controller.signal });
	const types = [];
	let final;
	for await (const e of stream) {
		types.push(e.type);
		if (e.type === "text_delta" && types.filter((t) => t === "text_delta").length === 3) controller.abort();
		if (e.type === "done" || e.type === "error") final = e;
	}
	const commands = sent.filter((r) => r.op === "command").map((r) => r.command.type);
	assert.deepEqual(commands.slice(0, 4), ["create", "attach", "prompt", "abort"]);
	const create = sent.find((r) => r.command?.type === "create").command;
	assert.deepEqual(create.config, { provider: "llamacpp", model: "lfm2.5-8b" });
	// No lastLocal set yet in this process (models were never listed), so no profile hint; the installed MCP entry pins it.
	assert.equal(sent.find((r) => r.command?.type === "prompt").command.message, "read this page");
	assert.equal(final.type, "error");
	assert.equal(final.reason, "aborted");
	assert.equal(final.error.stopReason, "aborted");
	assert.ok(types.filter((t) => t === "text_delta").length >= 3);
});

test("each chat gets its own session, and a local model's session asks for the small tool profile", async () => {
	const { sent } = fakeRuntime();
	const { refreshLocalStudioModels, streamLocalStudio } = await import("../src/eukhe/stream.ts");
	const listed = await refreshLocalStudioModels();
	assert.equal(listed[0].id, "llamacpp/lfm2.5-8b");
	const run = async (model, first) => {
		const controller = new AbortController();
		const context = { systemPrompt: "sys", messages: [{ role: "user", content: first, timestamp: 2 }] };
		for await (const e of streamLocalStudio(model, context, { signal: controller.signal })) if (e.type === "text_delta") controller.abort();
	};
	const local = listed.find((m) => m.id === "llamacpp/lfm2.5-8b");
	const plan = listed.find((m) => m.id === "openai-codex/gpt-5.5");
	// Each run is stopped by its own abort; only the create commands matter here.
	const creates = () => sent.filter((r) => r.command?.type === "create" && r.command.config.provider);
	const before = creates().length;
	await Promise.all([run(local, "chat one"), run(plan, "chat two")]);
	const [a, b] = creates().slice(before);
	assert.notEqual(a.conversation, b.conversation, "two chats, two sessions");
	const byProvider = Object.fromEntries([a, b].map((r) => [r.command.config.provider, r.command]));
	assert.deepEqual(byProvider.llamacpp.env, { TYCHICUS_PROFILE: "small" });
	assert.equal(byProvider["openai-codex"].env, undefined);
	assert.ok(sent.some((r) => r.command?.type === "kill"), "the session used only to list models was ended");
});

test("the Local Studio code holds no key and stores nothing", () => {
	for (const name of readdirSync(join(repo, "src", "eukhe"))) {
		const text = readFileSync(join(repo, "src", "eukhe", name), "utf8");
		assert.doesNotMatch(text, /providerKeys|apiKey|chrome\.storage|localStorage|indexedDB/, name);
	}
});
