import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import type { JqlSelectionResult } from "./jql-selection.ts";
/** Load two explicit files relative to the caller, with no implicit tracker or git read. */
export declare function runJqlSelectionComparison(options: Record<string, unknown>, cwd: string): JqlSelectionResult;
/** Register the read-only SDK comparison with host-owned TOON/JSON and row budgets. */
export declare function registerJqlSelectionCommand(api: ExtensionApi): void;
//# sourceMappingURL=jql-selection-command.d.ts.map