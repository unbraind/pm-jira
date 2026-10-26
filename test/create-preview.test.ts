/** Behavioral contracts for strict create metadata and all-batch export validation. */
import assert from "node:assert/strict";
import test from "node:test";
import { previewJiraCreate, runExportPush, buildExportPlan } from "../index.ts";
import type { JiraCreatePreviewInput, JiraCreatePreviewResult } from "../index.ts";

/** A revisioned scalar and custom required option create fixture. */
export function contract(): JiraCreatePreviewInput {
  return { metadata: { version: 1, revision: "fixture-1", project: "DEMO", issueType: "Task", fields: [
    { id: "summary", name: "Summary", required: true, type: "string" },
    { id: "customfield_10001", name: "Team", required: true, type: "option", allowedValues: [{ id: "10" }, { id: "20" }] },
  ] }, project: "DEMO", issueType: "Task", answers: { summary: "Example", customfield_10001: { id: "10" } } };
}
/** Assert refusal envelopes do not hide partial writes. */
function refused(result: JiraCreatePreviewResult, code = "invalid_input"): void {
  assert.equal(result.kind, "refused"); assert.ok(result.kind === "refused"); assert.equal(result.code, code);
  assert.equal(result.exit_code, 2); assert.equal(result.posts, 0); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024);
}

test("revisioned required field bindings, missing checklist and invalid choices cover the entire contract", () => {
  const input = contract(); const good = previewJiraCreate(input);
  assert.ok(good.kind === "ready"); assert.deepEqual(good.counts, { bound: 2, missing: 0, invalid: 0 });
  assert.equal(good.revision, "fixture-1"); assert.match(good.digest, /^[a-f0-9]{64}$/);
  input.metadata.revision = "fixture-2"; assert.notEqual((previewJiraCreate(input) as typeof good).digest, good.digest);
  delete input.answers.customfield_10001;
  const missing = previewJiraCreate(input); assert.ok(missing.kind === "incomplete");
  assert.deepEqual(missing.diagnostics.filter(row => row.state === "missing").map(row => row.field), ["customfield_10001"]);
  input.answers.customfield_10001 = { id: "99" }; input.answers.foreign = false;
  const invalid = previewJiraCreate(input); assert.ok(invalid.kind === "incomplete"); assert.equal(invalid.counts.invalid, 2);
  input.answers.customfield_10001 = "10"; assert.equal(previewJiraCreate(input).kind, "incomplete");
  input.project = "OTHER"; refused(previewJiraCreate(input), "scope_mismatch");
  input.project = "DEMO"; input.issueType = "Bug"; refused(previewJiraCreate(input), "scope_mismatch");
});

test("all supported value shapes validate exact choices without coercion", () => {
  const input = contract(); input.metadata.fields = [
    { id: "s", name: "s", required: false, type: "string", allowedValues: ["a"] },
    { id: "n", name: "n", required: false, type: "number", allowedValues: [0, 2] },
    { id: "b", name: "b", required: false, type: "boolean", allowedValues: [false] },
    { id: "ss", name: "ss", required: false, type: "strings", allowedValues: ["a", "b"] },
    { id: "oo", name: "oo", required: false, type: "options", allowedValues: [{ id: "a" }] },
  ];
  input.answers = {}; assert.equal(previewJiraCreate(input).kind, "ready");
  input.answers = { s: "a", n: 0, b: false, ss: ["a", "b"], oo: [{ id: "a" }] };
  assert.equal(previewJiraCreate(input).kind, "ready");
  input.answers.ss = ["x"]; input.answers.oo = []; input.answers.b = true;
  const bad = previewJiraCreate(input); assert.ok(bad.kind === "incomplete"); assert.equal(bad.counts.invalid, 2);
  assert.ok(bad.diagnostics.some(row => row.field === "oo" && row.state === "omitted"));
  input.answers.ss = "a"; input.answers.n = "2"; input.answers.s = 1; assert.equal(previewJiraCreate(input).kind, "incomplete");
});

