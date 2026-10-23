# Public tracker selection validation

Source: public `unbraind/pm-jira` main at
`b35701f73f5c180ea0fd37f6c6c691b33422afc7`, confirmed against the remote on
2026-10-23. Only the tracked `.agents/pm` tree was exported to a new non-git
scratch directory. All copied tracker files/directories were made read-only.
The validator ran with a git discovery ceiling and a PATH without git.

`scripts/validate-jql-selection.ts` uses the existing SDK loader,
`listAllComplete({ includeBody: true })`, and `certifyCompleteListResult`.
The SDK certified **105 unique items**, all terminal states included, complete
source/full projection, no omissions and unbounded delivery. No manual tracker
parser or mock supplied the corpus.

The script sorts the real item identities, projects them into synthetic Jira
keys, and selects real active/terminal status membership. Three active items
are withheld from the first selection to exercise entries. Supplied exclusion
evidence comes from the real terminal statuses. This exercises actual tracker
data, not live Jira search or permissions.

| Measurement | Result |
| --- | ---: |
| Tracker items / active items | 105 / 5 |
| Before keys / pages | 102 / 3 |
| After keys / pages | 5 / 1 |
| Retained / entries / exits | 2 / 3 / 100 |
| Explicit query-excluded exits | 100 |
| Default returned rows / JSON bytes | 32 / 3,061 |
| Rows recovered with seven-row pages | 103 |
| Exits unresolved when evidence is removed | 100 |
| Exits classified by injected permission-loss evidence | 100 |
| Truncated after-chain | `incomplete_chain`, zero changes |
| Writes / deletion proposals | 0 / 0 |
| Copied tracker byte changes | 0 |

The copied tree SHA-256 before and after was
`6aecdaf8becb627fe344ded8f31a6a7970c368cc450e4fdba07318b386a44dff`.
The script fingerprints every file, not just item counts. Re-run with:

```sh
node scripts/validate-jql-selection.ts "$PUBLIC_TRACKER_COPY"
```

`PUBLIC_TRACKER_COPY` must name an exported public tracker in a non-git scratch
project; use a read-only copy and disable git discovery. The validator prints
only counts, the SDK certificate and a tree hash. It never modifies the copy.
Permission-loss observations are deliberately injected to test the classifier;
there is no claim of live Jira authorization validation or atomic search capture.
