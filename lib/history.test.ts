import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearHistory, deleteHistory, findHistory, getAllHistory, saveHistory, type HistoryRecord } from "./history.ts";

const rec = (fileName: string, extra: Partial<HistoryRecord> = {}): HistoryRecord => ({
  fileName,
  customerCode: "0573/00028",
  businessName: "HỘ KINH DOANH",
  bank: "AGRIBANK",
  account: "4705235387979",
  name: "Ho Kinh Doanh An Binh",
  status: "ok",
  note: "",
  engine: "Gemini",
  size: 100,
  readAt: Date.now(),
  ...extra,
});

test("lưu, tìm theo tên file (kể cả tên NFD của macOS), ghi đè, xóa", async () => {
  await clearHistory();
  const name = "0573.00028_NHÀ THUỐC.JPG";
  await saveHistory([rec(name, { thumb: new Blob(["jpg"]) }), rec("b.png", { readAt: 1 })]);

  const found = await findHistory([name.normalize("NFD"), "moi.png"]);
  assert.equal(found.size, 1);
  assert.equal(found.get(name)!.account, "4705235387979");

  // Ghi đè không kèm ảnh thu nhỏ thì giữ ảnh cũ
  await saveHistory([rec(name, { account: "999", status: "review" })]);
  const again = (await findHistory([name])).get(name)!;
  assert.equal(again.account, "999");
  assert.ok(again.thumb, "giữ ảnh thu nhỏ cũ");

  const all = await getAllHistory();
  assert.deepEqual(all.map((r) => r.fileName), [name, "b.png"]); // mới nhất trước

  await deleteHistory(["b.png"]);
  assert.equal((await getAllHistory()).length, 1);
  await clearHistory();
  assert.equal((await getAllHistory()).length, 0);
});
