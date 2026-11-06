import type { CommitItemMutationsOptions, CommitItemMutationsResult } from "@unbrained/pm-cli/sdk";
import { type PmSdkModule } from "./sdk-importer.ts";
/** A tracker root or a reusable binding; this is not an arbitrary backend adapter. */
export type JiraPersistenceTarget = string | JiraPersistence;
/**
 * Pin one filesystem tracker before asynchronous work can change the process cwd.
 * The SDK owns validation, locks, history, completeness and batch recovery.
 * This binding adds no database emulation and makes no snapshot-isolation claim.
 */
export declare class JiraPersistence {
    /** Absolute tracker identity, shared by every SDK persistence operation. */
    readonly pmRoot: string;
    /** Observable scope of this implementation; no native database support is claimed. */
    readonly capabilities: Readonly<{
        readonly backend: "filesystem";
        readonly completeRead: "certified-corpus";
        readonly batchWrite: "recoverable-compensation";
    }>;
    /** Bind synchronously, without accessing the tracker or loading extensions. */
    constructor(pmRoot: string);
    /** Read all bodies and lifecycle states using the SDK completeness contract. */
    readComplete(): Promise<import("@unbrained/pm-cli/sdk").PmCompleteListResult>;
    /** Read authoritative settings for this tracker, including its identifier prefix. */
    readSettings(): Promise<import("@unbrained/pm-cli/sdk").PmSettings>;
    /** Create through the SDK with the same extension behavior as ordinary imports. */
    create(options: Parameters<PmSdkModule["create"]>[0]): Promise<import("@unbrained/pm-cli/sdk").CreateResult>;
    /** Commit through the resolved SDK coordinator without a per-call root override. */
    commit(options: Omit<CommitItemMutationsOptions, "pmRoot">, coordinator: (options: CommitItemMutationsOptions) => Promise<CommitItemMutationsResult>): Promise<CommitItemMutationsResult>;
}
/** Reuse a binding or synchronously pin a path at the public operation boundary. */
export declare function bindJiraPersistence(target: JiraPersistenceTarget): JiraPersistence;
//# sourceMappingURL=persistence.d.ts.map