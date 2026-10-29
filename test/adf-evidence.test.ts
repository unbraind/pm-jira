/** Selection/privacy/replay laws exercise the public SDK, never a second text normalizer. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { captureAdfEvidence, replayAdfEvidence } from "../adf-evidence.ts";
import type { AdfCaptureInput, AdfEvidencePacket, AdfSourceNode } from "../adf-evidence.ts";

/** Explicit source includes sensitive siblings, nested structures and unsupported/media nodes. */
function fixture(): AdfCaptureInput {
  const paragraph = (text: string): AdfSourceNode => ({ type: "paragraph", content: [{ type: "text", text }] });
  return { version: 1, budget: 65536, source: { site: "https://example.invalid", issue: "DEMO-1", revision: "r1", document: {
    type: "doc", version: 1, content: [paragraph("UNSELECTED"),
      { type: "table", attrs: { localId: "HIDDEN_ATTRIBUTE" }, content: [{ type: "tableRow", content: [
        { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [0], background: "white" }, content: [paragraph(" cell\r\n text ")] },
        { type: "tableHeader", content: [paragraph("UNSELECTED_CELL")] },
      ] }] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: " const x = 1;\r\n\n " }] },
      { type: "orderedList", attrs: { order: 0 }, content: [{ type: "listItem", content: [paragraph(" list ")] }] },
      { type: "extension", attrs: { text: "UNSUPPORTED" }, content: [paragraph("UNDER_UNSUPPORTED")] },
      { type: "mediaGroup", content: [{ type: "media", attrs: { id: "ATTACHMENT_CONTENT" } }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "blockquote", content: [
        { type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "Title", marks: [{ type: "strong" }, { type: "link", attrs: { href: "ATTACHMENT_LINK" } }, { type: "em", attrs: {} }] }] },
        { type: "paragraph", content: [{ type: "hardBreak" }] }, { type: "rule" },
      ] }] }] },
    ],
  } }, select: ["/content/1/content/0/content/0", "/content/2", "/content/3", "/content/6"] };
}
/** Assert success and let discriminated unions protect all following assertions. */
function preview(input: unknown): AdfEvidencePacket { const result = captureAdfEvidence(input); assert.notEqual(result.kind, "refused", JSON.stringify(result)); if (result.kind === "refused") throw new Error(result.code); return result.packet; }
/** Recursively sort only object keys for intentionally forged-schema integrity tests. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Re-sign invalid records so replay tests cover schema checks beyond the checksum. */
function signed(value: unknown): unknown { const { digest: _digest, ...rest } = value as Record<string, unknown>; return { ...rest, digest: createHash("sha256").update(canonical(rest)).digest("hex") }; }
/** Fresh mutable JSON copy keeps failure corpus cases independent. */
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

