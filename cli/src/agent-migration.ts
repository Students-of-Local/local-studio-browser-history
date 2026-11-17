/**
 * Moving agents from Polycarp: Claude Code, Codex, OpenCode, Cursor and OMP may still have an MCP entry that runs
 * Polycarp's browser server (`polycarp browser mcp`, `polycarp-browser mcp`, Polycarp's old browser launcher or
 * `tabkyra mcp`). When Polycarp drops its browser, those agents would lose their browser tools. For each such entry
 * this adds a `tychicus` entry that runs Tychicus's launcher with `mcp`, and points the old entry at the same command
 * under its old name. That alias is temporary: fleet rules that say "the polycarp MCP server" keep working until they
 * are renamed, and the aliases are listed in agent-aliases.json in Tychicus's config folder.
 *
 * Only the harness config files are written, each after a timestamped backup beside it, and only the entries that
 * launch Polycarp's browser server change: the rest of each file is kept byte for byte. A file that doesn't parse is
 * refused and left alone. Polycarp's own folders and launchers are never read or written. A second run finds nothing
 * to move and changes nothing.
 */

import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { configDir } from "./files.ts";
import { MCP_NAME } from "./harness.ts";

/** The harnesses whose MCP config this moves, with the file each one documents for user scope. */
export type MigrationHarness = "claude" | "codex" | "opencode" | "cursor" | "omp";

export interface Repointed {
	name: string;
	/** The command line the entry ran before. */
	from: string;
}

export interface FilePlan {
	harness: MigrationHarness;
	/** The harness's display name. */
	name: string;
	file: string;
	/** "change": `after` differs from `before`. "refused": the file couldn't be read safely; nothing is written. */
	status: "missing" | "unchanged" | "change" | "refused";
	reason?: string;
	/** Entries that launched Polycarp's browser server and now run Tychicus, under their old names. */
	repointed: Repointed[];
	/** True when a `tychicus` entry is added. */
	added: boolean;
	/** Notes on things left alone (an entry with extra arguments, a form this can't edit). */
	notes: string[];
	before?: string;
	after?: string;
}

