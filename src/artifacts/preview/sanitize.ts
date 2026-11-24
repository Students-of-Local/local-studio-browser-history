import DOMPurify, { type Config } from "dompurify";

/**
 * Sanitizes untrusted HTML fragments (notebook outputs) with DOMPurify, narrowed to the tags and
 * attributes previews show. Styles, scripts, event handlers, forms, frames and remote images never
 * make it across.
 */

const words = (list: string) => list.split(" ");

const COMMON_ATTRS = words("title colspan rowspan align valign dir lang");

const TAG_ATTRS = new Map([
	["a", ["href"]],
	["img", words("src alt width height")],
	["ol", words("start type")],
	["td", words("headers scope")],
	["th", words("headers scope")],
]);

const CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
	ALLOWED_TAGS: words(
		"a abbr b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strong sub summary sup table tbody td tfoot th thead tr u ul var",
	),
	ALLOWED_ATTR: [...COMMON_ATTRS, ...[...TAG_ATTRS.values()].flat()],
	ALLOW_ARIA_ATTR: false,
	ALLOW_DATA_ATTR: false,
	// Dropped with everything inside them, on top of DOMPurify's own list (script, style, svg, iframe...).
	ADD_FORBID_CONTENTS: words(
		"frame frameset object embed applet form input button select textarea source track link meta base canvas",
	),
	RETURN_DOM_FRAGMENT: true,
};

const INLINE_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,/;
const SAFE_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const SAFE_LINK = /^(https?:|mailto:)/i;

export const MAX_SANITIZE_CHARS = 5_000_000;
const MAX_NODES = 50_000;
const MAX_DEPTH = 64;

/** Nodes several sanitizeHtml calls may still create together, e.g. all outputs of one notebook. */
export interface NodeBudget {
	nodes: number;
}

/** Its own instance, made on first use: hooks stay off the shared one, and Node can import this file. */
let purify: ReturnType<typeof DOMPurify> | undefined;

/**
 * `resolveImage` maps an img src such as `attachment:name` to a data URL the caller already
 * validated (base64 of a PNG, JPEG, GIF or WebP); any other src must pass SAFE_IMAGE.
 */
export function sanitizeHtml(
	html: string,
	target: Document,
	budget: NodeBudget = { nodes: MAX_NODES },
	resolveImage?: (src: string) => string | undefined,
): DocumentFragment {
	if (html.length > MAX_SANITIZE_CHARS) {
		const out = target.createDocumentFragment();
		const p = target.createElement("p");
		p.textContent = "[Output too large to display]";
		out.appendChild(p);
		return out;
	}
	if (budget.nodes <= 0) return target.createDocumentFragment();
	purify ??= DOMPurify(window);
	// DOMPurify returns its input unchanged where it can't run.
	if (!purify.isSupported) throw new Error("This browser can't sanitize HTML");
	purify.addHook("uponSanitizeAttribute", (node, data) => {
		const tag = node.localName;
		const name = data.attrName;
		if (!COMMON_ATTRS.includes(name) && !TAG_ATTRS.get(tag)?.includes(name)) data.keepAttr = false;
		else if (name === "href") data.keepAttr = SAFE_LINK.test(data.attrValue);
		else if (name === "src") {
			const resolved = resolveImage?.(data.attrValue);
			// A resolved image is still checked: its prefix here, its base64 body when it was parsed.
			if (resolved !== undefined && INLINE_IMAGE.test(resolved)) data.attrValue = resolved;
			else data.keepAttr = SAFE_IMAGE.test(data.attrValue);
		}
	});
	let out: DocumentFragment;
	try {
		// The doctype keeps the parser out of quirks mode, where a table nests inside a paragraph.
		out = purify.sanitize(`<!doctype html><body>${html}`, CONFIG);
	} finally {
		purify.removeAllHooks();
	}
	finish(out, target, budget, 0);
	return target.adoptNode(out);
}

/** Caps the size and depth of clean output, opens links in a new tab, and puts alt text where an image was blocked. */
function finish(parent: Node, target: Document, budget: NodeBudget, depth: number): void {
	for (const node of Array.from(parent.childNodes)) {
		if (--budget.nodes < 0 || depth > MAX_DEPTH) {
			parent.removeChild(node);
			continue;
		}
		const el = node as Element;
		if (el.localName === "img" && !el.hasAttribute("src")) {
			const alt = el.getAttribute("alt");
			parent.replaceChild(target.createTextNode(alt ? `[Image: ${alt}]` : "[Image]"), node);
			continue;
		}
		if (el.localName === "a" && el.hasAttribute("href")) {
			el.setAttribute("target", "_blank");
			el.setAttribute("rel", "noopener noreferrer");
		}
		finish(node, target, budget, depth + 1);
	}
}
