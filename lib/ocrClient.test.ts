import { test } from "node:test";
import assert from "node:assert/strict";
import { FatalOcrError, postOcr } from "./ocrClient.ts";

const payload = { image: "x", mediaType: "image/png" };
const ok = { bank_raw: "AGRIBANK", bank_code: "AGRIBANK", account_number: "123456", recipient_name: "A", uncertain: false };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const noSleep = async () => {};

// Mỗi lần gọi trả về bản sao mới (body của Response chỉ đọc được một lần)
function fakeFetch(responses: Array<Response | Error>) {
  let i = 0;
  const calls = { n: 0 };
  const impl = (async () => {
    calls.n++;
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("thử lại khi Claude quá tải rồi thành công", async () => {
  const f = fakeFetch([json(429, { code: "rate_limited" }), json(529, { code: "rate_limited" }), json(200, ok)]);
  const r = await postOcr(payload, { password: "", fetchImpl: f.impl, sleep: noSleep });
  assert.equal(r.account_number, "123456");
  assert.equal(f.calls.n, 3);
});

test("thử lại khi mất mạng hoặc Vercel trả trang lỗi không phải JSON", async () => {
  const f = fakeFetch([new TypeError("fetch failed"), new Response("An error occurred", { status: 504 }), json(200, ok)]);
  const r = await postOcr(payload, { password: "", fetchImpl: f.impl, sleep: noSleep });
  assert.equal(r.recipient_name, "A");
});

test("sai mật khẩu / thiếu key là lỗi dừng cả lượt, không thử lại", async () => {
  const f = fakeFetch([json(401, { code: "bad_password", error: "Sai mật khẩu truy cập" })]);
  await assert.rejects(postOcr(payload, { password: "x", fetchImpl: f.impl, sleep: noSleep }), FatalOcrError);
  assert.equal(f.calls.n, 1);
  const g = fakeFetch([json(500, { code: "no_key", error: "Chưa cấu hình" })]);
  await assert.rejects(postOcr(payload, { password: "", fetchImpl: g.impl, sleep: noSleep }), FatalOcrError);
});

test("lỗi 400 không thử lại; quá số lần thử thì báo lỗi rõ ràng", async () => {
  const f = fakeFetch([json(400, { error: "Ảnh không hợp lệ" })]);
  await assert.rejects(postOcr(payload, { password: "", fetchImpl: f.impl, sleep: noSleep }), /Ảnh không hợp lệ/);
  assert.equal(f.calls.n, 1);
  const g = fakeFetch([new Response("<html>", { status: 413 })]);
  await assert.rejects(postOcr(payload, { password: "", fetchImpl: g.impl, sleep: noSleep }), /Ảnh quá lớn/);
  const h = fakeFetch([json(503, { error: "busy" })]);
  await assert.rejects(postOcr(payload, { password: "", fetchImpl: h.impl, sleep: noSleep, retries: 2 }), /thử lại nhiều lần/);
  assert.equal(h.calls.n, 3);
});

test("bấm Dừng thì không thử lại nữa", async () => {
  const f = fakeFetch([json(429, {}), json(200, ok)]);
  await assert.rejects(postOcr(payload, { password: "", fetchImpl: f.impl, sleep: noSleep, shouldStop: () => true }));
  assert.equal(f.calls.n, 1);
});