export interface AliasRecord {
	harness: MigrationHarness;
	file: string;
	name: string;
	since: string;
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

/**
 * True when command and args start Polycarp's browser MCP server: `polycarp browser mcp`, `polycarp-browser mcp`,
 * `tabkyra mcp`, or Polycarp's browser launcher (`.../polycarp/browser/polycarp`) with `mcp`. Plain `polycarp mcp`
 * is the Polycarp app's own server and is not this.
 */
export function launchesPolycarpBrowser(command: string, args: string[]): boolean {
	const base = basename(command.replaceAll("\\", "/"))
		.toLowerCase()
		.replace(/\.(exe|cmd|bat)$/, "");
	const line = args.join(" ");
	if (base === "polycarp" && line === "browser mcp") return true;
	if ((base === "polycarp-browser" || base === "tabkyra") && line === "mcp") return true;
	return base === "polycarp" && line === "mcp" && /[\\/]polycarp[\\/]browser[\\/]polycarp(\.(exe|cmd))?$/i.test(command);
}

/** The same commands with something more after `mcp`: left alone and named, since the extra flags may not carry over. */
function nearMiss(command: string, args: string[]): boolean {
	const i = args.indexOf("mcp");
	return i >= 0 && i < args.length - 1 && launchesPolycarpBrowser(command, args.slice(0, i + 1));
}

function commandLine(command: string, args: string[]): string {
	return [command, ...args].join(" ");
}

// ---- JSON: find where each value sits, so only the entries that move are rewritten ----

/** End offset (exclusive) of the JSON value starting at `i`. The text is already known to parse. */
function valueEnd(text: string, i: number): number {
	const ch = text[i];
	if (ch === '"') {
		let j = i + 1;
		while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
		return j + 1;
	}
	if (ch === "{" || ch === "[") {
		let depth = 0;
		let j = i;
		for (;;) {
			const c = text[j];
			if (c === '"') {
				j = valueEnd(text, j);
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

function skipSpace(text: string, i: number): number {
	while (/\s/.test(text[i] ?? "")) i++;
	return i;
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

/** The file's indent unit: the first indented line's leading whitespace, else two spaces. */
function indentUnit(text: string): string {
	const first = text.match(/\n([ \t]+)\S/)?.[1];
	if (!first) return "  ";
	return first.startsWith("\t") ? "\t" : first;
}

/** JSON with short string arrays on one line, as harness.ts's snippets print them, indented to sit at `indent`. */
function formatValue(value: unknown, unit: string, indent: string, compact: boolean): string {
	if (compact) return JSON.stringify(value);
	const pretty = JSON.stringify(value, null, unit).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_m, inner: string) => `[${inner.split(/,\s+/).join(", ")}]`);
	return pretty.replaceAll("\n", `\n${indent}`);
}

type JsonShape = "args" | "array";

function entryCommand(entry: unknown, shape: JsonShape): { command: string; args: string[] } | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const e = entry as Record<string, unknown>;
	if (shape === "array") {
		if (!Array.isArray(e.command) || !e.command.every((x) => typeof x === "string") || e.command.length === 0) return undefined;
		return { command: e.command[0] as string, args: (e.command as string[]).slice(1) };
	}
	if (typeof e.command !== "string") return undefined;
	const args = e.args === undefined ? [] : e.args;
	if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) return undefined;
	return { command: e.command, args: args as string[] };
}

function retarget(entry: Record<string, unknown>, shape: JsonShape, binary: string): Record<string, unknown> {
	return shape === "array" ? { ...entry, command: [binary, "mcp"] } : { ...entry, command: binary, args: ["mcp"] };
}

function planJson(plan: FilePlan, text: string, key: string, shape: JsonShape, binary: string): void {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (err) {
		plan.status = "refused";
		plan.reason = `it isn't valid JSON (${err instanceof Error ? err.message : String(err)}), so it was left as it is. Fix it, or move the entries by hand.`;
		return;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		plan.status = "refused";
		plan.reason = "it isn't a JSON object, so it was left as it is.";
		return;
	}
	const servers = (data as Record<string, unknown>)[key];
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
	const entries = servers as Record<string, unknown>;
	const top = objectSpans(text, skipSpace(text, 0));
	const serversStart = top.get(key)?.[1];
	if (serversStart === undefined) return;
	const spans = objectSpans(text, serversStart);
	const unit = indentUnit(text);
	const hasTychicus = Object.hasOwn(entries, MCP_NAME);
	// Edits from the end of the file backwards, so earlier offsets stay right.
	const edits: { at: number; end: number; text: string }[] = [];
	for (const [name, entry] of Object.entries(entries)) {
		const cmd = entryCommand(entry, shape);
		if (!cmd) continue;
		if (!launchesPolycarpBrowser(cmd.command, cmd.args)) {
			if (nearMiss(cmd.command, cmd.args)) plan.notes.push(`"${name}" runs ${commandLine(cmd.command, cmd.args)}: extra arguments, so it was left alone. Point it at ${binary} mcp by hand.`);
			continue;
		}
		const span = spans.get(name);
		if (!span) continue;
		const [keyStart, valueStart, end] = span;
		const lineStart = text.lastIndexOf("\n", keyStart) + 1;
		const lead = text.slice(lineStart, keyStart);
		const compact = !/^[ \t]*$/.test(lead);
		const indent = compact ? "" : lead;
		const moved = retarget(entry as Record<string, unknown>, shape, binary);
		// An entry written on one line stays on one line.
		const oneLine = !compact && !text.slice(valueStart, end).includes("\n");
		const format = (value: unknown) => (oneLine ? formatValue(value, unit, "", false).replace(/\n\s*/g, " ") : formatValue(value, unit, indent, compact));
		let replacement = format(moved);
		if (!hasTychicus && !plan.added && name !== MCP_NAME) {
			replacement += `${compact ? ", " : `,\n${indent}`}${JSON.stringify(MCP_NAME)}: ${format(moved)}`;
			plan.added = true;
		}
		edits.push({ at: valueStart, end, text: replacement });
		plan.repointed.push({ name, from: commandLine(cmd.command, cmd.args) });
	}
	if (edits.length === 0) return;
	let after = text;
	for (const edit of edits.sort((a, b) => b.at - a.at)) after = after.slice(0, edit.at) + edit.text + after.slice(edit.end);
	// The edited text must parse to exactly the intended object: everything else as it was.
	const expected = structuredClone(data) as Record<string, Record<string, unknown>>;
	const rebuilt: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(entries)) {
		const moved = plan.repointed.some((r) => r.name === name);
		rebuilt[name] = moved ? retarget(entry as Record<string, unknown>, shape, binary) : entry;
		if (moved && plan.added && name === plan.repointed[0].name) rebuilt[MCP_NAME] = rebuilt[name];
	}
	expected[key] = rebuilt;
	let parsed: unknown;
	try {
		parsed = JSON.parse(after);
	} catch {
		parsed = undefined;
	}
	if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
		plan.status = "refused";
		plan.reason = "the edit didn't come out as intended, so the file was left as it is. Move the entries by hand.";
		plan.repointed = [];
		plan.added = false;
		return;
	}
	plan.status = "change";
	plan.after = after;
}

