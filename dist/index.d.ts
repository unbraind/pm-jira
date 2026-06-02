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
        assignee?: {
            displayName: string;
            emailAddress: string;
        } | null;
        duedate?: string | null;
        fixVersions?: Array<{
            name: string;
        }>;
    };
}
type PmPriority = 1 | 2 | 3 | 4;
type PmStatus = "open" | "in_progress" | "closed" | "blocked";
export declare function mapJiraPriority(jiraPriority: string | undefined): PmPriority;
export declare function mapJiraStatus(jiraStatus: string, statusMap?: Record<string, PmStatus>): PmStatus;
export declare function parseStatusMap(raw: string | undefined): Record<string, PmStatus> | undefined;
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
export interface IssueToItem {
    title: string;
    status: PmStatus;
    priority: PmPriority;
    body: string;
    tags: string[];
    deadline?: string;
    description: string;
}
export declare function issueToItem(issue: JiraIssue, baseUrl: string, statusMap?: Record<string, PmStatus>): IssueToItem;
interface PmItem {
    id?: string;
    title?: string;
    status?: string;
    body?: string;
    description?: string;
    tags?: string[];
}
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
    };
}
export declare function itemToJiraPayload(item: PmItem, projectKey?: string): JiraCreatePayload;
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map