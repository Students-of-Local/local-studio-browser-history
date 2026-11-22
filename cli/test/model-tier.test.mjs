// "Match the model" site access (docs/decisions.md, D60): which tier a model name gets, which tier an MCP session
// reports, and that the bridge hello carries it. Local Studio's Rust copy of the rules gives the same 45 answers.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { modelTier, sessionTier } from "../src/model-tier.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const F = "frontier";
const S = "small";
const U = "unknown";
const CASES = [
	["claude-opus-5-5", F],
	["opus", F],
	["opus[1m]", F],
	["sonnet", F],
	["haiku", S],
	["claude-haiku-4-5-20251001", S],
	["claude-sonnet-4-5", S],
	["claude-sonnet-4-6", F],
	["claude-3-7-sonnet-latest", S],
	["claude-fable-5-2", F],
	["anthropic/claude-opus-4-5", F],
	["gpt-6.1-sol", F],
	["gpt-5.6-sol", F],
	["gpt-5.2-codex", F],
	["gpt-5.1-codex", S],
	["gpt-5", S],
	["gpt-5-mini", S],
	["gpt-4o", S],
	["gpt-oss-120b", S],
	["o3", U],
	["gemini-3-pro-preview", F],
	["gemini-3-flash", F],
	["gemini-3.1-flash-lite", S],
	["gemini-2.5-pro", S],
	["grok-4.5", F],
	["grok-4", S],
	["grok-code-fast-1", U],
	["deepseek-v4-pro", F],
	["deepseek-v3.2", S],
	["deepseek-r1", U],
	["kimi-k3", F],
	["kimi-k2.5", S],
	["glm-5.3", F],
	["glm-5", S],
	["minimax-m3", F],
	["MiniMax-M2.7", S],
	["qwen3.8-max", F],
	["qwen3.8-27b", S],
	["qwen3-coder:30b", S],
	["qwen3-coder-480b-a35b", S],
	["llama3.3:70b", S],
	["fv-smoke-lfm3-1.7b", S],
	["mistral-large-3", S],
	["devstral-2", S],
	["mystery-model", U],
];

test("modelTier gives the 45 agreed answers", () => {
	assert.equal(CASES.length, 45);
	const wrong = CASES.filter(([model, want]) => modelTier(model) !== want).map(([model, want]) => `${model}: got ${modelTier(model)}, want ${want}`);
	assert.deepEqual(wrong, []);
});

test("modelTier: a size under 100B is small whatever the family, and active-parameter tokens don't count", () => {
	assert.equal(modelTier("qwen3.8-max-8x7b"), S, "8x7b is 56B");
	assert.equal(modelTier("kimi-k3-a3b"), F, "a3b is active parameters, not size");
	assert.equal(modelTier("gemini-3-e4b"), F, "e4b starts with a letter");
	assert.equal(modelTier("glm-5.3-355b"), F, "355B is not small");
	assert.equal(modelTier("claude-opus-4-5-20251101"), F, "a date ends the version");
});

test("sessionTier: a named model wins, then the small profile, then Claude Code and Codex; the rest are unknown", () => {
	assert.deepEqual(sessionTier({ model: "claude-haiku-4-5", clientName: "claude-code" }), { tier: S, model: "claude-haiku-4-5" });
	assert.deepEqual(sessionTier({ model: "gpt-6.1-sol", clientName: "mystery" }), { tier: F, model: "gpt-6.1-sol" });
	for (const name of ["claude-code", "claude-ai", "claude", "codex", "codex-mcp-client", "codex_cli", "Claude-Code"]) assert.deepEqual(sessionTier({ clientName: name }), { tier: F }, name);
	assert.deepEqual(sessionTier({ clientName: "claude-code", small: true }), { tier: S }, "a local model under Claude Code asks");
	assert.deepEqual(sessionTier({ clientName: "LM Studio", small: true }), { tier: S });
	assert.deepEqual(sessionTier({ clientName: "cursor-vscode" }), { tier: U });
	assert.deepEqual(sessionTier({}), { tier: U });
	assert.deepEqual(sessionTier({ model: "  ", clientName: "codex" }), { tier: F }, "a blank model names none");
});

// ---- the hello the MCP server sends -------------------------------------------------------------

let root;
before(() => {
	root = mkdtempSync(join(tmpdir(), "tychicus-tier-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

const frame = (m) => {
	const body = Buffer.from(JSON.stringify(m));
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
};

/** Start `mcp` as client `name` against a fake host and return the first frame it sends: its hello. */
async function helloFrom(name, env = {}) {
	const dir = mkdtempSync(join(root, "sock-"));
	chmodSync(dir, 0o700);
	const home = join(dir, "home");
	mkdirSync(home);
	const path = join(dir, `${process.pid}.sock`);
	let gotHello;
	const hello = new Promise((resolve) => {
		gotHello = resolve;
	});
	const server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (buffered.length < 4 || buffered.length < 4 + buffered.readUInt32LE(0)) return;
			gotHello(JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32LE(0)).toString("utf8")));
			socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: false }));
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	const client = new Client({ name, version: "0.0.0" });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [cli, "mcp"],
				env: { HOME: home, PATH: dirname(process.execPath), TYCHICUS_SOCKET_DIR: dir, ...env },
				stderr: "ignore",
			}),
		);
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("no hello within 10 s")), 10000);
		});
		return await Promise.race([hello, timeout]).finally(() => clearTimeout(timer));
	} finally {
		await client.close().catch(() => {});
		server.close();
	}
}

test("the bridge hello carries the session's tier, and the model when one is named", async () => {
	const claude = await helloFrom("claude-code");
	assert.equal(claude.type, "hello");
	assert.equal(claude.client.tier, F);
	assert.equal(claude.client.model, undefined);
	const haiku = await helloFrom("claude-code", { TYCHICUS_MODEL: "claude-haiku-4-5" });
	assert.equal(haiku.client.tier, S);
	assert.equal(haiku.client.model, "claude-haiku-4-5");
	const inherited = await helloFrom("some-client", { POLYCARP_MODEL: "gpt-6.1-sol" });
	assert.equal(inherited.client.tier, F, "POLYCARP_MODEL is read too");
	assert.equal((await helloFrom("LM Studio")).client.tier, S, "a local-model client is small");
	assert.equal((await helloFrom("codex-mcp-client", { TYCHICUS_LOCAL_MODEL: "1" })).client.tier, S);
	assert.equal((await helloFrom("some-client")).client.tier, U);
});
