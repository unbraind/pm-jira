export declare const EXIT_CODE: {
    readonly GENERIC_FAILURE: 1;
    readonly USAGE: 2;
    readonly NOT_FOUND: 3;
};
export declare class CommandError extends Error {
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
interface JiraIssue {
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