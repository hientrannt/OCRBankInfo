import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFileName } from "./filename.ts";
import { parseOcrText } from "./parseText.ts";
import { normalizeBankName } from "./banks.ts";

test("parseFileName tách mã KH và tên CSKD", () => {
  assert.deepEqual(parseFileName("0573.00028_HỘ KINH DOANH NHÀ THUỐC MỸ  THỂ.JPG"), {
    customerCode: "0573/00028",
    businessName: "HỘ KINH DOANH NHÀ THUỐC MỸ THỂ",
  });
  // Tên file dạng NFD (macOS)
  const nfd = "0573.00029_NHÀ THUỐC.png".normalize("NFD");
  assert.equal(parseFileName(nfd).businessName, "NHÀ THUỐC");
  assert.equal(parseFileName("abc.png").customerCode, "");
});

test("parseOcrText đọc văn bản dạng màn hình chuyển tiền", () => {
  const text = `Thông tin người nhận  Mẫu chuyển tiền
Ngân hàng nhận
A . Ñ Vv
AGRIBANK - Ngân hàng Nôn...
Tài khoản/thẻ nhận
4705235387979 5
Tên người nhận
Ho Kinh Doanh An Binh`;
  assert.deepEqual(parseOcrText(text), {
    bank: "AGRIBANK - Ngân hàng Nôn...",
    account: "4705235387979",
    name: "Ho Kinh Doanh An Binh",
  });
});

test("normalizeBankName khôi phục tên bị cắt", () => {
  assert.equal(
    normalizeBankName("AGRIBANK - Ngân hàng Nôn..."),
    "AGRIBANK - Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam",
  );
  assert.equal(normalizeBankName("Vietcombank"), "VIETCOMBANK - Ngân hàng TMCP Ngoại thương Việt Nam");
  assert.equal(
    normalizeBankName("B4 AGRIBANK - Ngân hàngNôn..."),
    "AGRIBANK - Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam",
  );
  assert.equal(normalizeBankName("Ngân hàng lạ ABC"), "Ngân hàng lạ ABC");
});

test("parseOcrText giữ STK có nhóm số cách nhau", () => {
  const t = parseOcrText("Tài khoản/thẻ nhận\n0071 0001 23456 2\nTên người nhận\nNGUYEN VAN A");
  assert.equal(t.account, "0071000123456");
});

test("parseOcrText ghép tên người nhận xuống 2 dòng và sửa khoảng trắng lạc", () => {
  // Văn bản Tesseract thật của ảnh TECHCOMBANK (tên xuống dòng "NHI")
  const text = `Thông tin người nhận. (=) Mẫu chuyển tiền
Ngân hàng nhận
<> JR

TECHCOMBANK - Ngan han...

Tài khoản/thẻ nhận -

19050622266014

Tên người nhận

VND-TGT T-HKD NHA THUOC BANG

NHI
`;
  const r = parseOcrText(text);
  assert.equal(r.name, "VND-TGTT-HKD NHA THUOC BANG NHI");
  assert.equal(r.account, "19050622266014");
  assert.equal(normalizeBankName(r.bank), "TECHCOMBANK - Ngân hàng TMCP Kỹ thương Việt Nam");
});

test("parseOcrText dừng ghép tên khi gặp mục khác (Số tiền, Nội dung)", () => {
  const r = parseOcrText("Tên người nhận\nNGUYEN VAN A\nSố tiền\n1.000.000 VND\nNội dung\nTHANH TOAN");
  assert.equal(r.name, "NGUYEN VAN A");
});

test("parseFileName với tên file thật trên ổ mạng", () => {
  assert.deepEqual(parseFileName("0583.00228_HỘ KINH DOANH NHÀ THUỐC ÁNH TRANG 2.jpg"), {
    customerCode: "0583/00228",
    businessName: "HỘ KINH DOANH NHÀ THUỐC ÁNH TRANG 2",
  });
});
