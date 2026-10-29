# Selected Jira description evidence

`pm jira capture-adf --contract capture.json --json` produces a portable,
read-only evidence packet from an explicitly supplied Jira description snapshot.
Omit `--json` for the host's compact TOON rendering. It needs neither git nor
Jira credentials. Capture never changes native items, Jira, or attachment files.

Start with [the complete example](examples/adf-capture.json). The strict v1
contract has `source` (`site`, `issue`, `revision`, `document`), `select` and an
optional `budget` and `approval`. `site` is an HTTPS origin; `issue` is the exact
Jira key. Supply a revision observed when reading the issue, such as its Jira
`updated` timestamp. `document` is the ADF description only, not an entire REST
response. Never put attachments or comments in the contract.

1. Read a fresh issue description and revision from your authorized source.
2. Select explicit block pointers relative to the description root. For example,
   `/content/1/content/0/content/0` selects a cell in the second top-level block;
   `/content/2` selects the third block. Selectors must exist, be unique and not
   overlap. Selecting a container selects its supported descendants.
3. Run capture without `approval`. Review the `preview` packet. Approve its
   `source.revision` and `source.digest`, not the outer packet digest.
4. Read the source again and run the same contract with that fresh `source` and
   `approval: {"revision":"...","digest":"..."}`. An exact match returns
   `captured`; a changed revision, identity or description returns `source_changed`.
5. Save the complete captured `packet` as JSON. It can be cited with pm-evidence's
   existing JSON-pointer/retention commands. For example, after saving the packet
   as `evidence.json`: `pm evidence cite decision-id evidence.json --pointer /nodes/4 --retain`.
   Citation recording and ongoing freshness belong to pm-evidence.

Approval proves agreement with the **supplied snapshot**. The command does not
fetch Jira or attest that a file is current. Even an edit in an unselected block
changes the source digest. A revision-only change also invalidates approval,
including an A → B → A description edit with a newer revision. Reusing an old
snapshot and its old approval cannot establish live freshness. The digest is an
integrity check, not an authentication signature.

## Structure and addresses

`packet.nodes` is a source-order list of retained nodes, each with its original
RFC 6901 `pointer`. Identity is `(site, issue, revision, source digest, pointer)`.
Ancestors needed for interpretation have `context: true`; they contain only
structural attributes. Other nodes have `context: false`. Unselected siblings
are absent. Coordinates never shift to fill gaps in the source.

Supported nodes: doc, paragraph, text, hardBreak, heading, codeBlock, blockquote,
bulletList, orderedList, listItem, table, tableRow, tableCell, tableHeader, rule.
Code language, heading level, list start and cell span/width/background are
retained. Text, whitespace and CRLF are exact. Simple strong/em/code/strike/
underline marks are retained. Other marks, including block formatting marks, are excluded and counted. Empty
block mark arrays remain accepted.
Unfamiliar attributes never leave the snapshot.

Media and card nodes (media, mediaInline, mediaGroup, mediaSingle, inlineCard,
blockCard) are excluded. Other unsupported nodes are counted separately. Their
entire subtrees are excluded, even if a descendant would otherwise be supported.
Counts refer to individual source nodes: `source = retained + context +
unselected + unsupported + attachments`. Supported descendants below excluded
nodes count as `unselected`. `omittedMarks` covers retained and context nodes. No excluded
node attributes or attachment references are emitted. Ordinary selected text can
still contain sensitive data; the caller must choose the intended selection.

## SDK

```ts
import { captureAdfEvidence, replayAdfEvidence } from 'pm-jira';
import type { AdfCaptureInput } from 'pm-jira';

const preview = captureAdfEvidence(contract satisfies AdfCaptureInput);
if (preview.kind !== 'refused') {
  const captured = captureAdfEvidence({ ...contract, source: freshlyReadSource,
    approval: { revision: preview.packet.source.revision,
      digest: preview.packet.source.digest } });
  if (captured.kind === 'captured') {
    const restored = replayAdfEvidence(JSON.parse(JSON.stringify(captured.packet)));
    // restored.document is selective ADF; restored.coordinates maps its dense
    // coordinates back to the original pointers (including table cell positions).
  }
}
```

Replay accepts only an intact v1 packet and verifies schema, integrity, parent
boundaries and counts. It makes no source freshness claim. Selective ADF is for
evidence consumption, not replacing the original Jira description: omitted
siblings stay omitted, and coordinate mapping retains their original positions.
There is no new import/export/sync, native field, journal or idempotency cache.
A malformed packet refuses alone and does not affect other packets or items.

## Bounds and refusals

The request must be dense, finite JSON of at most 1 MiB, with at most 8192 ADF
nodes, ADF depth 32 and 1..64 nonoverlapping block selectors. Arrays have at most
8192 entries (marks 32, colwidth 256). JSON has at most 65536 values and depth 72.
Integers use safe domains: heading 1..6, order 0..1000000, spans 1..1000000,
widths 0..1000000. Known attribute strings have at most 128 characters.
The default output budget is 8192 bytes, configurable 4096..65536; it covers
pretty JSON plus newline. TOON also passes through the host renderer's budget.
Capture refuses oversized packets rather than clipping evidence or a code block.

All refusals carry `kind: refused`, a stable `code`, `remediation` and exit code 2:

| Code | Remedy |
| --- | --- |
| invalid_input | Use the strict v1 contract and documented finite bounds. |
| selection_missing | Select an existing supported block with supported ancestors. |
| source_changed | Read a fresh source, review the new preview and explicitly approve it. |
| budget_exceeded | Narrow selection or increase the budget; no partial packet exists. |
| invalid_packet | Replay an intact producer packet or recapture; do not edit it. |
| input_read | Supply a readable regular JSON file within the size cap. |

The package uses the host command contract, output renderer, supported SDK loader,
file adapter and testing harness. Since the capture/replay paths have no tracker
writes, they need no writer lease and make no transaction isolation claim. The
remaining source-observation window is between the caller's last Jira read and
capture; a change after that read is not detected until another source read.
`commitWorkspaceTransaction` would not close that window or isolate ordinary
SDK/CLI writers (pm-cli issue 1620).

ADF node boundaries follow [Atlassian's document structure](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/),
[table-cell attributes](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/table_cell/)
and [ordered-list attributes](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/orderedList/).
