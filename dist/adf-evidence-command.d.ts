import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import type { AdfCaptureResult } from "./adf-evidence.ts";
/** Resolve a caller-selected contract without reading tracker items or contacting Jira. */
export declare function runAdfCapture(options: Record<string, unknown>, cwd: string): AdfCaptureResult;
/** Register an agent-sized portable capture command that works without git or credentials. */
export declare function registerAdfCaptureCommand(api: ExtensionApi): void;
//# sourceMappingURL=adf-evidence-command.d.ts.map