// ---- Codex's TOML: tables are edited line by line, the rest of the file is kept ----

const TABLE = /^\s*\[\s*mcp_servers\.(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))((?:\.[A-Za-z0-9_-]+)*)\s*\]\s*(?:#.*)?$/;

/** A TOML string (basic or literal) as the whole value, or undefined. */
function tomlString(raw: string): string | undefined {
	const v = raw.trim();
	if (/^'[^']*'$/.test(v)) return v.slice(1, -1);
	if (/^"(?:[^"\\]|\\.)*"$/.test(v)) {
		try {
			return JSON.parse(v) as string;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** A one-line TOML array of strings, or undefined. */
function tomlStrings(raw: string): string[] | undefined {
	const v = raw.trim();
	if (!v.startsWith("[") || !v.endsWith("]")) return undefined;
	const items: string[] = [];
	const rest = v.slice(1, -1).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (m) => {
		const s = tomlString(m);
		if (s !== undefined) items.push(s);
		return "";
	});
	return /^[\s,]*$/.test(rest) ? items : undefined;
}

function stripComment(value: string): string {
	// A # outside quotes starts a comment.
	let quote = "";
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quote) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "#") return value.slice(0, i);
	}
	return value;
}

interface TomlTable {
	name: string;
	/** "" for the server's own table, ".env" and so on for its subtables. */
	sub: string;
	header: number;
	/** First line after the table (the next header or the end). */
	end: number;
}

function planToml(plan: FilePlan, text: string, binary: string): void {
	const lines = text.split("\n");
	const tables: TomlTable[] = [];
	let current: TomlTable | undefined;
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*\[/.test(lines[i])) continue;
		if (current) current.end = i;
		const m = lines[i].match(TABLE);
		current = m ? { name: m[1] ?? m[2] ?? m[3], sub: m[4], header: i, end: lines.length } : undefined;
		if (current) tables.push(current);
	}
	const hasTychicus = tables.some((t) => t.name === MCP_NAME && t.sub === "");
	const replace = new Map<number, string>();
	let insertAt = -1;
	const copy: string[] = [];
	for (const table of tables.filter((t) => t.sub === "")) {
		let command: { line: number; value?: string } | undefined;
		let args: { line: number; value?: string[] } | undefined;
		let unsure = false;
		for (let i = table.header + 1; i < table.end; i++) {
			const kv = lines[i].match(/^(\s*)(command|args)\s*=\s*(.*)$/);
			if (!kv) continue;
			const value = stripComment(kv[3]);
			if (kv[2] === "command") command = { line: i, value: tomlString(value) };
			else {
				args = { line: i, value: tomlStrings(value) };
				if (!args.value) unsure = true;
			}
		}
		if (!command?.value) continue;
		const argList = args?.value ?? [];
		if (unsure) {
			if (/\b(polycarp|tabkyra)/i.test(command.value)) plan.notes.push(`[mcp_servers.${table.name}] runs ${command.value} with args this can't read (more than one line?), so it was left alone.`);
			continue;
		}
		if (!launchesPolycarpBrowser(command.value, argList)) {
			if (nearMiss(command.value, argList)) plan.notes.push(`[mcp_servers.${table.name}] runs ${commandLine(command.value, argList)}: extra arguments, so it was left alone. Point it at ${binary} mcp by hand.`);
			continue;
		}
		const indent = lines[command.line].match(/^\s*/)?.[0] ?? "";
		replace.set(command.line, `${indent}command = ${JSON.stringify(binary)}`);
		if (args) replace.set(args.line, `${lines[args.line].match(/^\s*/)?.[0] ?? ""}args = ["mcp"]`);
		plan.repointed.push({ name: table.name, from: commandLine(command.value, argList) });
		if (!hasTychicus && !plan.added && table.name !== MCP_NAME) {
			// The new table copies this one and its subtables (env and so on), with the new command.
			const family = tables.filter((t) => t.name === table.name);
			insertAt = Math.max(...family.map((t) => t.end));
			for (const t of family) {
				const block = lines.slice(t.header, t.end).map((line, k) => {
					const at = t.header + k;
					if (at === t.header) return `[mcp_servers.${MCP_NAME}${t.sub}]`;
					return replace.get(at) ?? line;
				});
				if (!args && t.sub === "") block.splice(command.line - t.header + 1, 0, `${indent}args = ["mcp"]`);
				while (block.length > 1 && block[block.length - 1].trim() === "") block.pop();
				copy.push(...block, "");
			}
			plan.added = true;
		}
		if (!args) replace.set(command.line, `${replace.get(command.line)}\n${indent}args = ["mcp"]`);
	}
	if (plan.repointed.length === 0) return;
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i === insertAt) out.push(...copy);
		out.push(replace.get(i) ?? lines[i]);
	}
	if (insertAt === lines.length) {
		// The last table: a blank line, then the copy, which ends the file with a newline.
		if (out[out.length - 1] !== "") out.push("");
		out.push(...copy);
	}
	plan.status = "change";
	plan.after = out.join("\n");
}

