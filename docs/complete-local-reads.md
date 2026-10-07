# Certified local reads

Issue: [#128](https://github.com/unbraind/pm-jira/issues/128).
Work item: [pm-jira-sdwp](../.agents/pm/issues/pm-jira-sdwp.toon).

`readPmItems` calls the public SDK
`listAllComplete({ includeBody: true }, { pmRoot, cwd: pmRoot, noExtensions: true })`.
The SDK requests all statuses, full metadata, strict source scanning, no
pagination, and unbounded output amount/cost. `certifyCompleteListResult`
independently verifies the receipts and regenerates the whole-corpus certificate.
The integration additionally requires included bodies and validates the fields
consumed by payload construction and matching. The minimum SDK/CLI version is
2026.10.4 in both the npm peer dependency and extension manifest.

No local read launches a CLI process or relies on a stdout buffer. A missing
tracker is an error; a certified empty tracker is valid. Preview and push both
await certification before planning. Both importer entrypoints await it before
local creates. The import index includes closed and canceled work and compares
browse URLs, keeping separate Jira hosts distinct. Matched work is preserved
without updates or reopening. Atomic imports retain the original issue-set
transaction identity and their own already-applied mutation IDs, so interruption
recovery can replay the original SDK plan. Counts include newly created items;
a complete replay reports zero.

## Refusal matrix

Every row below raises a semantic `CommandError` with a tracker/SDK repair hint
and an all-status, strict, full, unbounded inspection command before writes.

| Answer | Refusal evidence |
| --- | --- |
| Missing/null/array envelope, missing items, results alias, non-array items | SDK `invalid_envelope` |
| Partial, unchecked, missing source scan, unreadable artifacts | SDK source completeness findings; strict source-read failure |
| Filters, excluded terminal work, missing strict-read proof | SDK scope/strict-read findings |
| Truncated, has_more, next_cursor, applied limit, missing pagination proof | SDK `page_incomplete` |
| Counts differ from item rows | SDK `count_mismatch` |
| Compact projection or missing body inclusion proof | SDK projection finding or integration body check |
| Missing, contradictory, or affirmative field omission receipt | SDK omission findings |
| Missing/malformed universal receipt or unproven include/amount/cost dimensions | SDK read-output findings |
| Strings/rows compacted, truncation marker, result/budget omission | SDK compaction/omission findings |
| Cross-call session projection | SDK `session_projection` |
| Null row, missing/blank/duplicate ID | SDK item-ID findings |
| Missing/blank/malformed title, status, type; missing/malformed body | Integration row validation |
| Non-string description/provenance, non-array/non-string tags, non-integer/out-of-range priority | Integration payload-field validation |

## Verification

`test/complete-local-reads.test.ts` creates disposable trackers through the real
installed pm CLI. It generates 10,003 canonical TOON documents and hashed import
history records using public SDK serialization, history construction, and atomic
file writers in process. A sampled history is verified with the CLI. Export
must retain all 10,003 rows, terminal identities, and the final body.

Refusal cases mutate a genuine `listAllComplete` result and call the public SDK
validator through the integration. This tests hostile/malformed answers without
mocking the SDK. A corrupt real tracker exercises import and export-push refusal;
item/history snapshots prove no durable writes. Sequential and atomic imports
use offline prefetched synthetic issues and real tracker mutations. Tests cover
terminal matching, zero-create repeat imports, distinct hosts, and recovery from
a deliberate real SDK transaction interruption. No real Jira service or live
credentials are involved.

## Revert proof

The negative control restores `origin/main`'s CLI reader and original
`runImport`. The validation test entrypoint uses the baseline JSON-envelope
decode expression (`items`/`results`/empty fallback), preserving test exports.
The unchanged targeted regressions exit 1 with 57 failures, including all 51
refusal cases and both terminal-matching modes (3 creates instead of 1).
A separate reader-only revert on the final 10,003-item fixture returns exactly
10,000 items and fails the expected 10,003 count. Restoring the implementation
makes these cases pass. Neither control replaces the SDK.

Commands used:

```sh
node --test --test-name-pattern='complete export|terminal matching|every incomplete|corrupt tracker' test/complete-local-reads.test.ts
node --test --test-name-pattern='complete export' test/complete-local-reads.test.ts
node --test test/complete-local-reads.test.ts
npm run release:check
bun run release:check
```

The release gate's configured executable source inventory is `index.ts` and
`sdk-importer.ts`. Its exact thresholds remain 100% lines, branches, and
functions; no files or thresholds were removed. The Bun command runs the
repository's release script, whose coverage runner explicitly uses Node; this
is not a separate native-Bun SDK-runtime claim.

The public SDK complete-list certificate does not type-check payload fields
or certify body inclusion. Both are enforced by this integration. A separate
package diagnostic issue, [pm-jira-d3tp](../.agents/pm/issues/pm-jira-d3tp.toon),
records that an interrupted atomic import currently describes compensation
even though its SDK journal remains resumable. Recovery is tested and preserved
here; that existing diagnostic is deferred.

Final verification: the focused suite passes 60 tests. Each npm/Bun release gate
passes 254 tests with 100% lines, branches, and functions across the configured
two-source inventory, plus production audit, package dry run, changelog and
release-workflow checks. Linked pm test runs execute the same commands; the
workspace's test-result tracking policy remains disabled, so results are
recorded in the work item's comments. Exact-commit gates are repeated before
pushing the PR.
