/** Target identity is invariant under every contract/native field overlay and published entry point. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import https from "node:https";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { generate } from "selfsigned";
import { PmClient, listAllComplete, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildExportPlan, buildJiraCreateBody, previewJiraCreate, previewJiraExport, runExportPush } from "../index.ts";
import { createPreviewRefusal } from "../create-preview.ts";
import type { JiraCreatePreviewInput, JiraCreateSources, JiraCreateRefusal } from "../index.ts";

/** Explicit scope has no defaults or inferred identity. */
function contract(project = "DEMO", issueType = "Task"): JiraCreatePreviewInput {
  return { metadata: { version: 1, revision: "scope-1", project, issueType, fields: [{ id: "summary", name: "Summary", required: true, type: "string" }] },
    project, issueType, answers: { summary: "Explicit" } };
}

/** Reproducible whole-layer corpus includes hidden lower-layer mismatches and malformed identities. */
test("scope identity cannot be repaired or redirected by any later field layer", async () => {
  const native = (): JiraCreateSources => ({ generatedFields: {}, mappedFields: {} });
  let cases = 0;
  for (const key of ["project", "issuetype"] as const) {
    const correct = key === "project" ? { key: "DEMO" } : { name: "Task" };
    const wrong = key === "project" ? { key: "OTHER" } : { name: "Bug" };
    const variants: unknown[] = [wrong, undefined, null, "", " ", [], {}, { id: "1" }, { ...correct, extra: true }];
    // All five layers, including answers; higher layers must never conceal lower mismatches.
    for (let layer = 0; layer < 5; layer++) for (const value of variants) {
      const input = contract(); const sources = native();
      input.generatedFields = {}; input.mappedFields = {};
      const layers = [input.generatedFields, sources.generatedFields, sources.mappedFields, input.mappedFields, input.answers];
      for (let later = layer + 1; later < 4; later++) layers[later]![key] = correct;
      layers[layer]![key] = value;
      const built = buildJiraCreateBody(input, sources);
      assert.equal(built.preview.kind, "refused", `hidden mismatch ${key} layer ${layer}`);
      assert.equal(built.body, ""); assert.deepEqual(built.bindings, {}); cases++;
    }
  }
  // The concrete review case: authoritative OTHER/Bug cannot become DEMO/Task.
  const plan = buildExportPlan([{ title: "Item", type: "Bug" }], "https://example.invalid", { projectKey: "OTHER", richMapping: true });
  const input = contract(); input.mappedFields = { project: { key: "DEMO" }, issuetype: { name: "Task" } };
  const preview = previewJiraExport(plan, input)[0]!;
  assert.ok(preview.kind === "refused"); assert.equal(preview.code, "scope_mismatch");
  let calls = 0;
  await assert.rejects(runExportPush(plan, { authHeader: "synthetic", updateExisting: false, createContract: input }, {
    post: async () => { calls++; return "{}"; }, put: async () => { calls++; return "{}"; },
  }), error => isPmCliExpectedError(error) && error.code === preview.code && error.message === preview.remediation);
  assert.equal(calls, 0); assert.equal(cases, 90);
});


/** Every refusal variant preserves the command's declared diagnostic collection and bounded envelope. */
test("every create refusal fulfills the same row contract as ready/incomplete results", () => {
  const codes: Record<JiraCreateRefusal["code"], true> = { invalid_input: true, input_read: true, scope_mismatch: true, budget_too_small: true };
  for (const code of Object.keys(codes) as JiraCreateRefusal["code"][]) {
    const refusal = createPreviewRefusal(code);
    assert.deepEqual(refusal.diagnostics, []); assert.equal(refusal.code, code); assert.equal(refusal.exit_code, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(refusal, null, 2)) + 1 < 1024);
  }
});

