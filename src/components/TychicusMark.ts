import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { uniqueSvgIds } from "./svg-ids.js";
import { TYCHICUS_ICON, TYCHICUS_ICON_16, TYCHICUS_MARK } from "./tychicus-svg.js";

/**
 * The Tychicus logo. `tile` is the app icon in Local Studio's blue (below 24 px, the flat 16 px drawing, since the
 * gradient would wash out); `mark` is the bare pointer mark in currentColor. Each copy gets its own gradient id.
 */
export function tychicusMark(size: number, variant: "tile" | "mark" = "tile", className = ""): TemplateResult {
	return html`<span
		class="inline-block shrink-0 [&>svg]:block [&>svg]:w-full [&>svg]:h-full ${className}"
		style="width:${size}px;height:${size}px"
		aria-hidden="true"
		>${unsafeSVG(variant === "mark" ? TYCHICUS_MARK : size < 24 ? TYCHICUS_ICON_16 : uniqueSvgIds(TYCHICUS_ICON))}</span
	>`;
}
