/** Jira Cloud cursor contracts exercised through a real TLS server and PM store. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { generate } from "selfsigned";
import { runImport, type JiraIssue } from "../index.ts";

/** Minimal synthetic issues; no provider or hosted tenant data enters these tests. */
const issues: JiraIssue[] = ["ONE-1", "ONE-2"].map(key => ({
  key, fields: { summary: key, status: { name: "To Do", statusCategory: { key: "new" } } },
}));

test("Cloud dry-run uses enhanced search without an offset", async () => {
  const result = await runImport({ project: "ONE", host: "https://example.atlassian.net", "dry-run": true }, ".");
  assert.ok("request" in result);
  const url = new URL(result.request.url);
  assert.equal(url.pathname, "/rest/api/3/search/jql");
  assert.equal(url.searchParams.has("startAt"), false);
  assert.equal(url.searchParams.has("nextPageToken"), false);
});

test("HTTPS cursor traversal imports once and refuses incomplete page chains before writes", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pm-jira-cloud-"));
  const originalCa = https.globalAgent.options.ca;
  const credentials = { JIRA_EMAIL: process.env.JIRA_EMAIL, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  process.env.JIRA_EMAIL = "fixture@example.invalid";
  process.env.JIRA_API_TOKEN = "synthetic";
  t.after(() => {
    for (const [key, value] of Object.entries(credentials)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.after(() => { https.globalAgent.options.ca = originalCa; rmSync(dir, { recursive: true, force: true }); });
  const { cert, private: key } = await generate([{ name: "commonName", value: "localhost" }], {
    keyType: "ec", algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
  });
  https.globalAgent.options.ca = cert;
  let pages: unknown[] = [];
  const requests: URL[] = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    requests.push(new URL(req.url!, "https://localhost"));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(pages.shift()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, "close"); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const host = `https://127.0.0.1:${address.port}`;
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const options = { project: "ONE", host };
  const cases = [
    { name: "bounded empty pagination", pages: Array.from({ length: 1000 }, (_, n) => ({ isLast: false, issues: [], nextPageToken: String(n) })), count: 0, error: /exceeded 1000 pages/ },
    { name: "opaque cursors including an empty intermediate page", pages: [
      { isLast: false, nextPageToken: "a +/&?", issues: [issues[0]] },
      { isLast: false, nextPageToken: "b", issues: [] },
      { isLast: true, issues: [issues[1]] },
    ], count: 2, tokens: [null, "a +/&?", "b"] },
    { name: "explicit issue limit", pages: [{ isLast: false, nextPageToken: "more", issues }], count: 2, tokens: [null], limit: 2 },
    { name: "empty final result", pages: [{ isLast: true, issues: [] }], count: 0, tokens: [null] },
    ...[
      null, [], {}, { issues: [] }, { isLast: true, issues: "invalid" },
      { isLast: false, issues: [] }, { isLast: false, issues: [], nextPageToken: "" },
      { isLast: false, issues: [], nextPageToken: 4 },
      { isLast: false, issues: [], nextPageToken: "first" },
      { isLast: true, issues: [issues[0]] },
      { isLast: true, issues: [null] },
      { isLast: true, issues: [{ key: "" }] },
    ].map((page, n) => ({ name: `invalid second page ${n}`, pages: [
      { isLast: false, nextPageToken: "first", issues: [issues[0]] }, page,
    ], count: 0, error: /Jira search/ })),
    { name: "oversized page", pages: [{ isLast: true, issues }], count: 0, limit: 1, error: /Jira search/ },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const root = mkdtempSync(join(dir, "tracker-"));
    execFileSync(process.execPath, [cli, "--path", root, "init", "fixture"], { stdio: "pipe" });
    pages = [...scenario.pages]; requests.length = 0;
    const importing = runImport({ ...options, "max-results": "limit" in scenario ? scenario.limit : 500 }, root, { atomic: true });
    if (scenario.error !== undefined) await assert.rejects(importing, scenario.error);
    else {
      const result = await importing;
      assert.ok("imported" in result);
      assert.equal(result.imported, scenario.count);
      assert.deepEqual(requests.map(url => url.searchParams.get("nextPageToken")), scenario.tokens);
    }
    assert.ok(requests.every(url => url.pathname === "/rest/api/3/search/jql" && !url.searchParams.has("startAt")));
    const data = JSON.parse(execFileSync(process.execPath, [cli, "--path", root, "list", "--all", "--json", "--output-limit", "unbounded"], { encoding: "utf8" }));
    assert.equal(data.items.length, scenario.count);
  });
});
