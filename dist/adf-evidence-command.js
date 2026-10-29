/** Bounded offline file adapter; host owns rendering, budgets and semantic refusal exits. */
import { resolve } from "node:path";
import { readCreateContract } from "./create-preview-command.js";
import { parseJiraOptions } from "./option-boundary.js";
import { adfEvidenceRefusal, captureAdfEvidence } from "./adf-evidence.js";
/** Resolve a caller-selected contract without reading tracker items or contacting Jira. */
export function runAdfCapture(options, cwd) {
    const parsed = parseJiraOptions(options);
    if (typeof parsed.contract !== "string")
        return adfEvidenceRefusal("invalid_input");
    const read = readCreateContract(resolve(cwd, parsed.contract));
    return "kind" in read ? adfEvidenceRefusal("input_read") : captureAdfEvidence(read.value);
}
/** Register an agent-sized portable capture command that works without git or credentials. */
export function registerAdfCaptureCommand(api) {
    api.registerCommand({ name: "jira capture-adf", description: "Capture selected revision-approved Jira description blocks as portable evidence",
        intent: "Preserve original code/list/table coordinates while excluding unselected blocks and attachment nodes",
        examples: ["pm jira capture-adf --contract adf-capture.json --json"],
        flags: [{ long: "--contract", value_name: "file", description: "Strict v1 JSON source snapshot, block pointers and optional approval; see docs/adf-evidence.md" }],
        async run(ctx) { return runAdfCapture(ctx.options, process.cwd()); },
    });
}
//# sourceMappingURL=adf-evidence-command.js.map