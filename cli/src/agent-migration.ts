/**
 * Moving agents from Polycarp: Claude Code, Codex, OpenCode, Cursor and OMP may still have an MCP entry that runs
 * Polycarp's browser server (`polycarp browser mcp`, `polycarp-browser mcp`, Polycarp's old browser launcher or
 * `tabkyra mcp`). When Polycarp drops its browser, those agents would lose their browser tools.
 *
 * The move points each such entry at Tychicus's launcher with `mcp` and keeps its old name, so one server runs and
 * fleet rules that say "the polycarp MCP server" keep working. That name is a temporary alias, listed in
 * agent-aliases.json in Tychicus's config folder. The finish step (`setup --agents --finish`) renames each alias to
 * `tychicus` once nothing names it, and takes it off the list.
 *
 * Only the harness config files are written, each after a timestamped backup beside it, and only the entries that move
 * change: the rest of each file is kept byte for byte, and the result must parse to exactly the intended config. A file
 * that doesn't parse is refused and left alone. A file that changed after it was planned is planned again and written
 * only if the same entries move. Polycarp's own folders and launchers are never read or written. A second run finds
 * nothing to do and changes nothing.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { configDir } from "./files.ts";
import { MCP_NAME } from "./harness.ts";
import { blankComments, dropTrailingCommas, skipSpace, stringEnd } from "./jsonc.ts";
import { COMMAND_NAME } from "./self.ts";

/** The harnesses whose MCP config this moves, with the file each one documents for user scope. */
export type MigrationHarness = "claude" | "codex" | "opencode" | "cursor" | "omp";

/** "move" points entries at Tychicus under their old names; "finish" renames those aliases to tychicus. */
export type PlanKind = "move" | "finish";

export interface Repointed {
	name: string;
	/** The command line the entry ran before. */
	from: string;
}

export interface Finished {
	name: string;
	/** "removed" when a tychicus entry already runs the same command. */
	action: "renamed" | "removed";
}

/** A Claude Code project (local scope) entry that still runs Polycarp's browser server. It is left alone. */
export interface ProjectEntry {
	project: string;
	name: string;
	from: string;
}

export interface FilePlan {
	kind: PlanKind;
	harness: MigrationHarness;
	/** The harness's display name. */
	name: string;
	file: string;
	/** "change": `after` differs from `before`. "refused": the file couldn't be read safely; nothing is written. */
	status: "missing" | "unchanged" | "change" | "refused";
	reason?: string;
	/** A refused file counts as a failure only when it could hold an entry to move: its text names polycarp or tabkyra. */
	blocking: boolean;
	/** The launcher moved entries run. */
	binary: string;
	/** Move: entries that launched Polycarp's browser server and now run Tychicus, under their old names. */
	repointed: Repointed[];
	/** Finish: the recorded aliases in this file. */
	aliases: string[];
	/** Finish: the aliases renamed to tychicus or removed. */
	finished: Finished[];
	/** Finish: recorded aliases no longer in the file as moved; they leave the list without a write. */
	forget: string[];
	/** Entries that still run Polycarp's browser server but are left alone, with the reason and the manual fix. */
	leftAlone: string[];
	/** Claude Code project entries that still run Polycarp's browser server; left alone (see ProjectEntry). */
	projects: ProjectEntry[];
	/** Things worth knowing that need nothing done now. */
	notes: string[];
	before?: string;
	after?: string;
	/** Set after the write when agent-aliases.json couldn't be updated; the config write itself stands. */
	aliasWarning?: string;
}

export interface AliasRecord {
	harness: MigrationHarness;
	file: string;
	name: string;
	/** When the move recorded it. An alias found by its name and launcher, with no record, has none. */
	since?: string;
}

const NAMES: Record<MigrationHarness, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", cursor: "Cursor", omp: "OMP" };

