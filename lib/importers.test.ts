import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { findDuplicateAccounts } from "./duplicates.ts";
import { makeBackup, parseBackup } from "./backup.ts";
import { importExcel } from "./excelImport.ts";
import type { HistoryRecord } from "./history.ts";

const r = (fileName: string, customerCode: string, account: string, businessName = "CSKD"): HistoryRecord => ({
  fileName, customerCode, businessName, account, bank: "AGRIBANK", name: "A", status: "ok", note: "", engine: "Gemini", size: 1, readAt: 5,
});

test("phát hiện trùng STK giữa các mã KH và mã KH có nhiều STK", () => {
  const w = findDuplicateAccounts([
    r("a.png", "0573/00001", "4705235387979", "NHA THUOC A"),
    r("b.png", "0573/00002", "4705235387979", "NHA THUOC B"),
    r("c.png", "0573/00003", "1111111111"),
    r("d.png", "0573/00003", "2222222222"),
    r("e.png", "0573/00005", "3333333333"),
    r("e2.png", "0573/00005", "3333333333"), // cùng mã KH, cùng STK -> không cảnh báo
  ]);
  assert.equal(w.get("a.png")![0], "Trùng STK với MSKH 0573/00002");
  assert.equal(w.get("b.png")![0], "Trùng STK với MSKH 0573/00001");
  assert.match(w.get("c.png")![0], /Mã KH có 2 STK khác nhau \(2222222222\)/);
  assert.equal(w.has("e.png"), false);
  assert.equal(w.has("e2.png"), false);
});

test("sao lưu rồi khôi phục giữ nguyên dữ liệu và ảnh thu nhỏ", async () => {
  const recs = [{ ...r("Nhà thuốc.png", "0573/00001", "123456789"), thumb: new Blob([new Uint8Array([1, 2, 3, 250])]) }, r("b.png", "x", "987654321")];
  const json = await makeBackup(recs, async (x) => x.thumb);
  const back = parseBackup(json);
  assert.equal(back.length, 2);
  assert.equal(back[0].fileName, "Nhà thuốc.png");
  assert.deepEqual([...new Uint8Array(await back[0].thumb!.arrayBuffer())], [1, 2, 3, 250]);
  assert.equal(back[1].thumb, undefined);
  assert.throws(() => parseBackup('{"foo":1}'), /không phải bản sao lưu/);
  assert.throws(() => parseBackup("not json"), /không đọc được/);
});

test("nhập file Excel do app xuất (kèm ảnh trong ô, STK dạng số hoặc chữ)", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Thông tin ngân hàng");
  ws.addRow(["STT", "Ảnh", "Mã số KH", "Tên CSKD", "Ngân hàng nhận", "Tài khoản/thẻ nhận", "Tên người nhận", "Tên file", "Ghi chú"]);
  ws.addRow([1, "", "0573/00028", "NHÀ THUỐC MỸ THỂ", "AGRIBANK - ...", "4705235387979", "Ho Kinh Doanh An Binh", "0573.00028_NHÀ THUỐC MỸ THỂ.JPG", ""]);
  ws.addRow([2, "", "0573/00029", "B", "BIDV", 12345678, "B", "0573.00029_B.png", "STK Tesseract: 1"]);
  ws.addRow([3, "", "0573/00030", "C", "VCB", "999999", "C", "", ""]); // thiếu tên file
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const id = wb.addImage({ buffer: png, extension: "png" } as never);
  ws.addImage(id, { tl: { nativeCol: 1, nativeColOff: 0, nativeRow: 1, nativeRowOff: 0 }, ext: { width: 10, height: 10 } } as never);
  const buf = await wb.xlsx.writeBuffer();

  const { records, skippedNoFileName } = await importExcel(buf as ArrayBuffer);
  assert.equal(records.length, 2);
  assert.equal(skippedNoFileName, 1);
  assert.equal(records[0].account, "4705235387979");
  assert.equal(records[0].status, "ok");
  assert.ok(records[0].thumb, "ảnh trong ô dòng 2 được lấy ra");
  assert.equal(records[1].account, "12345678");
  assert.equal(records[1].status, "review");
  assert.equal(records[1].thumb, undefined);
  assert.equal(records[0].engine, "Nhập từ Excel");
});

test("trùng STK liệt kê đủ các MSKH (tối đa 15)", () => {
  const items = Array.from({ length: 18 }, (_, i) => r(`f${i}.png`, `0573/${String(i).padStart(5, "0")}`, "999888777"));
  const msg = findDuplicateAccounts(items).get("f0.png")![0];
  assert.match(msg, /^Trùng STK với MSKH 0573\/00001, 0573\/00002, .*0573\/00015 và 2 mã khác$/);
});
