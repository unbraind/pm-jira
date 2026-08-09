import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import type { BulkItemCreateMutation, CommitItemMutationsOptions, CommitItemMutationsResult } from "@unbrained/pm-cli/sdk";
/**
 * Semantic exit codes pm's command runtime propagates to the shell.
 *
 * Mirrored here rather than imported because a standalone-installed extension
 * loads only its own `dist/`, so `@unbrained/pm-cli` is not resolvable at
 * runtime. {@link CommandError} carries one of these so a handled failure exits
 * cleanly once instead of re-invoking the handler.
 */
export declare const EXIT_CODE: {
    readonly GENERIC_FAILURE: 1;
    readonly USAGE: 2;
    readonly NOT_FOUND: 3;
};
/**
 * Error that carries a semantic process exit code.
 *
 * pm's command runtime treats a thrown error as a cleanly handled non-zero exit
 * only when it exposes a numeric `exitCode`; a plain `Error` instead falls
 * through to the "unhandled" path, which re-invokes the handler (doubling side
 * effects such as a second Jira fetch) and exits with a generic code. Throwing
 * this routes a failure to a clean, single exit at the chosen code.
 */
export declare class CommandError extends Error {
    /** Numeric exit code the runtime propagates to the shell (one of {@link EXIT_CODE}). */
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
/**
 * One Jira issue as returned by the REST search endpoint.
 *
 * Only the fields pm-jira reads are typed; the nested `fields` bag mirrors the
 * field projection requested by {@link buildSearchRequest} so an import pulls
 * exactly what it consumes.
 */
export interface JiraIssue {
    /** Issue key (`PROJECT-123`), used as the import id and provenance marker. */
    key: string;
    fields: {
        summary: string;
        description?: {
            type: string;
            content?: Array<{
                type: string;
                content?: Array<{
                    type: string;
                    text?: string;
                }>;
            }>;
        } | null;
        status: {
            name: string;
            statusCategory: {
                key: string;
            };
        };
        priority?: {
            name: string;
        } | null;
        labels?: string[];
        components?: Array<{
            name: string;
        }>;
        assignee?: {
            displayName: string;
            emailAddress: string;
        } | null;
        duedate?: string | null;
        fixVersions?: Array<{
            name: string;
        }>;
        issuetype?: {
            name: string;
        } | null;
        customfield_10020?: Array<{
            name?: string;
        }> | {
            name?: string;
        } | null;
        attachment?: Array<unknown> | null;
        comment?: {
            total?: number;
            comments?: Array<unknown>;
        } | null;
    };
}
type PmPriority = 1 | 2 | 3 | 4;
type PmStatus = "open" | "in_progress" | "closed" | "blocked";
/**
 * Map a Jira priority name onto pm's 1–4 priority scale.
 *
 * Unknown or missing priorities collapse to `3` (Medium) so an import never
 * blocks on an unmapped workflow value.
 *
 * @param jiraPriority - The Jira priority name (e.g. "Highest", "Low").
 * @returns The pm priority (1 highest – 4 lowest).
 */
export declare function mapJiraPriority(jiraPriority: string | undefined): PmPriority;
/**
 * Map a Jira status name onto a pm status.
 *
 * A caller-supplied `--status-map` override wins over the built-in keyword
 * heuristic; unrecognized names default to `open` so an import never invents a
 * state.
 *
 * @param jiraStatus - The Jira status name as returned by the API.
 * @param statusMap - Optional override keyed by lowercased Jira status name.
 * @returns The resolved pm status.
 */
export declare function mapJiraStatus(jiraStatus: string, statusMap?: Record<string, PmStatus>): PmStatus;
/**
 * Map a Jira `statusCategory` key onto a pm status.
 *
 * The category is the workflow-agnostic bucket Jira assigns to every status
 * ("new" | "indeterminate" | "done"), so this is a robust fallback that works
 * across custom workflows where the status *name* is unrecognized.
 *
 * @param categoryKey - The statusCategory key from the issue.
 * @returns The resolved pm status.
 */
export declare function mapJiraStatusCategory(categoryKey: string | undefined): PmStatus;
/**
 * Map a Jira issue type onto a pm item type.
 *
 * Defaults follow pm's common type vocabulary; a `--map issuetype=<pmType>`
 * override can replace the result for a custom workflow.
 *
 * @param jiraType - The Jira issue-type name.
 * @returns The pm item type.
 */
export declare function mapJiraIssueType(jiraType: string | undefined): string;
/**
 * Reverse-map a pm priority to its Jira priority name (for export).
 *
 * @param priority - The pm priority (1–4) or numeric value.
 * @returns The Jira priority name.
 */
export declare function mapPmPriorityToJira(priority: PmPriority | number | undefined): string;
/**
 * Normalize a user-supplied pm status string to its canonical value.
 *
 * Accepts canonical statuses and common aliases (todo, wip, done, on-hold, …),
 * collapsing spacing/hyphens. Returns `undefined` for an unrecognized value so
 * callers can treat it as raw Jira input rather than guessing.
 *
 * @param value - The raw status string from a CLI flag.
 * @returns The canonical pm status, or `undefined` when unrecognized.
 */
export declare function normalizePmStatusInput(value: string | undefined): PmStatus | undefined;
/**
 * How a `--status` value should be applied, as decided by
 * {@link resolveStatusFilter}.
 */
export interface StatusFilterResolution {
    /** `none` (no filter), `pm` (post-filter client-side), or `jira` (JQL server-side). */
    mode: "none" | "pm" | "jira";
    /** The trimmed raw input, when a value was given. */
    raw?: string;
    /** The resolved pm status, present only in `pm` mode. */
    pmStatus?: PmStatus;
}
export declare function resolveStatusFilter(value: string | undefined): StatusFilterResolution;
export type FieldMap = Record<string, string>;
/**
 * Parse a `--map` value into a jiraField→pmField lookup.
 *
 * Accepts comma-separated `jiraField=pmField` pairs. Throws {@link CommandError}
 * (USAGE) on a malformed pair or an unknown jira-side source field. Returns
 * `undefined` when no usable mapping was supplied so callers keep defaults.
 *
 * @param raw - The raw `--map` string.
 * @returns The parsed map, or `undefined`.
 */
export declare function parseFieldMap(raw: string | undefined): FieldMap | undefined;
/**
 * Parse a `--status-map` value into a lowercased Jira-status→pm-status table.
 *
 * Accepts comma-separated `JiraStatus=pm_status` pairs; targets accept canonical
 * pm statuses plus common aliases (done → closed, wip → in_progress). Throws
 * {@link CommandError} (USAGE) on a malformed entry or unrecognized target.
 *
 * @param raw - The raw `--status-map` string.
 * @returns The parsed lookup, or `undefined`.
 */
export declare function parseStatusMap(raw: string | undefined): Record<string, PmStatus> | undefined;
/**
 * The convenience filters {@link buildJql} composes into a JQL query.
 *
 * Every member is optional; an empty set yields the historical default query.
 */
export interface JqlFilters {
    /** Authoritative raw JQL; when set, it is returned verbatim by {@link buildJql}. */
    jql?: string;
    /** Jira project key. */
    project?: string;
    /** A pm status (canonical or alias) OR a raw Jira status name. */
    status?: string;
    /** Assignee account id, display name, or the `currentUser()` function. */
    assignee?: string;
    /** Issue type name. */
    issueType?: string;
    /** Label value. */
    label?: string;
    /** Relative ("-7d") or absolute ("2026-01-01") Jira date expression. */
    updatedSince?: string;
}
/**
 * Quote a JQL value for safe interpolation into a clause.
 *
 * Bare identifiers, numbers, and dotted keys stay unquoted; anything with
 * whitespace or punctuation is wrapped in double quotes (escaping embedded
 * quotes) so user input cannot break out of the clause.
 *
 * @param value - The raw JQL value.
 * @returns The quoted-or-bare value, safe for clause interpolation.
 */
export declare function jqlQuote(value: string): string;
/**
 * Compose convenience filters into a single JQL query string.
 *
 * Explicit `--jql` is authoritative and returned verbatim; otherwise the
 * project/status/assignee/issue-type/label/updated-since filters are
 * AND-combined. With no constraints the historical default ("not done, by
 * priority") is returned so back-compat holds.
 *
 * @param filters - The convenience filters to compose.
 * @returns The composed JQL query.
 */
export declare function buildJql(filters: JqlFilters): string;
/**
 * Read the convenience JQL filters off a loose options bag.
 *
 * Tolerates both kebab- and camel-case keys (the pm CLI normalizes flags to
 * camelCase).
 *
 * @param options - The raw option object from the command handler.
 * @returns The resolved JQL filters.
 */
export declare function readJqlFilters(options: Record<string, unknown>): JqlFilters;
/**
 * Flatten a Jira Atlassian Document Format (ADF) description to plain text.
 *
 * Recursively walks the `content`/`text` nodes; returns an empty string for a
 * null/missing description.
 *
 * @param node - An ADF node, a leaf text node, or null/undefined.
 * @returns The concatenated plain text.
 */
export declare function adfToPlainText(node: JiraIssue["fields"]["description"] | {
    type: string;
    content?: unknown[];
    text?: string;
} | null | undefined): string;
/**
 * Render a plain-text body as a minimal ADF document.
 *
 * Wraps the text in a single paragraph so it can be POSTed to the Jira create
 * API. An empty body becomes a single space (Jira rejects an empty paragraph).
 *
 * @param text - The plain text to wrap.
 * @returns A minimal ADF doc.
 */
export declare function plainTextToAdf(text: string): {
    type: "doc";
    version: 1;
    content: Array<{
        type: "paragraph";
        content: Array<{
            type: "text";
            text: string;
        }>;
    }>;
};
/**
 * Build the provenance marker line stored in a pm item's description.
 *
 * Embeds the Jira key and browse URL so {@link extractJiraKey} can recover them
 * (pm `create` exposes no generic custom-field setter for an extension).
 *
 * @param key - The Jira issue key (`PROJECT-123`).
 * @param browseUrl - The human-facing issue URL.
 * @returns The marker line.
 */
export declare function jiraProvenance(key: string, browseUrl: string): string;
/**
 * Recover the Jira key and URL from a description's provenance marker.
 *
 * @param text - The text to scan (typically the item description).
 * @returns The key and URL, or `undefined` when no marker is present.
 */
export declare function extractJiraKey(text: string | undefined): {
    key: string;
    url: string;
} | undefined;
/**
 * Read a trimmed, non-empty string option under its kebab- or camel-case key.
 *
 * Returns `undefined` for a missing or blank value. The pm CLI normalizes loose
 * flags to camelCase, so both spellings are checked (see the section note).
 *
 * @param options - The raw option object.
 * @param kebab - The kebab-case key (its camelCase form is also checked).
 * @returns The trimmed value, or `undefined`.
 */
export declare function readStringOption(options: Record<string, unknown>, kebab: string): string | undefined;
/**
 * Read a string option under one or more alias keys (kebab or camel).
 *
 * Returns the first non-empty value. Surfaces user-friendly flag aliases (e.g.
 * `--field-map` for `--map`, `--project-key` for `--project`) without
 * duplicating read logic at every call site.
 *
 * @param options - The raw option object.
 * @param kebabs - The kebab-case keys to try, in priority order.
 * @returns The first non-empty value, or `undefined`.
 */
export declare function readStringOptionAliased(options: Record<string, unknown>, ...kebabs: string[]): string | undefined;
/**
 * Read a numeric option under its kebab- or camel-case key.
 *
 * Coerces numeric strings; returns `undefined` for a missing or non-finite
 * value.
 *
 * @param options - The raw option object.
 * @param kebab - The kebab-case key (its camelCase form is also checked).
 * @returns The parsed number, or `undefined`.
 */
export declare function readNumberOption(options: Record<string, unknown>, kebab: string): number | undefined;
/**
 * Read a boolean option under its kebab- or camel-case key.
 *
 * A bare flag (empty string) reads as true, as do the strings "true"/"1"/"yes";
 * anything else falls back to JavaScript truthiness.
 *
 * @param options - The raw option object.
 * @param kebab - The kebab-case key (its camelCase form is also checked).
 * @returns The resolved boolean.
 */
export declare function readBooleanOption(options: Record<string, unknown>, kebab: string): boolean;
/**
 * Read the first non-empty string value under any of the given keys.
 *
 * @param options - The raw option object.
 * @param keys - The kebab-case keys to try, in priority order.
 * @returns The first non-empty value, or `undefined`.
 */
export declare function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined;
/**
 * Read the first finite numeric value under any of the given keys.
 *
 * @param options - The raw option object.
 * @param defaultValue - Returned when none of the keys yield a number.
 * @param keys - The kebab-case keys to try, in priority order.
 * @returns The first parsed number, or the default.
 */
export declare function optionInt(options: Record<string, unknown>, defaultValue: number, ...keys: string[]): number;
/**
 * Whether any of the given boolean keys reads as enabled.
 *
 * @param options - The raw option object.
 * @param keys - The kebab-case keys to check.
 * @returns True when at least one key is truthy.
 */
export declare function optionEnabled(options: Record<string, unknown>, ...keys: string[]): boolean;
/**
 * Resolved Jira credentials and the ready-to-send Authorization header.
 *
 * Produced by {@link resolveCreds} from the host option and environment.
 */
export interface JiraCreds {
    /** API base URL (no trailing slash), e.g. `https://your-domain.atlassian.net`. */
    baseUrl: string;
    /** The Atlassian account email used for basic auth. */
    email: string;
    /** The Jira API token used for basic auth. */
    token: string;
    /** Pre-built `Basic <b64>` header value, ready to send. */
    authHeader: string;
}
export declare function resolveCreds(options: Record<string, unknown>, envLike?: NodeJS.ProcessEnv): JiraCreds;
export interface CredDiagnostics {
    ready: boolean;
    baseUrlPresent: boolean;
    emailPresent: boolean;
    tokenPresent: boolean;
    baseUrlSource: "option" | "env" | "none";
    hostPreview?: string;
    missing: string[];
}
export declare function diagnoseCreds(options: Record<string, unknown>, envLike?: NodeJS.ProcessEnv): CredDiagnostics;
export declare function isMutatingJiraInvocation(command: string, options: Record<string, unknown>): boolean;
export declare function jiraPreflightShouldFailFast(command: string, options: Record<string, unknown>, envLike?: NodeJS.ProcessEnv): boolean;
export declare function jiraPreflightErrorMessage(command: string, diag: CredDiagnostics): string;
export declare function classifyHttpError(statusCode: number | undefined, body: unknown): string;
export declare function formatImportProgress(fetched: number, jiraTotal: number, maxResults: number): string;
export interface IssueToItem {
    title: string;
    status: PmStatus;
    priority: PmPriority;
    type: string;
    body: string;
    tags: string[];
    deadline?: string;
    description: string;
    jiraKey: string;
    jiraUrl: string;
}
export interface IssueMapOptions {
    statusMap?: Record<string, PmStatus>;
    fieldMap?: FieldMap;
}
export declare function issueToItem(issue: JiraIssue, baseUrl: string, optionsOrStatusMap?: IssueMapOptions | Record<string, PmStatus>): IssueToItem;
/**
 * The bound `commitItemMutations` signature the atomic path calls. Resolved
 * once per process via a dynamic `import("@unbrained/pm-cli/sdk")`; injectable
 * through {@link ImportRunOptions.commitItemMutations} for tests.
 */
type CommitItemMutations = (options: CommitItemMutationsOptions) => Promise<CommitItemMutationsResult>;
/**
 * Dynamically resolve the SDK `commitItemMutations` helper, throwing a clear,
 * actionable {@link CommandError} when the installed @unbrained/pm-cli is too
 * old to export it (requires >=2026.7.20). Mirrors pm-csv's
 * `resolveCommitWorkspaceTransaction` UX. The resolved function is cached at
 * module scope so repeated --atomic calls don't re-import the SDK.
 *
 * `importSdk` is an injection seam for tests: when supplied, the module-level
 * cache is bypassed and the SAME import-failure / not-a-function guards run
 * against the injected module, so both error branches are unit-testable
 * without an actual old SDK on disk. Production always uses the default
 * (cached) dynamic import.
 */
export declare function resolveCommitItemMutations(importSdk?: () => Promise<Partial<typeof import("@unbrained/pm-cli/sdk")>>): Promise<CommitItemMutations>;
/**
 * Derive a stable, resumable transaction id from the exact content being
 * imported: the ordered list of Jira issue keys plus the JQL/project that
 * scoped them. `jira-import-<sha1(jql \x1f sortedKeys)>` (12 hex chars).
 *
 * Folding the content (not just the project) into the id means: re-running
 * the SAME import after a crash keeps the same id (resumes from the durable
 * journal, no duplicates), while a DIFFERENT set of issues yields a fresh id
 * (a new import, never a stale skip). Mirrors pm-csv's
 * `deriveTransactionId`/`fingerprintContent` derivation.
 */
export declare function deriveAtomicTransactionId(jql: string, issueKeys: readonly string[]): string;
/**
 * Build one {@link BulkItemCreateMutation} for an imported issue.
 *
 * Each create gets a STABLE, transaction-owned id derived deterministically
 * from `(transactionId, jiraKey)` so a retried transaction resumes instead of
 * duplicating: `normalizeItemId("jira-tx-<sha1(transactionId)[:8]>-<sanitizedKey>", prefix)`.
 * The id is keyed on the Jira issue KEY (globally unique + stable per issue),
 * NOT the positional index — otherwise a crash + retry that re-fetches the
 * same issues in a DIFFERENT order (Jira gives no stable order without
 * ORDER BY) would map the same issue to a different index => a different id =>
 * a duplicate create instead of a resume. Jira guarantees unique keys, so the
 * sanitized key is structurally unique within a batch; the content-derived
 * transactionId prefix scopes ids to this import. `normalizeItemId` lowercases
 * the input and prepends the normalized prefix when absent, so the token
 * (already lowercase) round-trips deterministically. The `options` bag mirrors
 * the exact `pm create` flags the non-atomic path uses
 * (title/type/status/priority/description/body/deadline/tags).
 */
export declare function buildAtomicCreateMutation(item: IssueToItem, jiraKey: string, transactionId: string, idPrefix: string, normalizeItemId: (input: string, prefix: string) => string): BulkItemCreateMutation;
/**
 * Commit every imported create in one atomic, crash-recoverable transaction
 * via the official `commitItemMutations` SDK helper. On failure every applied
 * create is compensated (deleted) so no committed items remain, and a clear
 * {@link CommandError} is thrown. Returns the count of items committed by
 * this attempt (already-applied steps from a prior interrupted run are
 * resumed, not double-counted). Throws CommandError (USAGE) when the SDK
 * cannot be resolved.
 */
export declare function importJiraAtomic(pmRoot: string, jql: string, filtered: readonly {
    issue: JiraIssue;
    item: IssueToItem;
}[], opts: ImportRunOptions): Promise<{
    created: number;
    recovered: boolean;
    transactionId: string;
}>;
/**
 * The exact Jira search GET request an import issues.
 *
 * Pure data; built by {@link buildSearchRequest} and used by both the live
 * fetch and the `--dry-run` preview.
 */
export interface JiraSearchRequest {
    /** Always `GET`. */
    method: "GET";
    /** Fully-built search URL with encoded JQL and field projection. */
    url: string;
    /** The comma-separated `fields` projection requested. */
    fields: string;
}
/**
 * Counts of attachments and comments on a fetched issue.
 *
 * pm-jira imports neither; the importer surfaces these counts to STDERR as a
 * transparency note so dropped data is never silently expected.
 */
export interface IssueExtras {
    /** Number of attachments on the issue. */
    attachments: number;
    /** Number of comments on the issue. */
    comments: number;
    /** True when either count is non-zero. */
    hasExtras: boolean;
}
export declare function countIssueExtras(issue: JiraIssue): IssueExtras;
export declare function buildSearchRequest(baseUrl: string, jql: string, startAt: number, maxResults: number): JiraSearchRequest;
/**
 * Internal options for {@link runImport}. Extends the public dry-run/status
 * knobs with opt-in atomic-import controls and test seams. The atomic seams
 * (commitItemMutations / readSettings / normalizeItemId / issues) are NOT CLI
 * flags: they let tests inject a fake commit coordinator or a pre-fetched
 * issue set so the atomic path is exercised without the Jira network.
 */
export interface ImportRunOptions {
    dryRun?: boolean;
    statusFilter?: string;
    /** Import all creates atomically via commitItemMutations (pm-cli >=2026.7.20). */
    atomic?: boolean;
    /** Author attributed to the atomic transaction journal (defaults to `pm-jira`). */
    atomicAuthor?: string;
    /** Test seam: inject the commit coordinator (skips SDK resolution). */
    commitItemMutations?: CommitItemMutations;
    /** Test seam: inject readSettings (skips SDK resolution). */
    readSettings?: (pmRoot: string) => Promise<{
        id_prefix?: string;
    }>;
    /** Test seam: inject normalizeItemId (skips SDK resolution). */
    normalizeItemId?: (input: string, prefix: string) => string;
    /**
     * Test seam: a pre-fetched issue set. When set, the live Jira fetch (and
     * credential resolution) is skipped entirely so the atomic path can be
     * exercised offline against a real tracker.
     */
    issues?: JiraIssue[];
}
export declare function runImport(options: Record<string, unknown>, pmRoot: string, opts?: ImportRunOptions): Promise<{
    success: boolean;
    dryRun: boolean;
    jql: string;
    request: JiraSearchRequest;
    maxResults: number;
    project: string;
    atomic: boolean;
    statusFilter?: string | undefined;
    statusFilterMode?: "jira" | "none" | "pm" | undefined;
    pmStatusFilter?: PmStatus | undefined;
} | {
    success: boolean;
    synced: number;
    imported: number;
    total: number;
    project: string;
    atomic?: boolean | undefined;
    transactionId?: string | undefined;
    summary: string;
}>;
interface PmItem {
    id?: string;
    title?: string;
    status?: string;
    body?: string;
    description?: string;
    tags?: string[];
    priority?: number;
    type?: string;
}
export declare function mapPmTypeToJira(pmType: string | undefined, override?: string): string;
export interface JiraCreatePayload {
    fields: {
        project?: {
            key: string;
        };
        summary: string;
        description: ReturnType<typeof plainTextToAdf>;
        issuetype: {
            name: string;
        };
        labels: string[];
        priority?: {
            name: string;
        };
    };
}
export interface PayloadOptions {
    projectKey?: string;
    fieldMap?: FieldMap;
    richMapping?: boolean;
}
export declare function itemToJiraPayload(item: PmItem, projectKeyOrOptions?: string | PayloadOptions): JiraCreatePayload;
export interface ExportPlanEntry {
    op: "create" | "update";
    itemId?: string;
    existingKey?: string;
    method: "POST" | "PUT";
    endpoint: string;
    payload: JiraCreatePayload;
}
export interface ExportPlan {
    baseUrl: string;
    project?: string;
    entries: ExportPlanEntry[];
}
export declare function buildExportPlan(items: PmItem[], baseUrl: string, opts?: {
    projectKey?: string;
    fieldMap?: FieldMap;
    richMapping?: boolean;
}): ExportPlan;
export interface ExportPushDeps {
    post: (url: string, authHeader: string, payload: string) => Promise<string>;
    put: (url: string, authHeader: string, payload: string) => Promise<string>;
    /** Where per-item failures are logged. Injectable so tests don't have to
     * monkey-patch the global `console.error`. Defaults to `console.error`. */
    logError?: (message: string) => void;
}
export interface ExportPushFailure {
    /** pm item id when known, else the create endpoint / existing Jira key. */
    ref: string;
    op: "create" | "update";
    message: string;
}
export interface ExportPushResult {
    created: number;
    updated: number;
    /** Items already carrying a Jira key, not PUT because --update-existing was off. */
    skipped: number;
    /** Items whose create/update API call FAILED and were isolated. */
    failed: number;
    failures: ExportPushFailure[];
}
export declare function runExportPush(plan: ExportPlan, opts: {
    authHeader: string;
    updateExisting: boolean;
}, deps?: ExportPushDeps): Promise<ExportPushResult>;
export interface PushOnWriteDecision {
    shouldPush: boolean;
    reason: string;
}
export declare function decidePushOnWrite(hookCtx: {
    path?: string;
    scope?: string;
    op?: string;
} | undefined, envLike?: NodeJS.ProcessEnv): PushOnWriteDecision;
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map