test("one strict schema rejects unknown keys, sparse arrays, malformed types and every numeric extreme", () => {
  for (const input of [null, [], false, {}, new Date(), Object.create({ project: "DEMO" })]) refused(previewJiraCreate(input));
  const mutate = (fn: (input: Record<string, unknown>) => void) => { const input = structuredClone(contract()) as unknown as Record<string, unknown>; fn(input); refused(previewJiraCreate(input)); };
  for (const key of ["metadata", "project", "issueType", "answers"]) mutate(input => { delete input[key]; });
  mutate(input => { input.extra = true; });
  for (const bad of ["", " ", "\u0000", "x".repeat(513), 1, null]) mutate(input => { input.project = bad; });
  for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, "4096", 4095, 65537, Number.MAX_VALUE]) mutate(input => { input.budget = bad; });
  for (const bad of [NaN, Infinity, -1, 0.5, "0", 1000001]) mutate(input => { input.offset = bad; });
  for (const bad of [null, [], { x: Infinity }, { x: -Infinity }, { x: NaN }, { x: 1e12 + 1 }, { x: -1e12 - 1 }, { x: {} }, { x: [1] }, { x: Array(1) }, { x: Array(17).fill("x") }, { x: { id: "" } }, { "bad-id": true }, Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`f${i}`, 1]))]) mutate(input => { input.answers = bad; });
  for (const bad of [null, [], {}, { ...contract().metadata, version: 2 }, { ...contract().metadata, revision: "" }, { ...contract().metadata, project: "" }, { ...contract().metadata, issueType: "" }, { ...contract().metadata, unknown: 1 }]) mutate(input => { input.metadata = bad; });
  for (const fields of [Array(1), Array(257).fill(contract().metadata.fields[0]), [null], [1], [{}], [contract().metadata.fields[0], contract().metadata.fields[0]]]) {
    const input = contract(); input.metadata.fields = fields as typeof input.metadata.fields; refused(previewJiraCreate(input));
  }
  const base = contract().metadata.fields[0]!;
  for (const field of [{ ...base, extra: true }, { ...base, id: "" }, { ...base, id: "bad-id" }, { ...base, id: 1 }, { ...base, id: "project" }, { ...base, id: "issuetype" }, { ...base, name: "" }, { ...base, required: 1 }, { ...base, type: null }, { ...base, type: "unsupported" }, { ...base, allowedValues: Array(1) }, { ...base, allowedValues: Array(129).fill("a") }, { ...base, allowedValues: [1] }]) {
    const input = contract(); input.metadata.fields = [field] as typeof input.metadata.fields; refused(previewJiraCreate(input));
  }
  for (const value of [null, 1e12, -1e12, 0, false, " a\r\nb ", { id: "a" }, ["a"], [{ id: "b" }]]) {
    const input = contract(); input.answers.other = value; assert.equal(previewJiraCreate(input).kind, "incomplete");
  }
});

test("UTF-8 output budget exposes continuation with no lost diagnostics", () => {
  const input = contract(); input.budget = 4096; input.answers = {};
  input.metadata.fields = Array.from({ length: 32 }, (_, i) => ({ id: `f${i}`, name: "Team", required: true, type: "strings", allowedValues: ["雪".repeat(512)] }));
  input.answers.f0 = Array(16).fill("雪".repeat(512));
  const collected = []; let pages = 0;
  do {
    const page = previewJiraCreate(input); assert.ok(page.kind === "incomplete");
    assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) + 1 <= 4096);
    for (const number of [page.budget, page.counts.bound, page.counts.missing, page.counts.invalid, page.page.offset, page.page.total]) assert.ok(Number.isFinite(number) && number >= 0);
    collected.push(...page.diagnostics); pages++;
    if (page.page.nextOffset === null) break;
    assert.ok(page.page.nextOffset > (input.offset ?? 0)); input.offset = page.page.nextOffset;
  } while (pages < 200);
  assert.equal(collected.length, 16 + 31 + 32); assert.ok(pages > 1);
  assert.deepEqual(collected.filter(row => row.state === "missing").map(row => row.field), Array.from({ length: 31 }, (_, i) => `f${i + 1}`));
  assert.deepEqual(collected.filter(row => row.state === "allowed").map(row => row.field), Array.from({ length: 32 }, (_, i) => `f${i}`));
  const bindings = collected.filter(row => row.state === "bound"); assert.equal(bindings.length, 16);
  assert.ok(bindings.every(row => row.field === "f0" && row.value === "雪".repeat(512)));
  input.offset = 1000000; const tail = previewJiraCreate(input); assert.ok(tail.kind !== "refused"); assert.deepEqual(tail.diagnostics, []);
  input.budget = 65536; input.offset = 0; assert.ok(previewJiraCreate(input).kind !== "refused");
});

