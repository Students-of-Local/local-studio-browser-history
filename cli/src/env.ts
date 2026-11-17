/**
 * Environment variables the helper reads. Each has a `TYCHICUS_` name, which wins, and the `POLYCARP_` and `TABKYRA_`
 * names inherited from Polycarp's helper, still read so service files and test fixtures written with them keep working.
 * Read through here, never `process.env.TABKYRA_*` directly.
 */

/**
 * The variable `name` (without prefix) from `source`: TYCHICUS_<name> if set and non-empty, else the inherited
 * POLYCARP_<name>, else TABKYRA_<name>.
 */
export function envVar(name: string, source: Record<string, string | undefined> = process.env): string | undefined {
	return source[`TYCHICUS_${name}`] || source[`POLYCARP_${name}`] || source[`TABKYRA_${name}`] || undefined;
}

/** True when either name is set to something non-empty. */
export function envSet(name: string, source: Record<string, string | undefined> = process.env): boolean {
	return envVar(name, source) !== undefined;
}
