import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";
import { agentSetupPromptButton } from "../components/AgentSetupPrompt.js";
import { polycarpMark } from "../components/PolycarpMark.js";

/**
 * Where the dialog sends the person: the provider keys, Connect (use Polycarp from claude.ai or ChatGPT), or straight to
 * the chat (Local Studio runs, so no key is needed).
 */
export type WelcomeChoice = "provider" | "connect" | "chat" | "dismissed";

/** "local-studio" when Local Studio's daemon runs: chat works with no key, and keys sit behind a link. */
export type WelcomeMode = "keys" | "local-studio";

/**
 * Shown on first launch when no API keys are configured.
 * Blocks until the person picks one of two ways in: add a provider key, or use Polycarp from claude.ai or ChatGPT. Pairs with a third, copying a prompt for their own agent.
 */
export class WelcomeSetupDialog extends DialogBase {
	private resolvePromise?: (choice: WelcomeChoice) => void;
	private choice: WelcomeChoice = "dismissed";

	protected modalWidth = "min(450px, 90vw)";
	protected modalHeight = "auto";

	private mode: WelcomeMode = "keys";

	static async show(mode: WelcomeMode = "keys"): Promise<WelcomeChoice> {
		return new Promise<WelcomeChoice>((resolve) => {
			const dialog = new WelcomeSetupDialog();
			dialog.mode = mode;
			dialog.resolvePromise = resolve;
			dialog.open();
		});
	}

	private pick(choice: WelcomeChoice): void {
		this.choice = choice;
		this.close();
	}

	private renderKeys() {
		return html`
			<div class="flex flex-col gap-1.5">
				${Button({
					variant: "default",
					className: "w-full",
					onClick: () => this.pick("provider"),
					children: "Chat here",
				})}
				<p class="text-xs text-muted-foreground">Add a key from any AI provider, or a free one.</p>
			</div>
		`;
	}

	/** Local Studio runs: chat now on its models and sign-ins. No key field; keys stay one link away. */
	private renderLocalStudio() {
		return html`
			<div class="flex flex-col gap-1.5">
				${Button({
					variant: "default",
					className: "w-full",
					onClick: () => this.pick("chat"),
					children: "Chat here",
				})}
				<p class="text-xs text-muted-foreground">
					Runs on Local Studio, with its local models and the plans you signed in to there. No key needed.
				</p>
				<button
					type="button"
					class="self-start text-xs text-muted-foreground underline underline-offset-2 cursor-pointer"
					@click=${() => this.pick("provider")}
				>
					Use an API key instead
				</button>
			</div>
		`;
	}

	override close() {
		super.close();
		this.resolvePromise?.(this.choice);
	}

	protected renderContent() {
		return html`
			${DialogContent({
				className: "flex flex-col gap-4",
				children: html`
					<div class="flex items-center gap-3">
						${polycarpMark(40, "tile", "rounded-[9px]")}
						${DialogHeader({ title: "Welcome to Polycarp" })}
					</div>
					<p class="text-sm text-foreground">How do you want to use it?</p>
					${this.mode === "local-studio" ? this.renderLocalStudio() : this.renderKeys()}
					<div class="flex flex-col gap-1.5">
						${agentSetupPromptButton("Claude Code, Codex and other agents can drive this browser. Paste this prompt into yours.")}
					</div>
					<button
						type="button"
						class="self-start text-xs text-muted-foreground underline underline-offset-2 cursor-pointer"
						@click=${() => this.pick("connect")}
					>
						Use from claude.ai or ChatGPT
					</button>
				`,
			})}
		`;
	}
}

if (!customElements.get("welcome-setup-dialog")) {
	customElements.define("welcome-setup-dialog", WelcomeSetupDialog);
}
