/** Selection-boundary regressions use supplied snapshots, never a mocked pm store. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { explainJqlSelectionChanges, type JqlSelectionSnapshot, type JqlSelectionResult, type JqlSelectionOptions } from '../index.ts';

const snapshot = (keys: string[] = [], overrides: Partial<JqlSelectionSnapshot> = {}): JqlSelectionSnapshot => ({
  version: 1, site: 'https://example.atlassian.net', principal: 'fixture-principal', scope: 'fixture-scope',
  capturedAt: '2026-10-21T12:00:00.000Z', jql: 'project = DEMO', pages: [{ keys, isLast: true }], visibility: [], ...overrides,
});
const refused = (result: JqlSelectionResult, code: string) => {
  assert.equal(result.kind, 'refused');
  assert.ok(result.kind === 'refused'); assert.equal(result.code, code); assert.ok(result.remediation.length > 10);
  assert.equal(result.exit_code, 2); assert.equal(result.writes, 0); assert.equal(result.deletionProposals, 0);
  assert.deepEqual(result.changes, []);
};

test('query exclusion and permission loss require independent evidence; absence, visibility and 404 stay unresolved', () => {
  const a = snapshot(['DEMO-7', 'DEMO-3', 'DEMO-1', 'DEMO-2', 'DEMO-4', 'DEMO-5', 'DEMO-6']);
  const b = snapshot(['DEMO-7', 'DEMO-8'], { jql: 'project = DEMO AND status = Open', capturedAt: '2026-10-22T12:00:00.000Z', visibility: [
    { key: 'DEMO-1', state: 'query_excluded' }, { key: 'DEMO-2', state: 'permission_lost' },
    { key: 'DEMO-3', state: 'not_found' }, { key: 'DEMO-4', state: 'unknown' }, { key: 'DEMO-5', state: 'visible' },
    { key: 'DEMO-7', state: 'visible' },
  ] });
  const original = JSON.stringify([a, b]);
  const result = explainJqlSelectionChanges(a, b);
  assert.equal(result.kind, 'explained'); assert.ok(result.kind === 'explained');
  assert.deepEqual(result.counts, { before: 7, after: 2, retained: 1, entries: 1, exits: 6, queryExcluded: 1, permissionLost: 1, unresolved: 4 });
  assert.deepEqual(result.changes.map(row => [row.key, row.reason]), [
    ['DEMO-1', 'query_excluded'], ['DEMO-2', 'permission_lost'], ['DEMO-3', 'unresolved'], ['DEMO-4', 'unresolved'],
    ['DEMO-5', 'unresolved'], ['DEMO-6', 'unresolved'], ['DEMO-8', 'selected'],
  ]);
  assert.ok(result.changes.every(row => row.localAction === 'preserve'));
  assert.equal(result.writes, 0); assert.equal(result.deletionProposals, 0); assert.equal(result.queryChanged, true);
  assert.equal(JSON.stringify([a, b]), original);
  assert.ok(!JSON.stringify(result).includes('fixture-principal'));
});

test('unchanged selections and empty complete selections are valid; reordered pages and keys are neutral', () => {
  const a = snapshot(['DEMO-2', 'DEMO-1']);
  const b = snapshot([], { pages: [{ keys: ['DEMO-1'], isLast: false, nextPageToken: 'opaque' }, { keys: [], isLast: false, requestToken: 'opaque', nextPageToken: 'next' }, { keys: ['DEMO-2'], requestToken: 'next', isLast: true }] });
  for (const [before, after] of [[a, b], [snapshot(), snapshot()]]) {
    const result = explainJqlSelectionChanges(before, after);
    assert.ok(result.kind === 'explained'); assert.equal(result.queryChanged, false); assert.deepEqual(result.changes, []);
    assert.equal(result.page.total, 0); assert.equal(result.page.nextOffset, null);
  }
});

test('every change is recoverable with deterministic bounded pagination and exact global counts', () => {
  const before = snapshot(['DEMO-9', 'DEMO-1']); const after = snapshot(['DEMO-8', 'DEMO-2']);
  const all = explainJqlSelectionChanges(before, after); assert.ok(all.kind === 'explained');
  const rows = [];
  for (const offset of [0, 1, 2, 3]) {
    const page = explainJqlSelectionChanges(before, after, { limit: 1, offset }); assert.ok(page.kind === 'explained');
    assert.deepEqual(page.counts, all.counts); assert.equal(page.page.omitted, 3);
    assert.equal(page.page.nextOffset, offset < 3 ? offset + 1 : null); rows.push(...page.changes);
  }
  assert.deepEqual(rows, all.changes);
  for (const offset of [4, 100, Number.MAX_SAFE_INTEGER]) {
    const result = explainJqlSelectionChanges(before, after, { offset }); assert.ok(result.kind === 'explained');
    assert.equal(result.changes.length, 0); assert.equal(result.page.omitted, 4); assert.equal(result.page.nextOffset, null);
  }
});

test('invalid page controls refuse before considering untrusted snapshots', () => {
  for (const options of [{ limit: 0 }, { limit: 257 }, { limit: 1.5 }, { limit: NaN }, { offset: -1 }, { offset: 0.2 }, { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: null }, { offset: null }]) {
    refused(explainJqlSelectionChanges(null, null, options as JqlSelectionOptions), 'invalid_options');
  }
});

test('runtime validation rejects malformed metadata, timestamps, page shapes, keys and observations', () => {
  const bad: unknown[] = [null, [], {}, snapshot([], { version: 2 as 1 })];
  for (const site of ['', 'http://example.invalid', 'https://example.invalid/', 'https://user:secret@example.invalid', 'not a url', 'https://example.invalid/?secret=yes']) bad.push({ ...snapshot(), site });
  for (const field of ['principal', 'scope', 'jql']) for (const value of [null, '', ' padded ', '\u0001', 'x'.repeat(8193)]) bad.push({ ...snapshot(), [field]: value });
  for (const capturedAt of [null, '', '2026-10-21', '9999-99-99T00:00:00.000Z', '2026-02-31T00:00:00.000Z']) bad.push({ ...snapshot(), capturedAt });
  for (const pages of [null, [null], [{}], [{ keys: null, isLast: true }], [{ keys: [], isLast: 'true' }]]) bad.push({ ...snapshot(), pages });
  bad.push({ ...snapshot(), visibility: null });
  for (const key of [null, '', 'lower-1', 'DEMO-no', '../bad', 'A'.repeat(129) + '-1']) bad.push(snapshot([key as string]));
  bad.push(snapshot(['DEMO-1', 'DEMO-1']));
  bad.push(snapshot([], { pages: [{ keys: ['DEMO-1'], isLast: false, nextPageToken: 'next' }, { keys: ['DEMO-1'], isLast: true, requestToken: 'next' }] }));
  for (const observation of [null, {}, { key: 1, state: 'visible' }, { key: 'DEMO-1', state: 'bad' }, { key: 'DEMO-1', state: ['visible'] }]) bad.push({ ...snapshot(), visibility: [observation] });
  bad.push(snapshot([], { visibility: [{ key: 'DEMO-1', state: 'visible' }, { key: 'DEMO-1', state: 'visible' }] }));
  for (const candidate of bad) {
    refused(explainJqlSelectionChanges(candidate, snapshot()), 'invalid_snapshot');
    refused(explainJqlSelectionChanges(snapshot(), candidate), 'invalid_snapshot');
  }
});

test('missing, truncated, cycling, disconnected and premature-terminal chains never infer exits', () => {
  const bad: unknown[] = [[], [{ keys: [], isLast: false }], [{ keys: [], isLast: true, requestToken: 'unexpected' }],
    [{ keys: [], isLast: true, nextPageToken: 'unexpected' }],
    [{ keys: [], isLast: true }, { keys: [], isLast: true }]];
  for (const nextPageToken of [undefined, '', ' ', '\u0000', 1, 'x'.repeat(8193)]) bad.push([{ keys: [], isLast: false, nextPageToken }, { keys: [], isLast: true }]);
  bad.push([{ keys: [], isLast: false, nextPageToken: 'a' }, { keys: [], isLast: true, requestToken: 'b' }]);
  bad.push([{ keys: [], isLast: false, nextPageToken: 'a' }, { keys: [], isLast: false, requestToken: 'a', nextPageToken: 'a' }, { keys: [], isLast: true, requestToken: 'a' }]);
  for (const pages of bad) {
    const candidate = { ...snapshot(), pages };
    refused(explainJqlSelectionChanges(snapshot(['DEMO-1']), candidate), 'incomplete_chain');
    refused(explainJqlSelectionChanges(candidate, snapshot()), 'incomplete_chain');
  }
});

test('scope, site and principal changes cannot masquerade as membership or permission changes', () => {
  for (const overrides of [{ site: 'https://other.atlassian.net' }, { principal: 'another-principal' }, { scope: 'another-scope' }]) {
    refused(explainJqlSelectionChanges(snapshot(['DEMO-1']), snapshot([], overrides)), 'boundary_mismatch');
  }
  refused(explainJqlSelectionChanges(snapshot([], { capturedAt: '2026-10-22T12:00:00.000Z' }), snapshot()), 'time_order');
  for (const state of ['permission_lost', 'query_excluded', 'not_found', 'unknown'] as const) {
    refused(explainJqlSelectionChanges(snapshot(), snapshot(['DEMO-1'], { visibility: [{ key: 'DEMO-1', state }] })), 'conflicting_evidence');
  }
});

test('snapshot limits fail closed instead of silently clipping membership', () => {
  refused(explainJqlSelectionChanges(snapshot([], { pages: Array(1001).fill({ keys: [], isLast: true }) }), snapshot()), 'snapshot_limit');
  refused(explainJqlSelectionChanges(snapshot([], { visibility: Array(10001).fill({ key: 'DEMO-1', state: 'unknown' }) }), snapshot()), 'snapshot_limit');
  refused(explainJqlSelectionChanges(snapshot(Array.from({ length: 101 }, (_, i) => `DEMO-${i}`)), snapshot()), 'snapshot_limit');
  const keys = Array.from({ length: 10000 }, (_, i) => `DEMO-${i}`);
  const pages = Array.from({ length: 101 }, (_, i) => ({ keys: i === 100 ? ['DEMO-10000'] : keys.slice(i * 100, (i + 1) * 100),
    isLast: i === 100, ...(i ? { requestToken: String(i) } : {}), ...(i < 100 ? { nextPageToken: String(i + 1) } : {}) }));
  refused(explainJqlSelectionChanges(snapshot([], { pages }), snapshot()), 'snapshot_limit');
  pages.pop(); pages[99] = { keys: keys.slice(9900), requestToken: '99', isLast: true };
  const result = explainJqlSelectionChanges(snapshot([], { pages }), snapshot([], { pages }));
  assert.ok(result.kind === 'explained'); assert.equal(result.counts.retained, 10000);
});


test('documented JSON example produces the promised explanations', () => {
  const example = readFileSync(new URL('../docs/jql-selection-example.md', import.meta.url), 'utf8');
  const values = [...example.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]) as unknown);
  assert.equal(values.length, 2);
  const result = explainJqlSelectionChanges(values[0], values[1]); assert.ok(result.kind === 'explained');
  assert.deepEqual(result.counts, { before: 4, after: 2, retained: 1, entries: 1, exits: 3, queryExcluded: 1, permissionLost: 1, unresolved: 1 });
});