/** Each harness's user-scope MCP config, the same files harness.ts reads or its CLI writes. */
export function migrationFiles(): { harness: MigrationHarness; file: string }[] {
	const home = homedir();
	const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
	return [
		{ harness: "claude", file: process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json") },
		{ harness: "codex", file: join(process.env.CODEX_HOME || join(home, ".codex"), "config.toml") },
		{ harness: "opencode", file: join(configHome, "opencode", "opencode.json") },
		{ harness: "cursor", file: join(home, ".cursor", "mcp.json") },
		{ harness: "omp", file: join(home, ".omp", "agent", "mcp.json") },
	];
}

function newPlan(kind: PlanKind, harness: MigrationHarness, file: string, binary: string): FilePlan {
	return { kind, harness, name: NAMES[harness], file, status: "missing", blocking: false, binary, repointed: [], aliases: [], finished: [], forget: [], leftAlone: [], projects: [], notes: [] };
}

function refuse(plan: FilePlan, reason: string, blocking: boolean): void {
	plan.status = "refused";
	plan.reason = reason;
	plan.blocking = blocking;
	plan.repointed = [];
	plan.finished = [];
	plan.after = undefined;
}

/** Text that could hold an entry to move. A file without it is refused harmlessly: there was nothing to move in it. */
function couldHoldEntry(text: string): boolean {
	return /polycarp|tabkyra/i.test(text);
}

function message(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function programName(command: string): string {
	return basename(command.replaceAll("\\", "/"))
		.toLowerCase()
		.replace(/\.(exe|cmd|bat)$/, "");
}

/**
 * True when command and args start Polycarp's browser MCP server: `polycarp browser mcp`, `polycarp-browser mcp`,
 * `tabkyra mcp`, or Polycarp's browser launcher (`.../polycarp/browser/polycarp`) with `mcp`. Plain `polycarp mcp`
 * is the Polycarp app's own server and is not this.
 */
export function launchesPolycarpBrowser(command: string, args: string[]): boolean {
	const base = programName(command);
	const line = args.join(" ");
	if (base === "polycarp" && line === "browser mcp") return true;
	if ((base === "polycarp-browser" || base === "tabkyra") && line === "mcp") return true;
	return base === "polycarp" && line === "mcp" && /[\\/]polycarp[\\/]browser[\\/]polycarp(\.(exe|cmd))?$/i.test(command);
}

/** A Tychicus launcher with `mcp`: what a moved entry runs. */
function runsTychicus(command: string, args: string[]): boolean {
	return programName(command) === "tychicus" && args.length === 1 && args[0] === "mcp";
}

/** The same commands with something more after `mcp`: left alone and named, since the extra flags may not carry over. */
function nearMiss(command: string, args: string[]): boolean {
	const i = args.indexOf("mcp");
	return i >= 0 && i < args.length - 1 && launchesPolycarpBrowser(command, args.slice(0, i + 1));
}

function commandLine(command: string, args: string[]): string {
	return [command, ...args].join(" ");
}

type Command = { command: string; args: string[] };

function sameCommand(a: Command, b: Command): boolean {
	return a.command === b.command && a.args.join("\0") === b.args.join("\0");
}

/** A config value as plain data with its object keys sorted, so two entries compare whatever their key order. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(object)
				.sort()
				.map((k) => [k, canonical(object[k])]),
		);
	}
	return value;
}

/** The fields (command, args, env, enabled and any other) in which two server entries differ. */
function differingFields(a: unknown, b: unknown): string[] {
	// Through JSON first: TOML dates become their text and inline tables plain objects.
	const plain = (v: unknown) => (isObject(v) ? (JSON.parse(JSON.stringify(v)) as Record<string, unknown>) : {});
	const x = plain(a);
	const y = plain(b);
	const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
	return keys.filter((k) => JSON.stringify(canonical(x[k])) !== JSON.stringify(canonical(y[k])));
}

/** A server entry and the command it runs. */
interface Server {
	entry: unknown;
	cmd: Command;
}

// ---- JSON (and OpenCode's JSONC): find where each value sits, so only what moves is rewritten ----

/** End offset (exclusive) of the JSON value starting at `i`. The text is already known to parse. */
function valueEnd(text: string, i: number): number {
	const ch = text[i];
	if (ch === '"') return stringEnd(text, i);
	if (ch === "{" || ch === "[") {
		let depth = 0;
		let j = i;
		for (;;) {
			const c = text[j];
			if (c === '"') {
				j = stringEnd(text, j);
				continue;
			}
			if (c === "{" || c === "[") depth++;
			else if (c === "}" || c === "]") {
				depth--;
				if (depth === 0) return j + 1;
			}
			j++;
		}
	}
	let j = i;
	while (j < text.length && !/[\s,\]}]/.test(text[j])) j++;
	return j;
}

/** For the object at `start`: each key's [key start, value start, value end]. */
function objectSpans(text: string, start: number): Map<string, [number, number, number]> {
	const spans = new Map<string, [number, number, number]>();
	let i = skipSpace(text, start + 1);
	while (text[i] !== "}") {
		const keyStart = i;
		const keyEnd = valueEnd(text, i);
		const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
		i = skipSpace(text, keyEnd);
		i = skipSpace(text, i + 1); // the colon
		const end = valueEnd(text, i);
		spans.set(key, [keyStart, i, end]);
		i = skipSpace(text, end);
		if (text[i] === ",") i = skipSpace(text, i + 1);
	}
	return spans;
}

interface JsonFormat {
	/** The key that holds the servers. */
	key: string;
	/** "args": command and args fields. "array": OpenCode's command array. */
	shape: "args" | "array";
	/** OpenCode reads JSONC: comments and trailing commas. */
	jsonc: boolean;
}

const JSON_FORMATS: Record<Exclude<MigrationHarness, "codex">, JsonFormat> = {
	claude: { key: "mcpServers", shape: "args", jsonc: false },
	opencode: { key: "mcp", shape: "array", jsonc: true },
	cursor: { key: "mcpServers", shape: "args", jsonc: false },
	omp: { key: "mcpServers", shape: "args", jsonc: false },
};

/** The parsed config, and the text to find offsets in: the file with any comments blanked. */
function readJsonText(text: string, jsonc: boolean): { data: unknown; scan: string } {
	const scan = jsonc ? blankComments(text) : text;
	return { data: JSON.parse(jsonc ? dropTrailingCommas(scan) : text), scan };
}

