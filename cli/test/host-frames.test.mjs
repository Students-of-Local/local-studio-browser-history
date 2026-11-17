// The native host process as Chrome runs it. It answers only the pinned extension: started for another extension's
// origin, it exits before it reads a frame or opens its socket, so no pairing code is needed. And a frame over Chrome's
// 1 MB host-to-extension cap (a 3 MB screenshot in a Local Studio tool result) arrives in pieces the extension joins,
// instead of being refused.
import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTs } from "./helpers/bundle-ts.mjs";
import { startFakeEukhe } from "./helpers/fake-eukhe.mjs";

const { ChunkAssembler, chunkFrame, MAX_FRAME_TO_EXTENSION } = await loadTs(
	`export { ChunkAssembler, chunkFrame } from "@src/../../src/bridge/chunks.ts"; export { MAX_FRAME_TO_EXTENSION } from "@src/../../src/bridge/protocol.ts";`,
);

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const posix = process.platform !== "win32";
const ORIGIN = `chrome-extension://${extensionId.id}/`;
/** Chrome's own limit on one message from a native host. */
const CHROME_CAP = 1024 * 1024;

function sandbox(t) {
	const home = mkdtempSync(join(process.env.TMPDIR || "/tmp", "host-frames-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const sockets = join(home, "s");
	const env = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_STATE_HOME: join(home, ".local/state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		TYCHICUS_SOCKET_DIR: sockets,
	};
	return { home, sockets, env };
}

const encode = (message) => {
	const body = Buffer.from(JSON.stringify(message));
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
};

/** Read native-messaging frames from the host's stdout; `sizes` keeps each frame's byte length. */
function reader(stream) {
	let buffer = Buffer.alloc(0);
	const frames = [];
	const sizes = [];
	stream.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const n = buffer.readUInt32LE(0);
			if (buffer.length < 4 + n) break;
			sizes.push(n);
			frames.push(JSON.parse(buffer.subarray(4, 4 + n).toString("utf8")));
			buffer = buffer.subarray(4 + n);
		}
	});
	return { frames, sizes };
}

const until = async (fn, ms, what) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
};

