/** Independent refuse/allow corpora separate CLI values from metadata-driven create payloads. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { generate } from "selfsigned";
import { PmClient, isPmCliExpectedError, listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildExportPlan, previewJiraCreate, readPmItems, runExportPush } from "../index.ts";
import type { JiraCreateField, JiraCreateMetadata, JiraCreateValue } from "../index.ts";

const ABSENT: unique symbol = Symbol("absent");
const EMPTY: readonly (JiraCreateValue | typeof ABSENT)[] = [ABSENT, undefined, null, [], "", "   ", "\r\n"];

/** A simple independent schema oracle accepts only meaningful, correctly typed emitted values. */
function accepts(field: JiraCreateField, value: unknown): boolean {
  if (value === undefined) return !field.required;
  if (value === null || value === "" || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0)) return false;
  const objectIdentity = (candidate: unknown, key: string): boolean => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    return Object.keys(record).length === 1 && typeof record[key] === "string" && record[key].trim().length > 0;
  };
  let shape: boolean;
  switch (field.type) {
    case "string": shape = typeof value === "string"; break;
    case "number": shape = typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12; break;
    case "boolean": shape = typeof value === "boolean"; break;
    case "option": shape = objectIdentity(value, "id"); break;
    case "user": shape = objectIdentity(value, "accountId"); break;
    default:
      shape = Array.isArray(value) && value.every(entry => field.type === "strings" ? typeof entry === "string" && entry.trim().length > 0 :
        objectIdentity(entry, field.type === "users" ? "accountId" : "id"));
  }
  const entries = Array.isArray(value) ? value : [value];
  return shape && (field.allowedValues === undefined || entries.every(entry => field.allowedValues!.some(choice => JSON.stringify(choice) === JSON.stringify(entry))));
}

