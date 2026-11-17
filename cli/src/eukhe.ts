/**
 * The side panel's Local Studio chats: the native host relays them to the Eukhe daemon (Local Studio's agent runtime)
 * and the daemon's answers and session events back. The extension holds no key: the daemon runs the model (a local one,
 * or a subscription signed in with `eukhe /login`) and its own tools, the browser ones through the `tychicus` MCP entry
 * `tychicus install --local-studio` writes.
 *
 *   panel -> background -> native port -> host (this file) -> daemon.sock -> Eukhe session -> model -> tool calls
 *     -> `tychicus mcp` -> host socket -> extension
 *
 * The daemon speaks JSON lines on a Unix socket and trusts its peer's uid (eukhe 452f1be, eukhe-types
 * platform/transport.rs). It greets every connection with `daemon_hello`; a command goes in a `type: "command"` envelope
 * and its answer comes back as `type: "response"` with the same id. Session events reach only connections attached to
 * the session.
 *
 * What the panel may do is narrow on purpose: the commands in EUKHE_COMMANDS, each on a session this chat created, attached
 * as an interactive client. Every shell step a session asks about is refused here, so a panel chat never runs a shell
 * command, whatever the model or a page says.
 */

import { lstatSync, type Stats } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtEukhe, HostEukhe, RpcError } from "../../src/bridge/protocol.ts";
import { ERR } from "../../src/bridge/protocol.ts";

/** The daemon protocol this relay speaks (eukhe-types daemon PROTOCOL: eukhe.daemon v7). */
export const EUKHE_PROTOCOL = { name: "eukhe.daemon", version: 7 } as const;
/** How long a daemon has to say hello before it counts as not running. */
export const EUKHE_HELLO_MS = 1500;

/** Daemon commands the side panel may send. */
export const EUKHE_COMMANDS: ReadonlySet<string> = new Set([
	"create",
	"attach",
	"detach",
	"prompt",
	"abort",
	"kill",
	"get_available_models",
	"get_model_catalog",
	"set_model",
	"get_last_assistant_text",
]);

/** Daemon frames passed on to the panel; the rest (roster, list progress) are none of its business. */
const FORWARDED = new Set(["session_event", "session_closed"]);

/**
 * The daemon socket, resolved as Eukhe resolves it (eukhe-client paths.rs): a non-empty EUKHE_DAEMON_SOCKET (with `~`
 * expanded), else `daemon.sock` in `eukhe-<uid>` under TMPDIR, else under /tmp.
 */
export function eukheSocketPath(env: NodeJS.ProcessEnv = process.env, uid: number | undefined = process.getuid?.()): string {
	const explicit = env.EUKHE_DAEMON_SOCKET;
	if (explicit) {
		if (explicit === "~") return env.HOME ?? explicit;
		if (explicit.startsWith("~/") && env.HOME) return join(env.HOME, explicit.slice(2));
		return explicit;
	}
	return join(env.TMPDIR || "/tmp", `eukhe-${uid ?? 0}`, "daemon.sock");
}

/** The error a panel gets when no daemon answers, with what to do about it. */
export function unavailable(path: string, platform: string = process.platform, why?: string): RpcError {
	if (platform === "win32")
		return {
			code: ERR.EUKHE_UNAVAILABLE,
			message: "Local Studio chats are not on Windows yet. Use an API key instead, or drive this browser from your own agent.",
		};
	return {
		code: ERR.EUKHE_UNAVAILABLE,
		message: `Local Studio's Eukhe daemon is not running (${why ?? "no answer"} at ${path}). Start Local Studio, or run \`eukhe\` in a terminal, then try again.`,
	};
}

interface DaemonLink {
	socket: Socket;
	protocol: { name: string; version: number };
	hello: Record<string, unknown>;
}

/**
 * Why the daemon socket can't be trusted, or undefined. Eukhe checks its client's uid; this side checks the server's:
 * the socket's folder must be a real folder of this user's that no one else can write to, and the socket this user's.
 * Otherwise another user on the machine could make the folder first (it sits in /tmp when TMPDIR is unset) and receive
 * the panel's chats. Not on Windows, which has no Local Studio chats yet.
 */