test("table cell, code and list round-trip with stable source coordinates; no unselected or attachment content", () => {
  const request = fixture(); const packet = preview(request);
  assert.deepEqual(packet.counts, { source: 30, retained: 17, context: 3, unselected: 7, unsupported: 1, attachments: 2, omittedMarks: 2 });
  const wire = JSON.stringify(packet);
  for (const excluded of ["UNSELECTED", "UNSUPPORTED", "UNDER_UNSUPPORTED", "ATTACHMENT", "HIDDEN_ATTRIBUTE"]) assert.ok(!wire.includes(excluded), excluded);
  assert.ok(wire.includes("/content/1/content/0/content/0"));
  const restored = replayAdfEvidence(JSON.parse(wire)); assert.equal(restored.kind, "replayed");
  if (restored.kind !== "replayed") return;
  assert.deepEqual(restored.document.content![1], request.source.document.content![2]);
  assert.deepEqual(restored.document.content![0]!.content![0]!.content![0], request.source.document.content![1]!.content![0]!.content![0]);
  assert.deepEqual(restored.document.content![2], request.source.document.content![3]);
  assert.deepEqual(restored.coordinates.find(row => row.pointer === "/content/1/content/0"), { pointer: "/content/1/content/0", sourcePointer: "/content/2/content/0" });
  const captured = captureAdfEvidence({ ...request, approval: { revision: packet.source.revision, digest: packet.source.digest } });
  assert.equal(captured.kind, "captured"); assert.deepEqual(captured.packet, packet);
  assert.equal(captureAdfEvidence({ ...request, select: [...request.select].reverse() }).kind, "preview");
  assert.deepEqual(preview({ ...request, select: [...request.select].reverse() }), packet);
  const changed = copy(request); changed.source.revision = "r2"; changed.approval = { revision: "r1", digest: packet.source.digest };
  assert.equal(captureAdfEvidence(changed).kind, "refused");
  changed.source.revision = "r1"; changed.source.document.content![0]!.content![0]!.text = "changed unselected content";
  assert.equal(captureAdfEvidence(changed).kind, "refused");
  for (const key of ["site", "issue"] as const) { const other = copy(request); other.source[key] = key === "site" ? "https://other.invalid" : "DEMO-2"; other.approval = { revision: "r1", digest: packet.source.digest }; assert.equal(captureAdfEvidence(other).kind, "refused"); }
});

test("all refusal codes are actionable; zero partial output when selection or budget refuses", () => {
  for (const select of [["/content/99"], ["/content/5"], ["/content/4/content/0"], ["/content/2/content/0"]]) {
    const result = captureAdfEvidence({ ...fixture(), select }); assert.equal(result.kind, "refused"); if (result.kind === "refused") { assert.equal(result.code, "selection_missing"); assert.ok(result.remediation.length > 20); }
  }
  const request = fixture(); request.source.document.content![2]!.content![0]!.text = "x".repeat(9000); request.budget = 4096;
  const result = captureAdfEvidence(request); assert.equal(result.kind, "refused"); if (result.kind === "refused") assert.equal(result.code, "budget_exceeded");
  const minimal = fixture(); delete minimal.budget; minimal.select = ["/content/2"];
  assert.equal(captureAdfEvidence(minimal).kind, "preview");
});

