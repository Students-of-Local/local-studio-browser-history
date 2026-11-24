/**
 * The permission mode as the CLI reads and names it (docs/decisions.md, D67): Manual, Auto (the default) or Yolo. The
 * extension keeps the one store; the CLI only reads it in `status` and writes it through the bridge.
 */
export type PermissionMode = "manual" | "auto" | "yolo";
export const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "auto", "yolo"];

/** A mode by name, or the 1.4.0 name an older extension reports ("ask", "by_model", "allow_all"). */
export function asPermissionMode(value: unknown): PermissionMode | undefined {
	if (value === "manual" || value === "auto" || value === "yolo") return value;
	if (value === "ask") return "manual";
	if (value === "allow_all") return "yolo";
	if (value === "by_model") return "auto";
	return undefined;
}

/** The mode's name as a person reads it. */
export const MODE_TITLE: Record<PermissionMode, string> = { manual: "Manual", auto: "Auto", yolo: "Yolo" };

/** One line on what the mode lets agents do, for `status`, `mode` and `doctor`. */
export function modeSummary(mode: PermissionMode): string {
	if (mode === "manual") return "agents ask before a site you haven't allowed and before risky actions";
	if (mode === "yolo") return "agents open any site and act as you without asking";
	return "frontier models open ordinary sites; sensitive sites and risky actions ask";
}

/** Said before `tychicus mode yolo` asks for a yes; the same words as the Settings warning. */
export const YOLO_WARNING =
	"Yolo turns off these asks: agents open any site and send, post, buy, delete and change settings as you without asking. Uploads from this computer still ask, and password and payment fields, Tychicus's own pages and remote sessions stay limited.";

/** The mode a command line names: the three modes, and the older commands' names for them. */
export function modeFromCommand(command: string, arg: string | undefined): PermissionMode | undefined {
	if (command === "ask") return "manual";
	if (command === "allow-all" || command === "yolo") return "yolo";
	return arg === "manual" || arg === "auto" || arg === "yolo" ? arg : undefined;
}
