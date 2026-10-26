/** Value-bearing option inventory; regression tests reconcile it with actual registrations. */
export declare const JIRA_OPTION_TABLE: Readonly<Record<string, readonly string[]>>;
/**
 * Validate the whole supplied bag before defaults, alias selection, I/O or credentials.
 * Only undefined denotes an omitted option. Every string is trimmed once and must
 * remain nonempty; known options also enforce their scalar type. The returned
 * shallow snapshot is immutable, so later caller edits cannot bypass validation.
 * Reusing that snapshot does not repeat validation; raw bags are always rechecked.
 */
export declare function parseJiraOptions(input: unknown): Record<string, unknown>;
//# sourceMappingURL=option-boundary.d.ts.map