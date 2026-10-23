# Explain a JQL selection change

Save the first JSON block as `before.json` and the second as `after.json`.
These are explicit, projected enhanced-search page chains for one synchronized
scope. They are inputs to an offline comparison, not instructions to import or
delete local work.

```json
{
  "version": 1,
  "site": "https://example.atlassian.net",
  "principal": "sync-principal",
  "scope": "demo-team",
  "capturedAt": "2026-10-21T12:00:00.000Z",
  "jql": "project = DEMO",
  "pages": [
    { "keys": ["DEMO-1", "DEMO-2"], "isLast": false, "nextPageToken": "opaque-a" },
    { "keys": ["DEMO-3", "DEMO-4"], "isLast": true, "requestToken": "opaque-a" }
  ],
  "visibility": []
}
```

```json
{
  "version": 1,
  "site": "https://example.atlassian.net",
  "principal": "sync-principal",
  "scope": "demo-team",
  "capturedAt": "2026-10-22T12:00:00.000Z",
  "jql": "project = DEMO AND status = Open",
  "pages": [{ "keys": ["DEMO-4", "DEMO-5"], "isLast": true }],
  "visibility": [
    { "key": "DEMO-1", "state": "query_excluded" },
    { "key": "DEMO-2", "state": "permission_lost" },
    { "key": "DEMO-3", "state": "not_found" }
  ]
}
```

```sh
pm jira explain-selection --before before.json --after after.json --json
pm jira explain-selection --before before.json --after after.json --limit 2
pm jira explain-selection --before before.json --after after.json --limit 2 --offset 2
```

The result has one retained key, one entry (`DEMO-5`), and three exits:
`DEMO-1` is query-excluded, `DEMO-2` has explicit permission-loss evidence, and
`DEMO-3` is unresolved. A 404 does not establish deletion or permission loss.
Every change has `localAction: preserve`; both `writes` and `deletionProposals`
are zero. Rows sort lexically by key. Counts always cover the entire comparison;
`page` reports total, omitted rows and the next offset. The host may impose a
further output budget with its own omission receipt. If it does, retry the same
offset with `--output-budget unbounded --output-limit unbounded` before following
`nextOffset`. Keep both snapshot files unchanged while paging.

SDK callers can pass parsed JSON directly:

```ts
import { explainJqlSelectionChanges, type JqlSelectionResult } from 'pm-jira';
const result: JqlSelectionResult = explainJqlSelectionChanges(before, after, { limit: 2 });
if (result.kind === 'refused') {
  console.error(result.code, result.remediation);
} else {
  console.log(result.counts, result.changes, result.page.nextOffset);
}
```

## Preparing real snapshots

Record a canonical HTTPS site origin, a stable authenticated principal ID, a
stable synchronized-scope ID, the exact JQL, and a UTC timestamp with milliseconds.
Never put an email, credential or access token in `principal`. Each page projects
`issues` to `keys`, copies `isLast` and `nextPageToken`, and records the exact
`requestToken` used for that page. The first request has no token. Finish the
chain with `isLast: true` and no continuation. Empty intermediate pages are valid
when their token advances. An empty selection is one terminal empty page.

The existing importer may stop at `--max-results`; its result alone is not a
complete selection snapshot. Preserve the page chain separately and follow it to
completion. The comparison makes no network calls and does not capture or store
snapshots. Keep these files private: queries and cursor tokens can reveal scope.

`visibility` is mandatory (an empty array is valid). Evidence is asserted by the
caller for that snapshot's exact site, principal, capture interval and JQL:

- `query_excluded`: independently established that the issue remains visible
  and does not match this exact JQL. A successful issue GET alone is insufficient.
- `permission_lost`: independently established loss of issue visibility for the
  same principal. An ambiguous 403/404 or failed request alone is insufficient.
- `visible`: the issue can be read, but its query membership is unproven.
- `not_found` or `unknown`: the cause remains unproven.

Only the first two classify exits. Missing observations, visible-only checks,
404s, and unknown observations produce `unresolved`. Before-snapshot observations
are validated, but explanations use the after-snapshot evidence. Selected keys
can have only `visible` observations; contradictory or duplicate evidence
refuses the comparison. Unrelated observations do not create membership changes.

[Jira enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-get)
filters by permissions and is eventually consistent. A valid cursor chain proves
traversal, not a point-in-time read or the truth of supplied evidence. The
comparison does not evaluate JQL or authenticate observations. Recapture after
indexing settles and independently verify membership/permissions before treating
an explanation as current. `queryChanged` only compares JQL text; it does not
claim a query edit caused a particular exit. Moved/renamed issue keys appear as
entries/exits, not an inferred identity migration.
