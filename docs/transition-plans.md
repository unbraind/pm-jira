# Transition planning SDK example

```ts
import { discoverJiraTransitionPlan, planJiraTransition } from 'pm-jira';

const plan = await discoverJiraTransitionPlan({
  issue: 'DEMO-123', target: 'closed', transitionId: '31',
  fields: { resolution: { id: '1' } },
});
if (plan.kind === 'refused') {
  console.log(plan.code, plan.remediation);
} else {
  console.log(plan.kind, plan.steps); // advisory; no execution occurs
}

// Offline: Jira currently permits only an intermediate Review transition.
const blocked = planJiraTransition(
  { issue: 'DEMO-123', target: 'closed' },
  { key: 'DEMO-123', fields: { status: {
    id: '1', name: 'To Do', statusCategory: { key: 'new' },
  } } },
  { transitions: [{ id: '21', name: 'Review', to: {
    id: '2', name: 'Review', statusCategory: { key: 'indeterminate' },
  }, fields: {} }] },
);
// blocked.kind === 'refused'; blocked.code === 'no_permitted_transition'
// blocked.choices contains Review; no hypothetical Review -> Done edge is trusted.
```

Discovery uses two GET requests: issue status, then transitions with
`expand=transitions.fields&includeUnavailableTransitions=false`. See the
[Jira transitions API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-transitions-get).
The offline planner accepts these REST response shapes as `unknown` and validates
metadata before planning. Omitted field metadata is a refusal, not an empty
screen. Plans carry the issue key, observed source status ID, target lifecycle,
and selected transition ID/name/destination plus required field names. Values
remain in the caller's intent; this is a planning receipt, not a POST payload.

Refusal codes: `invalid_input`, `metadata_invalid`, `discovery_failed`,
`no_permitted_transition`, `ambiguous_transition`, `fields_required`,
`fields_invalid`. A no-op needs no transition. Supplying an explicit transition
ID asks to plan that transition even when already in the desired lifecycle.

## Public tracker validation

The public pm-jira tracker at main commit
`01fb41c6625106f4f18f1927cd65367ef3dc374f` was copied into a non-git scratch
directory and made filesystem read-only before measurement. The package's
`readPmItems` uses the pinned SDK's certified complete read with bodies, every
lifecycle state and extensions disabled. SHA-256 comparisons of the full copied
tree before and after found no changes, including no new runtime cache files.

The corpus contained **104 items**: 90 closed, 6 open, 5 in progress, 2 blocked,
and 1 canceled. The 103 supported lifecycle items supplied current-state intents
to four synthetic transition-discovery snapshots: direct completion, no permitted
edge, an intermediate Review edge, and completion requiring a resolution.
The canceled item was counted but excluded from the four-state Jira adapter.
**412 plans** produced 13 ready receipts, 26 no-permitted-transition refusals,
13 required-field refusals and 360 no-ops. Largest compact JSON receipt:
**366 bytes**. Tracker changes: **0**; Jira writes: **0**.

This validates real public tracker lifecycle data with synthetic Jira workflow
metadata. It is not a live Jira tenant or execution validation. Separate HTTPS
regressions verify GET-only discovery, permission failure, malformed responses,
secret redaction and an installed CLI running with no git executable on PATH.
