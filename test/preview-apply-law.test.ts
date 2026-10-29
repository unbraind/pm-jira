/** Seeded agreement law for final create bodies, precedence, references and fail-closed exports. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { generate } from "selfsigned";
import { PmClient, isPmCliExpectedError, listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildExportPlan, buildJiraCreateBody, previewJiraCreate, previewJiraExport, readPmItems, runExportPush } from "../index.ts";
import type { JiraCreateField, JiraCreateMetadata, JiraCreatePreviewInput, JiraCreateValue } from "../index.ts";

/** Independent fake-Jira schema oracle uses only the fixture's advertised forms and choices. */
function accepts(field: JiraCreateField, value: unknown): boolean {
  if (value === undefined) return !field.required;
  const single = (entry: unknown): boolean => {
    if (field.type === "number") return typeof entry === "number" && Number.isFinite(entry);
    if (field.type === "boolean") return typeof entry === "boolean";
    if (field.type === "string" || field.type === "strings") return typeof entry === "string" && entry.trim().length > 0;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const pairs = Object.entries(entry);
    const forms = field.type === "user" || field.type === "users" ? ["accountId"] : field.referenceBy ?? ["id", "name", "value"];
    return pairs.length > 0 && pairs.every(([key, text]) => forms.includes(key as "id") && typeof text === "string" && text.trim().length > 0);
  };
  const entries = ["strings", "options", "users"].includes(field.type) ? (Array.isArray(value) && value.length ? value : []) : [value];
  return entries.length > 0 && entries.every(entry => single(entry) && (field.allowedValues === undefined || field.allowedValues.some(choice => {
    if (typeof choice !== "object" || typeof entry !== "object" || !entry) return choice === entry;
    return Object.entries(entry).every(([key, text]) => (choice as Record<string, unknown>)[key] === text);
  })));
}

