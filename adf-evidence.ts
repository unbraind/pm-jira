/** Selective, revision-approved ADF evidence. All operations are offline and read-only. */
import { createHash } from "node:crypto";

/** Bounded JSON attributes accepted at the source boundary. */
export type AdfJson = null | boolean | number | string | AdfJson[] | { [key: string]: AdfJson };
/** ADF source node; unfamiliar node types are counted and excluded, including their descendants. */
export interface AdfSourceNode { type: string; version?: number; text?: string; attrs?: Record<string, AdfJson>; marks?: { type: string; attrs?: Record<string, AdfJson> }[]; content?: AdfSourceNode[] }
/** Caller-observed issue revision, scoped to one Jira origin and key. */
export interface AdfSource { site: string; issue: string; revision: string; document: AdfSourceNode }
/** Strict v1 request. Pointers are relative to the description root, never attachment paths. */
export interface AdfCaptureInput { version: 1; source: AdfSource; select: string[]; approval?: { revision: string; digest: string }; budget?: number }
/** One retained node at its original coordinate; context rows carry no unselected content. */
export interface AdfEvidenceNode { pointer: string; type: string; context: boolean; text?: string; attrs?: Record<string, AdfJson>; marks?: { type: string }[] }
/** Complete immutable selection; digest binds source identity, selection, rows and counts. */
export interface AdfEvidencePacket { version: 1; source: { site: string; issue: string; revision: string; digest: string }; select: string[]; nodes: AdfEvidenceNode[]; counts: { source: number; retained: number; context: number; unselected: number; unsupported: number; attachments: number; omittedMarks: number }; digest: string }
/** Stable refusals shared by direct SDK consumers and host command output. */
export interface AdfEvidenceRefusal { kind: "refused"; code: "invalid_input" | "selection_missing" | "source_changed" | "budget_exceeded" | "invalid_packet" | "input_read"; remediation: string; exit_code: 2 }
/** Preview and approved capture share the exact same compiler and output schema. */
export type AdfCaptureResult = { kind: "preview" | "captured"; packet: AdfEvidencePacket } | AdfEvidenceRefusal;
/** Reconstructed selective ADF plus addresses mapping dense replay coordinates to original source coordinates. */
export type AdfReplayResult = { kind: "replayed"; document: AdfSourceNode; coordinates: { pointer: string; sourcePointer: string }[] } | AdfEvidenceRefusal;

const supported = new Set(["doc", "paragraph", "text", "hardBreak", "heading", "codeBlock", "blockquote", "bulletList", "orderedList", "listItem", "table", "tableRow", "tableCell", "tableHeader", "rule"]);
const attachments = new Set(["media", "mediaInline", "mediaGroup", "mediaSingle", "inlineCard", "blockCard"]);
const marks = new Set(["strong", "em", "code", "strike", "underline"]);
const blocks = ["paragraph", "heading", "codeBlock", "blockquote", "bulletList", "orderedList", "table", "rule"];
const children = new Map<string, readonly string[]>([
  ["doc", blocks], ["blockquote", blocks], ["listItem", blocks], ["tableCell", blocks], ["tableHeader", blocks],
  ["paragraph", ["text", "hardBreak"]], ["heading", ["text", "hardBreak"]], ["codeBlock", ["text"]],
  ["bulletList", ["listItem"]], ["orderedList", ["listItem"]], ["table", ["tableRow"]], ["tableRow", ["tableCell", "tableHeader"]],
]);
const attrKeys = new Map<string, string[]>([["codeBlock", ["language"]], ["heading", ["level"]], ["orderedList", ["order"]], ["tableCell", ["colspan", "rowspan", "colwidth", "background"]], ["tableHeader", ["colspan", "rowspan", "colwidth", "background"]]]);

