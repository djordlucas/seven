import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { State } from "../src/state/db.ts";
import { ToolStore } from "../src/tools/store.ts";

function store(): ToolStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seven-store-test-"));
  return new ToolStore(new State(path.join(dir, "seven.db")), path.join(dir, "tools"));
}
const tool = { name: "t", description: "d", parameters: {}, deps: {}, packages: [] };
const record = (i: number) => ({
  at: `t${i}`,
  revision: 1,
  agent: "seven",
  mode: "sync" as const,
  ok: true,
  durationMs: i,
});

describe("tool store", () => {
  it("saves a tool and writes its source file per revision", () => {
    const s = store();
    s.save({ meta: tool, source: "export default 1" });
    s.save({ meta: tool, source: "export default 2" });
    const t = s.get("t");
    assert.equal(t?.meta.revision, 2);
    assert.equal(path.basename(t?.file ?? ""), "r2.ts");
    assert.equal(fs.readFileSync(t?.file ?? "", "utf8"), "export default 2");
  });

  it("keeps the newest 100 run records", () => {
    const s = store();
    s.save({ meta: tool, source: "export default 1" });
    for (let i = 0; i < 150; i++) s.recordRun("t", record(i));
    const h = s.history("t");
    assert.equal(h.length, 100);
    assert.equal(h[0]?.durationMs, 50);
    assert.deepEqual(
      s.history("t", 2).map((r) => r.durationMs),
      [148, 149],
    );
  });

  it("does not record a run for a tool deleted while it ran", () => {
    const s = store();
    s.recordRun("gone", record(1));
    assert.deepEqual(s.history("gone"), []);
  });

  it("disables and re-enables without touching the revision; redefining clears disabled", () => {
    const s = store();
    s.save({ meta: tool, source: "export default 1" });
    assert.equal(s.setDisabled("t", "broken"), true);
    assert.equal(s.get("t")?.meta.disabled?.reason, "broken");
    assert.equal(s.setDisabled("t", null), true);
    assert.equal(s.get("t")?.meta.disabled, undefined);
    assert.equal(s.get("t")?.meta.revision, 1);
    s.setDisabled("t", "again");
    s.save({ meta: tool, source: "export default 2" });
    assert.equal(s.get("t")?.meta.disabled, undefined);
    assert.equal(s.setDisabled("missing", "x"), false);
  });

  it("removes a tool, its history and its files", () => {
    const s = store();
    s.save({ meta: tool, source: "export default 1" });
    const file = s.get("t")?.file ?? "";
    s.recordRun("t", record(1));
    assert.equal(s.remove("t"), true);
    assert.equal(s.get("t"), undefined);
    assert.deepEqual(s.history("t"), []);
    assert.equal(fs.existsSync(file), false);
  });
});
