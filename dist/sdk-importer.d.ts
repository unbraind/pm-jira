/**
 * sdk-importer.ts — the `@unbrained/pm-cli/sdk` loader and its process cache.
 *
 * This lives outside `index.ts` on purpose. The resolver cache is process-wide,
 * so once a real resolve succeeds the import-failure, not-a-function and
 * "prior attempt failed" branches in `resolveCommitItemMutations` become
 * unreachable in the same process, and the caller-supplied `importSdk`
 * parameter cannot reach them either because it returns before the cache logic
 * runs. Covering those branches therefore needs a seam that swaps the loader
 * and clears the cache.
 *
 * Keeping that seam here rather than in `index.ts` keeps it off the package's
 * entry point: `package.json` points `main` and `types` at `dist/index.js` and
 * `dist/index.d.ts`, so nothing here appears in the published API surface or
 * its declarations. The package's own tests import this module directly.
 */
/** Default loader for `@unbrained/pm-cli/sdk` (dynamic so a missing peer is a CommandError). */
declare const defaultImportPmSdk: () => Promise<typeof import("@unbrained/pm-cli/sdk")>;
/** The resolved SDK module, or a rejection recorded for the rest of the process. */
export type PmSdkModule = Awaited<ReturnType<typeof defaultImportPmSdk>>;
/**
 * Load the pm SDK through the loader currently in effect.
 *
 * @returns The resolved SDK module namespace.
 */
export declare function importPmSdk(): Promise<PmSdkModule>;
/**
 * Replace the SDK loader.
 *
 * NOT PART OF THE SUPPORTED API, and not reachable through the package entry
 * point — the double-underscore name and this module's placement are both the
 * contract. Passing `undefined` restores the default loader. Callers are
 * responsible for clearing any cache keyed on the previous loader.
 *
 * @param replacement - Replacement loader, or `undefined` to restore the default.
 */
export declare function __setPmSdkImporterForTests(replacement?: () => Promise<unknown>): void;
export {};
//# sourceMappingURL=sdk-importer.d.ts.map