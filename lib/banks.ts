import { looseKey } from "./text.ts";

/**
 * Danh sách mã ngân hàng -> tên đầy đủ, dùng để khôi phục tên ngân hàng
 * khi ảnh chụp bị cắt (ví dụ "AGRIBANK - Ngân hàng Nôn...").
 */
export const BANKS: Record<string, string> = {
  AGRIBANK: "Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam",
  VIETCOMBANK: "Ngân hàng TMCP Ngoại thương Việt Nam",
  VCB: "Ngân hàng TMCP Ngoại thương Việt Nam",
  VIETINBANK: "Ngân hàng TMCP Công thương Việt Nam",
  BIDV: "Ngân hàng TMCP Đầu tư và Phát triển Việt Nam",
  TECHCOMBANK: "Ngân hàng TMCP Kỹ thương Việt Nam",
  TCB: "Ngân hàng TMCP Kỹ thương Việt Nam",
  MB: "Ngân hàng TMCP Quân đội",
  MBBANK: "Ngân hàng TMCP Quân đội",
  ACB: "Ngân hàng TMCP Á Châu",
  VPBANK: "Ngân hàng TMCP Việt Nam Thịnh Vượng",
  TPBANK: "Ngân hàng TMCP Tiên Phong",
  SACOMBANK: "Ngân hàng TMCP Sài Gòn Thương Tín",
  HDBANK: "Ngân hàng TMCP Phát triển TP. Hồ Chí Minh",
  VIB: "Ngân hàng TMCP Quốc tế Việt Nam",
  SHB: "Ngân hàng TMCP Sài Gòn - Hà Nội",
  EXIMBANK: "Ngân hàng TMCP Xuất Nhập khẩu Việt Nam",
  MSB: "Ngân hàng TMCP Hàng Hải Việt Nam",
  OCB: "Ngân hàng TMCP Phương Đông",
  SCB: "Ngân hàng TMCP Sài Gòn",
  SEABANK: "Ngân hàng TMCP Đông Nam Á",
  LPBANK: "Ngân hàng TMCP Lộc Phát Việt Nam",
  LIENVIETPOSTBANK: "Ngân hàng TMCP Bưu điện Liên Việt",
  ABBANK: "Ngân hàng TMCP An Bình",
  BACABANK: "Ngân hàng TMCP Bắc Á",
  NAMABANK: "Ngân hàng TMCP Nam Á",
  PVCOMBANK: "Ngân hàng TMCP Đại Chúng Việt Nam",
  VIETBANK: "Ngân hàng TMCP Việt Nam Thương Tín",
  VIETABANK: "Ngân hàng TMCP Việt Á",
  KIENLONGBANK: "Ngân hàng TMCP Kiên Long",
  BAOVIETBANK: "Ngân hàng TMCP Bảo Việt",
  SAIGONBANK: "Ngân hàng TMCP Sài Gòn Công Thương",
  PGBANK: "Ngân hàng TMCP Thịnh vượng và Phát triển",
  NCB: "Ngân hàng TMCP Quốc Dân",
  BVBANK: "Ngân hàng TMCP Bản Việt",
  VIETCAPITALBANK: "Ngân hàng TMCP Bản Việt",
  GPBANK: "Ngân hàng TM TNHH MTV Dầu Khí Toàn Cầu",
  OCEANBANK: "Ngân hàng TM TNHH MTV Đại Dương",
  CBBANK: "Ngân hàng TM TNHH MTV Xây dựng Việt Nam",
  VBSP: "Ngân hàng Chính sách Xã hội",
  VDB: "Ngân hàng Phát triển Việt Nam",
  COOPBANK: "Ngân hàng Hợp tác xã Việt Nam",
  SHINHANBANK: "Ngân hàng TNHH MTV Shinhan Việt Nam",
  WOORIBANK: "Ngân hàng TNHH MTV Woori Việt Nam",
  HSBC: "Ngân hàng TNHH MTV HSBC (Việt Nam)",
  STANDARDCHARTERED: "Ngân hàng TNHH MTV Standard Chartered (Việt Nam)",
  UOB: "Ngân hàng TNHH MTV United Overseas Bank (Việt Nam)",
  PUBLICBANK: "Ngân hàng TNHH MTV Public Việt Nam",
  CAKE: "Ngân hàng số CAKE by VPBank",
  TIMO: "Ngân hàng số Timo by Bản Việt Bank",
  UBANK: "Ngân hàng số Ubank by VPBank",
};

/**
 * Chuẩn hóa tên ngân hàng: nếu tên bị cắt ("...") hoặc chỉ có mã,
 * thì ghép mã với tên đầy đủ trong danh sách.
 */
export function normalizeBankName(raw: string, code?: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  let candidate = (code || text.split(/\s*-\s*/)[0] || "").trim();
  if (!BANKS[looseKey(candidate).toUpperCase()]) {
    // OCR có thể dính ký tự rác từ logo phía trước ("B4 AGRIBANK - ...")
    const found = text.split(/[\s-]+/).find((w) => BANKS[looseKey(w).toUpperCase()]);
    if (found) {
      candidate = found;
      text = text.slice(text.indexOf(found));
    }
  }
  const full = BANKS[looseKey(candidate).toUpperCase()];
  if (!full) return text.replace(/(\.\.\.|…)$/, "").trim();
  const truncated = /(\.\.\.|…)$/.test(text) || !text.includes("-");
  if (!truncated) return text;
  return `${candidate.toUpperCase()} - ${full}`;
}
