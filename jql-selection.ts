/** Offline Jira query membership explanations over caller-supplied evidence. */

/** One complete enhanced-search response projected to keys; tokens stay opaque. */
export interface JqlSelectionPage {
  requestToken?: string;
  nextPageToken?: string;
  isLast: boolean;
  keys: string[];
}

/** Independent evidence collected under this snapshot's site, principal and time. */
export interface JqlVisibilityEvidence {
  key: string;
  state: "visible" | "query_excluded" | "permission_lost" | "not_found" | "unknown";
}

/** Explicit selection boundary; completeness is checked rather than asserted by a flag. */
export interface JqlSelectionSnapshot {
  version: 1;
  site: string;
  principal: string;
  scope: string;
  capturedAt: string;
  jql: string;
  pages: JqlSelectionPage[];
  visibility: JqlVisibilityEvidence[];
}

/** Independent output page controls; every omitted change remains recoverable. */
export interface JqlSelectionOptions {
  limit?: number;
  offset?: number;
}

/** Stable machine-readable refusal reasons shared by SDK and CLI. */
export type JqlSelectionRefusalCode = "invalid_snapshot" | "snapshot_limit" | "incomplete_chain"
  | "boundary_mismatch" | "time_order" | "conflicting_evidence" | "invalid_options" | "input_read" | "input_json";

/** Safe refusal envelope consumed by the pm host's semantic exit contract. */
export interface JqlSelectionRefusal {
  kind: "refused";
  changes: [];
  code: JqlSelectionRefusalCode;
  remediation: string;
  writes: 0;
  deletionProposals: 0;
  exit_code: 2;
}

/** A membership change, never a tracker mutation or proof of Jira deletion. */
export interface JqlSelectionChange {
  key: string;
  change: "entry" | "exit";
  reason: "selected" | "query_excluded" | "permission_lost" | "unresolved";
  localAction: "preserve";
}

/** Compact counts cover all changes even when the returned page is bounded. */
export interface JqlSelectionExplanation {
  kind: "explained";
  basis: "supplied_snapshots";
  queryChanged: boolean;
  counts: { before: number; after: number; retained: number; entries: number; exits: number;
    queryExcluded: number; permissionLost: number; unresolved: number };
  changes: JqlSelectionChange[];
  page: { offset: number; limit: number; total: number; omitted: number; nextOffset: number | null };
  writes: 0;
  deletionProposals: 0;
}

/** Either a bounded explanation or a refusal with a concrete recovery action. */
export type JqlSelectionResult = JqlSelectionExplanation | JqlSelectionRefusal;

/** Build a redacted refusal without echoing snapshot contents or file paths. */
export function jqlSelectionRefusal(code: JqlSelectionRefusalCode, remediation: string): JqlSelectionRefusal {
  return { kind: "refused", changes: [], code, remediation, writes: 0, deletionProposals: 0, exit_code: 2 };
}

/** Narrow parsed JSON without trusting a caller's TypeScript annotation. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject empty, padded, control-bearing or unbounded boundary identifiers. */
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Keys are identities, not issue summaries; output stays bounded per row. */
function jiraKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[A-Z][A-Z0-9_]*-\d+$/.test(value);
}

/** Require a canonical HTTPS origin so equivalent or credential-bearing sites cannot mix. */
function siteOrigin(value: unknown): boolean {
  if (!text(value, 256)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; }
  catch { return false; }
}

