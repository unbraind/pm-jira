/** Entire option-table properties use real SDK handlers and a recording TLS Jira fixture. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { generate } from "selfsigned";
import { PmClient, isPmCliExpectedError, listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { readStringOptionAliased, optionEnabled, runExportPush, buildExportPlan } from "../index.ts";
import { JIRA_OPTION_TABLE, parseJiraOptions } from "../option-boundary.ts";

/** Validate the stable SDK usage-error contract without matching a concrete Error class. */
function usage(error: unknown): boolean {
  assert.ok(isPmCliExpectedError(error)); assert.equal(error.exitCode, 2); assert.equal(error.code, "invalid_option");
  assert.match(error.context.recovery!.suggested_retry!, /Omit unused options/); return true;
}

test("one boundary rejects unusable bags/scalars, checks all aliases, snapshots values and enforces finite domains", () => {
  for (const input of [null, false, 0, "", [], new Date(), Object.create({ push: true }), { "": "x" }, { ["x".repeat(129)]: "x" }, { project: false }, { project: 12 }, { x: null }, { x: [] }, { x: Infinity }, { x: NaN },
    { x: "x".repeat(1048577) }, Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`f${i}`, "x"]))]) assert.throws(() => parseJiraOptions(input), usage);
  for (const value of [false, "bad", NaN, Infinity, -1, 0, 1.5, Number.MAX_VALUE]) assert.throws(() => parseJiraOptions({ "max-results": value }), usage);
  for (const value of [-1, 0.5, "Infinity", true]) assert.throws(() => parseJiraOptions({ offset: value }), usage);
  for (const value of [2, -1, "maybe", " "]) assert.throws(() => parseJiraOptions({ push: value }), usage);
  for (const value of [0, 1, false, true, "true", "false", "yes", "no", "0", "1"]) assert.doesNotThrow(() => parseJiraOptions({ push: value }));
  assert.deepEqual(parseJiraOptions({ offset: 0, limit: "1", maxResults: 50 }), { offset: 0, limit: 1, maxResults: 50 });
  const raw = { host: " https://example.invalid ", optional: undefined };
  const parsed = parseJiraOptions(raw); raw.host = " "; assert.equal(parsed.host, "https://example.invalid");
  assert.equal(parseJiraOptions(parsed), parsed); assert.ok(Object.isFrozen(parsed)); assert.equal(Object.hasOwn(parsed, "optional"), false);
  assert.deepEqual(parseJiraOptions(undefined), {});
  assert.deepEqual(parseJiraOptions(Object.create(null)), {});
  assert.throws(() => readStringOptionAliased({ project: "DEMO", projectKey: " " }, "project", "project-key"), usage);
  assert.throws(() => readStringOptionAliased({ "project-key": " ", projectKey: "DEMO" }, "project-key"), usage);
  assert.throws(() => optionEnabled({ push: true, dryRun: " " }, "push", "dry-run"), usage);
  assert.throws(() => parseJiraOptions({ "expected-revision": " " }), usage);
});

