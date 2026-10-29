/** File adapter and host-owned command registration for create previews. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { parseJiraOptions } from "./option-boundary.ts";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { createPreviewRefusal, previewJiraCreate } from "./create-preview.ts";
import type { JiraCreatePreviewResult, JiraCreateRefusal } from "./create-preview.ts";

/** Read bounded regular JSON input without trusting file size or blocking on FIFOs. */
export function readCreateContract(file: string): { value: unknown } | JiraCreateRefusal {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { return createPreviewRefusal("input_read"); }
  let failure: JiraCreateRefusal;
  try {
    if (!fstatSync(fd).isFile()) return createPreviewRefusal("input_read");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes === buffer.length) return createPreviewRefusal("input_read");
    return { value: JSON.parse(buffer.subarray(0, bytes).toString("utf8")) as unknown };
  } catch { failure = createPreviewRefusal("input_read"); }
  finally { closeSync(fd); }
  return failure;
}
/** Compile exactly the supplied contract; SDK and CLI share the same strict input boundary. */
export function runCreatePreview(options: Record<string, unknown>, cwd: string): JiraCreatePreviewResult {
  options = parseJiraOptions(options);
  if (typeof options.contract !== "string") return createPreviewRefusal("invalid_input");
  const input = readCreateContract(resolve(cwd, options.contract));
  return "kind" in input ? input : previewJiraCreate(input.value);
}
/** Register host parsing, semantic exits and compact TOON/JSON output without git requirements. */
export function registerCreatePreviewCommand(api: ExtensionApi): void {
  api.registerCommand({ name: "jira preview-create", description: "Preview required Jira create bindings and missing answers without writes",
    intent: "Validate an explicitly selected project/type against revisioned create metadata before export",
    examples: ["pm jira preview-create --contract create.json --json"], read_output: { row_keys: ["diagnostics"] },
    flags: [{ long: "--contract", value_name: "file", description: "Strict v1 JSON contract with metadata, project, issueType, answers and optional byte budget/offset" }],
    async run(ctx) { return runCreatePreview(ctx.options, process.cwd()); },
  });
}
