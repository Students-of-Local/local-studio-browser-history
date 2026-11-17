import { html, type TemplateResult } from "lit";

/** How someone with no helper gets one, for screens that give a helper command (a store install starts with none). */
export function helperInstallHint(): TemplateResult {
	return html`Don't have Tychicus's helper? Copy the setup prompt in Settings > Agents into your coding agent, or
		<a class="underline" href="https://github.com/baney75/tychicus/releases/latest" target="_blank" rel="noopener noreferrer">install the latest release</a>.`;
}
