/** Portable command adapter; the pm host owns parsing, output and refusal exits. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { parseJiraOptions } from "./option-boundary.js";
import { explainJqlSelectionChanges, jqlSelectionRefusal, resolveJqlSelectionOptions } from "./jql-selection.js";
const MAX_BYTES = 8 * 1024 * 1024;
/** Read at most 8 MiB plus one byte from a regular file, even if it grows. */
function readSnapshot(file) {
    let fd;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    }
    catch {
        return jqlSelectionRefusal("input_read", "Supply readable before/after JSON files; no tracker or Jira writes were attempted.");
    }
    let failure;
    try {
        if (!fstatSync(fd).isFile())
            return jqlSelectionRefusal("input_read", "Supply regular JSON snapshot files, not directories or devices.");
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
            if (count === 0)
                break;
            bytes += count;
        }
        if (bytes > MAX_BYTES)
            return jqlSelectionRefusal("snapshot_limit", "Supply complete JSON snapshots of at most 8 MiB each; narrow the synchronized scope instead of truncating it.");
        try {
            return { value: JSON.parse(buffer.subarray(0, bytes).toString("utf8")) };
        }
        catch {
            return jqlSelectionRefusal("input_json", "Supply valid JSON selection snapshots; do not use clipped command output or TOON as input.");
        }
    }
    catch {
        failure = jqlSelectionRefusal("input_read", "Restore readable regular snapshot files and retry; no comparison was inferred.");
    }
    finally {
        closeSync(fd);
    }
    return failure;
}
/** Load two explicit files relative to the caller, with no implicit tracker or git read. */
export function runJqlSelectionComparison(options, cwd) {
    options = parseJiraOptions(options);
    if (typeof options.before !== "string" || typeof options.after !== "string") {
        return jqlSelectionRefusal("invalid_options", "Pass --before before.json and --after after.json; see jira explain-selection --help.");
    }
    // Scalar coercion belongs to the shared option boundary; the pure planner
    // retains its own SDK pagination domain checks.
    const page = resolveJqlSelectionOptions({ limit: options.limit, offset: options.offset });
    if ("kind" in page)
        return page;
    const before = readSnapshot(resolve(cwd, options.before));
    if ("kind" in before)
        return before;
    const after = readSnapshot(resolve(cwd, options.after));
    if ("kind" in after)
        return after;
    return explainJqlSelectionChanges(before.value, after.value, page);
}
/** Register the read-only SDK comparison with host-owned TOON/JSON and row budgets. */
export function registerJqlSelectionCommand(api) {
    api.registerCommand({
        name: "jira explain-selection",
        description: "Explain entries and exits between two explicit JQL selection snapshots, preserving local work",
        intent: "Distinguish query exclusion from permission loss without proposing deletions",
        examples: ["pm jira explain-selection --before before.json --after after.json --limit 32 --json"],
        read_output: { row_keys: ["changes"] },
        flags: [
            { long: "--before", value_name: "file", description: "Earlier complete JSON selection snapshot" },
            { long: "--after", value_name: "file", description: "Later complete JSON selection snapshot" },
            { long: "--limit", value_name: "count", description: "Changes per page, 1..256 (default 32)" },
            { long: "--offset", value_name: "count", description: "Change offset (default 0)" },
        ],
        async run(ctx) { return runJqlSelectionComparison(ctx.options, process.cwd()); },
    });
}
//# sourceMappingURL=jql-selection-command.js.map