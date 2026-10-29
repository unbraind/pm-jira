/** One shared boundary schema for all Jira command options and public readers. */
import { importPmSdk } from "./sdk-importer.ts";
const { createPmCliExpectedError, EXIT_CODE } = await importPmSdk();

const pull = ["project", "project-key", "jql", "host", "max-results", "status", "assignee", "issue-type", "label", "updated-since", "status-map", "map", "field-map"];
/** Value-bearing option inventory; regression tests reconcile it with actual registrations. */
export const JIRA_OPTION_TABLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "jira sync": pull,
  "jira import": pull,
  "jira-sync import": [...pull, "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
  "jira export": ["project", "project-key", "host", "map", "field-map", "create-contract"],
  "jira validate": ["host"],
  "jira plan-transition": ["issue", "to", "transition", "fields", "status-map", "host"],
  "jira explain-selection": ["before", "after", "limit", "offset"],
  "jira preview-create": ["contract"],
  "jira capture-adf": ["contract"],
});
const booleans = new Set(["dry-run", "atomic", "push", "rich", "update-existing"]);
const numbers = new Set(["max-results", "limit", "offset"]);
const text = new Set(Object.values(JIRA_OPTION_TABLE).flat().filter(key => !numbers.has(key)));
const validated = new WeakSet<object>();

/** Emit a redacted SDK usage error and concrete remedy without reflecting option values. */
function invalidOption(): never {
  throw createPmCliExpectedError("Supplied Jira options must contain meaningful values. Omit unused options, or supply a nonblank value of the documented type; guards cannot be disabled with blank values. See command --help.", {
    exitCode: EXIT_CODE.USAGE,
    context: { code: "invalid_option", recovery: { suggested_retry: "Omit unused options or provide nonblank documented values; rerun command --help." } },
  });
}
/** Treat kebab/camel spellings identically without rewriting config credential identifiers. */
function canonical(key: string): string {
  return key.startsWith("JIRA_") ? key : key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}
/**
 * Validate the whole supplied bag before defaults, alias selection, I/O or credentials.
 * Only undefined denotes an omitted option. Every string is trimmed once and must
 * remain nonempty; known options also enforce their scalar type. The returned
 * shallow snapshot is immutable, so later caller edits cannot bypass validation.
 * Reusing that snapshot does not repeat validation; raw bags are always rechecked.
 */
export function parseJiraOptions(input: unknown): Record<string, unknown> {
  if (input === undefined) input = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalidOption();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalidOption();
  if (validated.has(input)) return input as Record<string, unknown>;
  const entries = Object.entries(input);
  if (entries.length > 256) invalidOption();
  const result: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    if (key.length === 0 || key.length > 128) invalidOption();
    if (raw === undefined) continue;
    let value: unknown = typeof raw === "string" ? raw.trim() : raw;
    if ((typeof value === "string" && (value.length === 0 || value.length > 1048576)) ||
        (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") ||
        (typeof value === "number" && !Number.isFinite(value))) invalidOption();
    const name = canonical(key);
    if (text.has(name) && typeof value !== "string") invalidOption();
    if (numbers.has(name)) {
      const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (!Number.isSafeInteger(number) || number < (name === "offset" ? 0 : 1)) invalidOption();
      value = number;
    }
    if (booleans.has(name) && !(typeof value === "boolean" || value === 0 || value === 1 ||
        (typeof value === "string" && /^(true|false|yes|no|0|1)$/i.test(value)))) invalidOption();
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  Object.freeze(result);
  validated.add(result);
  return result;
}
