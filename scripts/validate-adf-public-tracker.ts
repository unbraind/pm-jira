/** Read-only measurement of capture/replay against a copied public tracker, without git subprocesses. */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { importPmSdk } from "../sdk-importer.ts";
import { captureAdfEvidence, replayAdfEvidence } from "../adf-evidence.ts";

const [root, report] = process.argv.slice(2);
if (!root || !report) throw new Error("Supply a copied public tracker and a scratch report filename");
const { listAllComplete } = await importPmSdk();
const options = { pmRoot: root, cwd: root, noExtensions: true };
const before = await listAllComplete({ includeBody: true }, options);
let captured = 0; let refused = 0; let retained = 0; let sourceNodes = 0; let sourceChanged = 0; let bytes = 0; let maxBytes = 0; let bodyBytes = 0;
for (const [i, item] of before.items.entries()) {
  // This is an explicit ADF projection of real public native fields, not a claim
  // that a fleet tracker contains Jira ADF or that live Jira was contacted.
  const body = typeof item.body === "string" ? item.body : typeof item.description === "string" ? item.description : item.title;
  bodyBytes += Buffer.byteLength(body);
  const input = { version: 1, budget: 65536, source: { site: "https://example.invalid", issue: `PUBLIC-${i + 1}`, revision: item.updated_at,
    document: { type: "doc", version: 1, content: [
      { type: "paragraph", content: [{ type: "text", text: "excluded context" }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colwidth: null, background: null }, content: [
        { type: "paragraph", content: [{ type: "text", text: item.title }] },
      ] }, { type: "tableHeader", attrs: { colwidth: null, background: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "excluded sibling" }] }] }] }] },
      { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: body }] },
      { type: "extension", attrs: { unselected: true } }, { type: "media", attrs: { id: "excluded attachment" } },
    ] } }, select: ["/content/1/content/0/content/0", "/content/2"] };
  const preview = captureAdfEvidence(input);
  if (preview.kind === "refused") { if (preview.code !== "budget_exceeded") throw new Error(`Unexpected capture refusal: ${preview.code}`); refused++; continue; }
  const approval = { revision: preview.packet.source.revision, digest: preview.packet.source.digest };
  const result = captureAdfEvidence({ ...input, approval });
  if (result.kind !== "captured") throw new Error("Reviewed projection did not capture");
  const replayed = replayAdfEvidence(JSON.parse(JSON.stringify(result.packet)));
  if (replayed.kind !== "replayed" || replayed.document.content?.[1]?.content?.[0]?.text !== body || replayed.document.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text !== item.title) throw new Error("Public native field round-trip differs");
  if (replayed.document.content[0]?.content?.[0]?.content?.[0]?.attrs?.colwidth !== null || replayed.document.content[0]?.content?.[0]?.content?.[0]?.attrs?.background !== null || replayed.document.content[1]?.attrs?.language !== null) throw new Error("Nullable editor default round-trip differs");
  const stale = captureAdfEvidence({ ...input, source: { ...input.source, revision: `${item.updated_at}-new` }, approval });
  if (stale.kind !== "refused" || stale.code !== "source_changed") throw new Error("Changed revision did not refuse");
  sourceChanged++; captured++; retained += result.packet.counts.retained; sourceNodes += result.packet.counts.source;
  const size = Buffer.byteLength(JSON.stringify(result, null, 2)) + 1; bytes += size; maxBytes = Math.max(maxBytes, size);
}
const after = await listAllComplete({ includeBody: true }, options);
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
if (fingerprint(before.items) !== fingerprint(after.items)) throw new Error("Read-only tracker state changed");
const result = { items: before.items.length, captured, budgetRefused: refused, sourceNodes, retainedNodes: retained, sourceChangedRefusals: sourceChanged, nativeBodyBytes: bodyBytes, emittedBytes: bytes, maxPacketBytes: maxBytes, nativeStateUnchanged: true, liveJiraCalls: 0, projection: "exact public SDK title and body-or-description in ADF table/code wrappers" };
writeFileSync(report, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
