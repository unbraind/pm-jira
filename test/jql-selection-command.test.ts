/** Real host parsing/rendering in a non-git tracker, with git absent from PATH. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { PmClient, listAllComplete } from '@unbrained/pm-cli/sdk';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import extension, { type JqlSelectionResult } from '../index.ts';
import { runJqlSelectionComparison } from '../jql-selection-command.ts';

const snapshot = (keys: string[]) => ({ version: 1, site: 'https://example.atlassian.net', principal: 'fixture', scope: 'fixture',
  capturedAt: '2026-10-21T12:00:00.000Z', jql: 'project = DEMO', pages: [{ keys, isLast: true }], visibility: [] });
const refusal = (result: JqlSelectionResult, code: string) => {
  assert.ok(result.kind === 'refused'); assert.equal(result.code, code); assert.equal(result.exit_code, 2);
  assert.equal(result.writes, 0); assert.equal(result.deletionProposals, 0);
};

// Only durable store data is compared; extension discovery may maintain host runtime caches.
const durable = (root: string): string[] => readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && !entry.parentPath.includes(`${join(root, 'runtime')}`) && !entry.parentPath.includes(`${join(root, 'extensions')}`))
  .map(entry => join(entry.parentPath, entry.name)).filter(file => /\.(toon|jsonl)$/.test(file) || file === join(root, 'settings.json'))
  .sort().map(file => `${file.slice(root.length)}:${readFileSync(file, 'utf8')}`);

test('file adapter refuses missing options, unreadable/invalid/nonregular/oversized input and bad page controls', t => {
  const root = mkdtempSync(join(tmpdir(), 'jql-files-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'before.json'), JSON.stringify(snapshot(['DEMO-1'])));
  writeFileSync(join(root, 'after.json'), JSON.stringify(snapshot([])));
  const options = { before: 'before.json', after: 'after.json' };
  for (const bad of [{}, { before: '' }, { before: 'before.json' }, { before: 'before.json', after: '' }, { before: true, after: 'after.json' }]) refusal(runJqlSelectionComparison(bad, root), 'invalid_options');
  for (const value of [0, '0', '', true, '-1', '1.2']) refusal(runJqlSelectionComparison({ ...options, limit: value }, root), 'invalid_options');
  assert.equal(runJqlSelectionComparison({ ...options, limit: 2, offset: '0' }, root).kind, 'explained');
  refusal(runJqlSelectionComparison({ ...options, before: 'missing.json' }, root), 'input_read');
  refusal(runJqlSelectionComparison({ ...options, after: 'missing.json' }, root), 'input_read');
  refusal(runJqlSelectionComparison({ ...options, before: '.' }, root), 'input_read');
  writeFileSync(join(root, 'bad.json'), '{');
  refusal(runJqlSelectionComparison({ ...options, after: 'bad.json' }, root), 'input_json');
  writeFileSync(join(root, 'big.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  refusal(runJqlSelectionComparison({ ...options, before: 'big.json' }, root), 'snapshot_limit');
  // Inject a disk fault after open, without substituting a pm SDK/store.
  t.mock.method(fs, 'readSync', () => { throw new Error('synthetic disk fault'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  refusal(runJqlSelectionComparison(options, root), 'input_read');
});

test('registered command uses host semantic refusal exits and read-output contracts', async () => {
  const harness = await createExtensionTestHarness(extension, { name: 'pm-jira', capabilities: ['commands', 'schema', 'importers', 'hooks', 'preflight'] });
  harness.assertCommandContract({ command: 'jira explain-selection', flags: ['--before', '--after', '--limit', '--offset'] });
  const result = await harness.runCommand({ command: 'jira explain-selection', pmRoot: '.', options: {} });
  assert.equal(result.exitCode, 2); assert.equal(result.errorCode, 'invalid_options'); assert.match(result.remediation!, /--before/);
});

test('installed CLI explains and refuses in JSON/TOON without git and preserves omitted local work byte for byte', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jql-no-git-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = resolve('node_modules/@unbrained/pm-cli/dist/cli.js');
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root), PM_AUTHOR: 'jql-fixture', HOME: join(root, 'home') };
  execFileSync(process.execPath, [cli, '--path', root, 'init', 'fixture'], { env, stdio: 'pipe' });
  const pkg = join(root, 'package'); mkdirSync(pkg);
  cpSync(resolve('dist'), join(pkg, 'dist'), { recursive: true }); cpSync(resolve('manifest.json'), join(pkg, 'manifest.json'));
  execFileSync(process.execPath, [cli, '--path', root, 'package', 'install', pkg, '--project'], { env, stdio: 'pipe' });
  const client = new PmClient({ pmRoot: root, cwd: root, author: 'jql-fixture', noExtensions: true });
  await client.create({ title: 'Local edits must survive omission', body: 'Independent local notes', type: 'Task', status: 'open' });
  await client.create({ title: 'Closed work must survive omission', type: 'Task', status: 'closed', closeReason: 'Fixture complete' });
  const original = durable(root);
  writeFileSync(join(root, 'before.json'), JSON.stringify(snapshot(['DEMO-1', 'DEMO-2', 'DEMO-3'])));
  const after = { ...snapshot(['DEMO-4']), visibility: [{ key: 'DEMO-1', state: 'query_excluded' }, { key: 'DEMO-2', state: 'permission_lost' }, { key: 'DEMO-3', state: 'not_found' }] };
  writeFileSync(join(root, 'after.json'), JSON.stringify(after));
  writeFileSync(join(root, 'partial.json'), JSON.stringify({ ...after, pages: [{ keys: [], isLast: false, nextPageToken: 'opaque' }] }));
  const bin = join(root, 'empty-bin'); mkdirSync(bin);
  const run = (args: string[]) => spawnSync(process.execPath, [cli, '--path', root, 'jira', 'explain-selection', ...args], {
    cwd: root, encoding: 'utf8', env: { ...env, PATH: bin },
  });
  for (const json of [false, true]) for (const partial of [false, true]) {
    const result = run(['--before', 'before.json', '--after', partial ? 'partial.json' : 'after.json', ...(json ? ['--json'] : [])]);
    assert.equal(result.status, partial ? 2 : 0, result.stderr + result.stdout);
    if (json) { const output = JSON.parse(result.stdout) as JqlSelectionResult;
      if (partial) refusal(output, 'incomplete_chain');
      else { assert.ok(output.kind === 'explained'); assert.equal(output.counts.queryExcluded, 1); assert.equal(output.counts.permissionLost, 1); assert.equal(output.counts.unresolved, 1); }
    } else assert.match(result.stdout, partial ? /kind: "refused"/ : /kind: "explained"/);
  }
  const page = run(['--before', 'before.json', '--after', 'after.json', '--limit', '1', '--offset', '1', '--json']);
  assert.equal(page.status, 0, page.stderr); const result = JSON.parse(page.stdout) as JqlSelectionResult; assert.ok(result.kind === 'explained');
  assert.equal(result.changes.length, 1); assert.equal(result.page.nextOffset, 2); assert.equal(result.page.omitted, 3);
  const help = run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /--before/);
  assert.deepEqual(durable(root), original);
  const items = await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true });
  assert.equal(items.items.length, 2); assert.ok(items.items.some(item => item.body === 'Independent local notes'));
});
