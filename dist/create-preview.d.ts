/** Supported Jira create value shapes; unsupported schemas must be adapted explicitly. */
export type JiraCreateValue = string | number | boolean | {
    id: string;
} | string[] | {
    id: string;
}[];
/** Normalized projection of one field from complete Jira create metadata. */
export interface JiraCreateField {
    id: string;
    name: string;
    required: boolean;
    type: "string" | "number" | "boolean" | "option" | "strings" | "options";
    allowedValues?: (string | number | boolean | {
        id: string;
    })[];
}
/** Versioned caller-supplied metadata, scoped to exactly one project/type. */
export interface JiraCreateMetadata {
    version: 1;
    revision: string;
    project: string;
    issueType: string;
    fields: JiraCreateField[];
}
/** Explicit answers never infer a Jira project or issue type from local defaults. */
export interface JiraCreatePreviewInput {
    metadata: JiraCreateMetadata;
    project: string;
    issueType: string;
    answers: Record<string, JiraCreateValue>;
    budget?: number;
    offset?: number;
}
/** Redacted, actionable refusal with the host semantic exit code. */
export interface JiraCreateRefusal {
    kind: "refused";
    code: "invalid_input" | "scope_mismatch" | "input_read" | "budget_too_small";
    remediation: string;
    exit_code: 2;
    posts: 0;
}
/** One bounded binding, missing-answer diagnostic, invalid answer, or allowed choice. */
export interface JiraCreateDiagnostic {
    field: string;
    state: "bound" | "missing" | "invalid" | "allowed";
    required: boolean;
    value?: JiraCreateValue;
}
/** Bounded diagnostic envelope; readiness always covers all fields, including omitted rows. */
export interface JiraCreatePreview {
    kind: "ready" | "incomplete";
    revision: string;
    digest: string;
    project: string;
    issueType: string;
    counts: {
        bound: number;
        missing: number;
        invalid: number;
    };
    diagnostics: JiraCreateDiagnostic[];
    page: {
        offset: number;
        total: number;
        nextOffset: number | null;
    };
    budget: number;
    posts: 0;
    exit_code?: 2;
    code?: "answers_required";
    remediation?: string;
}
/** Public SDK result, also used verbatim by the host command renderer. */
export type JiraCreatePreviewResult = JiraCreatePreview | JiraCreateRefusal;
/** Create a bounded refusal without reflecting untrusted input. */
export declare function createPreviewRefusal(code: JiraCreateRefusal["code"]): JiraCreateRefusal;
/**
 * Compile bindings/checklist from a complete, revisioned normalized metadata fixture.
 * The byte budget covers pretty JSON UTF-8 plus newline; TOON also uses the host budget.
 * A ready preview is evidence about supplied metadata, never execution authorization.
 */
export declare function previewJiraCreate(input: unknown): JiraCreatePreviewResult;
//# sourceMappingURL=create-preview.d.ts.map