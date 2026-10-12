import ExcelJS from "exceljs";
import { looseKey } from "./text.ts";

/**
 * Hồ sơ khách hàng (HSKH): bảng dò mã số KH -> nhân viên bán hàng + tài khoản ngân hàng đã đăng ký.
 * Chỉ giữ các cột cần dùng; các cột nhạy cảm khác (SĐT, CCCD, địa chỉ...) bỏ qua.
 */
export interface HskhEntry {
  /** MSNV - cột "Nhân Viên Bán" */
  msnv: string;
  /** Cột "Tên NVBH" */
  nvbh: string;
  /** Cột "Số Tài Khoản Khách hàng" (để đối chiếu STK đọc từ ảnh) */
  account?: string;
  /** Cột "Tên Chủ TK Ngân Hàng" */
  owner?: string;
  /** Cột "Tên Ngân hàng" */
  bank?: string;
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
const ACCOUNT_HEADERS = ["sotaikhoankhachhang", "sotaikhoan", "stk", "sotk"];
const OWNER_HEADERS = ["tenchutknganhang", "tenchutaikhoan", "chutaikhoan", "tenchutk"];
const BANK_HEADERS = ["tennganhang"];

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
      const cols: { code?: number; msnv?: number; name?: number; account?: number; owner?: number; bank?: number } = {};
      ws.getRow(r).eachCell((cell, c) => {
        const k = looseKey(cellText(cell.value));
        if (cols.code === undefined && CODE_HEADERS.includes(k)) cols.code = c;
        if (cols.msnv === undefined && MSNV_HEADERS.includes(k)) cols.msnv = c;
        if (cols.name === undefined && NAME_HEADERS.includes(k)) cols.name = c;
        if (cols.account === undefined && ACCOUNT_HEADERS.includes(k)) cols.account = c;
        if (cols.owner === undefined && OWNER_HEADERS.includes(k)) cols.owner = c;
        if (cols.bank === undefined && BANK_HEADERS.includes(k)) cols.bank = c;
      });
      if (!cols.msnv || !cols.name) continue;
      if (!cols.code) throw new Error('File HSKH không có cột mã khách hàng ("Số" hoặc "Mã KH")');
      const entries: Record<string, HskhEntry> = {};
      for (let i = r + 1; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const code = normalizeCode(cellText(row.getCell(cols.code).value));
        if (!code) continue;
        const get = (c?: number) => (c ? cellText(row.getCell(c).value) : "");
        const entry: HskhEntry = { msnv: get(cols.msnv), nvbh: get(cols.name) };
        const account = get(cols.account).replace(/[^\dA-Za-z]/g, "");
        if (account) entry.account = account;
        if (get(cols.owner)) entry.owner = get(cols.owner);
        if (get(cols.bank)) entry.bank = get(cols.bank).replace(/\s+/g, " ");
        entries[code] = entry;
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

/** Khoảng cách sửa (Levenshtein) giữa 2 chuỗi số: số chữ số phải thêm/bớt/sửa để giống nhau */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export type AccountCheck =
  | { kind: "none" }
  | { kind: "match" }
  /** Gần giống (lệch 1-2 chữ số): nhiều khả năng đọc nhầm */
  | { kind: "near"; hskhAccount: string; diff: number }
  /** Khác hẳn: khách đổi tài khoản / dùng tài khoản khác */
  | { kind: "different"; hskhAccount: string; hskhBank?: string };

/** Đối chiếu STK đọc từ ảnh với STK đã đăng ký trong HSKH */
export function checkAccount(entry: HskhEntry | undefined, account: string): AccountCheck {
  const ocr = account.replace(/\D/g, "");
  const reg = (entry?.account ?? "").replace(/\D/g, "");
  if (!ocr || !reg) return { kind: "none" };
  if (ocr === reg) return { kind: "match" };
  const diff = editDistance(ocr, reg);
  if (diff <= 2 && Math.min(ocr.length, reg.length) >= 6) return { kind: "near", hskhAccount: reg, diff };
  return { kind: "different", hskhAccount: reg, hskhBank: entry?.bank };
}

export function accountCheckText(c: AccountCheck): string {
  switch (c.kind) {
    case "match":
      return "STK khớp HSKH";
    case "near":
      return `STK gần giống HSKH (${c.hskhAccount}), lệch ${c.diff} chữ số - kiểm tra kỹ, có thể đọc nhầm`;
    case "different":
      return `Khác STK trong HSKH: ${c.hskhAccount}${c.hskhBank ? ` (${c.hskhBank})` : ""} - đổi tài khoản?`;
    default:
      return "";
  }
}
