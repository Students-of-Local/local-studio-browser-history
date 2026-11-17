import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { TYCHICUS_ICON, TYCHICUS_ICON_16, TYCHICUS_MARK } from "./tychicus-svg.js";

/**
 * The Tychicus logo. `tile` is the moss app icon (below 24 px, the 16 px drawing without the pointer, which would blur);
 * `mark` is the bare letter in currentColor.
 */
export function tychicusMark(size: number, variant: "tile" | "mark" = "tile", className = ""): TemplateResult {
	return html`<span
		class="inline-block shrink-0 [&>svg]:block [&>svg]:w-full [&>svg]:h-full ${className}"
		style="width:${size}px;height:${size}px"
		aria-hidden="true"
		>${unsafeSVG(variant === "mark" ? TYCHICUS_MARK : size < 24 ? TYCHICUS_ICON_16 : TYCHICUS_ICON)}</span
	>`;
}
