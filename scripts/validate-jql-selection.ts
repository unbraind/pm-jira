/** Read-only public tracker projection exercise; this is not a live Jira permission test. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { importPmSdk } from '../sdk-importer.ts';
import { explainJqlSelectionChanges, type JqlSelectionPage, type JqlSelectionSnapshot } from '../jql-selection.ts';

/** Hash every file in the supplied public copy to detect even an incidental write. */
function fingerprint(root: string): string {
  const hash = createHash('sha256');
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name)).sort();
  for (const file of files) hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

/** Project known local query membership to Jira-shaped keys, retaining every cursor link. */
function selection(keys: string[], jql: string): JqlSelectionSnapshot {
  const pages: JqlSelectionPage[] = [];
  for (let offset = 0; offset < Math.max(1, keys.length); offset += 40) {
    const isLast = offset + 40 >= keys.length;
    pages.push({ keys: keys.slice(offset, offset + 40), isLast,
      ...(offset ? { requestToken: `page-${offset}` } : {}), ...(!isLast ? { nextPageToken: `page-${offset + 40}` } : {}) });
  }
  return { version: 1, site: 'https://fixture.atlassian.net', principal: 'public-tracker-projection', scope: 'fleet-validation',
    capturedAt: '2026-10-21T12:00:00.000Z', jql, pages, visibility: [] };
}

/** Validate selections from a complete SDK read without persisting snapshots or modifying items. */
async function main(): Promise<void> {
  const root = resolve(process.argv[2]);
  const original = fingerprint(root);
  const sdk = await importPmSdk();
  const read = sdk.certifyCompleteListResult(await sdk.listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true }));
  const rows = [...read.items].sort((a, b) => a.id.localeCompare(b.id));
  const all = rows.map((item, i) => ({ key: `FLEET-${i + 1}`, active: item.status !== 'closed' && item.status !== 'canceled' }));
  const active = all.filter(row => row.active).map(row => row.key);
  const withheld = new Set(active.slice(0, 3));
  const before = selection(all.filter(row => !withheld.has(row.key)).map(row => row.key), 'project = FLEET AND label != withheld');
  const after = selection(active, 'project = FLEET AND status not in (Closed, Canceled)');
  after.visibility = all.filter(row => !row.active).map(row => ({ key: row.key, state: 'query_excluded' }));
  const result = explainJqlSelectionChanges(before, after);
  assert.ok(result.kind === 'explained');
  assert.equal(result.counts.entries, withheld.size); assert.equal(result.counts.exits, all.length - active.length);
  assert.equal(result.counts.queryExcluded, result.counts.exits);
  const changes = [];
  for (let offset = 0; offset < result.page.total; offset += 7) {
    const page = explainJqlSelectionChanges(before, after, { offset, limit: 7 }); assert.ok(page.kind === 'explained'); changes.push(...page.changes);
  }
  assert.equal(changes.length, result.page.total); assert.equal(new Set(changes.map(row => row.key)).size, result.page.total);
  const ambiguous = { ...after, visibility: [] };
  const unknown = explainJqlSelectionChanges(before, ambiguous); assert.ok(unknown.kind === 'explained');
  assert.equal(unknown.counts.unresolved, result.counts.exits);
  const permission = { ...after, visibility: after.visibility.map(row => ({ ...row, state: 'permission_lost' as const })) };
  const lost = explainJqlSelectionChanges(before, permission); assert.ok(lost.kind === 'explained');
  assert.equal(lost.counts.permissionLost, result.counts.exits); assert.equal(lost.counts.queryExcluded, 0);
  const partial = { ...after, pages: after.pages.slice(0, -1) };
  const refused = explainJqlSelectionChanges(before, partial); assert.ok(refused.kind === 'refused'); assert.equal(refused.code, 'incomplete_chain');
  const unchanged = fingerprint(root) === original; assert.ok(unchanged);
  console.log(JSON.stringify({ source: 'public pm-jira main tracker', certificate: read.complete_list,
    trackerItems: rows.length, activeItems: active.length, beforePages: before.pages.length, afterPages: after.pages.length,
    counts: result.counts, defaultRows: result.changes.length, recoveredRows: changes.length,
    defaultJsonBytes: Buffer.byteLength(JSON.stringify(result)),
    evidenceScenarios: { unknownExits: unknown.counts.unresolved, injectedPermissionLossExits: lost.counts.permissionLost, incompleteRefusal: refused.code },
    writes: result.writes, deletionProposals: result.deletionProposals, copyUnchanged: unchanged, sourceSha256: original,
    limitation: 'Real tracker status membership projected into Jira-shaped snapshots; permission-loss evidence is injected, not live Jira.' }, null, 2));
}

await main();
