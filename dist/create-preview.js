/** Strict, offline Jira create-contract compilation. No tracker or network mutations. */
import { createHash } from "node:crypto";
/** Create a bounded refusal without reflecting untrusted input. */
export function createPreviewRefusal(code) {
    const remedies = {
        invalid_input: "Supply the strict v1 create contract: unique fields, supported types, bounded dense arrays, finite numbers, explicit answers; budget 4096..65536 and offset 0..1000000. See docs/create-preview.md.",
        scope_mismatch: "Create contract scope differs; select the exact project and issueType recorded in the metadata; recapture metadata for another selection.",
        budget_too_small: "Increase budget up to 65536 bytes to fit the next diagnostic row; keep the same revision, answers and offset.",
        input_read: "Supply a readable regular JSON contract file of at most 1 MiB; see docs/create-preview.md.",
    };
    return { kind: "refused", code, remediation: remedies[code], posts: 0, exit_code: 2 };
}
/** Recognize plain objects, excluding class instances and prototype-bearing documents. */
function record(value) {
    return value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** Bound payload text without imposing required-field completeness. */
function payloadText(value, max) {
    return typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
/** Require meaningful metadata identifiers and nonempty scalar choices. */
function text(value, max) {
    return payloadText(value, max) && value.trim().length > 0;
}
/** Empty payload inputs are interpreted using required metadata, never CLI option rules. */
function emptyValue(value) {
    return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0) || (Array.isArray(value) && value.length === 0);
}
/** Require exact object keys at the one public input boundary. */
function keys(value, required, optional = []) {
    return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
/** Validate dense, bounded JSON arrays without Array.every's sparse-array shortcut. */
function dense(value, max) {
    return Array.isArray(value) && value.length <= max && Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}
/** Validate a scalar using the declared Jira contract type. Numbers use the documented safe domain. */
function scalar(value, type) {
    if (type === "string")
        return text(value, 512);
    if (type === "number")
        return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
    if (type === "boolean")
        return typeof value === "boolean";
    const permitted = type === "user" ? ["accountId"] : ["id", "name", "value"];
    return record(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, entry]) => permitted.includes(key) && text(entry, key === "id" ? 64 : key === "accountId" ? 128 : 512));
}
/** Validate one declared field value, including nonempty multi-value answers. */
function validValue(value, type) {
    if (type === "strings" || type === "options" || type === "users")
        return dense(value, 16) && value.length > 0 && value.every(entry => scalar(entry, type === "strings" ? "string" : type === "users" ? "user" : "option"));
    return scalar(value, type);
}
/** Bound arbitrary answer values before classifying schema/value mismatches as diagnostics. */
function answer(value) {
    return value === undefined || value === null || payloadText(value, 512) || scalar(value, "number") || scalar(value, "boolean") || scalar(value, "option") || scalar(value, "user") ||
        (dense(value, 16) && value.every(entry => payloadText(entry, 512) || scalar(entry, "option") || scalar(entry, "user")));
}
/** Single strict schema for SDK and CLI; no coercion or normalization of answers. */
function validate(value) {
    if (!record(value) || !keys(value, ["metadata", "project", "issueType", "answers"], ["budget", "offset", "mappedFields", "generatedFields"]) ||
        !text(value.project, 64) || !text(value.issueType, 64) || !record(value.answers) || Object.keys(value.answers).length > 256 ||
        !Object.entries(value.answers).every(([key, v]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && answer(v)))
        return false;
    if (![value.mappedFields, value.generatedFields].every(fields => fields === undefined || fieldSource(fields)))
        return false;
    const { budget = 8192, offset = 0, metadata: meta } = value;
    if (!Number.isSafeInteger(budget) || budget < 4096 || budget > 65536 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
        return false;
    if (!record(meta) || !keys(meta, ["version", "revision", "project", "issueType", "fields"]) || meta.version !== 1 ||
        !text(meta.revision, 64) || !text(meta.project, 64) || !text(meta.issueType, 64) || !dense(meta.fields, 256))
        return false;
    const ids = new Set();
    for (const field of meta.fields) {
        if (!record(field) || !keys(field, ["id", "name", "required", "type"], ["allowedValues", "referenceBy"]) ||
            typeof field.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field.id) || ["project", "issuetype"].includes(field.id) || ids.has(field.id) ||
            !text(field.name, 128) || typeof field.required !== "boolean" || typeof field.type !== "string" ||
            !["string", "number", "boolean", "option", "user", "strings", "options", "users"].includes(field.type))
            return false;
        ids.add(field.id);
        if (field.referenceBy !== undefined && (!["option", "options"].includes(field.type) || !dense(field.referenceBy, 3) || field.referenceBy.length === 0 || new Set(field.referenceBy).size !== field.referenceBy.length || !field.referenceBy.every(key => ["id", "name", "value"].includes(String(key)))))
            return false;
        if (field.allowedValues !== undefined && (!dense(field.allowedValues, 128) || !field.allowedValues.every(entry => scalar(entry, field.type === "strings" ? "string" : field.type === "options" ? "option" : field.type === "users" ? "user" : field.type))))
            return false;
    }
    return true;
}
/** Bound complete native source fields, including the exporter's ADF description, once. */
function fieldSource(value) {
    if (!record(value) || Object.keys(value).length > 256)
        return false;
    let remaining = 8192;
    let textRemaining = 1048576;
    const json = (entry, depth) => {
        if (--remaining < 0 || depth > 8)
            return false;
        if (entry === undefined || entry === null || typeof entry === "boolean")
            return true;
        if (typeof entry === "string") {
            textRemaining -= entry.length;
            return textRemaining >= 0 && payloadText(entry, 65536);
        }
        if (typeof entry === "number")
            return Number.isFinite(entry) && Math.abs(entry) <= 1e12;
        if (Array.isArray(entry))
            return dense(entry, 256) && entry.every(child => json(child, depth + 1));
        return record(entry) && Object.keys(entry).length <= 256 && Object.entries(entry).every(([key, child]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && json(child, depth + 1));
    };
    return json(value, 0);
}
/** Match a supplied reference against all of its advertised attributes on one choice. */
function same(left, right) {
    return record(left) && record(right) ? Object.entries(left).every(([key, value]) => right[key] === value) : left === right;
}
/** Match every element and schema-specific reference key without guessing aliases. */
function allowed(value, field) {
    return (Array.isArray(value) ? value : [value]).every(entry => (!field.referenceBy || !record(entry) || Object.keys(entry).every(key => field.referenceBy.includes(key))) &&
        (field.allowedValues === undefined || field.allowedValues.some(choice => same(entry, choice))));
}
/**
 * Compile bindings/checklist from a complete, revisioned normalized metadata fixture.
 * The byte budget covers pretty JSON UTF-8 plus newline; TOON also uses the host budget.
 * A ready preview is evidence about supplied metadata, never execution authorization.
 */
export function compileJiraCreate(input, sources) {
    const bindings = {};
    const omitted = [];
    let body = "";
    const finish = (preview) => ({ preview,
        bindings: preview.kind === "ready" ? bindings : {}, omitted: preview.kind === "ready" ? omitted : [], body: preview.kind === "ready" ? body : "" });
    if (!validate(input) || (sources !== undefined && (!record(sources) || !keys(sources, ["mappedFields", "generatedFields"]) || !fieldSource(sources.mappedFields) || !fieldSource(sources.generatedFields))))
        return finish(createPreviewRefusal("invalid_input"));
    const { metadata, project, issueType, budget = 8192, offset = 0 } = input;
    // This is the sole payload merge: explicit answers > item mappings > generated defaults.
    const answers = { ...input.generatedFields, ...sources?.generatedFields, ...sources?.mappedFields, ...input.mappedFields, ...input.answers };
    const scope = { project: { key: project }, issuetype: { name: issueType }, ...answers };
    const fields = { project: scope.project, issuetype: scope.issuetype };
    if (!record(scope.project) || !keys(scope.project, ["key"]) || scope.project.key !== project || !record(scope.issuetype) || !keys(scope.issuetype, ["name"]) || scope.issuetype.name !== issueType)
        return finish(createPreviewRefusal("scope_mismatch"));
    if (metadata.project !== project || metadata.issueType !== issueType)
        return finish(createPreviewRefusal("scope_mismatch"));
    const rows = [];
    const counts = { bound: 0, missing: 0, invalid: 0 };
    for (const field of metadata.fields) {
        if (!Object.hasOwn(answers, field.id)) {
            if (field.required) {
                rows.push({ field: field.id, state: "missing", required: true });
                counts.missing++;
            }
        }
        else {
            const value = answers[field.id];
            if (emptyValue(value)) {
                if (field.required) {
                    rows.push({ field: field.id, state: "missing", required: true });
                    counts.missing++;
                }
                else {
                    delete fields[field.id];
                    omitted.push(field.id);
                    rows.push({ field: field.id, state: "omitted", required: false });
                }
            }
            else {
                const state = validValue(value, field.type) && allowed(value, field) ? "bound" : "invalid";
                counts[state]++;
                if (state === "bound") {
                    bindings[field.id] = value;
                    fields[field.id] = value;
                }
                // Values are paged separately so even the largest legal array fits a minimal budget.
                if (state === "bound" && Array.isArray(value))
                    for (const entry of value)
                        rows.push({ field: field.id, state, required: field.required, value: entry });
                else
                    rows.push({ field: field.id, state, required: field.required, ...(state === "bound" ? { value } : {}) });
            }
        }
        for (const value of field.allowedValues ?? [])
            rows.push({ field: field.id, state: "allowed", required: field.required, value });
    }
    const known = new Set(metadata.fields.map(field => field.id));
    for (const id of Object.keys(input.answers))
        if (!known.has(id)) {
            counts.invalid++;
            rows.push({ field: id, state: "invalid", required: false });
        }
    // Native mappings absent from the captured create screen are omitted, never sent unvalidated.
    for (const id of Object.keys(answers))
        if (!known.has(id) && id !== "project" && id !== "issuetype" && !Object.hasOwn(input.answers, id)) {
            omitted.push(id);
            rows.push({ field: id, state: "omitted", required: false });
        }
    const ready = counts.missing === 0 && counts.invalid === 0;
    body = JSON.stringify({ fields });
    const result = { kind: ready ? "ready" : "incomplete", revision: metadata.revision,
        digest: createHash("sha256").update(JSON.stringify(metadata)).digest("hex"), project, issueType, ...(ready ? { bodyDigest: createHash("sha256").update(body).digest("hex") } : {}), counts, diagnostics: [],
        page: { offset, total: rows.length, nextOffset: null }, budget, posts: 0, ...(ready ? {} : { exit_code: 2, code: "answers_required", remediation: "Create answers are missing or invalid; supply missing fields and replace invalid answers with advertised choices, then preview again. Follow page.nextOffset for remaining diagnostics." }) };
    for (let index = offset; index < rows.length; index++) {
        result.diagnostics.push(rows[index]);
        result.page.nextOffset = index + 1 < rows.length ? index + 1 : null;
        if (Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 > budget) {
            result.diagnostics.pop();
            if (result.diagnostics.length === 0)
                return finish(createPreviewRefusal("budget_too_small"));
            result.page.nextOffset = index;
            break;
        }
    }
    return finish(result);
}
/** Return only the bounded agent-facing preview; export consumes the same compiled semantics. */
export function previewJiraCreate(input) {
    return compileJiraCreate(input).preview;
}
//# sourceMappingURL=create-preview.js.map