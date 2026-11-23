/**
 * Feed filters: what a filter says and how a post is matched against it. Pure, so the store (validation), the content script
 * (site-edits/feed-filter.ts) and the tests share one definition.
 *
 * A filter holds words and handles. A word is a whole word or phrase, matched in any case at word boundaries ("ai" doesn't
 * hit "said"; "machine learning" hits "Machine  Learning"), or a regular expression written /like this/ with optional flags.
 * A handle is an account: "@name", "u/name" and "name" are the same account; "r/name" is a subreddit.
 */

import { onHost } from "./common.js";

export interface FeedFilterSpec {
	words: string[];
	handles: string[];
	/** A CSS selector for one feed item, when the site's built-in one misses. */
	items?: string;
}

export const MAX_TERMS = 100;
export const MAX_TERM = 200;
export const MAX_HANDLES = 200;

const WORD_CHAR = "\\p{L}\\p{N}_";
const IS_WORD_CHAR = /[\p{L}\p{N}_]/u;

/** "/pattern/flags" as a regular expression's parts, or undefined for a plain word or phrase. */
export function regexTerm(term: string): { source: string; flags: string } | undefined {
	const m = /^\/(.+)\/([a-z]*)$/s.exec(term);
	if (!m) return undefined;
	// g and y make test() remember where it stopped, so the next post would start mid-text.
	const flags = [...new Set(m[2].replace(/[gyd]/g, ""))].join("");
	// No flags written: any case, like a word.
	return { source: m[1], flags: m[2] === "" ? "i" : flags };
}

/**
 * A quantified group that holds a quantifier, like (a+)+ or (\w*)*: a pattern that can take exponential time on a long post.
 * Refused, since one would freeze the page on every visit.
 */
export function nestedQuantifier(source: string): boolean {
	return /\((?:[^()\\]|\\.)*[*+}](?:[^()\\]|\\.)*\)[*+{]/.test(source);
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A plain word or phrase as a pattern: any run of spaces matches any run of spaces, and word edges need a boundary. */
export function wordSource(term: string): string {
	const body = term.trim().split(/\s+/).map(escapeRegex).join("\\s+");
	const head = IS_WORD_CHAR.test(term.trim()[0] ?? "") ? `(?<![${WORD_CHAR}])` : "";
	const tail = IS_WORD_CHAR.test(term.trim().slice(-1)) ? `(?![${WORD_CHAR}])` : "";
	return `${head}${body}${tail}`;
}

/** "@Name", "u/Name", "/user/name", "name" -> "name"; "r/Name" -> "r/name". Empty when nothing is left. */
export function normalizeHandle(raw: string): string {
	let h = raw.trim().toLowerCase();
	h = h.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
	h = h.replace(/^(u|user|users|in|channel)\//, "");
	h = h.replace(/^@/, "");
	h = h.replace(/\/+$/, "");
	return h;
}

/** A word filter's "format" words: a site can match these by what an item is rather than what it says (YouTube's Shorts). */
export type Formats = Record<string, (item: Element) => boolean>;

export interface CompiledFilter {
	/** Whether a post with this text, these author handles and this element is hidden. */
	test(text: string, handles: () => string[], item: Element): boolean;
	usesHandles: boolean;
}

/**
 * One filter as a test. All plain words become one pattern, so a post costs one scan however many words there are.
 * `formats` turns the words a site names (YouTube's "shorts") into a check on the item itself instead of its text.
 */
export function compileFilter(spec: FeedFilterSpec, formats: Formats = {}): CompiledFilter {
	const plain: string[] = [];
	const patterns: RegExp[] = [];
	const formatChecks: Array<(item: Element) => boolean> = [];
	for (const term of spec.words) {
		const format = formats[term.trim().toLowerCase()];
		if (format) {
			formatChecks.push(format);
			continue;
		}
		const re = regexTerm(term);
		if (re) {
			try {
				patterns.push(new RegExp(re.source, re.flags));
			} catch {
				/* checked when saved; an old browser without a flag skips it */
			}
		} else if (term.trim()) plain.push(wordSource(term));
	}
	const words = plain.length ? new RegExp(plain.join("|"), "iu") : undefined;
	const handles = new Set(spec.handles.map(normalizeHandle).filter(Boolean));
	return {
		usesHandles: handles.size > 0,
		test(text, itemHandles, item) {
			if (words?.test(text)) return true;
			for (const p of patterns) if (p.test(text)) return true;
			for (const f of formatChecks) if (f(item)) return true;
			if (handles.size) for (const h of itemHandles()) if (handles.has(h)) return true;
			return false;
		},
	};
}

/** The filter a stored edit's value holds. Throws on a value that isn't one. */
export function parseFilterValue(value: string): FeedFilterSpec {
	const raw = JSON.parse(value) as Partial<FeedFilterSpec>;
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
	return {
		words: list(raw.words),
		handles: list(raw.handles),
		...(typeof raw.items === "string" && raw.items ? { items: raw.items } : {}),
	};
}

/** One line for a person: what the filter hides. */
export function filterSummary(spec: FeedFilterSpec): string {
	const parts: string[] = [];
	if (spec.words.length) parts.push(`Words: ${spec.words.join(", ")}`);
	if (spec.handles.length) parts.push(`Accounts: ${spec.handles.join(", ")}`);
	if (spec.items) parts.push(`Items: ${spec.items}`);
	return parts.join(" · ");
}

/** The filters among stored site edits that are on and cover `url`. A value this version can't read hides nothing. */
export function filtersFor(stored: unknown, url: string | undefined): FeedFilterSpec[] {
	const edits = (
		stored as { edits?: Array<{ kind?: unknown; on?: unknown; host?: unknown; value?: unknown }> } | undefined
	)?.edits;
	if (!Array.isArray(edits)) return [];
	const out: FeedFilterSpec[] = [];
	for (const e of edits) {
		if (e?.kind !== "filter" || e.on !== true || typeof e.host !== "string" || typeof e.value !== "string") continue;
		if (!onHost(url, e.host)) continue;
		try {
			out.push(parseFilterValue(e.value));
		} catch {
			/* skipped */
		}
	}
	return out;
}
