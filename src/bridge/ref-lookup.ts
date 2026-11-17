/**
 * Forgiving refs for weaker models (D52). A ref comes back in many spellings ("@e12", "ref=e12", "[ref=e12]", "e12,"),
 * and a model that lost track of its refs often sends the control's name instead ("Save", "the Email field"). The
 * spellings are cleaned up here; a name is looked up among the page's controls by exact name (then whole words), and
 * acted on only when exactly one control answers to it. Pure: the bridge passes the page's nodes in.
 */

/** A ref as the page gives it: e12, or f1a2be12 for a control in a cross-origin frame. */
export const REF_RE = /^(f[0-9a-z]{4})?e\d+$/;

/** The ref a spelling means, or the text unchanged when it is not a ref spelling at all. */
export function cleanRef(raw: string): string {
	const s = raw.trim();
	const m = /^[[({"'`\s]*(?:ref\s*[=:]?\s*)?[@#]?((?:f[0-9a-z]{4})?e\d+)[\])}"'`\s,.;:]*$/i.exec(s);
	return m ? m[1].toLowerCase() : s;
}

/** Words a model puts around a name that say what kind of control it means, and the roles they mean. */
const ROLE_WORDS: Array<[RegExp, string[]]> = [
	[/\bbuttons?\b/, ["button"]],
	[/\blinks?\b/, ["link"]],
	[/\b(check ?box(es)?|tick ?box(es)?)\b/, ["checkbox", "switch"]],
	[/\bradio( buttons?)?\b/, ["radio"]],
	[/\b(drop ?down|select|combo ?box)\b/, ["combobox", "listbox"]],
	[/\b(text ?box|text ?field|text ?area|search ?box|input|field|box)\b/, ["textbox", "searchbox", "combobox"]],
	[/\btabs?\b/, ["tab"]],
	[/\b(menu ?item|option)\b/, ["menuitem", "option", "menuitemcheckbox", "menuitemradio"]],
	[/\bslider\b/, ["slider"]],
	[/\b(switch|toggle)\b/, ["switch", "checkbox"]],
];
/** Roles that only describe the page: a control a person acts on wins over them when both answer to a name. */
const DESCRIBES = new Set([
	"label",
	"heading",
	"cell",
	"columnheader",
	"rowheader",
	"status",
	"alert",
	"dialog",
	"generic",
	"listitem",
]);

const norm = (t: string) =>
	t
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/^[\s"'`]+|[\s"'`:*]+$/g, "")
		.trim();
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface NamedNode {
	ref: string;
	role: string;
	name: string;
}

/**
 * The controls a name means: those named exactly that (the query as given, then with role words and articles taken
 * off), else those whose name holds it as whole words. A role word narrows them when that leaves any; a control a
 * person acts on wins over text that only describes the page.
 */
export function matchByName<T extends NamedNode>(nodes: readonly T[], query: string): T[] {
	const raw = norm(query);
	if (!raw) return [];
	let roles: string[] = [];
	let q = raw;
	for (const [re, rs] of ROLE_WORDS)
		if (re.test(q)) {
			roles = roles.concat(rs);
			q = q.replace(re, " ");
		}
	q = norm(q.replace(/^(the|a|an)\s+/, "").replace(/\s+(the|a|an)$/, ""));
	const named = nodes.filter((n) => n.name.trim());
	let hits = named.filter((n) => norm(n.name) === raw);
	if (!hits.length && q) hits = named.filter((n) => norm(n.name) === q);
	if (!hits.length && q) {
		const word = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(q)}($|[^\\p{L}\\p{N}])`, "u");
		hits = named.filter((n) => word.test(norm(n.name)));
	}
	if (roles.length) {
		const typed = hits.filter((n) => roles.includes(n.role));
		if (typed.length) hits = typed;
	}
	const acting = hits.filter((n) => !DESCRIBES.has(n.role));
	return acting.length ? acting : hits;
}

/** One control line, as read_page shows it. */
export const nodeLine = (n: NamedNode) => `${n.ref} ${n.role} ${JSON.stringify(n.name.slice(0, 60))}`;
