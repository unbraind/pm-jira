/** Strict, offline Jira create-contract compilation. No tracker or network mutations. */
import { createHash } from "node:crypto";

/** Supported Jira create value shapes; unsupported schemas must be adapted explicitly. */
export type JiraCreateValue = string | number | boolean | { id: string } | string[] | { id: string }[];
/** Normalized projection of one field from complete Jira create metadata. */
export interface JiraCreateField {
  id: string;
  name: string;
  required: boolean;
  type: "string" | "number" | "boolean" | "option" | "strings" | "options";
  allowedValues?: (string | number | boolean | { id: string })[];
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
  counts: { bound: number; missing: number; invalid: number };
  diagnostics: JiraCreateDiagnostic[];
  page: { offset: number; total: number; nextOffset: number | null };
  budget: number;
  posts: 0;
  exit_code?: 2;
  code?: "answers_required";
  remediation?: string;
}
/** Public SDK result, also used verbatim by the host command renderer. */
export type JiraCreatePreviewResult = JiraCreatePreview | JiraCreateRefusal;

/** Create a bounded refusal without reflecting untrusted input. */
export function createPreviewRefusal(code: JiraCreateRefusal["code"]): JiraCreateRefusal {
  const remedies = {
    invalid_input: "Supply the strict v1 create contract: unique fields, supported types, bounded dense arrays, finite numbers, explicit answers; budget 4096..65536 and offset 0..1000000. See docs/create-preview.md.",
    scope_mismatch: "Select the exact project and issueType recorded in the metadata; recapture metadata for another selection.",
    budget_too_small: "Increase budget up to 65536 bytes to fit the next diagnostic row; keep the same revision, answers and offset.",
    input_read: "Supply a readable regular JSON contract file of at most 1 MiB; see docs/create-preview.md.",
  };
  return { kind: "refused", code, remediation: remedies[code], posts: 0, exit_code: 2 };
}

/** Recognize plain objects, excluding class instances and prototype-bearing documents. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** Bound identifiers and scalar strings, rejecting control characters except body whitespace. */
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
/** Require exact object keys at the one public input boundary. */
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
/** Validate dense, bounded JSON arrays without Array.every's sparse-array shortcut. */
function dense(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length <= max && Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}
/** Validate a scalar using the declared Jira contract type. Numbers use the documented safe domain. */
function scalar(value: unknown, type: string): boolean {
  if (type === "string") return text(value, 512);
  if (type === "number") return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
  if (type === "boolean") return typeof value === "boolean";
  return record(value) && keys(value, ["id"]) && text(value.id, 64);
}
/** Validate one declared field value, including nonempty multi-value answers. */
function validValue(value: unknown, type: string): boolean {
  if (type === "strings" || type === "options") return dense(value, 16) && value.length > 0 && value.every(entry => scalar(entry, type === "strings" ? "string" : "option"));
  return scalar(value, type);
}
/** Bound arbitrary answer values before classifying schema/value mismatches as diagnostics. */
function answer(value: unknown): boolean {
  return scalar(value, "string") || scalar(value, "number") || scalar(value, "boolean") || scalar(value, "option") ||
    (dense(value, 16) && value.every(entry => scalar(entry, "string") || scalar(entry, "option")));
}
/** Single strict schema for SDK and CLI; no coercion or normalization of answers. */
function validate(value: unknown): value is JiraCreatePreviewInput {
  if (!record(value) || !keys(value, ["metadata", "project", "issueType", "answers"], ["budget", "offset"]) ||
      !text(value.project, 64) || !text(value.issueType, 64) || !record(value.answers) || Object.keys(value.answers).length > 256 ||
      !Object.entries(value.answers).every(([key, v]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && answer(v))) return false;
  const { budget = 8192, offset = 0, metadata: meta } = value;
  if (!Number.isSafeInteger(budget) || (budget as number) < 4096 || (budget as number) > 65536 || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 1000000) return false;
  if (!record(meta) || !keys(meta, ["version", "revision", "project", "issueType", "fields"]) || meta.version !== 1 ||
      !text(meta.revision, 64) || !text(meta.project, 64) || !text(meta.issueType, 64) || !dense(meta.fields, 256)) return false;
  const ids = new Set<string>();
  for (const field of meta.fields) {
    if (!record(field) || !keys(field, ["id", "name", "required", "type"], ["allowedValues"]) ||
        typeof field.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field.id) || ["project", "issuetype"].includes(field.id) || ids.has(field.id) ||
        !text(field.name, 128) || typeof field.required !== "boolean" || typeof field.type !== "string" ||
        !["string", "number", "boolean", "option", "strings", "options"].includes(field.type)) return false;
    ids.add(field.id);
    if (field.allowedValues !== undefined && (!dense(field.allowedValues, 128) || !field.allowedValues.every(entry => scalar(entry, field.type === "strings" ? "string" : field.type === "options" ? "option" : field.type as string)))) return false;
  }
  return true;
}
/** Compare exact scalar contract choices independent of object key order. */
function same(left: unknown, right: unknown): boolean {
  return record(left) && record(right) ? left.id === right.id : left === right;
}
/** Match all supplied elements against advertised choices without inventing defaults. */
function allowed(value: JiraCreateValue, field: JiraCreateField): boolean {
  return field.allowedValues === undefined || (Array.isArray(value) ? value : [value]).every(entry => field.allowedValues!.some(choice => same(entry, choice)));
}

