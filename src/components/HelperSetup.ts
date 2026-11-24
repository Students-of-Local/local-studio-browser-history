import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { watchHostConnected } from "../bridge/host-state.js";
import { type InstallCommand, installCommandFor } from "../install-command.js";
import { COMMAND_BOX_CLASS } from "./command-box.js";
import { Toast } from "./Toast.js";

async function copyCommand(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		Toast.success("Copied. Paste it into a terminal and press Enter.");
	} catch {
		Toast.error("Couldn't copy. Click the side panel first, then try again.");
	}
}

/**
 * The helper's state on the welcome screen. A copy from the Chrome Web Store starts with no helper: then this shows the
 * one command that installs it for this OS (src/install-command.ts) with a Copy button, and switches to connected the
 * moment the helper answers (host-state.ts), with no reload. Uses the Connect tab's command box and online dot, in the
 * success token.
 */
@customElement("helper-setup")
export class HelperSetup extends LitElement {
	/** Undefined until the first read, so nothing flashes before the state is known. */
	@state() private connected?: boolean;
	@state() private command?: InstallCommand | null;
	private stop?: () => void;

	protected createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.stop = watchHostConnected((connected) => {
			this.connected = connected;
		});
		chrome.runtime
			.getPlatformInfo()
			.then((info) => {
				this.command = installCommandFor(info.os) ?? null;
			})
			.catch(() => {
				this.command = null;
			});
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.stop?.();
	}

	private install(command: InstallCommand): TemplateResult {
		const label = `Install command for ${command.shell}`;
		return html`
			<p class="text-xs text-muted-foreground">
				Coding agents reach this browser through Local Studio's helper on this computer. To install it, paste this into
				${command.shell === "PowerShell" ? "PowerShell" : "a terminal"}:
			</p>
			<div class="flex flex-col gap-1">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-muted-foreground">${command.shell}</span>
					<button
						type="button"
						class="rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
						aria-label=${`Copy ${label}`}
						@click=${() => void copyCommand(command.command)}
					>
						Copy
					</button>
				</div>
				<code class=${COMMAND_BOX_CLASS} data-install-command>${command.command}</code>
			</div>
			<p class="text-xs text-muted-foreground">This shows connected once it has run. No reload needed.</p>
		`;
	}

	override render(): TemplateResult | typeof nothing {
		if (this.connected === undefined || this.command === undefined) return nothing;
		const connected = this.connected;
		return html`
			<div class="flex flex-col gap-1.5" data-helper-setup=${connected ? "connected" : "missing"}>
				<div class="flex items-center gap-2" role="status">
					<span class="h-2 w-2 shrink-0 rounded-full ${connected ? "bg-[var(--tk-success)]" : "bg-muted-foreground/40"}" aria-hidden="true"></span>
					<span class="text-xs font-medium text-foreground">${connected ? "Helper connected" : "Helper not connected"}</span>
				</div>
				${
					connected
						? html`<p class="text-xs text-muted-foreground">Coding agents on this computer can use this browser now.</p>`
						: this.command
							? this.install(this.command)
							: html`<p class="text-xs text-muted-foreground">
									Local Studio's helper runs on macOS, Windows and Linux, not on this system. Chat here works without it.
								</p>`
				}
			</div>
		`;
	}
}
