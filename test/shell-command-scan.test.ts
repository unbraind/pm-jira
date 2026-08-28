/**
 * Tests for the shared shell-text scanner and the main-invocation guard.
 *
 * These live beside the modules rather than inside a gate's suite because both
 * release gates depend on them while not every package carries both gates.
 * When these assertions belonged to the changelog-date suite, propagating the
 * scanner to a package without that gate silently dropped a branch from
 * coverage -- which is the failure this file exists to prevent.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { bashArrays, expandArrays, expandScalars, joinContinuations, shellScalars } from "../scripts/shell-command-scan.ts";
import { isMainInvocation } from "../scripts/main-invocation.ts";

test("an unknown array reference is left in place rather than erased", () => {
  // Erasing it would turn "this scan does not understand the command" into
  // "this command carries no flags", which reads as a pass.
  assert.equal(expandArrays('cmd "${missing[@]}"', new Map()), 'cmd "${missing[@]}"');
  assert.equal(expandArrays('cmd "${known[@]}"', new Map([["known", "--a --b"]])), "cmd --a --b");
});

test("bashArrays collapses whitespace so a multi-line declaration is one flag string", () => {
  assert.equal(bashArrays("common=(\n  --a\n  --b\n)").get("common"), "--a --b");
});

test("the main-invocation guard answers both ways", () => {
  // Name the module under test, not a gate: not every package carries the same
  // gates, and a path that resolves nowhere makes realpathSync throw rather
  // than answer.
  const self = fileURLToPath(import.meta.resolve("../scripts/main-invocation.ts"));
  const url = import.meta.resolve("../scripts/main-invocation.ts");
  assert.equal(isMainInvocation(["node", self], url), true);
  assert.equal(isMainInvocation(["node", fileURLToPath(import.meta.url)], url), false);
  assert.equal(isMainInvocation(["node"], url), false);
});
test("a backslash continuation makes one logical command out of several lines", () => {
  assert.equal(
    joinContinuations("npm publish \\\n  --provenance \\\n  --access public\n"),
    // The joiner replaces the backslash-newline with a single space and leaves
    // the continuation line's own indentation, which the tokeniser then eats.
    "npm publish  --provenance  --access public\n",
  );
  // A backslash that does not end a line is an ordinary character.
  assert.equal(joinContinuations("printf 'a\\tb'\n"), "printf 'a\\tb'\n");
});

test("an array reference is replaced by the declaration's contents, quoted or bare", () => {
  const arrays = bashArrays('common=( --access public --provenance )\n');
  assert.equal(expandArrays('npm publish "${common[@]}"', arrays), "npm publish --access public --provenance");
  assert.equal(expandArrays("npm publish ${common[@]}", arrays), "npm publish --access public --provenance");
});

test("an unquoted scalar assignment is indexed so a variable-routed publish is caught", () => {
  // NPM=npm; "$NPM" publish --provenance=false must resolve $NPM to npm so
  // the scanner detects the unattested publish. Without unquoted scalar
  // support the assignment is skipped and the publish escapes.
  const scalars = shellScalars("NPM=npm; \"$NPM\" publish --provenance=false\n");
  assert.equal(scalars.get("NPM"), "npm");
  // expandScalars replaces $NPM with npm; the surrounding quotes remain
  // but the tokenizer strips them, so the scanner sees program=npm.
  assert.equal(expandScalars('"$NPM" publish --provenance=false', scalars), '"npm" publish --provenance=false');
});

test("a quoted scalar assignment is still indexed", () => {
  const scalars = shellScalars('CMD="npm publish"\n');
  assert.equal(scalars.get("CMD"), "npm publish");
  assert.equal(expandScalars("$CMD --provenance", scalars), "npm publish --provenance");
});

test("a scalar assignment with a substitution is not indexed", () => {
  // A value built from other variables is not resolvable without evaluating
  // the script, so it must not be indexed.
  const scalars = shellScalars('CMD="$other_cmd publish"\n');
  assert.equal(scalars.has("CMD"), false);
});