function jsonCommand(entry: unknown, shape: JsonFormat["shape"]): Command | undefined {
	if (!isObject(entry)) return undefined;
	if (shape === "array") {
		const c = entry.command;
		if (!Array.isArray(c) || c.length === 0 || !c.every((x) => typeof x === "string")) return undefined;
		return { command: c[0] as string, args: (c as string[]).slice(1) };
	}
	if (typeof entry.command !== "string") return undefined;
	const args = entry.args === undefined ? [] : entry.args;
	if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) return undefined;
	return { command: entry.command, args: args as string[] };
}

function retarget(entry: Record<string, unknown>, shape: JsonFormat["shape"], binary: string): Record<string, unknown> {
	return shape === "array" ? { ...entry, command: [binary, "mcp"] } : { ...entry, command: binary, args: ["mcp"] };
}

interface Edit {
	at: number;
	end: number;
	text: string;
}

function applyEdits(text: string, edits: Edit[]): string {
	let out = text;
	for (const edit of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, edit.at) + edit.text + out.slice(edit.end);
	return out;
}

/** Parse a JSON harness config, or refuse the plan. */
function parseJsonConfig(plan: FilePlan, text: string, format: JsonFormat): { data: Record<string, unknown>; scan: string } | undefined {
	const kind = format.jsonc ? "JSONC" : "JSON";
	let parsed: { data: unknown; scan: string };
	try {
		parsed = readJsonText(text, format.jsonc);
	} catch (err) {
		refuse(plan, `it isn't valid ${kind} (${message(err)}), so it was left as it is. Fix it, or move the entries by hand.`, couldHoldEntry(text));
		return undefined;
	}
	if (!isObject(parsed.data)) {
		refuse(plan, `it isn't a ${kind} object, so it was left as it is.`, couldHoldEntry(text));
		return undefined;
	}
	return { data: parsed.data, scan: parsed.scan };
}

/** Each server's [key start, value start, value end] under `key`. */
function serverSpans(scan: string, key: string): Map<string, [number, number, number]> | undefined {
	const start = objectSpans(scan, skipSpace(scan, 0)).get(key)?.[1];
	if (start === undefined || scan[start] !== "{") return undefined;
	return objectSpans(scan, start);
}

/** Write `after` into the plan if it parses to exactly `expected`; otherwise refuse the file. */
function settleJson(plan: FilePlan, text: string, edits: Edit[], expected: unknown, format: JsonFormat): void {
	if (edits.length === 0) return;
	const after = applyEdits(text, edits);
	let parsed: unknown;
	try {
		parsed = readJsonText(after, format.jsonc).data;
	} catch {
		parsed = undefined;
	}
	if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
		refuse(plan, "the edit didn't come out as intended, so the file was left as it is. Move the entries by hand.", true);
		return;
	}
	plan.status = "change";
	plan.after = after;
}

/** Claude Code's project (local scope) entries win over the user entry in that project. They are named, not edited. */
function noteProjects(plan: FilePlan, data: Record<string, unknown>): void {
	if (!isObject(data.projects)) return;
	for (const [project, settings] of Object.entries(data.projects)) {
		const servers = isObject(settings) ? settings.mcpServers : undefined;
		if (!isObject(servers)) continue;
		for (const [name, entry] of Object.entries(servers)) {
			const cmd = jsonCommand(entry, "args");
			if (cmd && launchesPolycarpBrowser(cmd.command, cmd.args)) plan.projects.push({ project, name, from: commandLine(cmd.command, cmd.args) });
		}
	}
}

function twoServersNote(plan: FilePlan, servers: Record<string, unknown>): void {
	if (Object.hasOwn(servers, MCP_NAME) && plan.repointed.some((r) => r.name !== MCP_NAME)) {
		plan.notes.push(`a ${MCP_NAME} entry is there too, so this agent runs two Tychicus servers until ${COMMAND_NAME} setup --agents --finish removes the old name.`);
	}
}

function planJsonMove(plan: FilePlan, text: string, format: JsonFormat): void {
	const parsed = parseJsonConfig(plan, text, format);
	if (!parsed) return;
	const { data, scan } = parsed;
	if (plan.harness === "claude") noteProjects(plan, data);
	const servers = data[format.key];
	if (!isObject(servers)) return;
	const spans = serverSpans(scan, format.key);
	if (!spans) return;
	const edits: Edit[] = [];
	const expected = structuredClone(data) as Record<string, Record<string, unknown>>;
	for (const [name, entry] of Object.entries(servers)) {
		const cmd = jsonCommand(entry, format.shape);
		if (!cmd) continue;
		const from = commandLine(cmd.command, cmd.args);
		if (!launchesPolycarpBrowser(cmd.command, cmd.args)) {
			if (nearMiss(cmd.command, cmd.args)) plan.leftAlone.push(`"${name}" runs ${from}: extra arguments, so it was left alone. Point it at ${plan.binary} mcp by hand.`);
			continue;
		}
		const span = spans.get(name);
		const fields = span ? objectSpans(scan, span[1]) : undefined;
		const command = fields?.get("command");
		const args = fields?.get("args");
		if (!command || (format.shape === "args" && !args)) continue;
		// Only the command (and args) values change; the entry's other fields, comments and layout stay.
		if (format.shape === "array") edits.push({ at: command[1], end: command[2], text: `[${JSON.stringify(plan.binary)}, "mcp"]` });
		else if (args) edits.push({ at: command[1], end: command[2], text: JSON.stringify(plan.binary) }, { at: args[1], end: args[2], text: '["mcp"]' });
		expected[format.key][name] = retarget(entry as Record<string, unknown>, format.shape, plan.binary);
		plan.repointed.push({ name, from });
	}
	twoServersNote(plan, servers);
	settleJson(plan, text, edits, expected, format);
}

