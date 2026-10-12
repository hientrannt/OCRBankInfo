import ExcelJS from "exceljs";
import { looseKey } from "./text.ts";

/**
 * Hồ sơ khách hàng (HSKH): bảng dò mã số KH -> nhân viên bán hàng.
 * Chỉ giữ 3 cột cần dùng (mã KH, MSNV, tên NVBH); các cột nhạy cảm khác (SĐT, CCCD...) bỏ qua.
 */
export interface HskhEntry {
  /** MSNV - cột "Nhân Viên Bán" */
  msnv: string;
  /** Cột "Tên NVBH" */
  nvbh: string;
}

export interface HskhData {
  /** mã KH đã chuẩn hóa -> nhân viên */
  entries: Record<string, HskhEntry>;
  fileName: string;
  importedAt: number;
  count: number;
}

/** "0573.00028" / " 0573/00028 " -> "0573/00028" */
export const normalizeCode = (code: string) => String(code ?? "").trim().replace(/\./g, "/").replace(/\s+/g, "").toUpperCase();

const CODE_HEADERS = ["so", "makh", "masokh", "makhachhang", "masokhachhang"].map((h) => looseKey(h));
const MSNV_HEADERS = ["nhanvienban", "msnv", "manvbh", "manhanvienban"];
const NAME_HEADERS = ["tennvbh", "tennhanvienban", "tennhanvienbanhang"];

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
    if ("result" in v) return v.result == null ? "" : String(v.result);
  }
  return String(v).trim();
}

/** Đọc file HSKH (.xlsx): tìm dòng tiêu đề có "Nhân Viên Bán" và "Tên NVBH", cột mã KH là "Số" / "Mã KH" */
export async function parseHskh(data: ArrayBuffer, fileName = "HSKH.xlsx"): Promise<HskhData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
      const cols: { code?: number; msnv?: number; name?: number } = {};
      ws.getRow(r).eachCell((cell, c) => {
        const k = looseKey(cellText(cell.value));
        if (cols.code === undefined && CODE_HEADERS.includes(k)) cols.code = c;
        if (cols.msnv === undefined && MSNV_HEADERS.includes(k)) cols.msnv = c;
        if (cols.name === undefined && NAME_HEADERS.includes(k)) cols.name = c;
      });
      if (!cols.msnv || !cols.name) continue;
      if (!cols.code) throw new Error('File HSKH không có cột mã khách hàng ("Số" hoặc "Mã KH")');
      const entries: Record<string, HskhEntry> = {};
      for (let i = r + 1; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const code = normalizeCode(cellText(row.getCell(cols.code).value));
        if (!code) continue;
        entries[code] = {
          msnv: cellText(row.getCell(cols.msnv).value),
          nvbh: cellText(row.getCell(cols.name).value),
        };
      }
      const count = Object.keys(entries).length;
      if (!count) throw new Error("File HSKH không có dòng dữ liệu nào");
      return { entries, fileName, importedAt: Date.now(), count };
    }
  }
  throw new Error('Không tìm thấy cột "Nhân Viên Bán" và "Tên NVBH" trong file HSKH');
}

export function lookupHskh(hskh: HskhData | null, customerCode: string): HskhEntry | undefined {
  if (!hskh || !customerCode) return undefined;
  return hskh.entries[normalizeCode(customerCode)];
}

const LOCAL_KEY = "ocr-hskh";

export function loadLocalHskh(): HskhData | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as HskhData) : null;
  } catch {
    return null;
  }
}

export function saveLocalHskh(data: HskhData | null) {
  try {
    if (data) localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
    else localStorage.removeItem(LOCAL_KEY);
  } catch {}
}