test("every command option: absent / empty / spaces / tab / CRLF / valid, with zero HTTP on blanks", async t => {
  const root = mkdtempSync(join(tmpdir(), "jira-options-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root), PM_AUTHOR: "option-fixture", HOME: join(root, "home") };
  execFileSync(process.execPath, [cli, "--path", root, "init", "fixture"], { env, stdio: "pipe" });
  const client = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: "option-fixture" });
  await client.create({ title: "Fixture", type: "Task", status: "open" });
  const before = (await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true })).items;
  const { cert, private: key } = await generate([{ name: "commonName", value: "localhost" }], { keyType: "ec", algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }] });
  const ca = https.globalAgent.options.ca; https.globalAgent.options.ca = cert; t.after(() => { https.globalAgent.options.ca = ca; });
  const calls: { method: string; url: string }[] = [];
  const status = (id: string, name: string, category: string) => ({ id, name, statusCategory: { key: category } });
  const server = https.createServer({ key, cert }, (request, response) => {
    calls.push({ method: request.method!, url: request.url! });
    response.setHeader("Content-Type", "application/json"); response.setHeader("Connection", "close");
    request.resume();
    if (request.method === "POST") { response.statusCode = 201; response.end(JSON.stringify({ id: "99", key: "DEMO-99" })); }
    else if (request.method === "PUT") { response.statusCode = 204; response.end(); }
    else if (request.url!.includes("/search/")) response.end(JSON.stringify({ isLast: true, issues: [] }));
    else if (request.url!.includes("/transitions")) response.end(JSON.stringify({ transitions: [{ id: "31", name: "Finish", to: status("2", "Done", "done"), fields: {} }] }));
    else response.end(JSON.stringify({ key: "DEMO-1", fields: { status: status("1", "Open", "new") } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, "close"); });
  const address = server.address(); assert.ok(address && typeof address === "object"); const host = `https://127.0.0.1:${address.port}`;
  const saved = { JIRA_BASE_URL: process.env.JIRA_BASE_URL, JIRA_EMAIL: process.env.JIRA_EMAIL, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  process.env.JIRA_BASE_URL = host; process.env.JIRA_EMAIL = "fixture@example.invalid"; process.env.JIRA_API_TOKEN = "synthetic";
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  t.mock.method(console, "error", () => {});
  const contract = join(root, "create.json"); const snapshot = join(root, "snapshot.json");
  writeFileSync(contract, JSON.stringify({ metadata: { version: 1, revision: "r1", project: "DEMO", issueType: "Task", fields: [{ id: "summary", name: "Summary", required: true, type: "string" }] }, project: "DEMO", issueType: "Task", answers: { summary: "Fixture" } }));
  writeFileSync(snapshot, JSON.stringify({ version: 1, site: "https://example.invalid", principal: "fixture", scope: "fixture", capturedAt: "2026-10-26T00:00:00.000Z", jql: "project = DEMO", pages: [{ keys: [], isLast: true }], visibility: [] }));
  const harness = await createExtensionTestHarness(extension, { name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"] });
  const registrations = harness.activation.registrations.flags;
  // Reconcile every value-bearing registration; config-only credential options
  // are explicitly inventoried because the legacy importer has no flag surface.
  for (const [command, fields] of Object.entries(JIRA_OPTION_TABLE)) {
    const registered = registrations.filter(row => row.target_command === command).flatMap(row => row.flags);
    if (command !== "jira-sync import") assert.deepEqual(registered.filter(row => row.value_name).map(row => row.long!.slice(2)).sort(), [...fields].sort(), command);
  }
  const valid: Record<string, string> = { project: "DEMO", "project-key": "DEMO", jql: "project = DEMO", host, "max-results": "2", status: "open", assignee: "currentUser()", "issue-type": "Task", label: "fixture", "updated-since": "-7d", "status-map": "Done=closed", map: "issuetype=Task", "field-map": "issuetype=Task", "create-contract": contract, issue: "DEMO-1", to: "closed", transition: "31", fields: "{}", before: snapshot, after: snapshot, limit: "2", offset: "0", contract, JIRA_BASE_URL: host, JIRA_EMAIL: "fixture@example.invalid", JIRA_API_TOKEN: "synthetic" };
  const invoke = async (command: string, options: Record<string, unknown>) => {
    if (command === "jira export") return harness.runExporter({ exporter: "jira", pmRoot: root, options });
    if (command.endsWith(" import")) return harness.runImporter({ importer: command.split(" ")[0]!, pmRoot: root, options });
    return harness.runCommand({ command, pmRoot: root, options });
  };
  const absent = Symbol("absent"); const blanks = ["", "   ", "\t", "\r\n"];
  let cases = 0; let blankCases = 0; let optionPairs = 0;
  // Fixed review case runs first so the behavioral revert fails for that case.
  const reviewCount = calls.length;
  try { await assert.rejects(invoke("jira export", { host, project: "DEMO", push: true, "create-contract": " " }), usage); }
  finally { t.diagnostic(`fixed review case HTTP calls: ${calls.length - reviewCount}`); }
  assert.equal(calls.length, 0);
  for (const [command, fields] of Object.entries(JIRA_OPTION_TABLE)) {
    const switches = registrations.filter(row => row.target_command === command).flatMap(row => row.flags).filter(flag => !flag.value_name).map(flag => flag.long!.slice(2));
    for (const field of [...fields, ...switches]) {
      optionPairs++;
      const camel = field.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      for (const spelling of new Set([field, camel])) for (const value of [absent, ...blanks, valid[field] ?? "true"]) {
        const options: Record<string, unknown> = { host, project: "DEMO" };
        if (command === "jira export") Object.assign(options, { push: true, "create-contract": contract });
        if (command === "jira plan-transition") Object.assign(options, { issue: "DEMO-1", to: "closed" });
        if (command === "jira explain-selection") Object.assign(options, { before: snapshot, after: snapshot });
        if (command === "jira preview-create") Object.assign(options, { contract });
        delete options[field]; delete options[camel];
        if (value !== absent) options[spelling] = value;
        const count: number = calls.length; cases++;
        if (typeof value === "string" && blanks.includes(value)) {
          blankCases++;
          try { const result = await invoke(command, options); assert.equal(result.exitCode, 2, `${command}:${spelling}`); assert.equal(result.errorCode, "invalid_option"); assert.match(result.errorMessage!, /Omit unused options/); }
          catch (error) { usage(error); }
          assert.equal(calls.length, count, `${command}:${spelling}: blank reached HTTP`);
        } else {
          try { const result = await invoke(command, options); assert.notEqual(result.errorCode, "invalid_option"); }
          catch (error) { assert.ok(isPmCliExpectedError(error)); assert.notEqual(error.code, "invalid_option"); assert.equal(value, absent, `${command}:${spelling}: ${String(error)}`); }
        }
      }
    }
  }
  const updated = await runExportPush(buildExportPlan([{ title: "Fixture", description: `Jira DEMO-2: ${host}/browse/DEMO-2` }], host, { projectKey: "DEMO" }), { authHeader: "synthetic", updateExisting: true });
  assert.equal(updated.updated, 1); assert.ok(calls.some(call => call.method === "PUT"));
  assert.ok(calls.some(call => call.method === "POST"), "valid/absent controls must reach the real fake Jira server");
  assert.ok(calls.some(call => call.method === "GET"));
  assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true })).items, before);
  // Installed CLI fixed case: parsing, preflight and handler all run without git.
  const pkg = join(root, "package"); mkdirSync(pkg); cpSync(resolve("dist"), join(pkg, "dist"), { recursive: true }); cpSync(resolve("manifest.json"), join(pkg, "manifest.json"));
  execFileSync(process.execPath, [cli, "--path", root, "package", "install", pkg, "--project"], { env, stdio: "pipe" });
  const certificate = join(root, "ca.pem"); writeFileSync(certificate, cert);
  const count = calls.length; const child = spawn(process.execPath, [cli, "--path", root, "jira", "export", "--project", "DEMO", "--host", host, "--create-contract", " ", "--push", "--json"], {
    cwd: root, env: { ...env, JIRA_BASE_URL: host, JIRA_EMAIL: "fixture@example.invalid", JIRA_API_TOKEN: "synthetic", NODE_EXTRA_CA_CERTS: certificate }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { output += String(data); });
  const [code] = await once(child, "close"); assert.equal(code, 2, output); assert.match(output, /invalid_option/); assert.match(output, /Omit unused options/); assert.equal(calls.length, count);
  t.diagnostic(`${Object.keys(JIRA_OPTION_TABLE).length} commands, ${optionPairs} option bindings, ${cases} cases, ${blankCases} blank cases, fixed SDK/CLI review cases; no blank reached HTTP`);
});