/**
 * The edits that take the removed entries out of their object, with the commas that separated them. Removed entries
 * that sit next to each other go as one range, so no two edits overlap: up to the next kept key when one follows, else
 * from the comma after the kept entry before them.
 */
function removalEdits(scan: string, spans: Map<string, [number, number, number]>, removed: Set<string>): Edit[] {
	const order = [...spans].sort((a, b) => a[1][0] - b[1][0]).map(([name, span]) => ({ name, span }));
	const edits: Edit[] = [];
	let i = 0;
	while (i < order.length) {
		if (!removed.has(order[i].name)) {
			i++;
			continue;
		}
		let j = i;
		while (j + 1 < order.length && removed.has(order[j + 1].name)) j++;
		const first = order[i].span;
		const last = order[j].span;
		const next = order[j + 1]?.span;
		const prev = order[i - 1]?.span;
		if (next) edits.push({ at: first[0], end: next[0], text: "" });
		else if (prev) edits.push({ at: skipSpace(scan, prev[2]), end: last[2], text: "" });
		else {
			const comma = skipSpace(scan, last[2]);
			edits.push({ at: first[0], end: scan[comma] === "," ? skipSpace(scan, comma + 1) : last[2], text: "" });
		}
		i = j + 1;
	}
	return edits;
}

/**
 * What the finish step does with one alias, given the tychicus entry (if any) already in the file. The alias is removed
 * only when the two entries are the same in every field; otherwise removing it could drop the server the agent runs
 * (an enabled alias beside a disabled tychicus) or its env and other settings, so it is left for a manual fix.
 */
function finishAction(plan: FilePlan, alias: string, entry: unknown, cmd: Command | undefined, present: boolean, tychicus: Server | undefined): "rename" | "remove" | undefined {
	if (!present) {
		plan.forget.push(alias);
		plan.notes.push(`"${alias}" is no longer in the file; it leaves the list of aliases.`);
		return undefined;
	}
	if (!cmd || !runsTychicus(cmd.command, cmd.args)) {
		plan.forget.push(alias);
		plan.notes.push(`"${alias}" no longer runs Tychicus${cmd ? ` (it runs ${commandLine(cmd.command, cmd.args)})` : ""}, so it was left alone and leaves the list of aliases.`);
		return undefined;
	}
	if (!tychicus) return "rename";
	if (!sameCommand(tychicus.cmd, cmd)) {
		plan.leftAlone.push(
			`"${alias}" runs ${commandLine(cmd.command, cmd.args)}, but the ${MCP_NAME} entry runs ${commandLine(tychicus.cmd.command, tychicus.cmd.args)}. Remove one of the two by hand, then run ${COMMAND_NAME} setup --agents --finish again.`,
		);
		return undefined;
	}
	const fields = differingFields(entry, tychicus.entry);
	if (fields.length === 0) return "remove";
	plan.leftAlone.push(
		`"${alias}" runs the same command as the ${MCP_NAME} entry but differs in ${fields.map((f) => `"${f}"`).join(", ")}, so both were left as they are. Keep the settings you want under ${MCP_NAME} and remove "${alias}" by hand, then run ${COMMAND_NAME} setup --agents --finish again.`,
	);
	return undefined;
}

function planJsonFinish(plan: FilePlan, text: string, format: JsonFormat): void {
	const parsed = parseJsonConfig(plan, text, format);
	if (!parsed) return;
	const { data, scan } = parsed;
	const servers = isObject(data[format.key]) ? (data[format.key] as Record<string, unknown>) : {};
	const spans = serverSpans(scan, format.key) ?? new Map();
	let tychicus: Server | undefined = Object.hasOwn(servers, MCP_NAME) ? { entry: servers[MCP_NAME], cmd: jsonCommand(servers[MCP_NAME], format.shape) ?? { command: "", args: [] } } : undefined;
	const edits: Edit[] = [];
	let renamed: string | undefined;
	const removed = new Set<string>();
	for (const alias of plan.aliases) {
		const cmd = jsonCommand(servers[alias], format.shape);
		const span = spans.get(alias);
		const action = finishAction(plan, alias, servers[alias], cmd, Object.hasOwn(servers, alias) && span !== undefined, tychicus);
		if (!action || !span || !cmd) continue;
		if (action === "rename") {
			edits.push({ at: span[0], end: valueEnd(scan, span[0]), text: JSON.stringify(MCP_NAME) });
			renamed = alias;
			tychicus = { entry: servers[alias], cmd };
		} else removed.add(alias);
		plan.finished.push({ name: alias, action: action === "rename" ? "renamed" : "removed" });
	}
	edits.push(...removalEdits(scan, spans, removed));
	const rebuilt: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(servers)) {
		if (removed.has(name)) continue;
		rebuilt[name === renamed ? MCP_NAME : name] = entry;
	}
	settleJson(plan, text, edits, { ...data, [format.key]: rebuilt }, format);
}

