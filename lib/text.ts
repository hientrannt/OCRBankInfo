/** Bỏ dấu tiếng Việt, viết thường - dùng để so sánh mềm */
export function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export function looseKey(s: string): string {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}