/**
 * Compile bindings/checklist from a complete, revisioned normalized metadata fixture.
 * The byte budget covers pretty JSON UTF-8 plus newline; TOON also uses the host budget.
 * A ready preview is evidence about supplied metadata, never execution authorization.
 */
export function previewJiraCreate(input: unknown): JiraCreatePreviewResult {
  if (!validate(input)) return createPreviewRefusal("invalid_input");
  const { metadata, answers, project, issueType, budget = 8192, offset = 0 } = input;
  if (metadata.project !== project || metadata.issueType !== issueType) return createPreviewRefusal("scope_mismatch");
  const rows: JiraCreateDiagnostic[] = [];
  const counts = { bound: 0, missing: 0, invalid: 0 };
  for (const field of metadata.fields) {
    if (!Object.hasOwn(answers, field.id)) {
      if (field.required) { rows.push({ field: field.id, state: "missing", required: true }); counts.missing++; }
    } else {
      const value = answers[field.id]!;
      const state = validValue(value, field.type) && allowed(value, field) ? "bound" : "invalid";
      counts[state]++;
      // Values are paged separately so even the largest legal array fits a minimal budget.
      if (state === "bound" && Array.isArray(value)) for (const entry of value) rows.push({ field: field.id, state, required: field.required, value: entry });
      else rows.push({ field: field.id, state, required: field.required, ...(state === "bound" ? { value } : {}) });
    }
    for (const value of field.allowedValues ?? []) rows.push({ field: field.id, state: "allowed", required: field.required, value });
  }
  const known = new Set(metadata.fields.map(field => field.id));
  for (const id of Object.keys(answers)) if (!known.has(id)) { counts.invalid++; rows.push({ field: id, state: "invalid", required: false }); }
  const ready = counts.missing === 0 && counts.invalid === 0;
  const result: JiraCreatePreview = { kind: ready ? "ready" : "incomplete", revision: metadata.revision,
    digest: createHash("sha256").update(JSON.stringify(metadata)).digest("hex"), project, issueType, counts, diagnostics: [],
    page: { offset, total: rows.length, nextOffset: null }, budget, posts: 0, ...(ready ? {} : { exit_code: 2 as const, code: "answers_required" as const, remediation: "Supply missing fields and replace invalid answers with advertised choices, then preview again. Follow page.nextOffset for remaining diagnostics." }) };
  for (let index = offset; index < rows.length; index++) {
    result.diagnostics.push(rows[index]!);
    result.page.nextOffset = index + 1 < rows.length ? index + 1 : null;
    if (Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 > budget) { result.diagnostics.pop();
      if (result.diagnostics.length === 0) return createPreviewRefusal("budget_too_small");
      result.page.nextOffset = index; break; }
  }
  return result;
}
