# Published pm SDK capability floor

Audited main: `84d1cde6211d9330ed659c39a756259e58c2f9c8`. Required API floor: **2026.8.18**.

Declared host floor: `2026.10.4`. npm peer: `>=2026.10.4`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:2180](../index.ts#L2180) |
| `@unbrained/pm-cli/sdk :: commitItemMutations` | 2026.7.20 | 2026.7.19 | [index.ts:1658](../index.ts#L1658) |
| `@unbrained/pm-cli/sdk :: createPmCliExpectedError` | 2026.6.5 | 2026.5.31 | [index.ts:55](../index.ts#L55) |
| `@unbrained/pm-cli/sdk :: EXIT_CODE` | 2026.5.14 | 2026.5.12 | [index.ts:55](../index.ts#L55) |
| `@unbrained/pm-cli/sdk :: listAllComplete` | 2026.8.18 | 2026.8.17 | [index.ts:2226](../index.ts#L2226) |
| `@unbrained/pm-cli/sdk :: normalizeItemId` | 2026.5.14 | 2026.5.12 | [index.ts:1784](../index.ts#L1784), [index.ts:2098](../index.ts#L2098) |
| `@unbrained/pm-cli/sdk :: PmClient` | 2026.7.6 | 2026.7.5 | [index.ts:1522](../index.ts#L1522) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [index.ts:1790](../index.ts#L1790), [index.ts:2094](../index.ts#L2094) |
| `CommandHandlerContext.command` | 2026.5.1 | 2026.3.12 | [index.ts:2636](../index.ts#L2636) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [index.ts:2900](../index.ts#L2900) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [jql-selection-command.ts:65](../jql-selection-command.ts#L65), [index.ts:2637](../index.ts#L2637), [index.ts:2662](../index.ts#L2662), [index.ts:2685](../index.ts#L2685), [index.ts:2899](../index.ts#L2899) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:2685](../index.ts#L2685) |
| `ExtensionApi.hooks` | 2026.5.1 | 2026.3.12 | [index.ts:2925](../index.ts#L2925) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [jql-selection-command.ts:53](../jql-selection-command.ts#L53), [index.ts:2648](../index.ts#L2648), [index.ts:2669](../index.ts#L2669), [index.ts:2892](../index.ts#L2892) |
| `ExtensionApi.registerExporter` | 2026.5.1 | 2026.3.12 | [index.ts:2766](../index.ts#L2766) |
| `ExtensionApi.registerFlags` | 2026.5.1 | 2026.3.12 | [index.ts:2692](../index.ts#L2692), [index.ts:2693](../index.ts#L2693) |
| `ExtensionApi.registerImporter` | 2026.5.1 | 2026.3.12 | [index.ts:2695](../index.ts#L2695), [index.ts:2703](../index.ts#L2703) |
| `ExtensionApi.registerItemFields` | 2026.5.1 | 2026.3.12 | [index.ts:2604](../index.ts#L2604) |
| `ExtensionApi.registerPreflight` | 2026.5.1 | 2026.3.12 | [index.ts:2629](../index.ts#L2629) |
| `ImportExportContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:2696](../index.ts#L2696), [index.ts:2704](../index.ts#L2704), [index.ts:2767](../index.ts#L2767) |
| `ImportExportContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:2696](../index.ts#L2696), [index.ts:2747](../index.ts#L2747), [index.ts:2752](../index.ts#L2752), [index.ts:2774](../index.ts#L2774) |
| `PmClient.create` | 2026.7.6 | 2026.7.5 | [index.ts:1525](../index.ts#L1525) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.5.31 | `d3b4a795704588e414070a22a4034d7fbd7a290a050509cc4852e0051c0969a7` |
| 2026.6.5 | `bb47c85bb2ce1a8ba858651af8d1f4ca6888bc731d0aaaa63a4b97427219cd89` |
| 2026.7.5 | `4a6664f68120cace5648faf48d51b08c14e969d9c7e185e592f1a0fceae57274` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.19 | `513e0aead42767a113a26b8b2e2cbb8a22879d0cb0500d4d3cdd16d21d9f7a39` |
| 2026.7.20 | `6fbc1d789477491e007d03396dbf1dd2f09376220059887faf6f9d50668a6b08` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
