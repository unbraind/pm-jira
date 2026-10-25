/** Compare a baseline build and this build using immutable public tracker snapshots and disposable non-git copies. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import https from "node:https";
import { generate } from "selfsigned";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { JiraIssue } from "../index.ts";

/** Read one public git tree into a scratch directory without touching the source checkout. */
async function snapshot(repository: string, ref: string, destination: string, trackerOnly = false): Promise<void> {
  await mkdir(destination, { recursive: true });
  const archive = execFileSync("git", ["-C", repository, "archive", ref, ...(trackerOnly ? [".agents/pm"] : [])], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", destination], { input: archive, stdio: ["pipe", "pipe", "pipe"] });
}

/** Keep only deterministic create fields; generated IDs and timestamps are deliberately excluded. */
function importedFields(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["title", "status", "type", "priority", "description", "body", "tags", "deadline", "author", "close_reason", "completed_at"]
    .map(key => [key, row[key]]));
}

const ref = process.env.PM_JIRA_BASELINE_REF || "origin/main";
const repositories = [process.cwd(), ...process.argv.slice(2).map(value => resolve(value))];
const scratch = await mkdtemp(join(tmpdir(), "jira-sdk-differential-"));
const baseline = join(scratch, "baseline");
const originalPath = process.env.PATH;
process.env.PATH = `${resolve("node_modules/.bin")}:${originalPath}`;
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const cases: { key: string; options: Record<string, unknown>; issues: JiraIssue[] }[] = [
  { key: "rich", options: {}, issues: [{ key: "SDKDIFF-1", fields: { summary: "SDK adoption fixture",
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Same body" }] }] },
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, priority: { name: "High" },
    labels: ["sdk", "fixture"], duedate: "2026-12-01" } }] },
  { key: "bare", options: {}, issues: [{ key: "SDKDIFF-2", fields: { summary: "Bare fixture",
    status: { name: "To Do", statusCategory: { key: "new" } } } }] },
  { key: "partial-failure", options: {}, issues: [
    { key: "SDKDIFF-3", fields: { summary: "Invalid date", duedate: "not-a-date", status: { name: "To Do", statusCategory: { key: "new" } } } },
    { key: "SDKDIFF-4", fields: { summary: "Still imported", status: { name: "To Do", statusCategory: { key: "new" } } } },
  ] },
  { key: "atomic", options: { atomic: true }, issues: [{ key: "SDKDIFF-5", fields: { summary: "Atomic stays atomic",
    status: { name: "To Do", statusCategory: { key: "new" } } } }] },
];
const { cert, private: key } = await generate([{ name: "commonName", value: "localhost" }], {
  keyType: "ec", algorithm: "sha256",
  extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
});
const previousCa = https.globalAgent.options.ca;
https.globalAgent.options.ca = cert;
let requests = 0;
const server = https.createServer({ key, cert }, (request, response) => {
  assert.equal(request.method, "GET", "import never creates a remote object");
  assert.ok(request.url?.startsWith("/rest/api/3/search/jql?"));
  requests++;
  response.setHeader("Connection", "close");
  response.end(JSON.stringify({ isLast: true, issues: cases[0]!.issues }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const host = `https://127.0.0.1:${address.port}`;
try {
  await snapshot(process.cwd(), ref, baseline);
  await symlink(resolve("node_modules"), join(baseline, "node_modules"), "dir");
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", baseline], { stdio: "pipe" });
  const before = await import(pathToFileURL(join(baseline, "dist/index.js")).href) as typeof import("../index.ts");
  const after = await import("../dist/index.js");
  let comparisons = 0;
  for (const [n, repository] of repositories.entries()) {
    const fixture = join(scratch, `fixture-${n}`);
    await snapshot(repository, ref, fixture, true);
    const fixtureRoot = join(fixture, ".agents/pm");
    // Snapshots stay unchanged. Each execution receives a fresh writable copy.
    const source = await listAllComplete({ includeBody: true }, { pmRoot: fixtureRoot, cwd: fixture, noExtensions: true });
    for (const scenario of cases) {
      const results: unknown[] = [];
      for (const [label, implementation] of [["before", before], ["after", after]] as const) {
        const working = join(scratch, `work-${n}-${scenario.key}-${label}`);
        await cp(fixture, working, { recursive: true });
        const root = join(working, ".agents/pm");
        const diagnostics: string[] = [];
        const previous = console.error;
        console.error = (...values: unknown[]) => { diagnostics.push(values.map(String).join(" ")); };
        try {
          const options = { project: "SDKDIFF", host: "https://example.invalid", ...scenario.options };
          const result = await implementation.runImport(options, root, { issues: scenario.issues });
          const retry = await implementation.runImport(options, root, { issues: scenario.issues });
          assert.ok("imported" in result && "imported" in retry);
          assert.equal(result.imported, 1);
          assert.equal(retry.imported, 0);
          const rows = await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: working, noExtensions: true });
          assert.equal(rows.items.length, source.items.length + 1);
          results.push({ result, retry, diagnostics, created: rows.items.filter(row => String(row.title).startsWith("[SDKDIFF-"))
            .map(importedFields).sort((a, b) => String(a.title).localeCompare(String(b.title))), total: rows.items.length });
        } finally { console.error = previous; }
      }
      assert.deepEqual(results[1], results[0], `${basename(repository)}: ${scenario.key}`);
      comparisons++;
    }
    // Exercise the affected command adapter too, without a network or a writable source fixture.
    for (const options of [{ project: "SDKDIFF", "dry-run": true }, { jql: "key = SDKDIFF-1", "dry-run": true }]) {
      const results: unknown[] = [];
      for (const implementation of [before, after]) {
        const harness = await createExtensionTestHarness(implementation.default, {
          name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
        });
        const previous = console.error;
        const diagnostics: string[] = [];
        console.error = (...values: unknown[]) => { diagnostics.push(values.map(String).join(" ")); };
        try {
          const answer = await harness.runCommand({ command: "jira sync", pmRoot: fixtureRoot, options });
          results.push({ result: answer.result, diagnostics });
        } finally { console.error = previous; }
      }
      assert.deepEqual(results[1], results[0]);
      comparisons++;
    }
    const legacy: unknown[] = [];
    for (const [label, implementation] of [["before", before], ["after", after]] as const) {
      const working = join(scratch, `work-${n}-legacy-${label}`);
      await cp(fixture, working, { recursive: true });
      const root = join(working, ".agents/pm");
      const harness = await createExtensionTestHarness(implementation.default, {
        name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
      });
      const options = { project: "SDKDIFF", JIRA_BASE_URL: host,
        JIRA_EMAIL: "fixture@example.invalid", JIRA_API_TOKEN: "synthetic" };
      const diagnostics: string[] = [];
      const previous = console.error;
      console.error = (...values: unknown[]) => { diagnostics.push(values.map(String).join(" ")); };
      try {
        const first = await harness.runImporter({ importer: "jira-sync", pmRoot: root, options });
        const retry = await harness.runImporter({ importer: "jira-sync", pmRoot: root, options });
        assert.deepEqual(first.result, { imported: 1, total: 1 });
        assert.deepEqual(retry.result, { imported: 0, total: 1 });
        const rows = await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: working, noExtensions: true });
        legacy.push({ first: first.result, retry: retry.result, diagnostics,
          created: rows.items.filter(row => String(row.title).startsWith("[SDKDIFF-")).map(importedFields) });
      } finally { console.error = previous; }
    }
    assert.deepEqual(legacy[1], legacy[0], "legacy importer through a real fake Jira server");
    comparisons++;
    console.log(`${basename(repository)}: ${source.items.length} public items; seven differential scenarios identical`);
  }
  for (const [name, run] of [
    ["map", (module: typeof before) => module.parseFieldMap("bad")],
    ["status-map", (module: typeof before) => module.parseStatusMap("bad")],
    ["missing-project", (module: typeof before) => module.runImport({}, scratch)],
  ] as const) {
    const errors: { message: string; exitCode: unknown; name: string }[] = [];
    for (const implementation of [before, after]) {
      try { await run(implementation); assert.fail("Expected rejection"); }
      catch (error) { assert.ok(error instanceof Error); errors.push({ message: error.message, exitCode: Reflect.get(error, "exitCode"), name: error.name }); }
    }
    assert.deepEqual({ ...errors[1], name: errors[0]!.name }, errors[0], name);
    assert.ok(["CommandError", "PmCliError"].includes(errors[0]!.name));
    assert.equal(errors[1]!.name, "PmCliError");
    comparisons++;
  }
  assert.equal(requests, repositories.length * 4);
  console.log(`PASS: ${comparisons} comparisons. Intentional difference: expected errors use SDK name PmCliError, unchanged message and exit code.`);
} finally {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
  https.globalAgent.options.ca = previousCa;
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  await rm(scratch, { recursive: true, force: true });
}
