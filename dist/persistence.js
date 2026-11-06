/** Filesystem persistence binding for the currently supported public PM SDK. */
import { resolve } from "node:path";
import { importPmSdk } from "./sdk-importer.js";
/**
 * Pin one filesystem tracker before asynchronous work can change the process cwd.
 * The SDK owns validation, locks, history, completeness and batch recovery.
 * This binding adds no database emulation and makes no snapshot-isolation claim.
 */
export class JiraPersistence {
    /** Absolute tracker identity, shared by every SDK persistence operation. */
    pmRoot;
    /** Observable scope of this implementation; no native database support is claimed. */
    capabilities = Object.freeze({
        backend: "filesystem",
        completeRead: "certified-corpus",
        batchWrite: "recoverable-compensation",
    });
    /** Bind synchronously, without accessing the tracker or loading extensions. */
    constructor(pmRoot) {
        this.pmRoot = resolve(pmRoot);
        Object.freeze(this);
    }
    /** Read all bodies and lifecycle states using the SDK completeness contract. */
    async readComplete() {
        const sdk = await importPmSdk();
        return sdk.listAllComplete({ includeBody: true }, {
            pmRoot: this.pmRoot, cwd: this.pmRoot, noExtensions: true,
        });
    }
    /** Read authoritative settings for this tracker, including its identifier prefix. */
    async readSettings() {
        const sdk = await importPmSdk();
        return sdk.readSettings(this.pmRoot);
    }
    /** Create through the SDK with the same extension behavior as ordinary imports. */
    async create(options) {
        const { PmClient } = await importPmSdk();
        return new PmClient({ pmRoot: this.pmRoot, cwd: this.pmRoot }).create(options);
    }
    /** Commit through the resolved SDK coordinator without a per-call root override. */
    commit(options, coordinator) {
        return coordinator({ ...options, pmRoot: this.pmRoot });
    }
}
/** Reuse a binding or synchronously pin a path at the public operation boundary. */
export function bindJiraPersistence(target) {
    return target instanceof JiraPersistence ? target : new JiraPersistence(target);
}
//# sourceMappingURL=persistence.js.map