test("export guard validates every create before any POST/PUT and recompiles each retry", async () => {
  let posts = 0; let puts = 0; const bodies: unknown[] = [];
  const deps = { post: async (_u: string, _a: string, body: string) => { posts++; bodies.push(JSON.parse(body) as unknown); return "{}"; }, put: async () => { puts++; return "{}"; } };
  const input = contract(); const opts = { authHeader: "synthetic", updateExisting: true, createContract: input };
  const items = [{ id: "one", title: "One" }, { id: "two", title: "Two" }, { id: "old", title: "Old", description: "Jira DEMO-1: https://example.invalid/browse/DEMO-1" }];
  const plan = buildExportPlan(items, "https://example.invalid", { projectKey: "DEMO" });
  delete input.answers.customfield_10001;
  await assert.rejects(runExportPush(plan, opts, deps), /missing or invalid/); assert.equal(posts + puts, 0);
  input.answers.customfield_10001 = { id: "10" };
  const invalid = structuredClone(plan); invalid.entries[1]!.payload.fields.summary = " ";
  await assert.rejects(runExportPush(invalid, opts, deps), /missing or invalid/); assert.equal(posts + puts, 0);
  const mismatch = structuredClone(plan); delete mismatch.entries[0]!.payload.fields.project;
  await assert.rejects(runExportPush(mismatch, opts, deps), /scope differs/);
  input.issueType = "Bug"; input.metadata.issueType = "Bug";
  await assert.rejects(runExportPush(plan, opts, deps), /scope differs/);
  await assert.rejects(runExportPush(plan, { ...opts, createContract: {} }, deps), /strict v1/);
  input.issueType = "Task"; input.metadata.issueType = "Task";
  const result = await runExportPush(plan, opts, deps); assert.equal(result.created, 2); assert.equal(result.updated, 1);
  assert.equal(posts, 2); assert.equal(puts, 1);
  assert.deepEqual((bodies[0] as { fields: Record<string, unknown> }).fields.customfield_10001, { id: "10" });
  assert.equal(Object.hasOwn(plan.entries[0]!.payload.fields, "customfield_10001"), false);
  input.metadata.revision = "fixture-2"; input.metadata.fields[1]!.allowedValues = [{ id: "20" }];
  await assert.rejects(runExportPush(plan, opts, deps), /missing or invalid/); assert.equal(posts, 2);
});

test("validated export values are isolated from caller mutation between POST awaits", async () => {
  const input = contract(); const plan = buildExportPlan([{ title: "One" }, { title: "Two" }], "https://example.invalid", { projectKey: "DEMO" });
  const observed: unknown[] = [];
  await runExportPush(plan, { authHeader: "synthetic", updateExisting: false, createContract: input }, {
    post: async (_url, _auth, body) => {
      observed.push(JSON.parse(body) as unknown);
      (input.answers.customfield_10001 as { id: string }).id = "forbidden";
      plan.entries[1]!.payload.fields.summary = " ";
      return "{}";
    }, put: async () => "{}",
  });
  assert.equal(observed.length, 2);
  const second = observed[1] as { fields: Record<string, unknown> };
  assert.deepEqual(second.fields.customfield_10001, { id: "10" }); assert.equal(second.fields.summary, "Two");
});

test("seeded extreme input/output fuzz keeps numeric and byte contracts finite", () => {
  let seed = 0x43524541;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const extremes = [NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE, -1e12, 1e12, 1e12 + 1, -0, [], Array(2), null, {}, { id: "1" }, "雪".repeat(512)];
  for (let n = 0; n < 1000; n++) {
    const input = contract(); const chosen = extremes[random() % extremes.length];
    if (random() % 2) Object.assign(input, { budget: chosen }); else Object.assign(input.answers, { summary: chosen });
    const output = previewJiraCreate(input);
    if (output.kind === "refused") assert.ok(Buffer.byteLength(JSON.stringify(output)) < 1024);
    else {
      assert.ok(Buffer.byteLength(JSON.stringify(output, null, 2)) + 1 <= output.budget);
      const numbers = [output.counts.bound, output.counts.invalid, output.counts.missing, output.page.offset, output.page.total, output.page.nextOffset ?? 0];
      assert.ok(numbers.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000));
    }
  }
});


test("a single escaped Unicode row that cannot fit refuses with a larger-budget remedy", () => {
  const input = contract(); const token = "\ud800".repeat(64);
  input.project = token; input.issueType = token; input.metadata.project = token; input.metadata.issueType = token; input.metadata.revision = token;
  input.answers.summary = "\ud800".repeat(512); input.budget = 4096;
  refused(previewJiraCreate(input), "budget_too_small");
  input.budget = 65536; assert.equal(previewJiraCreate(input).kind, "ready");
});