test("seed 0x53434f50: scope mismatches never reach recording Jira; matching scopes preserve digests", async t => {
  const root = mkdtempSync(join(tmpdir(), "jira-scope-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const childEnv = { ...process.env, HOME: join(root, "home"), GIT_CEILING_DIRECTORIES: dirname(root), JIRA_EMAIL: "fixture@example.invalid", JIRA_API_TOKEN: "synthetic" };
  execFileSync(process.execPath, [cli, "--path", root, "init", "fixture"], { env: childEnv, stdio: "pipe" });
  const client = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: "scope-fixture" });
  await client.create({ title: "Fixture", type: "Bug", status: "open" });
  const before = (await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true })).items;
  const { cert, private: key } = await generate([{ name: "commonName", value: "localhost" }], { keyType: "ec", algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }] });
  const previousCa = https.globalAgent.options.ca; https.globalAgent.options.ca = cert; t.after(() => { https.globalAgent.options.ca = previousCa; });
  const calls: string[] = []; const bodies: string[] = [];
  const server = https.createServer({ cert, key }, (request, response) => {
    calls.push(request.method!); let body = ""; request.on("data", data => { body += String(data); }); request.on("end", () => {
      bodies.push(body); response.statusCode = 201; response.setHeader("Connection", "close"); response.end('{"key":"DEMO-1"}');
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(async () => { server.closeAllConnections(); server.close(); await once(server, "close"); });
  const address = server.address(); assert.ok(address && typeof address === "object"); const host = `https://127.0.0.1:${address.port}`;
  let seed = 0x53434f50; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const covered = new Set<string>();
  for (let sequence = 0; sequence < 512; sequence++) {
    const input = contract(`P${next()}`, `Type${next()}`);
    const projectMismatch = Boolean(next() & 1); const typeMismatch = !projectMismatch || Boolean(next() & 1);
    const plan = buildExportPlan([{ title: "Mapped" }], host, { projectKey: projectMismatch ? `OTHER${sequence}` : input.project });
    plan.entries[0]!.payload.fields.issuetype.name = typeMismatch ? `Other${sequence}` : input.issueType;
    const layer = next() & 1 ? "mappedFields" : "generatedFields";
    input[layer] = { project: { key: input.project }, issuetype: { name: input.issueType } };
    covered.add(`${projectMismatch}:${typeMismatch}:${layer}`);
    const preview = previewJiraExport(plan, input)[0]!;
    assert.ok(preview.kind === "refused"); assert.equal(preview.code, "scope_mismatch");
    const prior = calls.length;
    await assert.rejects(runExportPush(plan, { authHeader: "synthetic", updateExisting: false, createContract: input }), error => isPmCliExpectedError(error) && error.code === preview.code && error.message === preview.remediation);
    assert.equal(calls.length, prior);
    plan.entries[0]!.payload.fields.project = { key: input.project }; plan.entries[0]!.payload.fields.issuetype = { name: input.issueType };
    const ready = previewJiraExport(plan, input)[0]!; assert.ok(ready.kind === "ready");
    assert.equal((await runExportPush(plan, { authHeader: "synthetic", updateExisting: false, createContract: input })).created, 1);
    assert.equal(calls.length, prior + 1); assert.equal(createHash("sha256").update(bodies.at(-1)!).digest("hex"), ready.bodyDigest);
    const body = JSON.parse(bodies.at(-1)!) as { fields: Record<string, unknown> };
    assert.deepEqual(body.fields.project, { key: input.project }); assert.deepEqual(body.fields.issuetype, { name: input.issueType });
  }
  assert.equal(covered.size, 6);
  const file = join(root, "create.json"); const input = contract(); input.mappedFields = { project: { key: "DEMO" }, issuetype: { name: "Task" } };
  writeFileSync(file, JSON.stringify(input));
  const saved = { JIRA_EMAIL: process.env.JIRA_EMAIL, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  process.env.JIRA_EMAIL = "fixture@example.invalid"; process.env.JIRA_API_TOKEN = "synthetic";
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const harness = await createExtensionTestHarness(extension, { name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"] });
  const prior = calls.length;
  await assert.rejects(harness.runExporter({ exporter: "jira", pmRoot: root, options: { host, project: "OTHER", rich: true, push: true, "create-contract": file } }), error => isPmCliExpectedError(error) && error.code === "scope_mismatch");
  assert.equal(calls.length, prior);

  // Test the actual npm tarball with Node and native Bun, without an SDK mock or a git repository.
  const archiveDir = join(root, "archive"); mkdirSync(archiveDir);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", archiveDir], { encoding: "utf8" })) as { filename: string }[];
  const unpacked = join(root, "unpacked"); mkdirSync(unpacked); execFileSync("tar", ["-xzf", join(archiveDir, packed[0]!.filename), "-C", unpacked]);
  const pkg = join(unpacked, "package");
  const installation = spawnSync(process.execPath, [cli, "--path", root, "package", "install", pkg, "--project"], { env: childEnv, encoding: "utf8" });
  assert.equal(installation.status, 0, installation.stdout + installation.stderr);
  mkdirSync(join(pkg, "node_modules", "@unbrained"), { recursive: true });
  symlinkSync(resolve("node_modules/@unbrained/pm-cli"), join(pkg, "node_modules", "@unbrained", "pm-cli"), "dir");
  const consumer = join(pkg, "consumer.mjs");
  writeFileSync(consumer, `import assert from 'node:assert/strict'; import { buildExportPlan, previewJiraExport, runExportPush } from './dist/index.js';
const input = JSON.parse(process.argv[2]); const plan = buildExportPlan([{title:'Fixture',type:'Bug'}],process.argv[3],{projectKey:'OTHER',richMapping:true});
assert.equal(previewJiraExport(plan,input)[0].code,'scope_mismatch');
await assert.rejects(runExportPush(plan,{authHeader:'synthetic',updateExisting:false,createContract:input}),error=>error.code==='scope_mismatch');
console.log('packed scope refused');`);
  for (const runtime of [process.execPath, "bun"]) {
    const result = spawnSync(runtime, [consumer, JSON.stringify(input), host], { cwd: root, env: childEnv, encoding: "utf8" });
    if (runtime === "bun" && result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") { t.diagnostic("Bun unavailable: packed Node assertions still run; CI requires Bun"); continue; }
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /packed scope refused/);
  }
  const noGit = join(root, "no-git"); mkdirSync(noGit);
  for (const json of [true, false]) {
    const previewInput = contract(); previewInput.generatedFields = { project: { key: "OTHER" }, issuetype: { name: "Bug" } }; previewInput.mappedFields = input.mappedFields;
    writeFileSync(file, JSON.stringify(previewInput));
    const rendered = spawnSync(process.execPath, [cli, "--path", root, "jira", "preview-create", "--contract", file, ...(json ? ["--json"] : [])], { cwd: root, env: { ...childEnv, PATH: noGit }, encoding: "utf8" });
    assert.equal(rendered.status, 2, rendered.stdout + rendered.stderr); assert.match(rendered.stdout, /scope_mismatch/, rendered.stdout + rendered.stderr); assert.ok(Buffer.byteLength(rendered.stdout) < 4096);
    if (json) { const output = JSON.parse(rendered.stdout) as { code: string; posts: number }; assert.equal(output.code, "scope_mismatch"); assert.equal(output.posts, 0); }
    writeFileSync(file, JSON.stringify(input));
    const exported = spawnSync(process.execPath, [cli, "--path", root, "jira", "export", "--host", host, "--project", "OTHER", "--rich", "--push", "--create-contract", file, ...(json ? ["--json"] : [])], { cwd: root, env: { ...childEnv, PATH: noGit }, encoding: "utf8" });
    assert.equal(exported.status, 2, exported.stdout + exported.stderr); assert.match(exported.stdout + exported.stderr, /scope differs/);
  }
  assert.equal(calls.length, prior);
  assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true })).items, before);
  t.diagnostic("512 mismatched targets refused with zero HTTP; 512 matching digest-equal POSTs; 90 whole-layer cases; registered SDK, packed Node/Bun and installed JSON/TOON refusal paths; SDK state unchanged");
});
