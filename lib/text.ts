/** Bỏ dấu tiếng Việt, viết thường - dùng để so sánh mềm */
export function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Tên chủ tài khoản ngân hàng trong ảnh không có dấu. Tesseract (bộ tiếng Việt) và đôi khi AI tự đoán thêm dấu
 * (vd "THỊ", "NHÀ"), nên bỏ dấu và gộp khoảng trắng; giữ nguyên chữ hoa/thường như trong ảnh.
 */
export function bankName(s: string): string {
  return stripDiacritics(s).replace(/\s+/g, " ").trim();
}

export function looseKey(s: string): string {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}