// ---- Codex's TOML: read with a real parser, edited by table text so comments and layout stay ----

const TABLE = /^\s*\[\s*mcp_servers\.(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))((?:\.[A-Za-z0-9_-]+)*)\s*\]\s*(?:#.*)?$/;

interface TomlTable {
	name: string;
	/** "" for the server's own table, ".env" and so on for its subtables. */
	sub: string;
	header: number;
	/** First line after the table (the next header or the end). */
	end: number;
}

function tomlTables(lines: string[]): TomlTable[] {
	const tables: TomlTable[] = [];
	let current: TomlTable | undefined;
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*\[/.test(lines[i])) continue;
		if (current) current.end = i;
		const m = lines[i].match(TABLE);
		current = m ? { name: m[1] ?? m[2] ?? m[3], sub: m[4], header: i, end: lines.length } : undefined;
		if (current) tables.push(current);
	}
	return tables;
}

function tomlCommand(entry: unknown): Command | undefined {
	if (!isObject(entry) || typeof entry.command !== "string") return undefined;
	const args = entry.args === undefined ? [] : entry.args;
	if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) return undefined;
	return { command: entry.command, args: args as string[] };
}

/** The line where an array that opens on `line` at `from` closes, reading strings and comments. */
function arrayEndLine(lines: string[], line: number, from: number): number | undefined {
	let depth = 0;
	for (let l = line; l < lines.length; l++) {
		const text = lines[l];
		for (let i = l === line ? from : 0; i < text.length; i++) {
			const ch = text[i];
			if (ch === "#") break;
			if (ch === '"' || ch === "'") {
				let j = i + 1;
				while (j < text.length && text[j] !== ch) j += ch === '"' && text[j] === "\\" ? 2 : 1;
				i = j;
			} else if (ch === "[") depth++;
			else if (ch === "]" && --depth === 0) return l;
		}
	}
	return undefined;
}

/** `key = value` among a table's own lines: the first line, the last (an array can span lines) and the indent. */
function tomlKey(lines: string[], table: TomlTable, key: string): { line: number; last: number; indent: string } | undefined {
	for (let i = table.header + 1; i < table.end; i++) {
		const m = lines[i].match(new RegExp(`^(\\s*)(?:${key}|"${key}")\\s*=\\s*`));
		if (!m) continue;
		if (lines[i][m[0].length] !== "[") return { line: i, last: i, indent: m[1] };
		const last = arrayEndLine(lines, i, m[0].length);
		return last === undefined ? undefined : { line: i, last, indent: m[1] };
	}
	return undefined;
}

/** Parse Codex's config, or refuse the plan. */
function parseCodex(plan: FilePlan, text: string): { data: Record<string, unknown>; servers: Record<string, unknown> } | undefined {
	let data: Record<string, unknown>;
	try {
		data = parseToml(text) as Record<string, unknown>;
	} catch (err) {
		refuse(plan, `it isn't valid TOML (${message(err)}), so it was left as it is. Fix it, or move the entries by hand.`, couldHoldEntry(text));
		return undefined;
	}
	return { data, servers: isObject(data.mcp_servers) ? data.mcp_servers : {} };
}

/** Write `after` into the plan if it parses to exactly `expected`; otherwise refuse the file. */
function settleToml(plan: FilePlan, lines: string[], replace: Map<number, string>, drop: Set<number>, expected: unknown): void {
	if (replace.size === 0 && drop.size === 0) return;
	const after = lines
		.flatMap((line, i) => (drop.has(i) ? [] : [replace.get(i) ?? line]))
		.join("\n");
	let parsed: unknown;
	try {
		parsed = parseToml(after);
	} catch {
		parsed = undefined;
	}
	if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
		refuse(plan, "the edit didn't come out as valid TOML with the intended entries, so the file was left as it is. Move the entries by hand.", true);
		return;
	}
	plan.status = "change";
	plan.after = after;
}