export function untrustedSocket(path: string): string | undefined {
	if (process.platform === "win32" || typeof process.getuid !== "function") return undefined;
	const uid = process.getuid();
	let dir: Stats;
	try {
		dir = lstatSync(dirname(path));
	} catch {
		return undefined; // No folder: the connect says "no socket".
	}
	if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o022) !== 0)
		return `its folder ${dirname(path)} is not a private folder of this user's`;
	try {
		if (lstatSync(path).uid !== uid) return "the socket belongs to another user";
	} catch {
		/* No socket: the connect says so. */
	}
	return undefined;
}

/**
 * Open the daemon socket and wait for its hello. Rejects with an RpcError (eukhe_unavailable) when nothing listens, the
 * peer does not greet within `helloMs`, or it greets as something other than the Eukhe daemon.
 */
export function connectDaemon(
	path: string,
	onFrame: (frame: Record<string, unknown>) => void,
	onClose: () => void,
	helloMs: number = EUKHE_HELLO_MS,
): Promise<DaemonLink> {
	return new Promise((resolve, reject) => {
		const untrusted = untrustedSocket(path);
		if (untrusted) {
			reject(unavailable(path, process.platform, untrusted));
			return;
		}
		let greeted = false;
		let buffer = "";
		const socket = createConnection(path);
		const fail = (why: string) => {
			if (greeted) return;
			greeted = true;
			clearTimeout(timer);
			socket.destroy();
			reject(unavailable(path, process.platform, why));
		};
		const timer = setTimeout(() => fail(`no hello within ${helloMs} ms`), helloMs);
		socket.setEncoding("utf8");
		socket.on("error", (err: NodeJS.ErrnoException) => fail(err.code === "ENOENT" ? "no socket" : (err.code ?? err.message)));
		socket.on("close", () => {
			if (!greeted) fail("the connection closed before the hello");
			else onClose();
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let cut = buffer.indexOf("\n");
			while (cut >= 0) {
				const line = buffer.slice(0, cut).trim();
				buffer = buffer.slice(cut + 1);
				cut = buffer.indexOf("\n");
				if (!line) continue;
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(line);
				} catch {
					if (!greeted) fail("a greeting that is not JSON");
					continue;
				}
				if (!greeted) {
					if (frame.type !== "daemon_hello") continue;
					const p = frame.protocol as { name?: unknown; version?: unknown } | undefined;
					if (p?.name !== EUKHE_PROTOCOL.name) {
						fail(`a daemon that speaks ${String(p?.name ?? "an unknown protocol")}`);
						return;
					}
					greeted = true;
					clearTimeout(timer);
					// Envelopes carry the lower of the two versions, as Eukhe's own client does.
					const version = typeof p.version === "number" ? Math.min(p.version, EUKHE_PROTOCOL.version) : EUKHE_PROTOCOL.version;
					resolve({ socket, protocol: { name: EUKHE_PROTOCOL.name, version }, hello: frame });
					continue;
				}
				onFrame(frame);
			}
		});
	});
}

/**
 * The create command a panel chat may send, built from an allowlist: the provider and model, whether to keep a session
 * file, and the small tool profile hint. The session lives only as long as the panel's connection (client_owned) and
 * works in the home folder, as Local Studio's own sessions do; neither can be changed from the extension.
 */
export function panelCreate(raw: Record<string, unknown>): Record<string, unknown> {
	const asked = raw.config && typeof raw.config === "object" && !Array.isArray(raw.config) ? (raw.config as Record<string, unknown>) : {};
	const config: Record<string, unknown> = {};
	for (const key of ["provider", "model"] as const) if (typeof asked[key] === "string" && asked[key]) config[key] = asked[key];
	config.cwd = homedir();
	const env = raw.env as Record<string, unknown> | undefined;
	return {
		type: "create",
		lifecycle: "client_owned",
		config,
		...(typeof raw.noSession === "boolean" ? { noSession: raw.noSession } : {}),
		...(env?.TYCHICUS_PROFILE === "small" ? { env: { TYCHICUS_PROFILE: "small" } } : {}),
	};
}

