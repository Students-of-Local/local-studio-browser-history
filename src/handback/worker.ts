/**
 * Hand-back with Continue, in the service worker (state.ts has the whole flow). An agent's `handback` call waits here
 * until the user presses Continue in the side panel or on the veil's pill, takes the tab back, closes it, or the wait
 * times out. It runs beside the client's queue (src/bridge/native.ts), like ask_user, so nothing else of the agent's is
 * held up and a reload ends it with an answer.
 *
 * The panel presses Continue by writing `handback_continue_<id>` to chrome.storage.session, which web pages can't
 * reach; the pill's button sends a message the veil checks came from its own script in that tab's top frame.
 */

import { showWaiting } from "../attention/badge.js";
import { BridgeError } from "../bridge/errors.js";
import { ERR } from "../bridge/protocol.js";
import { releaseAgentViewport } from "../browser/cdp.js";
import type { BrowserSession } from "../browser/session.js";
import { onVeilContinue, veilWait } from "../browser/veil.js";
import { veilViewFor } from "../browser/veil-state.js";
import {
	CONTINUE_KEY_PREFIX,
	cleanReason,
	HANDBACK_KEY,
	HANDBACK_TIMEOUT_MS,
	type HandbackEnd,
	type HandbackOutcome,
	handbackOutcome,
	type PendingHandback,
} from "./state.js";

const SESSIONS_KEY = "browser_sessions";
const BRIDGE_ENABLED_KEY = "bridge_enabled";

interface Waiting {
	pending: PendingHandback;
	session: BrowserSession;
	/** The caller's own id, which handback.cancel names. */
	waitId?: string;
	settle: (end: HandbackEnd) => void;
}

const waiting = new Map<string, Waiting>();

/** Tests shorten the wait through the worker's global. */
function timeoutMs(): number {
	const override = (globalThis as { __TYCHICUS_HANDBACK_MS?: number }).__TYCHICUS_HANDBACK_MS;
	return typeof override === "number" && override > 0 ? override : HANDBACK_TIMEOUT_MS;
}

let listOps: Promise<unknown> = Promise.resolve();
function editPending(edit: (list: PendingHandback[]) => PendingHandback[]): Promise<void> {
	const run = listOps.then(async () => {
		const data = await chrome.storage.session.get(HANDBACK_KEY);
		const list = (data[HANDBACK_KEY] as PendingHandback[] | undefined) ?? [];
		const next = edit(list);
		await chrome.storage.session.set({ [HANDBACK_KEY]: next });
		await showWaiting("handbacks", next);
	});
	listOps = run.catch(() => undefined);
	return run;
}

/**
 * Wait for the user on one of the session's tabs. `params.tabId` defaults to the current tab; `params.reason` is what
 * the user is asked to do. The tab is not focused: the user goes to it from the panel's card or the tab strip.
 */
export async function handleHandback(
	client: { clientId: string; session: BrowserSession },
	params: Record<string, unknown>,
): Promise<HandbackOutcome> {
	const { session } = client;
	const tabId = typeof params.tabId === "number" ? params.tabId : session.currentTabId;
	if (tabId === undefined || !session.tabIds.includes(tabId))
		throw new BridgeError(
			ERR.NO_TAB,
			tabId === undefined
				? "You have no current tab to hand to the user. navigate first, or pass tabId."
				: `Tab ${tabId} is not one of your tabs (tabs_context lists yours).`,
		);
	const reason = cleanReason(params.reason);
	// One wait per tab: a second call replaces the first, which hears it was stopped.
	for (const w of waiting.values()) if (w.pending.tabId === tabId) w.settle("aborted");
	const tab = await chrome.tabs.get(tabId).catch(() => undefined);
	if (!tab) throw new BridgeError(ERR.NO_TAB, `Tab ${tabId} is closed.`);
	const view = veilViewFor(session.record);
	const now = Date.now();
	const limit = timeoutMs();
	const pending: PendingHandback = {
		id: crypto.randomUUID(),
		clientId: client.clientId,
		sessionId: session.id,
		tabId,
		reason,
		agent: view.agent,
		detail: view.detail,
		color: view.color,
		tabTitle: (tab.title || tab.url || `Tab ${tabId}`).replace(/\s+/g, " ").slice(0, 120),
		createdAt: now,
		expiresAt: now + limit,
	};
	// The page draws at its real size when the user looks at it, not the agent's background viewport.
	await releaseAgentViewport(tabId).catch(() => undefined);
	let settle: (end: HandbackEnd) => void = () => undefined;
	const ended = new Promise<HandbackEnd>((resolve) => {
		const timer = setTimeout(() => settle("timeout"), limit);
		settle = (end) => {
			clearTimeout(timer);
			resolve(end);
		};
	});
	const waitId = typeof params.waitId === "string" ? params.waitId.slice(0, 80) : undefined;
	waiting.set(pending.id, { pending, session, waitId, settle });
	await editPending((list) => [...list.filter((p) => p.id !== pending.id), pending]);
	void veilWait(session, tabId, reason);
	try {
		const end = await ended;
		return handbackOutcome(end, tabId, reason, limit);
	} finally {
		waiting.delete(pending.id);
		void veilWait(session, tabId, undefined);
		await editPending((list) => list.filter((p) => p.id !== pending.id)).catch(() => undefined);
	}
}

/** End the waits `match` picks with `end`. Returns how many. */
function endWhere(match: (w: Waiting) => boolean, end: HandbackEnd): number {
	let n = 0;
	for (const w of [...waiting.values()])
		if (match(w)) {
			w.settle(end);
			n++;
		}
	return n;
}

/** The client's own cancel (its call was aborted). */
export function cancelHandback(clientId: string, waitId: unknown): number {
	if (typeof waitId !== "string") return 0;
	return endWhere((w) => w.pending.clientId === clientId && w.waitId === waitId, "aborted");
}

/** The client left (or every client, `undefined`): nobody hears a Continue any more. */
export function cancelHandbacksFor(clientId: string | undefined): number {
	return endWhere((w) => clientId === undefined || w.pending.clientId === clientId, "disconnected");
}

/** Continue on a tab (the veil's pill). */
function continueOnTab(tabId: number): void {
	endWhere((w) => w.pending.tabId === tabId, "continued");
}

/** Wire the panel's Continue, the pill's buttons and the ways a tab leaves the agent. Call once per worker start. */
export function startHandback(): void {
	// Waits a previous worker left have nobody waiting on them.
	editPending(() => []).catch(() => undefined);
	// The pill's Take over moves the tab out of the session, which the session table change below ends as "taken".
	onVeilContinue(continueOnTab);
	chrome.tabs.onRemoved.addListener((tabId) => {
		endWhere((w) => w.pending.tabId === tabId, "closed");
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local") {
			if (changes[BRIDGE_ENABLED_KEY]?.newValue === false) cancelHandbacksFor(undefined);
			if (SESSIONS_KEY in changes) {
				// The tab left the session (dragged out of the group, released, the session ended): it is the user's.
				const table = (changes[SESSIONS_KEY].newValue ?? {}) as Record<string, { tabIds?: number[] }>;
				endWhere((w) => !table[w.pending.sessionId]?.tabIds?.includes(w.pending.tabId), "taken");
			}
			return;
		}
		if (area !== "session") return;
		for (const key of Object.keys(changes)) {
			if (!key.startsWith(CONTINUE_KEY_PREFIX) || changes[key].newValue === undefined) continue;
			const w = waiting.get(key.slice(CONTINUE_KEY_PREFIX.length));
			w?.settle("continued");
			chrome.storage.session.remove(key).catch(() => undefined);
		}
	});
}
