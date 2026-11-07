/** A real process importing into a shared tracker after changing its cwd. */
import { bindJiraPersistence, runImport } from "../../index.ts";
const target = bindJiraPersistence("tracker");
process.chdir(process.argv[2]!);
process.send!("ready");
process.once("message", async () => {
  try {
    const result = await runImport({ project: "ONE", host: "https://example.invalid" }, target,
      { atomic: true, issues: [{ key: `ONE-${process.argv[3]!}`, fields: {
        summary: "Concurrent bound writer", status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Preserved body" }] }] },
      } }] });
    process.send!(result);
  } catch (error) {
    process.send!({ error: String(error) });
    process.exitCode = 1;
  } finally { process.disconnect!(); }
});