interface Conversation {
	link: Promise<DaemonLink>;
	/** Envelope id -> the extension's request id. */
	pending: Map<string, number>;
	/** Sessions this chat created: the only ones its commands may name. */
	sessions: Set<string>;
	/** Envelope ids of create commands, whose answer names a new session. */
	creates: Set<string>;
	closed: boolean;
}

/** One per native host. `send` writes a frame to the extension. */
export class EukheRelay {
	private readonly conversations = new Map<string, Conversation>();
	private seq = 0;

	constructor(
		private readonly send: (frame: HostEukhe) => void,
		private readonly options: { socketPath?: () => string; helloMs?: number; platform?: string } = {},
	) {}

	private path(): string {
		return this.options.socketPath?.() ?? eukheSocketPath();
	}

	private reply(conversation: string, id: number, answer: { result?: unknown; error?: RpcError }): void {
		this.send({ type: "eukhe", conversation, id, ...answer });
	}

	handle(message: ExtEukhe): void {
		const { id, conversation, op } = message;
		if (typeof id !== "number" || typeof conversation !== "string" || !conversation || conversation.length > 200) return;
		if ((this.options.platform ?? process.platform) === "win32") {
			this.reply(conversation, id, { error: unavailable(this.path(), "win32") });
			return;
		}
		if (op === "probe") {
			void this.probe(conversation, id);
			return;
		}
		if (op === "close") {
			this.close(conversation);
			this.reply(conversation, id, { result: { closed: true } });
			return;
		}
		if (op !== "command") {
			this.reply(conversation, id, { error: { code: ERR.BAD_PARAMS, message: `Unknown op ${String(op)}` } });
			return;
		}
		const checked = this.check(conversation, message.command);
		if ("error" in checked) {
			this.reply(conversation, id, { error: checked.error });
			return;
		}
		void this.forward(conversation, id, checked.command);
	}

	/** Is a daemon there? Its hello, on a connection of its own that closes at once. */
	private async probe(conversation: string, id: number): Promise<void> {
		try {
			const link = await connectDaemon(this.path(), () => undefined, () => undefined, this.options.helloMs);
			link.socket.end();
			this.reply(conversation, id, {
				result: { reachable: true, appVersion: link.hello.appVersion, protocol: link.protocol },
			});
		} catch (err) {
			this.reply(conversation, id, { error: asRpcError(err) });
		}
	}

