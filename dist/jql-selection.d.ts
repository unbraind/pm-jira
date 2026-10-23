/** Offline Jira query membership explanations over caller-supplied evidence. */
/** One complete enhanced-search response projected to keys; tokens stay opaque. */
export interface JqlSelectionPage {
    requestToken?: string;
    nextPageToken?: string;
    isLast: boolean;
    keys: string[];
}
/** Independent evidence collected under this snapshot's site, principal and time. */
export interface JqlVisibilityEvidence {
    key: string;
    state: "visible" | "query_excluded" | "permission_lost" | "not_found" | "unknown";
}
/** Explicit selection boundary; completeness is checked rather than asserted by a flag. */
export interface JqlSelectionSnapshot {
    version: 1;
    site: string;
    principal: string;
    scope: string;
    capturedAt: string;
    jql: string;
    pages: JqlSelectionPage[];
    visibility: JqlVisibilityEvidence[];
}
/** Independent output page controls; every omitted change remains recoverable. */
export interface JqlSelectionOptions {
    limit?: number;
    offset?: number;
}
/** Stable machine-readable refusal reasons shared by SDK and CLI. */
export type JqlSelectionRefusalCode = "invalid_snapshot" | "snapshot_limit" | "incomplete_chain" | "boundary_mismatch" | "time_order" | "conflicting_evidence" | "invalid_options" | "input_read" | "input_json";
/** Safe refusal envelope consumed by the pm host's semantic exit contract. */
export interface JqlSelectionRefusal {
    kind: "refused";
    changes: [];
    code: JqlSelectionRefusalCode;
    remediation: string;
    writes: 0;
    deletionProposals: 0;
    exit_code: 2;
}
/** A membership change, never a tracker mutation or proof of Jira deletion. */
export interface JqlSelectionChange {
    key: string;
    change: "entry" | "exit";
    reason: "selected" | "query_excluded" | "permission_lost" | "unresolved";
    localAction: "preserve";
}
/** Compact counts cover all changes even when the returned page is bounded. */
export interface JqlSelectionExplanation {
    kind: "explained";
    basis: "supplied_snapshots";
    queryChanged: boolean;
    counts: {
        before: number;
        after: number;
        retained: number;
        entries: number;
        exits: number;
        queryExcluded: number;
        permissionLost: number;
        unresolved: number;
    };
    changes: JqlSelectionChange[];
    page: {
        offset: number;
        limit: number;
        total: number;
        omitted: number;
        nextOffset: number | null;
    };
    writes: 0;
    deletionProposals: 0;
}
/** Either a bounded explanation or a refusal with a concrete recovery action. */
export type JqlSelectionResult = JqlSelectionExplanation | JqlSelectionRefusal;
/** Build a redacted refusal without echoing snapshot contents or file paths. */
export declare function jqlSelectionRefusal(code: JqlSelectionRefusalCode, remediation: string): JqlSelectionRefusal;
/** Resolve bounded output pagination for SDK and command inputs before reading files. */
export declare function resolveJqlSelectionOptions(options: JqlSelectionOptions): {
    limit: number;
    offset: number;
} | JqlSelectionRefusal;
/**
 * Compare membership without I/O or JQL evaluation. Missing keys alone cannot
 * distinguish lost visibility, deletion, query exclusion or eventual consistency.
 * Visibility evidence is a caller assertion, not server-verified authorization.
 * All local work is preserved, including on incomplete or ambiguous input.
 */
export declare function explainJqlSelectionChanges(before: unknown, after: unknown, options?: JqlSelectionOptions): JqlSelectionResult;
//# sourceMappingURL=jql-selection.d.ts.map