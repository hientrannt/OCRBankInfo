import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { lookupHskh, normalizeCode, parseHskh } from "./hskh.ts";

async function workbook(header: string[], rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet");
  ws.addRow(header);
  rows.forEach((r) => ws.addRow(r));
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

test("đọc HSKH (cột 'Số ' có dấu cách thừa, MSNV dạng số hoặc chữ) và dò theo mã KH", async () => {
  const buf = await workbook(
    ["Số ", "Tên người đại diện", "Tên Đơn Vị", "Số CCCD/Hộ Chiếu", "Nhân Viên Bán", "Tên NVBH", "NV Thu Tiền"],
    [
      ["0573/00028", "A", "HỘ KINH DOANH MỸ THỂ", "054000000001", "7771", "Mai Xuân Phước", "1"],
      ["0583/00228", "B", "HỘ KINH DOANH NHÀ THUỐC ÁNH TRANG 2", "054000000002", 6274, "Nguyễn Trường Thọ", "2"],
      [null, "dòng trống", null, null, null, null, null],
    ],
  );
  const h = await parseHskh(buf, "HSKH.xlsx");
  assert.equal(h.count, 2);
  assert.deepEqual(lookupHskh(h, "0573/00028"), { msnv: "7771", nvbh: "Mai Xuân Phước" });
  // mã lấy từ tên file dạng 0583.00228 cũng dò được
  assert.deepEqual(lookupHskh(h, "0583.00228"), { msnv: "6274", nvbh: "Nguyễn Trường Thọ" });
  assert.equal(lookupHskh(h, "0999/00001"), undefined);
  // không giữ các cột nhạy cảm
  assert.ok(!JSON.stringify(h).includes("054000000001"));
});

test("báo lỗi rõ khi file không đúng mẫu HSKH", async () => {
  await assert.rejects(parseHskh(await workbook(["A", "B"], [["1", "2"]])), /Nhân Viên Bán/);
  await assert.rejects(parseHskh(await workbook(["Tên", "Nhân Viên Bán", "Tên NVBH"], [["x", "1", "y"]])), /mã khách hàng/);
  assert.equal(normalizeCode(" 0573.00028 "), "0573/00028");
});

test("đối chiếu STK với HSKH: khớp / gần giống (nghi đọc nhầm) / khác hẳn", async () => {
  const { checkAccount, accountCheckText, editDistance } = await import("./hskh.ts");
  const e = { msnv: "1", nvbh: "A", account: "4705235387979", bank: "Agribank" };
  assert.equal(checkAccount(e, "4705235387979").kind, "match");
  const near = checkAccount(e, "4705255587979"); // Tesseract đọc nhầm 3 -> 5 hai chỗ
  assert.deepEqual(near, { kind: "near", hskhAccount: "4705235387979", diff: 2 });
  assert.match(accountCheckText(near), /có thể đọc nhầm/);
  assert.equal(checkAccount(e, "470523538797").kind, "near"); // thiếu 1 chữ số
  const diff = checkAccount(e, "19050622266014");
  assert.equal(diff.kind, "different");
  assert.match(accountCheckText(diff), /Khác STK trong HSKH: 4705235387979 \(Agribank\)/);
  assert.equal(checkAccount({ msnv: "", nvbh: "" }, "123").kind, "none");
  assert.equal(editDistance("12345", "12354"), 2);
});

test("HSKH đọc thêm STK, chủ TK, ngân hàng", async () => {
  const buf = await workbook(
    ["Số", "Số Tài Khoản Khách hàng", "Tên Chủ TK Ngân Hàng", "Tên Ngân hàng", "Nhân Viên Bán", "Tên NVBH"],
    [["0573/00028", "968866975812", "HKD MỸ THỂ", "Ngân Hàng TMCP Hàng Hải", "7771", "Mai Xuân Phước"]],
  );
  const h = await parseHskh(buf);
  assert.deepEqual(lookupHskh(h, "0573/00028"), {
    msnv: "7771", nvbh: "Mai Xuân Phước", account: "968866975812", owner: "HKD MỸ THỂ", bank: "Ngân Hàng TMCP Hàng Hải",
  });
});
