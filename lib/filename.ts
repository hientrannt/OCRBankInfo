export interface ParsedFileName {
  /** Mã số KH, ví dụ "0573/00028" */
  customerCode: string;
  /** Tên cơ sở kinh doanh */
  businessName: string;
}

export const IMAGE_EXTENSIONS = /\.(jpe?g|png)$/i;

/**
 * "0573.00028_HỘ KINH DOANH NHÀ THUỐC MỸ  THỂ.JPG"
 *   -> { customerCode: "0573/00028", businessName: "HỘ KINH DOANH NHÀ THUỐC MỸ THỂ" }
 */
export function parseFileName(fileName: string): ParsedFileName {
  // Tên file trên macOS thường ở dạng NFD, chuẩn hóa về NFC để Excel hiển thị đúng
  const base = fileName.normalize("NFC").replace(/\.[^.]+$/, "");
  const idx = base.indexOf("_");
  if (idx < 0) {
    return { customerCode: "", businessName: cleanSpaces(base) };
  }
  const code = base.slice(0, idx).trim().replace(/\./g, "/");
  return { customerCode: code, businessName: cleanSpaces(base.slice(idx + 1)) };
}

function cleanSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