	/** Only an allowed command, on a session this chat made, attached as an interactive client. */
	private check(conversation: string, raw: unknown): { command: Record<string, unknown> } | { error: RpcError } {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: { code: ERR.BAD_PARAMS, message: "command must be an object" } };
		const command = { ...(raw as Record<string, unknown>) };
		const type = command.type;
		if (typeof type !== "string" || !EUKHE_COMMANDS.has(type))
			return { error: { code: ERR.PERMISSION_DENIED, message: `The side panel may not send ${JSON.stringify(type)} to Eukhe.` } };
		delete command.id;
		if (type === "create") return { command: panelCreate(command) };
		const session = command.activeSessionId;
		const own = this.conversations.get(conversation)?.sessions;
		if (typeof session !== "string" || !own?.has(session))
			return { error: { code: ERR.PERMISSION_DENIED, message: "That Eukhe session was not opened by this chat." } };
		// A gateway client would let a session run shell steps unasked; a panel is always interactive.
		if (type === "attach") command.clientKind = "interactive";
		return { command };
	}

	private conversation(name: string): Conversation {
		const existing = this.conversations.get(name);
		if (existing && !existing.closed) return existing;
		const conv: Conversation = { link: Promise.resolve() as never, pending: new Map(), sessions: new Set(), creates: new Set(), closed: false };
		conv.link = connectDaemon(
			this.path(),
			(frame) => this.onDaemonFrame(name, conv, frame),
			() => this.onDaemonClose(name, conv),
			this.options.helloMs,
		);
		// A failed connect is reported to each waiting command; it must not reject unobserved.
		conv.link.catch(() => {
			conv.closed = true;
			if (this.conversations.get(name) === conv) this.conversations.delete(name);
		});
		this.conversations.set(name, conv);
		return conv;
	}

	private async forward(conversation: string, id: number, command: Record<string, unknown>): Promise<void> {
		const conv = this.conversation(conversation);
		let link: DaemonLink;
		try {
			link = await conv.link;
		} catch (err) {
			this.reply(conversation, id, { error: asRpcError(err) });
			return;
		}
		if (conv.closed || link.socket.destroyed) {
			this.reply(conversation, id, { error: unavailable(this.path(), process.platform, "the daemon connection closed") });
			return;
		}
		const envelopeId = `tychicus_${process.pid}_${++this.seq}`;
		conv.pending.set(envelopeId, id);
		if (command.type === "create") conv.creates.add(envelopeId);
		link.socket.write(
			`${JSON.stringify({ type: "command", id: envelopeId, protocol: link.protocol, clientId: `tychicus-panel:${process.pid}`, command })}\n`,
		);
	}

	private onDaemonFrame(name: string, conv: Conversation, frame: Record<string, unknown>): void {
		if (frame.type === "response" && typeof frame.id === "string") {
			const id = conv.pending.get(frame.id);
			if (id === undefined) return;
			conv.pending.delete(frame.id);
			const created = conv.creates.delete(frame.id);
			if (frame.success === true) {
				const data = (frame.data ?? {}) as Record<string, unknown>;
				if (created && typeof data.activeSessionId === "string") conv.sessions.add(data.activeSessionId);
				this.reply(name, id, { result: data });
			} else {
				const info = frame.errorInfo as { code?: unknown } | undefined;
				this.reply(name, id, {
					error: { code: typeof info?.code === "string" ? info.code : "eukhe_error", message: String(frame.error ?? `${String(frame.command)} failed`) },
				});
			}
			return;
		}
		if (frame.type === "shell_approval") {
			this.refuseShell(conv, frame);
			const request = frame.request as { command?: unknown } | undefined;
			this.send({
				type: "eukhe",
				conversation: name,
				event: { type: "shell_refused", activeSessionId: frame.activeSessionId, command: String(request?.command ?? "") },
			});
			return;
		}
		if (typeof frame.type === "string" && FORWARDED.has(frame.type)) this.send({ type: "eukhe", conversation: name, event: frame });
	}

	/** Answer a session's shell question with no: the panel runs no shell commands. */
	private refuseShell(conv: Conversation, frame: Record<string, unknown>): void {
		const request = frame.request as { requestId?: unknown } | undefined;
		if (typeof frame.activeSessionId !== "string" || typeof request?.requestId !== "string") return;
		void conv.link.then((link) => {
			if (link.socket.destroyed) return;
			const command = { type: "answer_shell_approval", activeSessionId: frame.activeSessionId, requestId: request.requestId, verdict: "deny" };
			link.socket.write(
				`${JSON.stringify({ type: "command", id: `tychicus_${process.pid}_${++this.seq}`, protocol: link.protocol, clientId: `tychicus-panel:${process.pid}`, command })}\n`,
			);
		});
	}

	private onDaemonClose(name: string, conv: Conversation): void {
		conv.closed = true;
		if (this.conversations.get(name) === conv) this.conversations.delete(name);
		for (const id of conv.pending.values())
			this.reply(name, id, { error: unavailable(this.path(), process.platform, "the daemon connection closed") });
		conv.pending.clear();
		this.send({ type: "eukhe", conversation: name, closed: true });
	}

	/** Drop one chat's connection; its client-owned sessions end with it. */
	close(name: string): void {
		const conv = this.conversations.get(name);
		if (!conv) return;
		this.conversations.delete(name);
		conv.closed = true;
		void conv.link.then((link) => link.socket.end()).catch(() => undefined);
	}

	/** The extension went away: every chat's connection goes with it. */
	closeAll(): void {
		for (const name of [...this.conversations.keys()]) this.close(name);
	}
}

function asRpcError(err: unknown): RpcError {
	if (err && typeof err === "object" && "code" in err && "message" in err) return err as RpcError;
	return { code: ERR.EUKHE_UNAVAILABLE, message: err instanceof Error ? err.message : String(err) };
}