function planTomlMove(plan: FilePlan, text: string): void {
	const parsed = parseCodex(plan, text);
	if (!parsed) return;
	const lines = text.split("\n");
	const tables = tomlTables(lines);
	const replace = new Map<number, string>();
	const drop = new Set<number>();
	// A fresh parse, not a clone: smol-toml's dates keep their own form only as parsed.
	const expected = parseToml(text) as Record<string, Record<string, Record<string, unknown>>>;
	for (const [name, entry] of Object.entries(parsed.servers)) {
		const cmd = tomlCommand(entry);
		if (!cmd) continue;
		const from = commandLine(cmd.command, cmd.args);
		if (!launchesPolycarpBrowser(cmd.command, cmd.args)) {
			if (nearMiss(cmd.command, cmd.args)) plan.leftAlone.push(`[mcp_servers.${name}] runs ${from}: extra arguments, so it was left alone. Point it at ${plan.binary} mcp by hand.`);
			continue;
		}
		const table = tables.find((t) => t.name === name && t.sub === "");
		const command = table && tomlKey(lines, table, "command");
		const args = table && tomlKey(lines, table, "args");
		if (!command || !args || command.last !== command.line) {
			plan.leftAlone.push(`"${name}" runs ${from}, but it is written in a form this can't edit (an inline table, dotted keys or a multi-line string), so it was left alone. Point it at ${plan.binary} mcp by hand.`);
			continue;
		}
		replace.set(command.line, `${command.indent}command = ${JSON.stringify(plan.binary)}`);
		replace.set(args.line, `${args.indent}args = ["mcp"]`);
		for (let i = args.line + 1; i <= args.last; i++) drop.add(i);
		expected.mcp_servers[name].command = plan.binary;
		expected.mcp_servers[name].args = ["mcp"];
		plan.repointed.push({ name, from });
	}
	twoServersNote(plan, parsed.servers);
	settleToml(plan, lines, replace, drop, expected);
}

