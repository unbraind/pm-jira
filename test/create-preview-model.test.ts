/** Seeded model-based state preservation across create previews and existing import/export paths. */
import https from "node:https";
import { once } from "node:events";
import { generate } from "selfsigned";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PmClient, listAllComplete } from "@unbrained/pm-cli/sdk";
import { buildExportPlan, previewJiraCreate, readPmItems, runExportPush, runImport } from "../index.ts";
import type { JiraIssue } from "../index.ts";

/** Deterministic generator keeps every failure exactly replayable. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 8; };
}
/** Read the complete native field state through the SDK; timestamps are independent clocks. */
async function state(root: string) {
  const result = await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true });
  return result.items.map(({ created_at: _created, updated_at: _updated, ...item }) => ({ ...item,
    ...(item.dependencies ? { dependencies: item.dependencies.map(({ created_at: _clock, ...edge }) => edge) } : {})
  })).sort((a, b) => a.id.localeCompare(b.id));
}

test("seed 0x4a495241: 500 random operation sequences compare SDK readback with a separate SDK reference tracker", async t => {
  const base = await mkdtemp(join(tmpdir(), "create-model-")); t.after(() => rm(base, { recursive: true, force: true }));
  const roots = [join(base, "actual"), join(base, "reference")];
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  for (const root of roots) execFileSync(process.execPath, [cli, "--path", root, "init", "fixture"], {
    stdio: "pipe", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(base) },
  });
  const clients = roots.map(root => new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: "model-fixture" }));
  const rand = random(0x4a495241);
  const credentials = { JIRA_EMAIL: process.env.JIRA_EMAIL, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  process.env.JIRA_EMAIL = "fixture@example.invalid"; process.env.JIRA_API_TOKEN = "synthetic";
  const originalCa = https.globalAgent.options.ca;
  t.after(() => { https.globalAgent.options.ca = originalCa; for (const [key, value] of Object.entries(credentials)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const { cert, private: key } = await generate([{ name: "commonName", value: "localhost" }], {
    keyType: "ec", algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
  });
  https.globalAgent.options.ca = cert;
  let served: JiraIssue[] = [];
  const server = https.createServer({ key, cert }, (request, response) => {
    assert.equal(request.method, "GET"); response.setHeader("Content-Type", "application/json");
    response.setHeader("Connection", "close"); response.end(JSON.stringify({ isLast: true, issues: served }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, "close"); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const host = `https://127.0.0.1:${address.port}`;
  const ext = await createExtensionTestHarness(extension, { name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"] });
  const paths = ["direct", "sync", "jira", "jira-sync"];
  const visited = new Set<string>();
  const importing = async (path: string, issues: JiraIssue[], atomic: boolean) => {
    served = issues; visited.add(`${path}:${atomic}`);
    if (path === "direct") return runImport({ project: "DEMO", host }, roots[0]!, { atomic, issues });
    const options = { project: "DEMO", host, atomic };
    const result = path === "sync" ? await ext.runCommand({ command: "jira sync", pmRoot: roots[0]!, options }) :
      await ext.runImporter({ importer: path, pmRoot: roots[0]!, options });
    if (result.exitCode !== undefined) throw new Error(result.errorMessage ?? "unexpected import refusal"); return result.result;
  };
  // Random status names carry SDK-defined roles. Create previews never filter statuses.
  const statuses = ["open"];
  for (let i = 0; i < 4; i++) {
    const name = `custom_${rand()}`; statuses.push(name);
    for (const client of clients) await client.schemaAddStatus(name, { role: [i % 2 ? "blocked" : "active"] });
  }
  for (const client of clients) {
    await client.create({ id: "model-parent", title: "Parent", type: "Epic", status: "open" });
    for (let i = 0; i < 4; i++) await client.create({ id: `model-${i}`, title: `Native ${i}`, type: "Task", status: statuses[i],
      parent: "fixture-model-parent", body: " body\r\nwith whitespace ", description: `Jira DEMO-${i + 1}: ${host}/browse/DEMO-${i + 1}`,
      tags: "one,two", priority: i + 1, deadline: "2026-12-01", dep: ["id=fixture-model-parent,kind=related"] });
  }
  const nativeIds = (await state(roots[0]!)).filter(row => row.type === "Task").map(row => row.id);
  t.mock.method(console, "error", () => {});
  for (const path of paths) for (const atomic of [false, true]) {
    const number = 100 + nativeIds.length;
    const issue: JiraIssue = { key: `DEMO-${number}`, fields: { summary: ` Fresh ${number} `,
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body\r\nline" }] }] },
      status: { name: "Custom server state", statusCategory: { key: "new" } }, priority: { name: "High" },
      labels: ["first", "second"], issuetype: { name: "Task" }, duedate: "2026-12-01",
      components: [{ name: "core" }], fixVersions: [{ name: "v1" }], customfield_10020: [{ name: "s1" }],
      assignee: { displayName: "Fixture", emailAddress: "fixture@example.invalid" },
    } };
    const imported = await importing(path, [issue], atomic) as { imported: number }; assert.equal(imported.imported, 1);
    const actual = (await state(roots[0]!)).find(item => item.description?.includes(`Jira DEMO-${number}:`)); assert.ok(actual);
    await clients[1]!.create({ author: atomic && path !== "jira-sync" ? "pm-jira" : "harness:codex", id: actual.id, title: `[DEMO-${number}] ${issue.fields.summary}`, body: "Body\r\nline",
      description: `Jira DEMO-${number}: ${host}/browse/DEMO-${number}`, status: "open", priority: 2,
      type: "Task", deadline: "2026-12-01", tags: "first,second,v1,component:core,sprint:s1,assignee:Fixture" });
    nativeIds.push(actual.id);
  }
  const originals: JiraIssue[] = nativeIds.map((_, i) => ({ key: `DEMO-${i < 4 ? i + 1 : 100 + i}`, fields: {
    summary: ` Old summary ${i}\r\n `, status: { name: "Random Jira state", statusCategory: { key: "new" } },
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: " older\r\nbody " }] }] },
    labels: [" older "], priority: { name: "High" }, issuetype: { name: "Bug" }, duedate: "2026-12-02",
    components: [{ name: "legacy" }], fixVersions: [{ name: "old" }], customfield_10020: [{ name: "old" }],
    assignee: { displayName: "Fixture", emailAddress: "fixture@example.invalid" }, attachment: [{}], comment: { total: 1 },
  } }));
  let posts = 0; let refusedReplays = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    const index = rand() % nativeIds.length; const id = nativeIds[index]!;
    // Each sequence has an edit, older-input replay, export and guarded create preview.
    const options = { title: `Native ${sequence} ${rand()}`, body: `  body ${rand()}\r\nline\n `,
      tags: `tag-${rand() % 9},shared`, priority: rand() % 5, deadline: `2026-12-${String(1 + rand() % 28).padStart(2, "0")}`,
      status: statuses[rand() % statuses.length] };
    for (const client of clients) await client.update(id, options);
    const before = await state(roots[0]!);
    const path = paths[rand() % paths.length]!; const atomic = Boolean(rand() % 2);
    try {
      const imported = await importing(path, [originals[index]!], atomic) as { imported: number };
      assert.equal(imported.imported, 0, `sequence ${sequence}: replay preserves local revisions`);
    } catch (error) {
      // Existing atomic imports key a journal by issue keys. Different older
      // content must refuse rather than replay that frozen plan or mutate data.
      assert.ok(atomic && path !== "jira-sync");
      assert.match(String(error), /journal does not match the supplied plan/); refusedReplays++;
    }
    const items = await readPmItems(roots[0]!);
    const plan = buildExportPlan(items, "https://example.invalid", { projectKey: "DEMO", richMapping: Boolean(rand() % 2) });
    assert.equal(plan.entries.length, 13);
    const input = { metadata: { version: 1, revision: `r-${sequence}`, project: "DEMO", issueType: "Task", fields: [
      { id: "customfield_1", name: "Team", required: true, type: "option", allowedValues: [{ id: "1" }] },
    ] }, project: "DEMO", issueType: "Task", answers: {}, budget: 4096 };
    assert.equal(previewJiraCreate(input).kind, "incomplete");
    const creates = buildExportPlan([{ title: String(items[index]?.title), body: items[index]?.body }], "https://example.invalid", { projectKey: "DEMO" });
    await assert.rejects(runExportPush(creates, { authHeader: "synthetic", updateExisting: false, createContract: input }, {
      post: async () => { posts++; return "{}"; }, put: async () => { throw new Error("unexpected PUT"); },
    }));
    assert.deepEqual(await state(roots[0]!), before, `sequence ${sequence}: read/export paths preserve all native fields and relationships`);
    assert.deepEqual(await state(roots[0]!), await state(roots[1]!), `sequence ${sequence}: SDK reference model`);
  }
  assert.equal(posts, 0);
  t.diagnostic(`500 sequences, 2000 operations, ${refusedReplays} safely refused older atomic replays`);
  assert.ok(refusedReplays > 0);
  assert.equal(visited.size, 8, "all import/sync entrypoints and atomic selections were exercised");
});
