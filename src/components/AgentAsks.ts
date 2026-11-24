/**
 * The questions agents are waiting on, as one card each: a site to open, or files to upload. The side panel shows them
 * above the chat, and Settings > Agents lists them too, with the same buttons. One click answers: allow the site, allow
 * once, or deny (an upload has no "allow the site": every upload asks). The answer goes through recordDecision, which
 * the worker picks up.
 */

import { html, nothing, type TemplateResult } from "lit";
import {
	getPendingRequests,
	PENDING_KEY,
	type PendingRequest,
	type PermissionDecision,
	recordDecision,
} from "../bridge/permissions.js";

const fileSize = (n: number) =>
	n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;

/** The buttons a question offers, in order: the first is the one to reach for. */
export function askChoices(p: PendingRequest): Array<{ decision: PermissionDecision; label: string }> {
	if (p.upload)
		return [
			{ decision: "allow_once", label: "Upload this once" },
			{ decision: "deny", label: "Deny" },
		];
	return [
		{ decision: "allow_host", label: "Allow site" },
		{ decision: "allow_once", label: "Allow once" },
		{ decision: "deny", label: "Deny" },
	];
}

/** What the question asks, in one line. */
export function askLine(p: PendingRequest): string {
	if (p.upload)
		return `${p.clientName} wants to upload ${p.upload.files.length === 1 ? "a file from this computer" : `${p.upload.files.length} files from this computer`} to ${p.host}`;
	return `${p.clientName} wants to open ${p.host}`;
}

/** One question with its buttons. `decide` answers it. */
export function askCard(p: PendingRequest, decide: (decision: PermissionDecision) => unknown): TemplateResult {
	const [first, ...rest] = askChoices(p);
	const button = (c: { decision: PermissionDecision; label: string }, strong: boolean) =>
		html`<button
			type="button"
			class="rounded-md px-2 py-1 text-xs ${strong ? "bg-primary text-primary-foreground" : "border border-border text-foreground hover:bg-secondary"}"
			@click=${() => decide(c.decision)}
		>
			${c.label}
		</button>`;
	return html`<div
		class="p-3 rounded-lg border border-orange-500/40 bg-orange-500/10 space-y-2"
		data-testid="agent-ask"
		data-kind=${p.upload ? "upload" : "site"}
	>
		<div class="text-sm text-foreground">${askLine(p)}</div>
		${
			p.upload
				? html`<div class="text-xs text-muted-foreground break-all">${p.upload.files.map((f) => `${f.name} (${fileSize(f.bytes)})`).join(", ")}</div>
					<div class="text-xs text-muted-foreground">Only the name is shown here. The agent may be acting on what a page told it, so don't take its word for where the file is: say yes only if you asked for this file.</div>`
				: html`<div class="text-xs text-muted-foreground break-all">${p.url}</div>`
		}
		<div class="flex gap-2 flex-wrap">${button(first, true)}${rest.map((c) => button(c, false))}</div>
	</div>`;
}

let pending: PendingRequest[] = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;

/** Listens before it reads: a question asked meanwhile comes up, and the older list the read gives doesn't undo it. */
async function load(): Promise<void> {
	let changed = false;
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "session" || !(PENDING_KEY in changes)) return;
		changed = true;
		pending = (changes[PENDING_KEY].newValue as PendingRequest[] | undefined) ?? [];
		for (const l of listeners) l();
	});
	const stored = await getPendingRequests();
	if (!changed) pending = stored;
}

/** Load the questions and call `onChange` whenever they change. */
export async function watchAgentAsks(onChange: () => void): Promise<() => void> {
	listeners.add(onChange);
	loading ??= load();
	await loading;
	onChange();
	return () => listeners.delete(onChange);
}

/** The side panel's cards, above the chat; nothing when no agent is waiting. */
export function agentAsks(): TemplateResult | typeof nothing {
	if (pending.length === 0) return nothing;
	return html`<section class="mx-3 my-2 space-y-2 shrink-0" aria-label="Agents waiting for your answer" role="alert">
		${pending.map((p) => askCard(p, (d) => recordDecision(p.requestId, d)))}
	</section>`;
}
