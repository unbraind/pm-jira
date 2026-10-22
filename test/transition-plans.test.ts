/** Read-only transition discovery and no-git CLI regression scenarios. */
import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { generate } from 'selfsigned';
import extension, { planJiraTransition, discoverJiraTransitionPlan, runTransitionPlan, type JiraTransitionIntent } from '../index.ts';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';

const status = (name = 'To Do', category = 'new', id = '1') => ({ id, name, statusCategory: { key: category } });
const issue = (s: unknown = status()) => ({ key: 'ONE-1', fields: { status: s } });
const field = { required: true, operations: ['set'], allowedValues: [{ id: 'fixed' }] };
const edge = (id = '31', to: unknown = status('Done', 'done', '3'), fields: unknown = {}) => ({ id, name: 'Complete', to, fields });
const intent: JiraTransitionIntent = { issue: 'ONE-1', target: 'closed' };
const response = (...transitions: unknown[]) => ({ transitions });
const refused = (result: ReturnType<typeof planJiraTransition>, code: string) => {
  assert.equal(result.kind, 'refused');
  assert.ok('code' in result); assert.equal(result.code, code); assert.equal(result.writes, 0);
};

test('planner refuses impossible, unavailable, ambiguous and invalid plans before writes', () => {
  const ready = planJiraTransition(intent, issue(), response(edge()));
  assert.equal(ready.kind, 'ready'); assert.ok('steps' in ready); assert.equal(ready.steps[0]?.id, '31');
  assert.equal(planJiraTransition(intent, issue(status('Done', 'done')), response()).kind, 'noop');
  refused(planJiraTransition({ ...intent, issue: '../bad' }, {}, {}), 'invalid_input');
  refused(planJiraTransition({ ...intent, target: 'bad' as 'closed' }, {}, {}), 'invalid_input');
  // Intermediate step exists, but no direct permitted path to Done exists.
  refused(planJiraTransition(intent, issue(), response(edge('21', status('Review', 'indeterminate')))), 'no_permitted_transition');
  refused(planJiraTransition(intent, issue(), response()), 'no_permitted_transition');
  refused(planJiraTransition(intent, issue(), response({ ...edge(), isAvailable: false })), 'no_permitted_transition');
  refused(planJiraTransition(intent, issue(), response(edge(), edge('32'))), 'ambiguous_transition');
  assert.equal(planJiraTransition({ ...intent, transitionId: '32' }, issue(), response(edge(), edge('32'))).kind, 'ready');
  refused(planJiraTransition({ ...intent, transitionId: '99' }, issue(), response(edge())), 'no_permitted_transition');
  assert.equal(planJiraTransition({ ...intent, target: 'blocked' }, issue(), response(edge('5', status('Blocked', 'indeterminate')))).kind, 'ready');
  assert.equal(planJiraTransition({ ...intent, statusMap: { qa: 'closed' } }, issue(), response(edge('5', status('QA', 'indeterminate')))).kind, 'ready');
  assert.equal(planJiraTransition({ ...intent, statusMap: { other: 'blocked' } }, issue(), response(edge())).kind, 'ready');
  for (const bad of [null, [], {}, { key: 'OTHER-1' }, { key: 'ONE-1', fields: null }, issue(null), issue({}), issue({ id: '1' }), issue({ id: '1', name: 'X' }), issue(status('X', 'unknown'))]) {
    refused(planJiraTransition(intent, bad, response()), 'metadata_invalid');
  }
  for (const bad of [null, {}, { transitions: null }]) refused(planJiraTransition(intent, issue(), bad), 'metadata_invalid');
  for (const bad of [null, {}, { ...edge(), id: '' }, { ...edge(), id: 3 }, { ...edge(), name: 4 }, edge('3', null), edge('3', status(), null)]) {
    refused(planJiraTransition(intent, issue(), response(bad)), 'metadata_invalid');
  }
  refused(planJiraTransition(intent, issue(), response(edge(), edge())), 'metadata_invalid');
  for (const bad of [null, {}, { required: true }, { required: true, operations: [4] }, { ...field, allowedValues: 4 }]) {
    refused(planJiraTransition(intent, issue(), response(edge('31', status('Done', 'done'), { resolution: bad }))), 'metadata_invalid');
  }
});

test('transition screens require explicit valid fields, without disclosing their values', () => {
  const data = response(edge('31', status('Done', 'done'), { resolution: field, optional: { required: false, operations: ['set'] } }));
  for (const fields of [undefined, {}, { resolution: null }, { resolution: undefined }, { resolution: '' }, { resolution: [] }]) {
    refused(planJiraTransition({ ...intent, fields }, issue(), data), 'fields_required');
  }
  const fields = { resolution: { id: 'fixed' } };
  assert.equal(planJiraTransition({ ...intent, fields }, issue(), data).kind, 'ready');
  refused(planJiraTransition({ ...intent, fields: { resolution: { id: 'other' } } }, issue(), data), 'fields_invalid');
  refused(planJiraTransition({ ...intent, fields: { ...fields, unknown: 1 } }, issue(), data), 'fields_invalid');
  refused(planJiraTransition({ ...intent, fields: { optional: 1 } }, issue(), response(edge('31', status('Done', 'done'), { optional: { required: false, operations: ['add'] } }))), 'fields_invalid');
  assert.equal(planJiraTransition({ ...intent, fields: { optional: 'secret' } }, issue(), response(edge('31', status('Done', 'done'), { optional: { required: false, operations: ['set'] } }))).kind, 'ready');
  assert.equal(planJiraTransition({ ...intent, fields: { optional: 1 } }, issue(), response(edge('31', status('Done', 'done'), { optional: { required: false, operations: ['set'], allowedValues: [] } }))).kind, 'ready');
  assert.ok(!JSON.stringify(planJiraTransition({ ...intent, fields: { optional: 'secret' } }, issue(), response(edge()))).includes('secret'));
});