test("seed 0x424f4459: ready preview equals exact POST digest; refused preview equals apply refusal", async t => {
  const root = mkdtempSync(join(tmpdir(), "jira-agreement-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, "init", "fixture"], { stdio: "pipe", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
  const client = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: "agreement-fixture" });
  await client.create({ title: "Mapped title", type: "Task", priority: 2, tags: "", status: "open" });
  const readback = async () => (await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true })).items;
  const before = await readback(); const items = await readPmItems(root);
  const { cert, private: key } = await generate([{ name: "commonName", value: "localhost" }], { keyType: "ec", algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }] });
  const previousCa = https.globalAgent.options.ca; https.globalAgent.options.ca = cert; t.after(() => { https.globalAgent.options.ca = previousCa; });
  let current: JiraCreateMetadata;
  const bodies: string[] = []; const calls: string[] = [];
  const server = https.createServer({ key, cert }, (request, response) => {
    calls.push(request.method!); let body = ""; request.on("data", data => { body += String(data); });
    request.on("end", () => {
      bodies.push(body); const { fields } = JSON.parse(body) as { fields: Record<string, unknown> };
      const good = current.fields.every(field => accepts(field, fields[field.id])) && Object.keys(fields).every(id => ["project", "issuetype"].includes(id) || current.fields.some(field => field.id === id));
      response.statusCode = good ? 201 : 400; response.setHeader("Connection", "close"); response.end(JSON.stringify(good ? { key: "DEMO-1" } : { errors: ["schema refusal"] }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(async () => { server.closeAllConnections(); server.close(); await once(server, "close"); });
  const address = server.address(); assert.ok(address && typeof address === "object"); const host = `https://127.0.0.1:${address.port}`;
  const harness = await createExtensionTestHarness(extension, { name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"] });
  const saved = { JIRA_EMAIL: process.env.JIRA_EMAIL, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  process.env.JIRA_EMAIL = "fixture@example.invalid"; process.env.JIRA_API_TOKEN = "synthetic";
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  t.mock.method(console, "error", () => {});
  const file = join(root, "contract.json");
  const base = (): JiraCreatePreviewInput => ({ metadata: { version: 1, revision: "fixed", project: "DEMO", issueType: "Task", fields: [
    { id: "summary", name: "Summary", required: true, type: "string" },
    { id: "labels", name: "Labels", required: false, type: "strings" },
    { id: "priority", name: "Priority", required: true, type: "option", referenceBy: ["id", "name"], allowedValues: [{ id: "3", name: "Medium" }] },
  ] }, project: "DEMO", issueType: "Task", answers: { priority: { id: "3" } } });
  // Fixed regression: generated rich priority High must never replace the explicit id 3.
  const fixed = base(); current = fixed.metadata;
  const fixedPlan = buildExportPlan(items, host, { projectKey: "DEMO", richMapping: true });
  const fixedPreview = previewJiraExport(fixedPlan, fixed)[0]!;
  assert.equal(fixedPreview.kind, "ready", "fixed rich priority answer must preview ready");
  writeFileSync(file, JSON.stringify(fixed));
  const fixedResult = await harness.runExporter({ exporter: "jira", pmRoot: root, options: { host, project: "DEMO", push: true, rich: true, "create-contract": file } });
  assert.equal((fixedResult.result as { created: number }).created, 1);
  assert.ok(fixedPreview.kind === "ready"); assert.equal(fixedPreview.bodyDigest, createHash("sha256").update(bodies.at(-1)!).digest("hex"));
  assert.deepEqual(JSON.parse(bodies.at(-1)!).fields.priority, { id: "3" }); assert.equal(Object.hasOwn(JSON.parse(bodies.at(-1)!).fields, "labels"), false);
  const blankStart = calls.length;
  await assert.rejects(harness.runExporter({ exporter: "jira", pmRoot: root, options: { host, project: "DEMO", push: true, rich: true, "create-contract": " " } }), error => isPmCliExpectedError(error) && error.code === "invalid_option");
  assert.equal(calls.length, blankStart);
  let seed = 0x424f4459;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const coverage = new Set<string>(); let ready = 0; let refused = 0;
  for (let sequence = 0; sequence < 512; sequence++) {
    const input = base(); input.metadata.revision = `law-${sequence}`;
    input.answers.summary = "Explicit title";
    input.generatedFields = { summary: "Generated title", customfield_text: "Generated" };
    input.mappedFields = { customfield_text: "Mapped" };
    const types: JiraCreateField["type"][] = ["string", "number", "boolean", "strings", "option", "options", "user", "users"];
    for (const [index, type] of types.entries()) {
      const id = `customfield_${index}`; const required = Boolean(next() & 1);
      const form = ["id", "name", "value"][next() % 3]!;
      const choice = { id: "7", name: "Seven", value: "Seventh" };
      const ref = { [form]: choice[form as keyof typeof choice] };
      let value: JiraCreateValue;
      if (type === "string") value = "  preserved  "; else if (type === "number") value = 0; else if (type === "boolean") value = false;
      else if (type === "strings") value = ["tag"];
      else if (type === "user") value = { accountId: "account-1" }; else if (type === "users") value = [{ accountId: "account-1" }];
      else value = type === "option" ? ref : [ref];
      const field: JiraCreateField = { id, name: "Any name", required, type };
      if (type === "option" || type === "options") {
        // Alternate alias-rich metadata and metadata keyed only by the supplied id/name/value.
        field.allowedValues = [next() & 1 ? choice : ref]; field.referenceBy = [form as "id"];
        coverage.add(`${type}:${form}`);
      }
      if (type === "user" || type === "users") field.allowedValues = [{ accountId: "account-1" }];
      input.metadata.fields.push(field); coverage.add(`${type}:${required}`);
      if (!required && (next() & 1)) value = [undefined, null, [], "", " \r\n"][next() % 5] as JiraCreateValue;
      input.answers[id] = value;
    }
    input.metadata.fields.push({ id: "customfield_text", name: "Text", required: true, type: "string" });
    if (next() & 1) input.answers.customfield_text = "Explicit";
    if (next() & 1) delete input.mappedFields.customfield_text;
    if (next() & 1) { delete input.answers.priority; input.mappedFields.priority = { name: "Medium" }; }
    // Version/component schemas accept id/name, while custom selects also accept value.
    const versionForm = next() & 1 ? "id" : "name";
    for (const id of ["versions", "components"]) {
      input.metadata.fields.push({ id, name: id, required: Boolean(next() & 1), type: "options", referenceBy: ["id", "name"], allowedValues: [{ id: "9", name: "Nine" }] });
      input.answers[id] = [{ [versionForm]: versionForm === "id" ? "9" : "Nine" }]; coverage.add(`${id}:${versionForm}`);
    }
    const variant = { ...items[0]!, title: ["Mapped title", "  Alternate title  ", ""][next() % 3]!,
      tags: next() & 1 ? ["green"] : [], priority: next() % 5 };
    const plan = buildExportPlan([variant], host, { projectKey: "DEMO", richMapping: Boolean(next() & 1) });
    current = input.metadata;
    const preview = previewJiraExport(plan, input)[0]!; assert.ok(preview.kind === "ready");
    const prior = bodies.length; const result = await runExportPush(plan, { authHeader: "synthetic", updateExisting: false, createContract: input });
    assert.equal(result.created, 1); assert.equal(bodies.length, prior + 1);
    assert.equal(createHash("sha256").update(bodies.at(-1)!).digest("hex"), preview.bodyDigest);
    const fields = JSON.parse(bodies.at(-1)!).fields as Record<string, unknown>;
    assert.equal(fields.summary, "Explicit title"); assert.equal(fields.customfield_text, input.answers.customfield_text ?? input.mappedFields.customfield_text ?? "Generated"); assert.deepEqual(fields.priority, input.answers.priority ?? { name: "Medium" });
    // Standalone/CLI preview can reproduce the exact plan by including its native source fields.
    const { priority, project, issuetype, ...mapped } = plan.entries[0]!.payload.fields;
    const standalone = previewJiraCreate({ ...input, generatedFields: { ...input.generatedFields, project, issuetype, ...(priority ? { priority } : {}) }, mappedFields: { ...mapped, ...input.mappedFields } });
    assert.deepEqual(standalone, preview); ready++;
    const bad = structuredClone(input);
    const target = bad.metadata.fields[3 + next() % types.length]!; target.required = true;
    bad.answers[target.id] = [undefined, null, [], "", " \r\n"][next() % 5] as JiraCreateValue;
    const no = previewJiraExport(plan, bad)[0]!; assert.ok(no.kind === "incomplete"); assert.equal(no.bodyDigest, undefined);
    const callsBefore = calls.length;
    await assert.rejects(runExportPush(plan, { authHeader: "synthetic", updateExisting: false, createContract: bad }), error => isPmCliExpectedError(error) && error.code === no.code && error.message === no.remediation);
    assert.equal(calls.length, callsBefore); refused++;
    const illegal = structuredClone(input); illegal.answers.priority = { value: "Medium" };
    const denied = previewJiraExport(plan, illegal)[0]!; assert.ok(denied.kind === "incomplete");
    await assert.rejects(runExportPush(plan, { authHeader: "synthetic", updateExisting: false, createContract: illegal }), error => isPmCliExpectedError(error) && error.code === denied.code && error.message === denied.remediation);
    assert.equal(calls.length, callsBefore); refused++;
  }
  assert.equal(coverage.size, 26); assert.deepEqual(await readback(), before);
  t.diagnostic(`512 sequences: ${ready} ready/digest-equal schema-accepted POSTs plus fixed rich priority; ${refused} same-reason refusals with zero HTTP; 26 schema/role/reference cells`);
});

/** Boundary extremes include source JSON, schema reference restrictions, exact alias matching and scope. */
test("final-body boundary refuses malformed native sources and metadata reference domains", async () => {
  const input = (): JiraCreatePreviewInput => ({ metadata: { version: 1, revision: "bounds", project: "DEMO", issueType: "Task", fields: [] }, project: "DEMO", issueType: "Task", answers: {} });
  let nested: unknown = "leaf"; for (let depth = 0; depth < 10; depth++) nested = { nested };
  const cycle: Record<string, unknown> = {}; cycle.cycle = cycle;
  for (const source of [null, [], false, new Date(), { bad: Infinity }, { bad: NaN }, { bad: -Infinity }, { bad: new Date() }, { bad: "x".repeat(65537) }, { bad: Array(1) }, { bad: Array(257).fill(0) }, { "bad-key": 1 }, { bad: nested }, cycle,
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`f${i}`, 0])), { bad: Array(40).fill(Array(256).fill(0)) }, { bad: Array(17).fill("x".repeat(65536)) }]) {
    assert.equal(buildJiraCreateBody({ ...input(), mappedFields: source }).preview.kind, "refused");
    assert.equal(buildJiraCreateBody({ ...input(), generatedFields: source }).preview.kind, "refused");
  }
  const good = { ...input(), mappedFields: { a: undefined, b: null, c: true, d: 0, e: "", f: ["ok"] } };
  const built = buildJiraCreateBody(good); assert.ok(built.preview.kind === "ready");
  assert.equal(built.preview.bodyDigest, createHash("sha256").update(built.body).digest("hex"));
  for (const sources of [null, {}, { mappedFields: {}, generatedFields: {}, extra: true }, { mappedFields: null, generatedFields: {} }, { mappedFields: {}, generatedFields: null }]) {
    assert.equal(buildJiraCreateBody(input(), sources as never).preview.kind, "refused");
  }
  for (const source of [{ project: null }, { project: { id: "DEMO" } }, { project: { key: "OTHER" } }, { issuetype: null }, { issuetype: { id: "1" } }, { issuetype: { name: "Bug" } }]) {
    const result = buildJiraCreateBody({ ...input(), mappedFields: source }).preview;
    assert.ok(result.kind === "refused"); assert.equal(result.code, "scope_mismatch");
  }
  for (const field of [
    { id: "f", name: "F", type: "string", required: false, referenceBy: ["id"] },
    ...[[], ["id", "id"], ["accountId"], ["id", "name", "value", "id"], Array(1), "id"].map(referenceBy => ({ id: "f", name: "F", type: "option", required: false, referenceBy })),
  ]) assert.equal(previewJiraCreate({ ...input(), metadata: { ...input().metadata, fields: [field] } }).kind, "refused");
  for (const [type, forms] of [["option", ["id", "name", "value"]], ["user", ["accountId"]]] as const) {
    for (const form of forms) {
      const value = { [form]: "one" };
      const result = previewJiraCreate({ ...input(), metadata: { ...input().metadata, fields: [{ id: "f", name: "F", type, required: true, allowedValues: [value] }] }, answers: { f: value } });
      assert.equal(result.kind, "ready");
    }
  }
  const aliases = { ...input(), metadata: { ...input().metadata, fields: [{ id: "f", name: "F", type: "option", required: true, allowedValues: [{ id: "1", name: "One" }] }] } };
  assert.equal(previewJiraCreate({ ...aliases, answers: { f: { id: "1", name: "One" } } }).kind, "ready");
  assert.equal(previewJiraCreate({ ...aliases, answers: { f: { id: "1", name: "Other" } } }).kind, "incomplete");
  // A guard remains a guard even if the selected plan happens to contain updates only.
  const updates = buildExportPlan([{ title: "Old", description: "Jira DEMO-1: https://example.invalid/browse/DEMO-1" }], "https://example.invalid", { projectKey: "DEMO" });
  let requests = 0; const deps = { post: async () => { requests++; return "{}"; }, put: async () => { requests++; return "{}"; } };
  await assert.rejects(runExportPush(updates, { authHeader: "synthetic", updateExisting: true, createContract: {} }, deps), error => isPmCliExpectedError(error) && error.code === "invalid_input");
  assert.equal(requests, 0);
  assert.equal((await runExportPush(updates, { authHeader: "synthetic", updateExisting: true, createContract: input() }, deps)).updated, 1);
});
