import ExcelJS from "exceljs";
import type { HistoryRecord } from "./history.ts";
import { looseKey } from "./text.ts";

const COLUMNS = {
  customerCode: "Mã số KH",
  businessName: "Tên CSKD",
  bank: "Ngân hàng nhận",
  account: "Tài khoản/thẻ nhận",
  name: "Tên người nhận",
  fileName: "Tên file",
  note: "Ghi chú",
} as const;

/** Giá trị ô Excel -> chữ (ô có thể là số, chữ định dạng, công thức, liên kết…) */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
    if ("result" in v) return v.result == null ? "" : String(v.result);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

export interface ExcelImportResult {
  records: HistoryRecord[];
  /** Dòng bị bỏ vì thiếu tên file (không có tên file thì không nhận ra ảnh trùng được) */
  skippedNoFileName: number;
}

/** Đọc file Excel do app xuất ra (kể cả ảnh trong ô) thành bản ghi lịch sử */
export async function importExcel(data: ArrayBuffer): Promise<ExcelImportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("File Excel không có trang tính nào");

  // Tìm dòng tiêu đề trong 5 dòng đầu
  let headerRow = 0;
  const col: Partial<Record<keyof typeof COLUMNS, number>> = {};
  for (let r = 1; r <= Math.min(5, ws.rowCount) && !headerRow; r++) {
    const row = ws.getRow(r);
    row.eachCell((cell, c) => {
      const key = looseKey(cellText(cell.value));
      for (const [k, title] of Object.entries(COLUMNS)) if (key === looseKey(title)) col[k as keyof typeof COLUMNS] = c;
    });
    if (col.fileName || col.account) headerRow = r;
  }
  if (!headerRow || !col.fileName) {
    throw new Error('Không tìm thấy cột "Tên file" trong file Excel (cần file do app này xuất ra)');
  }

  // Ảnh trong ô: neo theo dòng (nativeRow đếm từ 0)
  const imageByRow = new Map<number, Blob>();
  for (const img of ws.getImages()) {
    const row = Math.floor(Number((img.range.tl as { nativeRow?: number; row?: number }).nativeRow ?? img.range.tl.row)) + 1;
    const media = wb.getImage(Number(img.imageId));
    const buf = media?.buffer as unknown as Uint8Array | undefined;
    if (buf) imageByRow.set(row, new Blob([new Uint8Array(buf)], { type: `image/${media.extension === "png" ? "png" : "jpeg"}` }));
  }

  const records: HistoryRecord[] = [];
  let skippedNoFileName = 0;
  const now = Date.now();
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k: keyof typeof COLUMNS) => (col[k] ? cellText(row.getCell(col[k]!).value) : "");
    const fileName = get("fileName").normalize("NFC");
    const hasData = get("account") || get("name") || get("bank");
    if (!fileName) {
      if (hasData) skippedNoFileName++;
      continue;
    }
    const note = get("note");
    records.push({
      fileName,
      customerCode: get("customerCode"),
      businessName: get("businessName"),
      bank: get("bank"),
      account: get("account").replace(/\D/g, ""),
      name: get("name"),
      status: !note || note.startsWith("Đã kiểm tra") ? "ok" : "review",
      note,
      engine: "Nhập từ Excel",
      size: 0,
      readAt: now,
      thumb: imageByRow.get(r),
    });
  }
  return { records, skippedNoFileName };
}
