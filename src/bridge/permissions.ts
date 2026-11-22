/**
 * Host permissions for bridge sessions.
 *
 * Mode "by_model" (default, docs/decisions.md D60): an agent on a frontier model opens any site, as in
 * "allow_all"; an agent on a small or unknown model asks, as in "ask". The CLI says which in its hello
 * (cli/src/model-tier.ts), and a client that says nothing is unknown.
 * Mode "ask": a harness may only navigate to hosts the user allowed.
 * Unknown hosts raise a permission request that the harness shows (MCP
 * elicitation) or that the user answers in Settings > Agents. Mode "allow_all"
 * skips the check for people who trust their harness.
 */
import type { ModelTier } from "./protocol.js";

const ENABLED_KEY = "bridge_enabled";
const MODE_KEY = "bridge_permission_mode";
const HOSTS_KEY = "bridge_allowed_hosts";
const PENDING_KEY = "bridge_pending_requests";

export type PermissionMode = "by_model" | "ask" | "allow_all";
export type PermissionDecision = "allow_once" | "allow_host" | "deny";

export interface PendingRequest {
	requestId: string;
	clientId: string;
	clientName: string;
	host: string;
	url: string;
	createdAt: number;
	/**
	 * Set when the question is about putting local files into a page, not opening a site
	 * (docs/decisions.md, D38). The answer covers this one upload and is never remembered.
	 */
	upload?: { files: Array<{ name: string; bytes: number }> };
}

export async function isBridgeEnabled(): Promise<boolean> {
	const data = await chrome.storage.local.get(ENABLED_KEY);
	return data[ENABLED_KEY] !== false;
}

export async function setBridgeEnabled(enabled: boolean): Promise<void> {
	await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}

/** The stored mode; nothing stored (or anything unrecognized) is "by_model". */
export async function getPermissionMode(): Promise<PermissionMode> {
	const data = await chrome.storage.local.get(MODE_KEY);
	const stored = data[MODE_KEY];
	return stored === "allow_all" || stored === "ask" ? stored : "by_model";
}

/** What a mode means for one client: "by_model" lets a frontier model open any site and makes the rest ask. */
export function effectiveMode(mode: PermissionMode, tier: ModelTier | undefined): "ask" | "allow_all" {
	if (mode !== "by_model") return mode;
	return tier === "frontier" ? "allow_all" : "ask";
}

/** A hello's tier as the extension trusts it: anything but a known value, or none (older CLIs), is unknown. */
export function asModelTier(value: unknown): ModelTier {
	return value === "frontier" || value === "small" ? value : "unknown";
}

export async function setPermissionMode(mode: PermissionMode): Promise<void> {
	await chrome.storage.local.set({ [MODE_KEY]: mode });
}

export async function getAllowedHosts(): Promise<string[]> {
	const data = await chrome.storage.local.get(HOSTS_KEY);
	return (data[HOSTS_KEY] as string[] | undefined) ?? [];
}

export async function allowHost(host: string): Promise<void> {
	const hosts = await getAllowedHosts();
	const normalized = host.toLowerCase();
	if (!hosts.includes(normalized)) await chrome.storage.local.set({ [HOSTS_KEY]: [...hosts, normalized] });
}

export async function revokeHost(host: string): Promise<void> {
	const hosts = await getAllowedHosts();
	await chrome.storage.local.set({ [HOSTS_KEY]: hosts.filter((h) => h !== host.toLowerCase()) });
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * What a person typed for Allowed sites, as the hostname permissions compare (a port or path can't
 * narrow an entry; hostAllowed looks only at the hostname), or the reason it can't be one.
 */
export function normalizeHostInput(input: string): { host: string } | { error: string } {
	const text = input.trim();
	const refused = { error: `"${text}" isn't a site address. Enter one like example.com.` };
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return refused;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return refused;
	const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
	return /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/.test(host) ? { host } : refused;
}

/** "docs.example.com" is covered by an entry for "example.com". */
export function hostAllowed(host: string, allowed: string[]): boolean {
	return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

/**
 * True when the URL is on a host an agent may never open: the public URL of this machine's OAuth
 * approval page and the loopback addresses serve and the hub answer on (issue #94). The native
 * host sends them with each request. An entry is a hostname, which guards every port, or
 * "host:port" ("[::1]:port" for IPv6), which guards that port only: a local dev server on another
 * port stays open. This holds in every permission mode, "allow_all" included, and covers only
 * agent-driven navigation: a person who opens the page in their own tab is not stopped.
 */
export function isGuardedUrl(url: string, guardedHosts: readonly string[] | undefined): boolean {
	if (!guardedHosts?.length) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const host = parsed.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host === "") return false;
	const port = parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "");
	return guardedHosts.some((entry) => {
		const e = entry.toLowerCase().replace(/\.$/, "");
		const withPort = /^(?:\[([^\]]+)\]|([^:\]]+)):(\d+)$/.exec(e);
		if (withPort) return (withPort[1] ?? withPort[2]) === host && withPort[3] === port;
		return e.replace(/^\[|\]$/g, "") === host;
	});
}

/**
 * Polycarp's own pages (the side panel, Settings, the Connect relay's callers) are never a place a
 * bridge client may take a tab: a page there runs with the extension's rights. Refused in every
 * mode, and never put to the user as a permission prompt.
 */
export function isOwnExtensionUrl(url: string): boolean {
	try {
		let u = new URL(url);
		// blob: and filesystem: URLs carry the origin that made them after the scheme; that document has the extension's rights.
		if (u.protocol === "blob:" || u.protocol === "filesystem:") u = new URL(u.pathname);
		return u.protocol === "chrome-extension:" && u.hostname.toLowerCase() === String(chrome.runtime.id).toLowerCase();
	} catch {
		return false;
	}
}

/** `tier` is the calling client's (its hello); without one the client counts as unknown. */
export async function isUrlAllowed(url: string, tier?: ModelTier): Promise<boolean> {
	if (isOwnExtensionUrl(url)) return false;
	if (effectiveMode(await getPermissionMode(), tier) === "allow_all") return true;
	const host = hostOf(url);
	if (!host) return url === "about:blank";
	return hostAllowed(host, await getAllowedHosts());
}

// ---- pending requests (visible to the sidepanel settings tab) -----------------

export async function getPendingRequests(): Promise<PendingRequest[]> {
	const data = await chrome.storage.session.get(PENDING_KEY);
	return (data[PENDING_KEY] as PendingRequest[] | undefined) ?? [];
}

export async function addPendingRequest(request: PendingRequest): Promise<void> {
	const pending = await getPendingRequests();
	await chrome.storage.session.set({ [PENDING_KEY]: [...pending, request] });
}

export async function removePendingRequest(requestId: string): Promise<void> {
	const pending = await getPendingRequests();
	await chrome.storage.session.set({ [PENDING_KEY]: pending.filter((p) => p.requestId !== requestId) });
}

/**
 * The sidepanel answers a request by writing the decision here; the service
 * worker picks it up through storage.onChanged.
 */
export const DECISION_KEY_PREFIX = "bridge_decision_";

export async function recordDecision(requestId: string, decision: PermissionDecision): Promise<void> {
	await chrome.storage.session.set({ [`${DECISION_KEY_PREFIX}${requestId}`]: decision });
	await removePendingRequest(requestId);
}