test("strict source boundary refuses sparse/extreme/malformed inputs, allows released ADF and CRLF", () => {
  const cases: unknown[] = [null, false, [], new Date(), Object.create({}), { ...fixture(), extra: true }, { ...fixture(), version: 2 }];
  const mutate = (edit: (value: Record<string, unknown>) => void) => { const value = copy(fixture()) as unknown as Record<string, unknown>; edit(value); cases.push(value); };
  for (const budget of [NaN, Infinity, -Infinity, 0, 4095, 65537, 1.1, Number.MAX_VALUE, undefined]) mutate(v => { v.budget = budget; });
  for (const select of [[], Array(1), [""], ["/content/01"], ["/content/1", "/content/1/content/0"], ["/content/1", "/content/1"], Array(65).fill("/content/1"), ["/content/10000"], ["/content/9999"], ["/content/0".repeat(33)]]) mutate(v => { v.select = select; });
  for (const approval of [null, {}, { revision: "r1", digest: "bad" }, { revision: 2, digest: "0".repeat(64) }]) mutate(v => { v.approval = approval; });
  for (const source of [null, {}, { site: "bad", issue: "X-1", revision: "1", document: {} }, { ...fixture().source, issue: "constructor" }, { ...fixture().source, revision: " " }, { ...fixture().source, site: "https://example.invalid/" }, { ...fixture().source, site: "https://example.invalid:99999" }]) mutate(v => { v.source = source; });
  for (const node of [null, {}, { type: "doc", version: 2 }, { type: "doc", version: 1, other: true }, { type: "doc", version: 1, content: Array(1) }, { type: "doc", version: 1, content: [{ type: "doc" }] },
    { type: "doc", version: 1, content: [{ type: "text", text: "bad child" }] }, { type: "doc", version: 1, content: [{ type: "paragraph", version: 1 }] },
    { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text" }] }] },
    { type: "doc", version: 1, content: [{ type: "paragraph", text: "invalid" }] },
    { type: "doc", version: 1, content: [{ type: "codeBlock", attrs: [] }] },
    { type: "doc", version: 1, content: [{ type: "heading", attrs: { level: 7 } }] },
    { type: "doc", version: 1, content: [{ type: "codeBlock", attrs: { language: 1 } }] },
    { type: "doc", version: 1, content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colwidth: [-1] } }] }] }] },
    { type: "doc", version: 1, content: [{ type: "paragraph", marks: [] }] },
    { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "\u0000" }] }] },
    { type: "doc", version: 1, attrs: { finite: Infinity } }, { type: "doc", version: 1, attrs: { finite: Number.MAX_VALUE } },
    { type: "doc", version: 1, attrs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x${i}`, i])) },
  ]) mutate(v => { (v.source as Record<string, unknown>).document = node; });
  const deep = fixture(); let tail = deep.source.document; for (let i = 0; i < 34; i++) { const next = { type: "blockquote", content: [] }; tail.content = [next]; tail = next; } cases.push(deep);
  const jsonDeep = fixture(); let attrs: Record<string, unknown> = {}; jsonDeep.source.document.attrs = attrs as Record<string, never>; for (let i = 0; i < 75; i++) { const next = {}; attrs.x = next; attrs = next; } cases.push(jsonDeep);
  const wide = fixture(); wide.source.document.content = Array.from({ length: 8192 }, () => ({ type: "rule" })); cases.push(wide);
  const huge = fixture(); huge.source.document.attrs = { ignored: "x".repeat(1048577) }; cases.push(huge);
  const cyclic = fixture(); cyclic.source.document.content!.push(cyclic.source.document); cases.push(cyclic);
  for (const invalid of cases) { const result = captureAdfEvidence(invalid); assert.equal(result.kind, "refused"); if (result.kind === "refused") assert.equal(result.code, "invalid_input"); }
  // Previously released plain-text export ADF remains accepted without rewriting its whitespace.
  const legacy = fixture(); legacy.source.document = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: " \r\n legacy " }] }] }; legacy.select = ["/content/0"];
  assert.equal(preview(legacy).nodes.at(-1)!.text, " \r\n legacy ");
  const unknown = fixture(); unknown.source.document.attrs = { data: [null, true, 0, { key: false }] }; preview(unknown);
});

test("packet reader rejects corrupt/foreign records before replay, including valid checksums with invalid schema", () => {
  const packet = preview(fixture());
  assert.equal(replayAdfEvidence(null).kind, "refused");
  assert.equal(replayAdfEvidence({ ...packet, digest: "0".repeat(64) }).kind, "refused");
  const edits: ((v: AdfEvidencePacket) => void)[] = [
    v => { v.nodes[1]!.type = "media"; }, v => { v.nodes[1]!.pointer = "/content/99/content/0"; },
    v => { v.nodes[0]!.type = "paragraph"; }, v => { v.nodes.push(copy(v.nodes[0]!)); },
    v => { v.nodes[1]!.attrs = { unknown: "hidden" }; }, v => { v.nodes[1]!.context = false; },
    v => { v.nodes[0]!.marks = []; }, v => { v.nodes[1]!.text = "unselected"; },
    v => { v.nodes[2]!.type = "text"; }, v => { v.nodes[3]!.pointer = "/content/1/content/0/content/0/content/0/content/0"; },
    v => { v.select = ["/content/99"]; }, v => { v.counts.source++; }, v => { v.counts.context++; }, v => { v.counts.retained++; },
    v => { v.counts.source = 8193; }, v => { v.counts.omittedMarks = Infinity; },
    v => { v.nodes[0]!.pointer = "bad"; }, v => { v.nodes[1]!.context = undefined as unknown as boolean; },
    v => { const index = v.nodes.findIndex(row => row.type === "codeBlock"); const moved = v.nodes.splice(index, 2); v.nodes.splice(1, 0, ...moved); },
    v => { const tail = v.nodes.splice(-1); v.nodes.splice(2, 0, ...tail); },
    v => { v.nodes = []; }, v => { v.select = [v.nodes.at(-1)!.pointer]; },
    v => { v.nodes.find(row => row.type === "text")!.marks = [{ type: "link" }]; },
  ];
  for (const edit of edits) { const bad = copy(packet); edit(bad); assert.equal(replayAdfEvidence(signed(bad)).kind, "refused", JSON.stringify(bad)); }
  const empty: AdfCaptureInput = { ...fixture(), select: ["/content/0"] }; empty.source.document.content = [{ type: "paragraph", content: [] }];
  const restored = replayAdfEvidence(preview(empty)); assert.equal(restored.kind, "replayed");
});

test("seed 0xadf1029: 500 operation sequences preserve producer/validator agreement, order and exact text", () => {
  let seed = 0xadf1029;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sequence = 0; sequence < 500; sequence++) {
    const input = fixture(); const text = ` ${rand()}${rand() % 2 ? "\r\n" : "\n"}tail `;
    input.source.revision = `revision-${sequence}`; input.source.document.content![2]!.content![0]!.text = text;
    input.select = rand() % 2 ? ["/content/2", "/content/1/content/0/content/0"] : ["/content/2", "/content/3"];
    const packet = preview(input); const replay = replayAdfEvidence(copy(packet)); assert.equal(replay.kind, "replayed");
    if (replay.kind === "replayed") assert.equal(replay.document.content!.find(node => node.type === "codeBlock")!.content![0]!.text, text);
    assert.deepEqual(preview({ ...input, select: [...input.select].reverse() }), packet);
    const approval = { revision: packet.source.revision, digest: packet.source.digest };
    assert.equal(captureAdfEvidence({ ...input, approval }).kind, "captured");
    input.source.revision = `revision-${sequence + 1}`;
    assert.equal(captureAdfEvidence({ ...input, approval }).kind, "refused");
    for (const number of Object.values(packet.counts)) assert.ok(Number.isSafeInteger(number) && number >= 0 && number <= 262144);
  }
});

test("exact source limits reject default-port aliases, leaf children and invalid approval envelopes", () => {
  assert.equal(captureAdfEvidence({ ...fixture(), source: { ...fixture().source, site: "https://example.invalid:443" } }).kind, "refused");
  const wrongRoot = fixture(); wrongRoot.source.document = { type: "paragraph", content: [] };
  assert.equal(captureAdfEvidence(wrongRoot).kind, "refused");
  const leaf = fixture(); leaf.source.document.content = [{ type: "paragraph", content: [{ type: "text", text: "x", content: [{ type: "hardBreak" }] }] }];
  assert.equal(captureAdfEvidence(leaf).kind, "refused");
  const approval = { ...fixture(), approval: { revision: "r1", digest: "a".repeat(64), extra: true } };
  assert.equal(captureAdfEvidence(approval).kind, "refused");
});


test("original numeric coordinates sort correctly above nine and copied attributes stay detached", () => {
  const input = fixture(); input.source.document.content = Array.from({ length: 12 }, (_, i) => ({ type: "codeBlock", attrs: { language: String(i) }, content: [{ type: "text", text: `line ${i}` }] }));
  input.select = ["/content/11", "/content/2"];
  const packet = preview(input); assert.deepEqual(packet.select, ["/content/2", "/content/11"]);
  assert.equal(replayAdfEvidence(packet).kind, "replayed");
  const cell = fixture(); const captured = preview(cell);
  const widths = cell.source.document.content![1]!.content![0]!.content![0]!.attrs!.colwidth as number[];
  widths[0] = 999;
  assert.deepEqual(captured.nodes.find(row => row.type === "tableCell")!.attrs!.colwidth, [0]);
});
