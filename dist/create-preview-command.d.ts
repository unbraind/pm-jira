import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import type { JiraCreatePreviewResult, JiraCreateRefusal } from "./create-preview.ts";
/** Read bounded regular JSON input without trusting file size or blocking on FIFOs. */
export declare function readCreateContract(file: string): {
    value: unknown;
} | JiraCreateRefusal;
/** Compile exactly the supplied contract; SDK and CLI share the same strict input boundary. */
export declare function runCreatePreview(options: Record<string, unknown>, cwd: string): JiraCreatePreviewResult;
/** Register host parsing, semantic exits and compact TOON/JSON output without git requirements. */
export declare function registerCreatePreviewCommand(api: ExtensionApi): void;
//# sourceMappingURL=create-preview-command.d.ts.map