import type { BulkItemCreateMutation, CommitItemMutationsOptions, CommitItemMutationsResult } from "@unbrained/pm-cli/sdk";
export declare const EXIT_CODE: {
    readonly GENERIC_FAILURE: 1;
    readonly USAGE: 2;
    readonly NOT_FOUND: 3;
};
export declare class CommandError extends Error {
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
export interface JiraIssue {
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
export declare function mapJiraPriority(jiraPriority: string | undefined): PmPriority;
export declare function mapJiraStatus(jiraStatus: string, statusMap?: Record<string, PmStatus>): PmStatus;
export declare function mapJiraStatusCategory(categoryKey: string | undefined): PmStatus;
export declare function mapJiraIssueType(jiraType: string | undefined): string;
export declare function mapPmPriorityToJira(priority: PmPriority | number | undefined): string;
export declare function normalizePmStatusInput(value: string | undefined): PmStatus | undefined;
export interface StatusFilterResolution {
    mode: "none" | "pm" | "jira";
    raw?: string;
    pmStatus?: PmStatus;
}
export declare function resolveStatusFilter(value: string | undefined): StatusFilterResolution;
export type FieldMap = Record<string, string>;
export declare function parseFieldMap(raw: string | undefined): FieldMap | undefined;
export declare function parseStatusMap(raw: string | undefined): Record<string, PmStatus> | undefined;
export interface JqlFilters {
    jql?: string;
    project?: string;
    status?: string;
    assignee?: string;
    issueType?: string;
    label?: string;
    updatedSince?: string;
}
export declare function jqlQuote(value: string): string;
export declare function buildJql(filters: JqlFilters): string;
export declare function readJqlFilters(options: Record<string, unknown>): JqlFilters;
export declare function adfToPlainText(node: JiraIssue["fields"]["description"] | {
    type: string;
    content?: unknown[];
    text?: string;
} | null | undefined): string;
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
export declare function jiraProvenance(key: string, browseUrl: string): string;
export declare function extractJiraKey(text: string | undefined): {
    key: string;
    url: string;
} | undefined;
export declare function readStringOption(options: Record<string, unknown>, kebab: string): string | undefined;
export declare function readStringOptionAliased(options: Record<string, unknown>, ...kebabs: string[]): string | undefined;
export declare function readNumberOption(options: Record<string, unknown>, kebab: string): number | undefined;
export declare function readBooleanOption(options: Record<string, unknown>, kebab: string): boolean;
export declare function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined;
export declare function optionInt(options: Record<string, unknown>, defaultValue: number, ...keys: string[]): number;
export declare function optionEnabled(options: Record<string, unknown>, ...keys: string[]): boolean;
export interface JiraCreds {
    baseUrl: string;
    email: string;
    token: string;
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
export interface JiraSearchRequest {
    method: "GET";
    url: string;
    fields: string;
}
export interface IssueExtras {
    attachments: number;
    comments: number;
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
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map