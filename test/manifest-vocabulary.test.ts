import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk";

const repoRoot = resolve(import.meta.dirname, "..");

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { devDependencies?: Record<string, string> };
const extensionManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "manifest.json"), "utf8"),
) as Record<string, unknown>;

/**
 * The pm CLI's extension-manifest vocabulary is a CLOSED set of keys (name,
 * version, entry, priority, description, author, capabilities,
 * manifest_version, pm_min_version, pm_max_version, engines, trusted,
 * provenance, sandbox_profile, permissions, activation, contributions,
 * legacy_capability_aliases). Since pm-cli 2026.8.19, any manifest.json key
 * outside that set yields a `manifest_unknown_key` finding instead of being
 * silently ignored. This repo carried a top-level `"pm": {"compatibility":
 * "v2"}` key that nothing ever read — inert configuration — but downstream
 * strict-assertion consumers (unbraind/pm-linear PRs #75/#76) expect finding
 * codes to be exactly `["pm_min_version_unmet"]` and fail on the extra
 * `manifest_unknown_key`. This test pins the manifest to the closed
 * vocabulary so an unknown key cannot reappear unnoticed; it also pins the
 * dev CLI to an exact version, because only a current-enough CLI can detect
 * unknown keys at all.
 */
test("the extension manifest uses only keys the pm CLI recognizes", () => {
  const pin = packageJson.devDependencies?.["@unbrained/pm-cli"] ?? "";
  assert.match(pin, /^\d+\.\d+\.\d+$/, "the pinned CLI version must be an exact three-part version");
  const result = checkExtensionManifestCompatibility(extensionManifest, { pmVersion: pin });
  const unknownKeyFindings = result.findings.filter((finding) => finding.code === "manifest_unknown_key");
  assert.deepStrictEqual(
    unknownKeyFindings,
    [],
    `manifest.json carries keys outside the closed manifest vocabulary: ${unknownKeyFindings.map((f) => f.path).join(", ")}`,
  );
});
