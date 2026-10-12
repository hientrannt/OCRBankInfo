/** Bỏ dấu tiếng Việt, viết thường - dùng để so sánh mềm */
export function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Tên chủ tài khoản ngân hàng luôn là chữ IN HOA KHÔNG DẤU (như trong ảnh). Tesseract (bộ tiếng Việt) và đôi khi AI
 * tự đoán thêm dấu (vd "THỊ", "NHÀ"), nên chuẩn hóa: bỏ dấu, viết hoa, gộp khoảng trắng.
 */
export function bankName(s: string): string {
  return stripDiacritics(s).toUpperCase().replace(/\s+/g, " ").trim();
}

export function looseKey(s: string): string {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}