/** Redact invalid input while giving a concrete retry path. */
export function adfEvidenceRefusal(code: AdfEvidenceRefusal["code"]): AdfEvidenceRefusal {
  const remedies = {
    invalid_input: "Supply a strict v1 source snapshot and 1..64 unique, nonoverlapping block pointers; at most 8192 nodes, depth 32, 1 MiB JSON; budget 4096..65536. See docs/adf-evidence.md.",
    selection_missing: "Select an existing supported description block with supported ancestors; remove attachment, unsupported or text-node selections.",
    source_changed: "Read the current source again, review its preview, and explicitly approve that revision and source digest. Never replay an older approval.",
    budget_exceeded: "Select fewer or smaller blocks, or increase budget up to 65536 bytes. Evidence is never clipped; no partial capture was returned.",
    invalid_packet: "Use an intact v1 packet emitted by captureAdfEvidence. Do not edit its coordinates, selection, counts or digest; recapture the source instead.",
    input_read: "Supply a readable regular JSON contract file of at most 1 MiB. Use docs/examples/adf-capture.json as a starting point.",
  };
  return { kind: "refused", code, remediation: remedies[code], exit_code: 2 };
}
/** Recognize JSON records without accepting class instances. */
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
/** Enforce exact key inventories at all versioned boundaries. */
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean { return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)); }
/** Dense arrays only; sparse inputs must not disappear through Array.every. */
function dense(value: unknown, max: number): value is unknown[] { return Array.isArray(value) && value.length <= max && Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean); }
/** Text is lossless, including whitespace/CRLF, but excludes control characters. */
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value); }
/** Integer domains are exact and finite. */
function integer(value: unknown, min: number, max: number): value is number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
/** Canonical JSON hashes ignore object insertion order, never text whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Content hashes are scoped by source identity and revision before use as approval keys. */
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
/** Validate arbitrary source JSON once with shared depth, size and finite-number limits. */
function boundedJson(value: unknown): boolean {
  let remaining = 65536;
  const visit = (entry: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 72) return false;
    if (entry === null || typeof entry === "boolean") return true;
    if (typeof entry === "string") return text(entry, 1048576);
    if (typeof entry === "number") return Number.isFinite(entry) && Math.abs(entry) <= Number.MAX_SAFE_INTEGER;
    if (Array.isArray(entry)) return dense(entry, 8192) && entry.every(child => visit(child, depth + 1));
    return record(entry) && Object.keys(entry).length <= 64 && Object.entries(entry).every(([key, child]) => text(key, 128) && visit(child, depth + 1));
  };
  return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= 1048576;
}
/** Origin/key/revision are immutable identity, not inferred from ambient tracker focus. */
function identity(value: unknown, withDocument: boolean): boolean {
  if (!record(value) || !keys(value, ["site", "issue", "revision", withDocument ? "document" : "digest"]) || !text(value.site, 256) || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(value.site) || !text(value.issue, 64) || !/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(value.issue) || !text(value.revision, 128) || value.revision.trim().length === 0) return false;
  try { if (new URL(value.site).origin !== value.site) return false; } catch { return false; }
  return withDocument || hash(value.digest);
}
/** SHA-256 values have one canonical wire spelling. */
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
/** Strict original coordinates have no alternate numeric spellings. */
function pointer(value: unknown): value is string { return typeof value === "string" && value.length <= 512 && /^(\/content\/(0|[1-9][0-9]{0,3})){1,32}$/.test(value) && value.split("/content/").slice(1).every(index => Number(index) < 8192); }
/** Selection order is canonical source order, independent of caller order. */
function selections(value: unknown): value is string[] { return dense(value, 64) && value.length > 0 && value.every(pointer) && value.every((path, i) => value.every((other, j) => i === j || (path !== other && !String(other).startsWith(`${path}/`)))); }
/** Validate known attributes; unknown JSON attributes stay in the source hash but are never emitted. */
function validAttrs(type: string, attrs: unknown, retained: boolean): boolean {
  if (!record(attrs)) return false;
  const allowed = attrKeys.get(type) ?? [];
  return Object.entries(attrs).every(([key, value]) => {
    if (!allowed.includes(key)) return !retained;
    if (key === "language" || key === "background") return text(value, 128);
    if (key === "colwidth") return dense(value, 256) && value.every(width => integer(width, 0, 1000000));
    return integer(value, key === "order" ? 0 : 1, key === "level" ? 6 : 1000000);
  });
}
/** One node-field schema serves both source validation and the packet reader. */
function nodeFields(value: Record<string, unknown>, retained: boolean): boolean {
  if (!text(value.type, 64) || value.type.length === 0 || (retained && !supported.has(value.type))) return false;
  if (Object.hasOwn(value, "text") && (value.type !== "text" || !text(value.text, 1048576))) return false;
  if (value.type === "text" && !Object.hasOwn(value, "text")) return false;
  if (Object.hasOwn(value, "attrs") && !validAttrs(value.type, value.attrs, retained)) return false;
  return !Object.hasOwn(value, "marks") || (value.type === "text" && dense(value.marks, 32) && value.marks.every(mark => record(mark) && keys(mark, ["type"], retained ? [] : ["attrs"]) && text(mark.type, 64) && mark.type.length > 0 && (!retained || marks.has(mark.type)) && (!Object.hasOwn(mark, "attrs") || record(mark.attrs))));
}
/** Structural grammar permits unsupported nodes so exclusion counts never silently lose them. */
function childAllowed(parent: string, child: string): boolean { return !supported.has(parent) || !supported.has(child) || (children.get(parent) ?? []).includes(child); }
/** Snapshot validation is a single boundary pass shared by preview and capture. */
function input(value: unknown): value is AdfCaptureInput {
  if (!boundedJson(value) || !record(value) || !keys(value, ["version", "source", "select"], ["approval", "budget"]) || value.version !== 1 || !identity(value.source, true) || !selections(value.select) || (Object.hasOwn(value, "budget") && !integer(value.budget, 4096, 65536))) return false;
  if (Object.hasOwn(value, "approval") && (!record(value.approval) || !keys(value.approval, ["revision", "digest"]) || !text(value.approval.revision, 128) || !hash(value.approval.digest))) return false;
  let count = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (++count > 8192 || depth > 32 || !record(node) || !keys(node, ["type"], ["version", "text", "attrs", "marks", "content"]) || !nodeFields(node, false) || (Object.hasOwn(node, "version") && (depth !== 0 || node.version !== 1))) return false;
    if (depth === 0 ? node.type !== "doc" || node.version !== 1 : node.type === "doc") return false;
    return !Object.hasOwn(node, "content") || (dense(node.content, 8192) && node.content.every(child => record(child) && childAllowed(String(node.type), String(child.type)) && visit(child, depth + 1)));
  };
  return visit((value.source as Record<string, unknown>).document, 0);
}
/** Strip all unfamiliar attributes and marks; never include hidden source data in retained rows. */
function fields(node: AdfSourceNode): Pick<AdfEvidenceNode, "type" | "text" | "attrs" | "marks"> {
  const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([key]) => (attrKeys.get(node.type) ?? []).includes(key)));
  return { type: node.type, ...(node.text === undefined ? {} : { text: node.text }),
    ...(Object.keys(attrs).length === 0 ? {} : { attrs: structuredClone(attrs) }), ...(node.marks === undefined ? {} : { marks: node.marks.filter(mark => marks.has(mark.type) && mark.attrs === undefined).map(mark => ({ type: mark.type })) }) };
}
/** Compile selected rows and ancestor boundaries, binding approval to the entire observed source. */
export function captureAdfEvidence(value: unknown): AdfCaptureResult {
  if (!input(value)) return adfEvidenceRefusal("invalid_input");
  const sourceDigest = digest(value.source);
  if (value.approval !== undefined && (value.approval.revision !== value.source.revision || value.approval.digest !== sourceDigest)) return adfEvidenceRefusal("source_changed");
  const counts = { source: 0, retained: 0, context: 0, unselected: 0, unsupported: 0, attachments: 0, omittedMarks: 0 };
  const nodes: AdfEvidenceNode[] = []; const found = new Set<string>();
  const visit = (node: AdfSourceNode, path: string, excluded: boolean): void => {
    counts.source++;
    const media = attachments.has(node.type); const unknown = !supported.has(node.type);
    const blocked = excluded || unknown;
    if (media) counts.attachments++; else if (unknown) counts.unsupported++;
    const selected = !blocked && value.select.some(selection => path === selection || path.startsWith(`${selection}/`));
    const context = !blocked && !selected && value.select.some(selection => selection.startsWith(`${path}/`));
    if (value.select.includes(path) && !blocked && !["text", "hardBreak", "doc"].includes(node.type)) found.add(path);
    if (selected || context) {
      const row = { pointer: path, context, ...fields(node) }; nodes.push(row);
      if (context) counts.context++; else counts.retained++;
      counts.omittedMarks += (node.marks?.length ?? 0) - (row.marks?.length ?? 0);
    } else if (!unknown) counts.unselected++;
    node.content?.forEach((child, i) => visit(child, `${path}/content/${i}`, blocked));
  };
  visit(value.source.document, "", false);
  if (found.size !== value.select.length) return adfEvidenceRefusal("selection_missing");
  const selected = nodes.filter(node => value.select.includes(node.pointer)).map(node => node.pointer);
  const payload = { version: 1 as const, source: { site: value.source.site, issue: value.source.issue, revision: value.source.revision, digest: sourceDigest }, select: selected, nodes, counts };
  const packet: AdfEvidencePacket = { ...payload, digest: digest(payload) };
  const result = { kind: value.approval === undefined ? "preview" as const : "captured" as const, packet };
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 > (value.budget ?? 8192)) return adfEvidenceRefusal("budget_exceeded");
  return result;
}
/** Validate the exact producer schema and its integrity before any replay. No source access is implied. */
function packet(value: unknown): value is AdfEvidencePacket {
  if (!boundedJson(value) || !record(value) || !keys(value, ["version", "source", "select", "nodes", "counts", "digest"]) || value.version !== 1 || !identity(value.source, false) || !selections(value.select) || !dense(value.nodes, 8192) || !record(value.counts) || !keys(value.counts, ["source", "retained", "context", "unselected", "unsupported", "attachments", "omittedMarks"]) || !Object.entries(value.counts).every(([key, count]) => integer(count, 0, key === "omittedMarks" ? 262144 : 8192)) || !hash(value.digest)) return false;
  const { digest: checksum, ...payload } = value;
  if (digest(payload) !== checksum) return false;
  const seen = new Map<string, string>(); let retained = 0; let context = 0; let previous = "";
  for (const row of value.nodes) {
    if (!record(row) || !keys(row, ["pointer", "type", "context"], ["text", "attrs", "marks"]) || !nodeFields(row, true) || typeof row.context !== "boolean" || typeof row.pointer !== "string" || (row.pointer !== "" && !pointer(row.pointer)) || seen.has(row.pointer)) return false;
    const order = row.pointer.replace(/[0-9]+/g, part => part.padStart(4, "0"));
    if (seen.size > 0 && order <= previous) return false;
    previous = order;
    const parent = row.pointer.slice(0, row.pointer.lastIndexOf("/content/"));
    if (row.pointer === "" ? row.type !== "doc" : !seen.has(parent) || !childAllowed(seen.get(parent)!, String(row.type))) return false;
    const selected = value.select.some(selection => row.pointer === selection || String(row.pointer).startsWith(`${selection}/`));
    if (row.context !== !selected || (!selected && !value.select.some(selection => String(selection).startsWith(`${row.pointer}/`))) || (row.context && (Object.hasOwn(row, "text") || Object.hasOwn(row, "marks")))) return false;
    if (row.context) context++; else retained++;
    seen.set(row.pointer, String(row.type));
  }
  return value.select.every(selection => seen.has(selection) && !["text", "hardBreak", "doc"].includes(seen.get(selection)!)) && retained === value.counts.retained && context === value.counts.context && value.counts.source === retained + context + Number(value.counts.unselected) + Number(value.counts.unsupported) + Number(value.counts.attachments);
}
/** Replay a complete packet into selective ADF with stable original source addresses. */
export function replayAdfEvidence(value: unknown): AdfReplayResult {
  if (!packet(value)) return adfEvidenceRefusal("invalid_packet");
  const nodes = new Map<string, { node: AdfSourceNode; output: string }>();
  const document: AdfSourceNode = { type: "doc", version: 1, content: [] };
  const coordinates: { pointer: string; sourcePointer: string }[] = [];
  for (const row of value.nodes) {
    const { pointer: sourcePointer, context: _context, ...data } = row;
    if (sourcePointer === "") { nodes.set("", { node: document, output: "" }); coordinates.push({ pointer: "", sourcePointer }); continue; }
    const parent = nodes.get(sourcePointer.slice(0, sourcePointer.lastIndexOf("/content/")))!;
    parent.node.content ??= [];
    const output = `${parent.output}/content/${parent.node.content.length}`;
    const node: AdfSourceNode = { ...structuredClone(data), ...(children.has(data.type) ? { content: [] } : {}) };
    parent.node.content.push(node); nodes.set(sourcePointer, { node, output }); coordinates.push({ pointer: output, sourcePointer });
  }
  return { kind: "replayed", document, coordinates };
}