/** What a run would change in each harness config, without writing anything. */
export function planMigration(binary: string): FilePlan[] {
	return migrationFiles().map(({ harness, file }) => {
		const plan: FilePlan = { harness, name: NAMES[harness], file, status: "missing", repointed: [], added: false, notes: [] };
		if (!existsSync(file)) return plan;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (err) {
			plan.status = "refused";
			plan.reason = `it couldn't be read (${err instanceof Error ? err.message : String(err)}).`;
			return plan;
		}
		plan.status = "unchanged";
		plan.before = text;
		if (harness === "codex") planToml(plan, text, binary);
		else if (harness === "opencode") planJson(plan, text, "mcp", "array", binary);
		else planJson(plan, text, "mcpServers", "args", binary);
		return plan;
	});
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

/**
 * Write each changed file: a backup beside it first (same permissions), then the new text through a temporary file
 * and a rename, into the real file when the path is a link. Returns the backups made. Refused and unchanged files
 * are not touched.
 */
export function applyMigration(plans: FilePlan[], now = new Date()): { file: string; backup: string }[] {
	const done: { file: string; backup: string }[] = [];
	const stamp = backupStamp(now);
	for (const plan of plans) {
		if (plan.status !== "change" || plan.after === undefined) continue;
		const real = realpathSync(plan.file);
		const mode = statSync(real).mode & 0o777;
		const backup = `${plan.file}.tychicus-backup-${stamp}`;
		copyFileSync(real, backup);
		chmodSync(backup, mode);
		const temp = join(dirname(real), `.${basename(real)}.tychicus-${process.pid}`);
		writeFileSync(temp, plan.after, { mode });
		chmodSync(temp, mode);
		renameSync(temp, real);
		done.push({ file: plan.file, backup });
	}
	const aliases = plans.flatMap((p) => (p.status === "change" ? p.repointed.filter((r) => r.name !== MCP_NAME).map((r) => ({ harness: p.harness, file: p.file, name: r.name })) : []));
	if (aliases.length > 0) {
		const known = readAliases();
		for (const a of aliases) {
			if (!known.some((k) => k.harness === a.harness && k.file === a.file && k.name === a.name)) known.push({ ...a, since: now.toISOString() });
		}
		const record = {
			note: `Temporary: these entries keep their old names but run Tychicus, so rules that name the polycarp MCP server still work. Remove each once nothing names it; the ${MCP_NAME} entry beside it stays.`,
			aliases: known,
		};
		writeFileSync(aliasFile(), `${JSON.stringify(record, null, 2)}\n`);
	}
	return done;
}