function planTomlFinish(plan: FilePlan, text: string): void {
	const parsed = parseCodex(plan, text);
	if (!parsed) return;
	const { servers } = parsed;
	const lines = text.split("\n");
	const tables = tomlTables(lines);
	const replace = new Map<number, string>();
	const drop = new Set<number>();
	let tychicus: Server | undefined = Object.hasOwn(servers, MCP_NAME) ? { entry: servers[MCP_NAME], cmd: tomlCommand(servers[MCP_NAME]) ?? { command: "", args: [] } } : undefined;
	let renamed: string | undefined;
	const removed = new Set<string>();
	for (const alias of plan.aliases) {
		const cmd = tomlCommand(servers[alias]);
		const action = finishAction(plan, alias, servers[alias], cmd, Object.hasOwn(servers, alias), tychicus);
		if (!action || !cmd) continue;
		const family = tables.filter((t) => t.name === alias);
		if (!family.some((t) => t.sub === "")) {
			plan.leftAlone.push(`"${alias}" is written in a form this can't rename (an inline table or dotted keys). Rename it to ${MCP_NAME} by hand.`);
			continue;
		}
		if (action === "rename") {
			for (const t of family) replace.set(t.header, lines[t.header].replace(/(\[\s*mcp_servers\.)(?:"[^"\\]+"|'[^']+'|[A-Za-z0-9_-]+)/, `$1${MCP_NAME}`));
			renamed = alias;
			tychicus = { entry: servers[alias], cmd };
		} else {
			for (const t of family) for (let i = t.header; i < t.end; i++) drop.add(i);
			removed.add(alias);
		}
		plan.finished.push({ name: alias, action: action === "rename" ? "renamed" : "removed" });
	}
	const expected = parseToml(text) as Record<string, unknown>;
	if (isObject(expected.mcp_servers)) {
		const rebuilt: Record<string, unknown> = {};
		for (const [name, entry] of Object.entries(expected.mcp_servers)) {
			if (removed.has(name)) continue;
			rebuilt[name === renamed ? MCP_NAME : name] = entry;
		}
		expected.mcp_servers = rebuilt;
	}
	settleToml(plan, lines, replace, drop, expected);
}

// ---- Plans ----

function planMoveText(plan: FilePlan, text: string): void {
	if (plan.harness === "codex") planTomlMove(plan, text);
	else planJsonMove(plan, text, JSON_FORMATS[plan.harness]);
}

function planFinishText(plan: FilePlan, text: string): void {
	if (plan.harness === "codex") planTomlFinish(plan, text);
	else planJsonFinish(plan, text, JSON_FORMATS[plan.harness]);
}

/** Read the file into the plan and fill it in, or refuse it when it can't be read. */
function planFile(plan: FilePlan): FilePlan {
	if (!existsSync(plan.file)) {
		if (plan.kind === "finish") plan.forget = [...plan.aliases];
		return plan;
	}
	let text: string;
	try {
		text = readFileSync(plan.file, "utf8");
	} catch (err) {
		refuse(plan, `it couldn't be read (${message(err)}).`, true);
		return plan;
	}
	plan.status = "unchanged";
	plan.before = text;
	if (plan.kind === "move") planMoveText(plan, text);
	else planFinishText(plan, text);
	return plan;
}

/** What moving agents from Polycarp would change in each harness config, without writing anything. */
export function planMigration(binary: string): FilePlan[] {
	return migrationFiles().map(({ harness, file }) => planFile(newPlan("move", harness, file, binary)));
}

/** What finishing the move would change: each alias renamed to tychicus. Nothing is written. */
export function planFinish(binary: string): FilePlan[] {
	const byFile = new Map<string, { harness: MigrationHarness; names: string[] }>();
	for (const record of knownAliases()) {
		const group = byFile.get(record.file) ?? { harness: record.harness, names: [] };
		if (!group.names.includes(record.name)) group.names.push(record.name);
		byFile.set(record.file, group);
	}
	return [...byFile].map(([file, { harness, names }]) => {
		const plan = newPlan("finish", harness, file, binary);
		plan.aliases = names;
		return planFile(plan);
	});
}

/** The plan for the file's current text, to compare with the one the user approved. */
function replan(plan: FilePlan, text: string): FilePlan {
	const again = newPlan(plan.kind, plan.harness, plan.file, plan.binary);
	again.aliases = plan.aliases;
	again.status = "unchanged";
	again.before = text;
	if (plan.kind === "move") planMoveText(again, text);
	else planFinishText(again, text);
	return again;
}

/** The same entries move (or the same aliases finish) as in the plan the user said yes to. */
function sameApproval(approved: FilePlan, current: FilePlan): boolean {
	return current.status === "change" && JSON.stringify([approved.repointed, approved.finished]) === JSON.stringify([current.repointed, current.finished]);
}

/** A line diff of before and after, three lines of context, as `diff -u` prints it. */
export function unifiedDiff(file: string, before: string, after: string): string {
	// Lines as `diff -u` counts them: a final newline ends the last line, it doesn't start another.
	const lines = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
	const a = lines(before);
	const b = lines(after);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	// The changed middle is small (a few entries), so a plain LCS table is fine.
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const ops: string[] = [];
	if (midA.length * midB.length <= 4_000_000) {
		const lcs = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0));
		for (let i = midA.length - 1; i >= 0; i--) for (let j = midB.length - 1; j >= 0; j--) lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		let i = 0;
		let j = 0;
		while (i < midA.length || j < midB.length) {
			if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
				ops.push(` ${midA[i]}`);
				i++;
				j++;
			} else if (i < midA.length && (j === midB.length || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(`-${midA[i++]}`);
			else ops.push(`+${midB[j++]}`);
		}
	} else {
		ops.push(...midA.map((l) => `-${l}`), ...midB.map((l) => `+${l}`));
	}
	const context = 3;
	const from = Math.max(0, start - context);
	const lead = a.slice(from, start).map((l) => ` ${l}`);
	const trail = a.slice(endA, Math.min(a.length, endA + context)).map((l) => ` ${l}`);
	const removed = ops.filter((o) => o[0] !== "+").length;
	const addedCount = ops.filter((o) => o[0] !== "-").length;
	const header = `@@ -${from + 1},${lead.length + removed + trail.length} +${from + 1},${lead.length + addedCount + trail.length} @@`;
	return [`--- ${file}`, `+++ ${file} (after)`, header, ...lead, ...ops, ...trail].join("\n");
}

/** A timestamp for backup names: 20261117T195441Z. */
export function backupStamp(now = new Date()): string {
	return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** `path`, or `path-2`, `path-3`... when a backup from the same second is already there. */
function freeName(path: string): string {
	if (!existsSync(path)) return path;
	let n = 2;
	while (existsSync(`${path}-${n}`)) n++;
	return `${path}-${n}`;
}

// ---- The list of temporary aliases ----

/** The file that lists the temporary aliases. */
export function aliasFile(): string {
	return join(configDir(), "agent-aliases.json");
}

export function readAliases(): AliasRecord[] {
	try {
		const data = JSON.parse(readFileSync(aliasFile(), "utf8")) as { aliases?: AliasRecord[] };
		return Array.isArray(data.aliases) ? data.aliases : [];
	} catch {
		return [];
	}
}

function writeAliases(aliases: AliasRecord[]): void {
	const file = aliasFile();
	if (aliases.length === 0) {
		rmSync(file, { force: true });
		return;
	}
	mkdirSync(dirname(file), { recursive: true });
	const record = {
		note: `Temporary: these entries keep their old names but run Tychicus, so rules that name the polycarp MCP server still work. Once nothing names them, ${COMMAND_NAME} setup --agents --finish renames each to ${MCP_NAME}.`,
		aliases,
	};
	writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

function recordAliases(plan: FilePlan, now: Date): void {
	const known = readAliases();
	for (const r of plan.repointed) {
		if (r.name === MCP_NAME) continue;
		if (!known.some((k) => k.harness === plan.harness && k.file === plan.file && k.name === r.name)) known.push({ harness: plan.harness, file: plan.file, name: r.name, since: now.toISOString() });
	}
	writeAliases(known);
}

function forgetAliases(plan: FilePlan): void {
	const names = new Set([...plan.finished.map((f) => f.name), ...plan.forget]);
	if (names.size === 0) return;
	const known = readAliases();
	const kept = known.filter((k) => !(k.harness === plan.harness && k.file === plan.file && names.has(k.name)));
	if (kept.length !== known.length) writeAliases(kept);
}

function entryCommand(harness: MigrationHarness, entry: unknown): Command | undefined {
	return harness === "codex" ? tomlCommand(entry) : jsonCommand(entry, JSON_FORMATS[harness].shape);
}

function readServers(harness: MigrationHarness, text: string): Record<string, unknown> | undefined {
	if (harness === "codex") {
		const data = parseToml(text) as Record<string, unknown>;
		return isObject(data.mcp_servers) ? data.mcp_servers : undefined;
	}
	const format = JSON_FORMATS[harness];
	const { data } = readJsonText(text, format.jsonc);
	const servers = isObject(data) ? data[format.key] : undefined;
	return isObject(servers) ? servers : undefined;
}

/**
 * Entries named like polycarp or tabkyra (any case) that run a Tychicus launcher, in each harness's config. They are
 * temporary aliases whether or not agent-aliases.json lists them: the move's write of that list can fail after the
 * config was written, and the finish and doctor must still find them.
 */
function foundAliases(): AliasRecord[] {
	const found: AliasRecord[] = [];
	for (const { harness, file } of migrationFiles()) {
		let servers: Record<string, unknown> | undefined;
		try {
			servers = readServers(harness, readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		for (const [name, entry] of Object.entries(servers ?? {})) {
			if (name === MCP_NAME || !couldHoldEntry(name)) continue;
			const cmd = entryCommand(harness, entry);
			if (cmd && runsTychicus(cmd.command, cmd.args)) found.push({ harness, file, name });
		}
	}
	return found;
}

/** The recorded aliases, and the ones found by name and launcher that the list is missing. */
export function knownAliases(): AliasRecord[] {
	const known = readAliases();
	for (const f of foundAliases()) if (!known.some((k) => k.harness === f.harness && k.file === f.file && k.name === f.name)) known.push(f);
	return known;
}

/**
 * The alias through which this harness runs Tychicus, if its entry is still there and still runs a Tychicus launcher.
 * Setup and doctor count it as configured, so they don't add a second `tychicus` entry beside it.
 */
export function liveAlias(harness: string): AliasRecord | undefined {
	for (const record of knownAliases()) {
		if (record.harness !== harness) continue;
		try {
			const cmd = entryCommand(record.harness, readServers(record.harness, readFileSync(record.file, "utf8"))?.[record.name]);
			if (cmd && runsTychicus(cmd.command, cmd.args)) return record;
		} catch {
			// An unreadable file is no alias.
		}
	}
	return undefined;
}

// ---- Writing ----

function changedWhileDeciding(plan: FilePlan): void {
	refuse(plan, `it changed while you were deciding; run ${COMMAND_NAME} setup --agents${plan.kind === "finish" ? " --finish" : ""} again. Nothing was written to it.`, true);
}

/**
 * Bring agent-aliases.json in step with a plan. A failure there doesn't undo or stop the config write: the finish and
 * doctor also find aliases by name and launcher, so it becomes a warning on the plan.
 */
function updateAliasList(plan: FilePlan, update: () => void): void {
	try {
		update();
	} catch (err) {
		const unnamed = plan.kind === "move" ? plan.repointed.map((r) => r.name).filter((n) => n !== MCP_NAME && !couldHoldEntry(n)) : [];
		const byHand = unnamed.length > 0 ? ` Rename ${unnamed.map((n) => `"${n}"`).join(", ")} to ${MCP_NAME} by hand once nothing names ${unnamed.length === 1 ? "it" : "them"}.` : "";
		plan.aliasWarning = `${aliasFile()} couldn't be updated (${message(err)}). ${COMMAND_NAME} setup --agents --finish and ${COMMAND_NAME} doctor still find entries named polycarp or tabkyra that run Tychicus.${byHand}`;
	}
}

/**
 * Write each changed file: the new text to a temporary file beside the real one (through a link to its target), a
 * last check that the file is still the text this run planned from, a backup of that text, then a rename. A file that
 * changed after it was planned is planned again and written only if the same entries move; otherwise it is refused
 * (the plan's status says so) and nothing is written to it. Each file's aliases are recorded (move) or taken off the
 * list (finish) right after its rename; a failure there is set as the plan's aliasWarning. Returns the backups made.
 */
export function applyMigration(plans: FilePlan[], now = new Date()): { file: string; backup: string }[] {
	const done: { file: string; backup: string }[] = [];
	const stamp = backupStamp(now);
	for (const plan of plans) {
		if (plan.kind === "finish" && plan.status !== "change" && plan.status !== "refused") updateAliasList(plan, () => forgetAliases(plan));
		if (plan.status !== "change" || plan.after === undefined) continue;
		const real = realpathSync(plan.file);
		const mode = statSync(real).mode & 0o777;
		const temp = join(dirname(real), `.${basename(real)}.tychicus-${process.pid}`);
		try {
			const fresh = readFileSync(real, "utf8");
			if (fresh !== plan.before) {
				const again = replan(plan, fresh);
				if (!sameApproval(plan, again)) {
					changedWhileDeciding(plan);
					continue;
				}
				Object.assign(plan, again);
			}
			writeFileSync(temp, plan.after as string, { mode });
			chmodSync(temp, mode);
			// From here to the rename: one read, the backup and the rename.
			if (readFileSync(real, "utf8") !== fresh) {
				changedWhileDeciding(plan);
				continue;
			}
			const backup = freeName(`${plan.file}.tychicus-backup-${stamp}`);
			writeFileSync(backup, fresh, { mode, flag: "wx" });
			chmodSync(backup, mode);
			renameSync(temp, real);
			done.push({ file: plan.file, backup });
			updateAliasList(plan, () => (plan.kind === "move" ? recordAliases(plan, now) : forgetAliases(plan)));
		} finally {
			rmSync(temp, { force: true });
		}
	}
	return done;
}