test('CLI parser gives typed input refusals and host command uses SDK rendering', async () => {
  for (const options of [{}, { issue: 'ONE-1', to: 'bad' }, { issue: 'ONE-1', to: 'closed', fields: '{' }, { issue: 'ONE-1', to: 'closed', fields: '[]' }, { issue: 'ONE-1', to: 'closed', statusMap: 'bad' }]) refused(await runTransitionPlan(options), 'invalid_input');
  refused(await discoverJiraTransitionPlan({ ...intent, issue: 'bad' }), 'invalid_input');
  refused(await discoverJiraTransitionPlan({ ...intent, target: 'bad' as 'closed' }), 'invalid_input');
  const harness = await createExtensionTestHarness(extension, { name: 'pm-jira', capabilities: ['commands', 'schema', 'importers', 'hooks', 'preflight'] });
  harness.assertCommandContract({ command: 'jira plan-transition' });
  const before = process.exitCode;
  const handled = await harness.runCommand({ command: 'jira plan-transition', options: {}, pmRoot: '.' });
  assert.equal(handled.exitCode, 2); assert.equal(handled.errorCode, 'invalid_input');
  assert.match(handled.remediation!, /--issue/); assert.equal(process.exitCode, before);
});

test('HTTPS discovery and actual non-git CLI never write, even on permission failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jira-plans-'));
  const originalCa = https.globalAgent.options.ca;
  const envBefore = { JIRA_BASE_URL: process.env.JIRA_BASE_URL, JIRA_EMAIL: process.env.JIRA_EMAIL, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  t.after(() => { https.globalAgent.options.ca = originalCa; for (const [key, value] of Object.entries(envBefore)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  process.env.JIRA_EMAIL = 'fixture@example.invalid'; process.env.JIRA_API_TOKEN = 'synthetic';
  const { cert, private: key } = await generate([{ name: 'commonName', value: 'localhost' }], { keyType: 'ec', algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] });
  https.globalAgent.options.ca = cert;
  let mode = 'ready'; const methods: string[] = []; const urls: string[] = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    methods.push(req.method!); urls.push(req.url!); res.setHeader('Connection', 'close');
    if (mode === '403') { res.writeHead(403); res.end('private response'); return; }
    if (mode === 'json') { res.end('{'); return; }
    res.end(JSON.stringify(req.url!.includes('/transitions') ? response(edge()) : issue()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const host = `https://127.0.0.1:${address.port}`; process.env.JIRA_BASE_URL = host;
  assert.equal((await discoverJiraTransitionPlan(intent)).kind, 'ready');
  assert.ok(urls.some(url => url.includes('expand=transitions.fields&includeUnavailableTransitions=false')));
  mode = '403'; refused(await discoverJiraTransitionPlan(intent), 'discovery_failed');
  mode = 'json'; refused(await discoverJiraTransitionPlan(intent), 'discovery_failed'); mode = 'ready';
  for (const host of ['http://example.invalid', 'https://user:pass@example.invalid', 'https://example.invalid/?query=1', 'https://example.invalid/#fragment']) refused(await discoverJiraTransitionPlan(intent, { host }), 'invalid_input');
  delete process.env.JIRA_EMAIL; refused(await discoverJiraTransitionPlan(intent), 'discovery_failed'); process.env.JIRA_EMAIL = 'fixture@example.invalid';
  const harness = await createExtensionTestHarness(extension, { name: 'pm-jira', capabilities: ['commands', 'schema', 'importers', 'hooks', 'preflight'] });
  await harness.runCommand({ command: 'jira plan-transition', pmRoot: '.', options: { issue: 'ONE-1', to: 'done', fields: '{}', statusMap: 'Done=closed', transition: '31' } });
  const cli = resolve('node_modules/@unbrained/pm-cli/dist/cli.js');
  execFileSync(process.execPath, [cli, '--path', root, 'init', 'fixture'], { stdio: 'pipe', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
  const pkg = join(root, 'package'); mkdirSync(pkg);
  cpSync(resolve('dist'), join(pkg, 'dist'), { recursive: true });
  cpSync(resolve('manifest.json'), join(pkg, 'manifest.json'));
  execFileSync(process.execPath, [cli, '--path', root, 'package', 'install', pkg, '--project'], { stdio: 'pipe' });
  const bin = join(root, 'bin'); mkdirSync(bin);
  const ca = join(root, 'ca.pem'); writeFileSync(ca, cert);
  // Absolute Node entrypoint and empty PATH ensure a git subprocess cannot run.
  for (const json of [true, false]) for (const invalid of [false, true]) {
    const args = [cli, '--path', root, 'jira', 'plan-transition', '--issue', 'ONE-1', '--to', 'closed'];
    if (json) args.push('--json');
    if (invalid) args.push('--fields', '[]');
    const child = spawn(process.execPath, args, { env: { ...process.env, PATH: bin, NODE_EXTRA_CA_CERTS: ca, GIT_CEILING_DIRECTORIES: dirname(root) } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    const [code] = await once(child, 'close'); assert.equal(code, invalid ? 2 : 0, stderr);
    if (json) assert.equal(JSON.parse(stdout).kind, invalid ? 'refused' : 'ready');
    else assert.match(stdout, invalid ? /kind: "refused"/ : /kind: "ready"/);
  }
  assert.ok(methods.length >= 8); assert.ok(methods.every(method => method === 'GET'));
});
