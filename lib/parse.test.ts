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
