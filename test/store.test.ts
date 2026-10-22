import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ToolStore } from "../src/tools/store.ts";

const store = () => new ToolStore(fs.mkdtempSync(path.join(os.tmpdir(), "seven-store-test-")));
const tool = { name: "t", description: "d", parameters: {}, deps: {}, packages: [] };
const record = (i: number) => ({ at: `t${i}`, revision: 1, mode: "sync" as const, ok: true, durationMs: i });

describe("tool store", () => {
  it("trims the run history to the newest 100 once it reaches 200", () => {
    const s = store();
    s.save({ meta: tool, source: "export default 1" });
    for (let i = 0; i < 199; i++) s.recordRun("t", record(i));
    assert.equal(s.history("t").length, 100, "history() returns at most 100");
    s.recordRun("t", record(199));
    const lines = fs
      .readFileSync(path.join(s.dir, "t", "runs.jsonl"), "utf8")
      .trimEnd()
      .split("\n");
    assert.equal(lines.length, 100);
    assert.deepEqual(
      s.history("t", 2).map((r) => r.durationMs),
      [198, 199],
    );
  });

  it("does not record a run for a tool deleted while it ran", () => {
    const s = store();
    s.recordRun("gone", record(1));
    assert.equal(fs.existsSync(path.join(s.dir, "gone")), false);
  });

  it("disables and re-enables without touching the revision", () => {
    const s = store();
    s.save({ meta: tool, source: "export default 1" });
    assert.equal(s.setDisabled("t", "broken"), true);
    assert.equal(s.get("t")?.meta.disabled?.reason, "broken");
    assert.equal(s.setDisabled("t", null), true);
    assert.equal(s.get("t")?.meta.disabled, undefined);
    assert.equal(s.get("t")?.meta.revision, 1);
    assert.equal(s.setDisabled("missing", "x"), false);
  });
});
