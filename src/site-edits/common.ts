/**
 * The parts of site edits the page side needs too (the feed filter's content script, site-edits/feed-filter.ts): the storage
 * key and the host test. Kept apart from store.ts so the content script doesn't carry the Public Suffix List.
 */

export const STORAGE_KEY = "tk-site-edits";

/**
 * The feed filter's messages. Its content script asks the service worker for its own page's filters (GET), and the worker
 * sends each tab its filters again after every change (SET). The content script never reads extension storage itself, so
 * a page's renderer never receives the other settings kept there.
 */
export const FEED_FILTER_GET = "tk-feed-filter:get";
export const FEED_FILTER_SET = "tk-feed-filter:set";

/** Whether `url` is on `host` or one of its subdomains. */
export function onHost(url: string | undefined, host: string): boolean {
	if (!url) return false;
	let h: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		h = parsed.hostname.toLowerCase();
	} catch {
		return false;
	}
	return h === host || h.endsWith(`.${host}`);
}
