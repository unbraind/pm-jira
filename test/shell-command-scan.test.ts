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

import { bashArrays, expandArrays, expandScalars, joinContinuations, scalarAssignments, shellScalars } from "../scripts/shell-command-scan.ts";
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

test("the pathological ReDoS input completes in bounded time", () => {
  // The old ASSIGNMENT_COMMAND regex used [ \t]* (zero-or-more) between
  // repeated assignment groups, so on input like A=!A=!A=...!( the engine
  // tried 2^n ways to split the string into assignments before failing.
  // With 40 repetitions the old regex needs longer than the age of the
  // session; the fixed regex (which requires [ \t]+ between assignments)
  // finishes in well under 1 ms.
  const pathological = "A=" + "!A=".repeat(40) + "(";
  const start = process.hrtime.bigint();
  shellScalars(pathological + "\n");
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 100, `ReDoS input took ${elapsedMs.toFixed(2)} ms — expected < 100 ms`);
});

test("two space-separated assignments bind both names", () => {
  // A=1 B=2 is an assignment-only command binding both A and B.
  const assignments = scalarAssignments("A=1 B=2\n");
  assert.equal(assignments.length, 2);
  assert.equal(assignments[0]!.name, "A");
  assert.equal(assignments[0]!.value, "1");
  assert.equal(assignments[1]!.name, "B");
  assert.equal(assignments[1]!.value, "2");
});

test("export with two assignments including a quoted value binds both", () => {
  // export A=1 B="two three" is an assignment-only command binding both.
  const assignments = scalarAssignments('export A=1 B="two three"\n');
  assert.equal(assignments.length, 2);
  assert.equal(assignments[0]!.name, "A");
  assert.equal(assignments[0]!.value, "1");
  assert.equal(assignments[1]!.name, "B");
  assert.equal(assignments[1]!.value, "two three");
});

test("A=1B=2 binds A to the literal 1B=2 and does not bind B", () => {
  // In a real shell, A=1B=2 is a single assignment of A to 1B=2 — separate
  // assignments require whitespace. The fixed regex enforces this.
  const assignments = scalarAssignments("A=1B=2\n");
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0]!.name, "A");
  assert.equal(assignments[0]!.value, "1B=2");
});

test("an assignment line with trailing whitespace or a comment still matches", () => {
  // Trailing whitespace after the last assignment is allowed.
  const withTrailingWs = scalarAssignments("A=1   \n");
  assert.equal(withTrailingWs.length, 1);
  assert.equal(withTrailingWs[0]!.name, "A");
  assert.equal(withTrailingWs[0]!.value, "1");
  // A trailing comment is stripped before the regex sees the segment.
  const withComment = scalarAssignments("A=1 # set A\n");
  assert.equal(withComment.length, 1);
  assert.equal(withComment[0]!.name, "A");
  assert.equal(withComment[0]!.value, "1");
});

test("a genuine command is not mistaken for an assignment-only line", () => {
  // npm publish has no assignment, so ASSIGNMENT_COMMAND must reject it.
  const assignments = scalarAssignments("npm publish\n");
  assert.equal(assignments.length, 0);
});
