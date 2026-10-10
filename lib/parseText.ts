import { digitsOnly, stripDiacritics } from "./text.ts";

export interface BankFields {
  bank: string;
  account: string;
  name: string;
}

const LABELS = {
  bank: /ngan\s*hang\s*nhan/,
  account: /(so\s*)?tai\s*khoan(\s*\/?\s*the(\s*nhan)?)?|the\s*nhan/,
  name: /ten\s*nguoi\s*nhan|ten\s*nguoi\s*thu\s*huong|chu\s*tai\s*khoan/,
} as const;

/**
 * Tách thông tin từ văn bản OCR thô (Tesseract). Giá trị nằm cùng dòng
 * sau nhãn hoặc ở dòng kế tiếp.
 */
export function parseOcrText(text: string): BankFields {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.normalize("NFC").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const plain = lines.map((l) => stripDiacritics(l).toLowerCase());

  const valueAfter = (label: RegExp, exclude?: RegExp): string => {
    for (let i = 0; i < plain.length; i++) {
      if (exclude && exclude.test(plain[i])) continue;
      const m = plain[i].match(label);
      if (!m) continue;
      // Phần còn lại trên cùng dòng (sau nhãn)
      const rest = lines[i].slice((m.index ?? 0) + m[0].length).replace(/^[\s:\-/|]+/, "").trim();
      if (rest.length > 2) return rest;
      const next: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const isLabel = Object.values(LABELS).some((re) => re.test(plain[j]));
        if (isLabel) break;
        if (lines[j].length > 1) next.push(lines[j]);
      }
      if (!next.length) continue;
      // Logo/icon có thể tạo ra dòng rác ngắn: ưu tiên dòng có nhiều chữ/số nhất
      return next.reduce((best, l) => (score(l) > score(best) ? l : best));
    }
    return "";
  };

  const bank = valueAfter(LABELS.bank).replace(/[^\p{L}\p{N}\s\-.…()&]/gu, "").trim();
  const accountLine = valueAfter(LABELS.account, LABELS.bank);
  // Lấy cụm số dài nhất (cho phép nhóm số cách nhau, bỏ ký tự nhiễu lẻ từ icon)
  const account =
    (accountLine.match(/\d{3,}(?:[ .-]\d{3,})*/g) || [])
      .map(digitsOnly)
      .sort((a, b) => b.length - a.length)[0] || digitsOnly(accountLine);
  const name = valueAfter(LABELS.name, /ngan\s*hang/).replace(/[^\p{L}\p{N}\s.&-]/gu, "").trim();

  return { bank, account, name };
}

function score(line: string): number {
  return (line.match(/[\p{L}\p{N}]{2,}/gu) || []).join("").length;
}