test("the host refuses an extension that is not Tychicus before it reads a frame", { skip: !posix && "sockets", timeout: 20_000 }, async (t) => {
	const { sockets, env } = sandbox(t);
	const other = spawn(process.execPath, [cli, "host", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], { env, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	other.stdout.on("data", (d) => {
		stdout += d;
	});
	other.stderr.on("data", (d) => {
		stderr += d;
	});
	// stdin stays open, with a hello waiting: a host that read it would answer.
	other.stdin.write(encode({ type: "hello", version: "0", protocol: 1, methods: [], features: ["chunks"] }));
	const code = await new Promise((r) => other.once("exit", r));
	assert.equal(code, 1);
	assert.match(stderr, /is not the Tychicus extension/);
	assert.equal(stdout, "", "nothing was sent to the other extension");
	assert.ok(!existsSync(sockets) || readdirSync(sockets).length === 0, "no socket was opened for it");

	// The pinned extension: the host starts, listens and answers.
	const ours = spawn(process.execPath, [cli, "host", ORIGIN], { env, stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => ours.kill("SIGKILL"));
	const out = reader(ours.stdout);
	ours.stdin.write(encode({ type: "hello", version: "0", protocol: 1, methods: [], features: ["chunks"] }));
	await until(() => existsSync(sockets) && readdirSync(sockets).some((f) => f === `${ours.pid}.sock`), 10_000, "the host's socket");
	await until(() => out.frames.length > 0, 10_000, "a frame from the host");
	const exited = new Promise((r) => ours.once("exit", r));
	ours.stdin.end();
	assert.equal(await exited, 0);
});

test("pieces of a 3 MB frame join back exactly, each under Chrome's cap", async () => {
	const image = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64");
	const frame = { type: "eukhe", conversation: "c", event: { type: "session_event", event: { type: "tool_execution_end", result: { content: [{ type: "image", data: image, mimeType: "image/png" }] } } } };
	const json = new TextEncoder().encode(JSON.stringify(frame));
	const pieces = chunkFrame(json, 9);
	assert.ok(pieces.length >= 5, `${pieces.length} pieces`);
	const assembler = new ChunkAssembler();
	let joined;
	for (const piece of pieces) {
		assert.ok(encode(piece).length <= MAX_FRAME_TO_EXTENSION, "each piece fits one native message");
		const r = assembler.push(piece);
		assert.equal(r.error, undefined);
		if (r.message) joined = r.message;
	}
	assert.deepEqual(joined, frame);
	assert.equal(assembler.pending, 0);
	// A lost piece drops the frame, it never joins wrong.
	const broken = new ChunkAssembler();
	broken.push(pieces[0]);
	assert.match(broken.push(pieces[2]).error ?? "", /expected piece 1/);
});

test("a 3 MB screenshot result from Local Studio reaches the extension in pieces, not refused", { skip: !posix && "sockets", timeout: 30_000 }, async (t) => {
	const { home, env } = sandbox(t);
	const image = Buffer.alloc(3 * 1024 * 1024, 1).toString("base64");
	const daemon = await startFakeEukhe({
		path: join(home, "eukhe", "daemon.sock"),
		turn: async (turn) => {
			await turn.tool("screenshot", {}, async () => ({ content: [{ type: "image", data: image, mimeType: "image/png" }] }));
			await turn.delta("Here it is.");
		},
	});
	t.after(() => daemon.close());

	const run = async (features) => {
		const host = spawn(process.execPath, [cli, "host", ORIGIN], { env: { ...env, EUKHE_DAEMON_SOCKET: daemon.path }, stdio: ["pipe", "pipe", "pipe"] });
		t.after(() => host.kill("SIGKILL"));
		const out = reader(host.stdout);
		const send = (m) => host.stdin.write(encode(m));
		send({ type: "hello", version: "0", protocol: 1, methods: [], features });
		const answer = async (id) => until(() => out.frames.find((f) => f.type === "eukhe" && f.id === id), 10_000, `answer ${id}`);
		send({ type: "eukhe", id: 1, conversation: "chat", op: "command", command: { type: "create", config: {} } });
		const session = (await answer(1)).result.activeSessionId;
		send({ type: "eukhe", id: 2, conversation: "chat", op: "command", command: { type: "attach", activeSessionId: session } });
		await answer(2);
		send({ type: "eukhe", id: 3, conversation: "chat", op: "command", command: { type: "prompt", activeSessionId: session, message: "screenshot" } });
		await answer(3);
		// agent_end is small and comes last: everything before it was written.
		await until(() => out.frames.some((f) => f.event?.event?.type === "agent_end"), 15_000, "the end of the turn");
		const exited = new Promise((r) => host.once("exit", r));
		host.stdin.end();
		await exited;
		return out;
	};

	const chunked = await run(["chunks", "eukhe"]);
	assert.ok(Math.max(...chunked.sizes) <= CHROME_CAP, `largest frame ${Math.max(...chunked.sizes)} bytes`);
	const assembler = new ChunkAssembler();
	const whole = [];
	for (const f of chunked.frames) {
		if (f.type !== "chunk") continue;
		const r = assembler.push(f);
		assert.equal(r.error, undefined);
		if (r.message) whole.push(r.message);
	}
	const shot = whole.find((m) => m.event?.event?.type === "tool_execution_end");
	assert.ok(shot, "the screenshot result arrived");
	assert.equal(shot.event.event.result.content[0].data, image, "byte for byte");

	// An extension from before pieces is not sent a frame it would choke on (Chrome would close the port).
	const old = await run([]);
	assert.ok(Math.max(...old.sizes) <= CHROME_CAP);
	assert.equal(old.frames.filter((f) => f.type === "chunk").length, 0);
});
