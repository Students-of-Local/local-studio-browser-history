/**
 * Feed filters: what a filter says and how a post is matched against it. Pure, so the store (validation), the content script
 * (site-edits/feed-filter.ts) and the tests share one definition.
 *
 * A filter holds words and handles. A word is a whole word or phrase, matched in any case at word boundaries ("ai" doesn't
 * hit "said"; "machine learning" hits "Machine  Learning"), or a regular expression written /like this/ with optional flags.
 * Scripts written without spaces between words (Chinese, Japanese, Thai and their neighbors) have no word edges to find, so
 * a word's side in one of them matches anywhere: "比特币" hits "今天比特币大涨".
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
/** Scripts that don't put spaces between words: a word edge there means nothing. Hangul is spaced, but between phrases,
 * with particles written onto the word ("비트코인이"), so a word written in it matches inside a phrase too. */
const UNSPACED =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Hangul}]/u;

/** "/pattern/flags" as a regular expression's parts, or undefined for a plain word or phrase. */
export function regexTerm(term: string): { source: string; flags: string } | undefined {
	const m = /^\/(.+)\/([a-z]*)$/s.exec(term);
	if (!m) return undefined;
	// g and y make test() remember where it stopped, so the next post would start mid-text.
	const flags = [...new Set(m[2].replace(/[gyd]/g, ""))].join("");
	// No flags written: any case, like a word.
	return { source: m[1], flags: m[2] === "" ? "i" : flags };
}

/** The quantifier that starts at `source[i]`, if one does: its length, and whether it repeats without end (*, +, {n,}). */
function quantifierAt(source: string, i: number): { length: number; unbounded: boolean } | undefined {
	const c = source[i];
	if (c === "*" || c === "+") return { length: 1, unbounded: true };
	if (c !== "{") return undefined;
	const m = /^\{\d+(,\d*)?\}/.exec(source.slice(i, i + 24));
	if (!m) return undefined; // a literal brace
	return { length: m[0].length, unbounded: m[1] === "," };
}

/**
 * Why a pattern could take far too long on a long post, or undefined when it shows none of these shapes. Refused when
 * saved, since one would freeze the page on every visit:
 * - a repeated group that holds a repeat, like (a+)+ or (\w*)*: exponential;
 * - a group repeated without end whose own level is a choice, like (a|a)+ or (\w|\d)+: alternatives that overlap try every
 *   split of the text, exponential too;
 * - more than one repeat without end, like .*.*.*z: each one multiplies the work by the post's length. One is fine
 *   (moon+, \bcrypto\w*).
 * Escapes and character classes are skipped whole: [a*+] holds characters, not repeats.
 */
export function riskyPattern(source: string): string | undefined {
	// One frame per open group: whether anything inside it repeats, and whether its own level holds a "|".
	const stack: Array<{ repeats: boolean; choice: boolean }> = [{ repeats: false, choice: false }];
	let unbounded = 0;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "[") {
			for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++;
			continue;
		}
		if (c === "(") {
			stack.push({ repeats: false, choice: false });
			continue;
		}
		if (c === "|") {
			stack[stack.length - 1].choice = true;
			continue;
		}
		if (c === ")") {
			if (stack.length < 2) continue;
			const inner = stack.pop() as { repeats: boolean; choice: boolean };
			const q = quantifierAt(source, i + 1);
			if (q && inner.repeats) return "nests one repeat inside another";
			if (q?.unbounded && inner.choice) return "repeats a choice, like (a|b)+";
			if (q) {
				if (q.unbounded) unbounded++;
				i += q.length;
			}
			stack[stack.length - 1].repeats ||= inner.repeats || !!q;
			continue;
		}
		const q = quantifierAt(source, i);
		if (q) {
			if (q.unbounded) unbounded++;
			stack[stack.length - 1].repeats = true;
			i += q.length - 1;
		}
	}
	return unbounded > 1 ? "has more than one open-ended repeat (*, + or {n,})" : undefined;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A plain word or phrase as a pattern: any run of spaces matches any run of spaces, and word edges need a boundary, except
 * on a side whose character is in a script without spaces (a mixed "AI芯片" keeps the edge before its "A").
 */
export function wordSource(term: string): string {
	const body = term.trim().split(/\s+/).map(escapeRegex).join("\\s+");
	const first = [...term.trim()][0] ?? "";
	const last = [...term.trim()].at(-1) ?? "";
	const edge = (c: string) => IS_WORD_CHAR.test(c) && !UNSPACED.test(c);
	const head = edge(first) ? `(?<![${WORD_CHAR}])` : "";
	const tail = edge(last) ? `(?![${WORD_CHAR}])` : "";
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
