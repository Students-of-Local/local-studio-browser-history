/**
 * The feed filter's content script: the extension's own code, registered by site-edits/apply.ts for the sites that have a
 * filter on, so it needs no user-scripts switch. It asks the service worker for this page's filters, hides what they match
 * (site-edits/feed-filter-core.ts), and takes the new filters the worker sends after every change the person or an agent
 * makes. It never reads extension storage: the page's renderer gets this page's filters and nothing else kept there.
 *
 * It can be injected more than once into one page (registered, then put into tabs already open), so it starts only once.
 */

import { FEED_FILTER_GET, FEED_FILTER_SET } from "./common.js";
import { type FeedFilter, startFeedFilter } from "./feed-filter-core.js";
import type { FeedFilterSpec } from "./feed-match.js";

const STARTED = "__tychicusFeedFilter";
const scope = globalThis as typeof globalThis & { [STARTED]?: boolean };

if (!scope[STARTED] && typeof chrome !== "undefined" && chrome.runtime?.id && typeof document !== "undefined") {
	scope[STARTED] = true;
	let filter: FeedFilter | undefined;
	/** Set once the worker has sent filters: an answer to the first question can't be newer, so it is dropped. */
	let pushed = false;
	const apply = (specs: unknown) => {
		if (!Array.isArray(specs)) return;
		const list = specs as FeedFilterSpec[];
		if (filter) filter.update(list);
		else if (list.length) filter = startFeedFilter(document, list, { hostname: location.hostname });
	};
	chrome.runtime.onMessage.addListener((message: unknown) => {
		const m = message as { type?: unknown; filters?: unknown } | null;
		if (m?.type !== FEED_FILTER_SET) return undefined;
		pushed = true;
		apply(m.filters);
		return undefined;
	});
	chrome.runtime
		.sendMessage({ type: FEED_FILTER_GET })
		.then((specs: unknown) => {
			if (!pushed) apply(specs);
		})
		.catch(() => undefined);
}