/** Validate the explicit page chain before deriving any membership differences. */
function validateSnapshot(value: unknown): { snapshot: JqlSelectionSnapshot; keys: Set<string> } | JqlSelectionRefusal {
  const invalid = () => jqlSelectionRefusal("invalid_snapshot", "Supply v1 snapshots with canonical HTTPS site, principal, scope, ISO UTC capturedAt, JQL, pages and visibility; see the selection example.");
  if (!record(value) || value.version !== 1 || !siteOrigin(value.site) || !text(value.principal, 256) ||
      !text(value.scope, 256) || !text(value.jql, 8192) || typeof value.capturedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.capturedAt) ||
      !Number.isFinite(Date.parse(value.capturedAt)) || new Date(value.capturedAt).toISOString() !== value.capturedAt ||
      !Array.isArray(value.pages) || !Array.isArray(value.visibility)) return invalid();
  if (value.pages.length > 1000 || value.visibility.length > 10000) {
    return jqlSelectionRefusal("snapshot_limit", "Supply at most 1000 pages and 10000 keys or visibility observations per snapshot; narrow the complete synchronized scope.");
  }
  const incomplete = () => jqlSelectionRefusal("incomplete_chain", "Recapture every page from the initial request through isLast=true, preserving exact request/next tokens; a capped import is not a complete selection.");
  if (value.pages.length === 0) return incomplete();
  const keys = new Set<string>();
  const tokens = new Set<string>();
  let expected: string | undefined;
  for (let index = 0; index < value.pages.length; index++) {
    const page: unknown = value.pages[index];
    if (!record(page) || !Array.isArray(page.keys) || typeof page.isLast !== "boolean") return invalid();
    if (page.requestToken !== expected || page.isLast !== (index === value.pages.length - 1)) return incomplete();
    if (page.isLast) {
      if (page.nextPageToken !== undefined) return incomplete();
    } else {
      if (!text(page.nextPageToken, 8192) || tokens.has(page.nextPageToken)) return incomplete();
      tokens.add(page.nextPageToken);
      expected = page.nextPageToken;
    }
    if (page.keys.length > 100 || keys.size + page.keys.length > 10000) {
      return jqlSelectionRefusal("snapshot_limit", "Keep each enhanced-search page at most 100 keys and each complete selection at most 10000 keys; narrow the JQL scope, never truncate pages.");
    }
    for (const key of page.keys) {
      if (!jiraKey(key) || keys.has(key)) return invalid();
      keys.add(key);
    }
  }
  const observed = new Set<string>();
  for (const observation of value.visibility) {
    if (!record(observation) || !jiraKey(observation.key) ||
        typeof observation.state !== "string" || !["visible", "query_excluded", "permission_lost", "not_found", "unknown"].includes(observation.state) || observed.has(observation.key)) return invalid();
    if (keys.has(observation.key) && observation.state !== "visible") {
      return jqlSelectionRefusal("conflicting_evidence", "Recapture consistent visibility evidence: a selected key must be visible to the same principal at that snapshot.");
    }
    observed.add(observation.key);
  }
  return { snapshot: value as unknown as JqlSelectionSnapshot, keys };
}

/** Resolve bounded output pagination for SDK and command inputs before reading files. */
export function resolveJqlSelectionOptions(options: JqlSelectionOptions): { limit: number; offset: number } | JqlSelectionRefusal {
  const { limit = 32, offset = 0 } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || !Number.isSafeInteger(offset) || offset < 0) {
    return jqlSelectionRefusal("invalid_options", "Set limit to an integer in 1..256 and offset to a nonnegative safe integer.");
  }
  return { limit, offset };
}

/**
 * Compare membership without I/O or JQL evaluation. Missing keys alone cannot
 * distinguish lost visibility, deletion, query exclusion or eventual consistency.
 * Visibility evidence is a caller assertion, not server-verified authorization.
 * All local work is preserved, including on incomplete or ambiguous input.
 */
export function explainJqlSelectionChanges(before: unknown, after: unknown, options: JqlSelectionOptions = {}): JqlSelectionResult {
  const page = resolveJqlSelectionOptions(options);
  if ("kind" in page) return page;
  const { limit, offset } = page;
  const left = validateSnapshot(before);
  if ("kind" in left) return left;
  const right = validateSnapshot(after);
  if ("kind" in right) return right;
  const a = left.snapshot; const b = right.snapshot;
  if (a.site !== b.site || a.principal !== b.principal || a.scope !== b.scope) {
    return jqlSelectionRefusal("boundary_mismatch", "Compare snapshots from the same site, principal and synchronized scope; changing users cannot establish permission loss.");
  }
  if (a.capturedAt > b.capturedAt) return jqlSelectionRefusal("time_order", "Supply the earlier selection as before and the later selection as after.");
  const visibility = new Map(b.visibility.map(row => [row.key, row.state]));
  const changes: JqlSelectionChange[] = [];
  const counts = { before: left.keys.size, after: right.keys.size, retained: 0, entries: 0, exits: 0,
    queryExcluded: 0, permissionLost: 0, unresolved: 0 };
  for (const key of left.keys) {
    if (right.keys.has(key)) { counts.retained++; continue; }
    const state = visibility.get(key);
    const reason = state === "query_excluded" ? "query_excluded" : state === "permission_lost" ? "permission_lost" : "unresolved";
    counts.exits++;
    if (reason === "query_excluded") counts.queryExcluded++;
    else if (reason === "permission_lost") counts.permissionLost++;
    else counts.unresolved++;
    changes.push({ key, change: "exit", reason, localAction: "preserve" });
  }
  for (const key of right.keys) {
    if (!left.keys.has(key)) {
      counts.entries++;
      changes.push({ key, change: "entry", reason: "selected", localAction: "preserve" });
    }
  }
  changes.sort((a, b) => a.key < b.key ? -1 : 1);
  const rows = changes.slice(offset, offset + limit);
  const next = offset + rows.length;
  return { kind: "explained", basis: "supplied_snapshots", queryChanged: a.jql !== b.jql, counts, changes: rows,
    page: { offset, limit, total: changes.length, omitted: changes.length - rows.length, nextOffset: next < changes.length ? next : null },
    writes: 0, deletionProposals: 0 };
}
