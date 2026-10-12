import { looseKey } from "./text.ts";

export interface DupInput {
  fileName: string;
  customerCode: string;
  businessName: string;
  account: string;
}

/**
 * Cảnh báo trùng số tài khoản:
 * - cùng một STK nhưng thuộc mã KH (CSKD) khác nhau
 * - cùng một mã KH nhưng có nhiều STK khác nhau
 * Trả về Map tên file -> danh sách cảnh báo.
 */
export function findDuplicateAccounts(items: DupInput[]): Map<string, string[]> {
  const byAccount = new Map<string, DupInput[]>();
  const byCode = new Map<string, DupInput[]>();
  for (const it of items) {
    const acc = it.account.replace(/\D/g, "");
    if (acc.length >= 6) byAccount.set(acc, [...(byAccount.get(acc) ?? []), it]);
    const code = looseKey(it.customerCode);
    if (code && acc) byCode.set(code, [...(byCode.get(code) ?? []), it]);
  }
  const out = new Map<string, string[]>();
  const add = (f: string, msg: string) => out.set(f, [...(out.get(f) ?? []), msg]);

  for (const group of byAccount.values()) {
    for (const it of group) {
      // Liệt kê cụ thể các MSKH khác đang dùng cùng STK (tối đa 15 mã, còn lại ghi số lượng)
      const codes = [
        ...new Set(
          group
            .filter((o) => o.fileName !== it.fileName && looseKey(o.customerCode) !== looseKey(it.customerCode))
            .map((o) => o.customerCode || o.fileName),
        ),
      ];
      if (codes.length) {
        const shown = codes.slice(0, 15).join(", ");
        add(it.fileName, `Trùng STK với MSKH ${shown}${codes.length > 15 ? ` và ${codes.length - 15} mã khác` : ""}`);
      }
    }
  }
  for (const group of byCode.values()) {
    for (const it of group) {
      const accs = new Set(group.map((o) => o.account.replace(/\D/g, "")));
      if (accs.size > 1) {
        const otherAccs = [...accs].filter((a) => a !== it.account.replace(/\D/g, ""));
        add(it.fileName, `Mã KH có ${accs.size} STK khác nhau (${otherAccs.slice(0, 2).join(", ")})`);
      }
    }
  }
  return out;
}