/** A deterministic generator provides replayable metadata, required flags, values and CLI variations. */
function random(seed: number): () => number {
  let state = seed;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

/** The shape boundary permits empty payload inputs while metadata decides whether they are complete. */
test("payload empties follow required flags, with exact option/user choices and meaningful zero/false", () => {
  const shapes: { type: JiraCreateField["type"]; value: JiraCreateValue; choices?: JiraCreateField["allowedValues"] }[] = [
    { type: "string", value: "  retained text  ", choices: ["  retained text  "] },
    { type: "number", value: 0, choices: [0] }, { type: "boolean", value: false, choices: [false] },
    { type: "strings", value: ["tag"], choices: ["tag"] },
    { type: "options", value: [{ id: "1" }], choices: [{ id: "1" }] },
    { type: "option", value: { id: "1" }, choices: [{ id: "1" }] },
    { type: "user", value: { accountId: "user-1" }, choices: [{ accountId: "user-1" }] },
    { type: "users", value: [{ accountId: "user-1" }], choices: [{ accountId: "user-1" }] },
  ];
  for (const shape of shapes) for (const required of [true, false]) {
    const metadata = { version: 1, revision: "r1", project: "DEMO", issueType: "Task", fields: [
      { id: "field", name: "Any field name", required, type: shape.type, allowedValues: shape.choices },
    ] };
    for (const value of EMPTY) {
      const result = previewJiraCreate({ metadata, project: "DEMO", issueType: "Task", answers: value === ABSENT ? {} : { field: value } });
      assert.equal(result.kind, required ? "incomplete" : "ready", `${shape.type}:${required}:${String(value)}`);
      if (required) { assert.ok(result.kind === "incomplete"); assert.equal(result.counts.missing, 1); }
    }
    assert.equal(previewJiraCreate({ metadata, project: "DEMO", issueType: "Task", answers: { field: shape.value } }).kind, "ready");
  }
  for (const [type, value] of [["user", { accountId: "other" }], ["users", [{ accountId: "other" }]], ["user", { id: "user-1" }]] as const) {
    const result = previewJiraCreate({ metadata: { version: 1, revision: "r1", project: "DEMO", issueType: "Task", fields: [
      { id: "field", name: "User", required: false, type, allowedValues: [{ accountId: "user-1" }] },
    ] }, project: "DEMO", issueType: "Task", answers: { field: value } });
    assert.equal(result.kind, "incomplete");
  }
  for (const required of [false, true]) {
    const result = previewJiraCreate({ metadata: { version: 1, revision: "r1", project: "DEMO", issueType: "Task", fields: [
      { id: "field", name: "No choices", type: "option", required, allowedValues: [] },
    ] }, project: "DEMO", issueType: "Task", answers: { field: null } });
    assert.equal(result.kind, required ? "incomplete" : "ready");
  }
  const users = { version: 1, revision: "r1", project: "DEMO", issueType: "Task", fields: [{ id: "field", name: "Users", required: false, type: "users" }] };
  assert.equal(previewJiraCreate({ metadata: users, project: "DEMO", issueType: "Task", answers: { field: [{ accountId: "one" }] } }).kind, "ready");
  for (const answers of [{ field: { accountId: "" } }, { field: { accountId: "one", extra: true } }]) {
    assert.equal(previewJiraCreate({ metadata: users, project: "DEMO", issueType: "Task", answers }).kind, "refused");
  }
});

test("seed 0x454d5054: MUST-ALLOW optional empties and MUST-REFUSE required empties / CLI blanks", async t => {
  const root = mkdtempSync(join(tmpdir(), "jira-payload-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  execFileSync(process.execPath, [cli, "--path", root, "init", "fixture"], { stdio: "pipe", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
  const client = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: "payload-fixture" });
  await client.create({ title: "Untagged fixture", type: "Task", status: "open" });
  const readback = async () => (await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true })).items;
  const before = await readback(); const items = await readPmItems(root);
  const { cert, private: key } = await generate([{ name: "commonName", value: "localhost" }], { keyType: "ec", algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }] });
  const previousCa = https.globalAgent.options.ca; https.globalAgent.options.ca = cert; t.after(() => { https.globalAgent.options.ca = previousCa; });
  let current: JiraCreateMetadata;
  const posts: { fields: Record<string, unknown>; accepted: boolean }[] = [];
  const methods: string[] = [];
  const server = https.createServer({ key, cert }, (request, response) => {
    methods.push(request.method!); let body = ""; request.on("data", data => { body += String(data); });
    request.on("end", () => {
      const payload = JSON.parse(body) as { fields: Record<string, unknown> };
      const accepted = current.fields.every(field => accepts(field, payload.fields[field.id]));
      posts.push({ fields: payload.fields, accepted }); response.setHeader("Content-Type", "application/json"); response.setHeader("Connection", "close");
      response.statusCode = accepted ? 201 : 400; response.end(JSON.stringify(accepted ? { key: "DEMO-99" } : { errorMessages: ["schema refusal"] }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(async () => { server.closeAllConnections(); server.close(); await once(server, "close"); });
  const address = server.address(); assert.ok(address && typeof address === "object"); const host = `https://127.0.0.1:${address.port}`;
  const saved = { JIRA_EMAIL: process.env.JIRA_EMAIL, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  process.env.JIRA_EMAIL = "fixture@example.invalid"; process.env.JIRA_API_TOKEN = "synthetic";
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  t.mock.method(console, "error", () => {});
  const harness = await createExtensionTestHarness(extension, { name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"] });
  const contractFile = join(root, "create.json");
  const intent = (metadata: JiraCreateMetadata, answers: Record<string, JiraCreateValue> = {}) => ({ metadata, project: "DEMO", issueType: "Task", answers });
  const base = (): JiraCreateMetadata => ({ version: 1, revision: "fixed", project: "DEMO", issueType: "Task", fields: [
    { id: "summary", name: "Summary", required: true, type: "string" }, { id: "labels", name: "Labels", required: false, type: "strings" },
  ] });
  current = base(); writeFileSync(contractFile, JSON.stringify(intent(current)));
  // Fixed MUST-ALLOW review case uses the actual exporter's labels: [], with no tags.
  const fixedStart = posts.length;
  try {
    const fixed = await harness.runExporter({ exporter: "jira", pmRoot: root, options: { host, project: "DEMO", push: true, "create-contract": contractFile } });
    assert.equal((fixed.result as { created: number }).created, 1); assert.equal(posts.length, fixedStart + 1);
    assert.equal(Object.hasOwn(posts.at(-1)!.fields, "labels"), false); assert.ok(posts.at(-1)!.accepted);
  } finally { t.diagnostic(`fixed optional-labels MUST-ALLOW POSTs: ${posts.length - fixedStart}`); }
  const fixedMethods = methods.length;
  await assert.rejects(harness.runExporter({ exporter: "jira", pmRoot: root, options: { host, project: "DEMO", push: true, "create-contract": " " } }), error => isPmCliExpectedError(error) && error.exitCode === 2 && error.code === "invalid_option");
  assert.equal(methods.length, fixedMethods);
  const next = random(0x454d5054);
  const schemas: { field: JiraCreateField; valid: JiraCreateValue }[] = [
    { field: { id: "customfield_text", name: "Text", required: false, type: "string" }, valid: "  retained payload  " },
    { field: { id: "customfield_score", name: "Score", required: false, type: "number", allowedValues: [0, 2] }, valid: 0 },
    { field: { id: "customfield_flag", name: "Flag", required: false, type: "boolean" }, valid: false },
    { field: { id: "labels", name: "Labels", required: false, type: "strings", allowedValues: ["green"] }, valid: ["green"] },
    { field: { id: "components", name: "Components", required: false, type: "options", allowedValues: [{ id: "10" }] }, valid: [{ id: "10" }] },
    { field: { id: "versions", name: "Versions", required: false, type: "options", allowedValues: [{ id: "20" }] }, valid: [{ id: "20" }] },
    { field: { id: "customfield_choice", name: "Choice", required: false, type: "option", allowedValues: [{ id: "30" }] }, valid: { id: "30" } },
    { field: { id: "assignee", name: "Person", required: false, type: "user", allowedValues: [{ accountId: "user-1" }] }, valid: { accountId: "user-1" } },
    { field: { id: "customfield_users", name: "People", required: false, type: "users", allowedValues: [{ accountId: "user-1" }] }, valid: [{ accountId: "user-1" }] },
  ];
  let allowed = 0; let refusedRequired = 0; let refusedOptions = 0;
  const roles = new Set<string>(); const emptyCoverage = new Set<string>();
  for (let sequence = 0; sequence < 512; sequence++) {
    const metadata = base(); metadata.revision = `seed-${sequence}`;
    metadata.fields = [metadata.fields[0]!, ...schemas.map(({ field }) => ({ ...field, required: Boolean(next() & 1) }))];
    const payload = buildExportPlan(items, host, { projectKey: "DEMO" });
    const emptyIds: string[] = [];
    const optional: Record<string, JiraCreateValue> = {};
    for (const { field, valid } of schemas) {
      const definition = metadata.fields.find(row => row.id === field.id)!; roles.add(`${field.id}:${definition.required}`);
      const value = definition.required ? valid : EMPTY[next() % EMPTY.length]!;
      const fields = payload.entries[0]!.payload.fields as unknown as Record<string, unknown>;
      if (value === ABSENT) delete fields[field.id]; else fields[field.id] = value;
      if (!definition.required) { emptyIds.push(field.id); emptyCoverage.add(`${field.type}:${value === ABSENT ? "absent" : JSON.stringify(value)}`); }
      const optionalValue = EMPTY[next() % EMPTY.length]!; if (optionalValue !== ABSENT) optional[field.id] = optionalValue;
    }
    current = metadata; let count = posts.length;
    const good = await runExportPush(payload, { authHeader: "synthetic", updateExisting: false, createContract: intent(metadata) });
    assert.equal(good.created, 1); assert.equal(posts.length, count + 1); allowed++;
    for (const id of emptyIds) assert.equal(Object.hasOwn(posts.at(-1)!.fields, id), false);
    for (const { field, valid } of schemas) if (metadata.fields.find(row => row.id === field.id)!.required) assert.deepEqual(posts.at(-1)!.fields[field.id], valid);
    // Each schema becomes required independently of its field name.
    const badMetadata = structuredClone(metadata); const chosen = next() % schemas.length; const field = badMetadata.fields[chosen + 1]!; field.required = true;
    const badPlan = structuredClone(payload); const missing = EMPTY[next() % EMPTY.length]!;
    const badFields = badPlan.entries[0]!.payload.fields as unknown as Record<string, unknown>;
    if (missing === ABSENT) delete badFields[field.id]; else badFields[field.id] = missing;
    count = methods.length; current = badMetadata;
    await assert.rejects(runExportPush(badPlan, { authHeader: "synthetic", updateExisting: false, createContract: intent(badMetadata) }), error => isPmCliExpectedError(error) && error.exitCode === 2);
    assert.equal(methods.length, count); refusedRequired++;
    // CLI blanks remain refused even though empty values inside JSON are valid payload input.
    const blank = ["", "   ", "\t", "\r\n"][next() % 4]!;
    const key = ["create-contract", "project", "host", "field-map"][next() % 4]!;
    count = methods.length;
    await assert.rejects(harness.runExporter({ exporter: "jira", pmRoot: root, options: { host, project: "DEMO", push: true, "create-contract": contractFile, [key]: blank } }), error => isPmCliExpectedError(error) && error.exitCode === 2 && error.code === "invalid_option");
    assert.equal(methods.length, count); refusedOptions++;
    current = { ...metadata, fields: metadata.fields.map((row, index) => index === 0 ? row : { ...row, required: false }) };
    writeFileSync(contractFile, JSON.stringify(intent(current, optional)));
    count = posts.length;
    const validCLI = await harness.runExporter({ exporter: "jira", pmRoot: root, options: { host: ` ${host} `, project: " DEMO ", push: true, "create-contract": contractFile } });
    assert.equal((validCLI.result as { created: number }).created, 1); assert.equal(posts.length, count + 1); allowed++;
    for (const { field } of schemas) assert.equal(Object.hasOwn(posts.at(-1)!.fields, field.id), false);
  }
  assert.equal(roles.size, schemas.length * 2); assert.equal(emptyCoverage.size, 8 * EMPTY.length);
  assert.equal(allowed, 1024); assert.equal(refusedRequired, 512); assert.equal(refusedOptions, 512);
  assert.ok(posts.every(post => post.accepted)); assert.ok(methods.every(method => method === "POST"));
  assert.deepEqual(await readback(), before);
  t.diagnostic(`512 seeded metadata sequences; ${allowed} MUST-ALLOW POSTs plus fixed optional labels; ${refusedRequired} required-empty and ${refusedOptions} CLI-blank MUST-REFUSE cases; all posted bodies schema-accepted; SDK state unchanged`);
});
