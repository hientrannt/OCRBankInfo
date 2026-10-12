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

/** Mục khác của màn hình chuyển tiền: dừng ghép dòng khi gặp */
const STOP = /so\s*tien|noi\s*dung|phi\s*chuyen|tiep\s*tuc|xac\s*nhan|luu\s*(mau|nguoi)|ghi\s*chu|so\s*du|chuyen\s*nhanh/;

/**
 * Tesseract đôi khi chèn khoảng trắng vào giữa mã viết hoa ngay trước dấu gạch: "TGT T-HKD" -> "TGTT-HKD"
 */
function fixStraySpaces(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\b([A-Z]{2,}) ([A-Z])(?=-)/g, "$1$2").trim();
}

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

  /** Các dòng giá trị sau nhãn: phần còn lại trên cùng dòng, rồi các dòng kế tiếp tới nhãn/mục khác */
  const linesAfter = (label: RegExp, exclude?: RegExp): string[] => {
    for (let i = 0; i < plain.length; i++) {
      if (exclude && exclude.test(plain[i])) continue;
      const m = plain[i].match(label);
      if (!m) continue;
      const out: string[] = [];
      const rest = lines[i].slice((m.index ?? 0) + m[0].length).replace(/^[\s:\-/|]+/, "").trim();
      if (rest.length > 2) out.push(rest);
      for (let j = i + 1; j < lines.length; j++) {
        const isLabel = Object.values(LABELS).some((re) => re.test(plain[j])) || STOP.test(plain[j]);
        if (isLabel) break;
        if (lines[j].length > 1) out.push(lines[j]);
      }
      if (out.length) return out;
    }
    return [];
  };

  // Ngân hàng: logo/icon có thể tạo dòng rác ngắn phía trước -> lấy dòng có nhiều chữ/số nhất
  const bankLines = linesAfter(LABELS.bank);
  const bank = (bankLines.length ? bankLines.reduce((best, l) => (score(l) > score(best) ? l : best)) : "")
    .replace(/[^\p{L}\p{N}\s\-.…()&]/gu, "")
    .trim();

  // Số tài khoản/thẻ dài có thể xuống dòng: ghép các dòng tiếp theo chỉ toàn chữ số
  const accLines = linesAfter(LABELS.account, LABELS.bank);
  let accountLine = accLines[0] ?? "";
  for (const l of accLines.slice(1, 3)) {
    if (/^[\d\s.-]{3,}$/.test(l)) accountLine += l.trim();
    else break;
  }
  // Lấy cụm số dài nhất (cho phép nhóm số cách nhau, bỏ ký tự nhiễu lẻ từ icon)
  const account =
    (accountLine.match(/\d{3,}(?:[ .-]\d{3,})*/g) || [])
      .map(digitsOnly)
      .sort((a, b) => b.length - a.length)[0] || digitsOnly(accountLine);

  // Tên người nhận có thể xuống 2-3 dòng (vd "VND-TGTT-HKD NHA THUOC BANG" / "NHI") -> ghép lại
  const nameLines = linesAfter(LABELS.name, /ngan\s*hang/)
    .map((l) => l.replace(/[^\p{L}\p{N}\s.&-]/gu, "").trim())
    .filter((l) => score(l) >= 2);
  const name = fixStraySpaces(nameLines.slice(0, 3).join(" "));

  return { bank, account, name };
}

function score(line: string): number {
  return (line.match(/[\p{L}\p{N}]{2,}/gu) || []).join("").length;
}
