/**
 * The side panel's half of "Give this tab to Tychicus" (state.ts): take the worker's note for this window, once.
 */

import { freshHandoff, HANDOFF_KEY } from "./state.js";

/** The tab given to this window's panel in the last few seconds, if any. The note is removed, so only one panel acts. */
export async function takeHandoff(windowId: number): Promise<number | undefined> {
	const data = await chrome.storage.session.get(HANDOFF_KEY).catch(() => ({}) as Record<string, unknown>);
	const note = freshHandoff(data[HANDOFF_KEY], windowId, Date.now());
	if (!note) return undefined;
	await chrome.storage.session.remove(HANDOFF_KEY).catch(() => undefined);
	return note.tabId;
}

/** Call `onTab` each time a tab is given to this window's open panel. */
export function watchHandoff(windowId: number, onTab: (tabId: number) => void): void {
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "session" || !(HANDOFF_KEY in changes)) return;
		if (!freshHandoff(changes[HANDOFF_KEY].newValue, windowId, Date.now())) return;
		void takeHandoff(windowId).then((tabId) => {
			if (tabId !== undefined) onTab(tabId);
		});
	});
}
