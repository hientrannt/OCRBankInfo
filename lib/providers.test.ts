import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, extractWithGemini } from "./providers.ts";

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("Gemini: đọc JSON trả về, gửi key qua header", async () => {
  let url = "", headers: Record<string, string> = {}, body: any;
  const impl = (async (u: string, init: RequestInit) => {
    url = u;
    headers = init.headers as Record<string, string>;
    body = JSON.parse(String(init.body));
    const text = JSON.stringify({ bank_raw: "AGRIBANK - Ngân hàng Nôn...", bank_code: "AGRIBANK", account_number: "4705235387979", recipient_name: "Ho Kinh Doanh An Binh", uncertain: false });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await extractWithGemini("BASE64", "image/png", "AIza-key", "gemini-2.5-flash", impl);
  assert.equal(r.account_number, "4705235387979");
  assert.equal(r.note, "");
  assert.match(url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(headers["x-goog-api-key"], "AIza-key");
  assert.equal(body.contents[0].parts[0].inline_data.data, "BASE64");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
});

test("Gemini: phân loại lỗi key sai / quá tải / model không có", async () => {
  const bad = reply(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
  await assert.rejects(extractWithGemini("x", "image/png", "k", "m", bad), (e: ProviderError) => e.code === "bad_key");
  const busy = reply(429, { error: { message: "Resource has been exhausted" } });
  await assert.rejects(extractWithGemini("x", "image/png", "k", "m", busy), (e: ProviderError) => e.code === "rate_limited" && e.status === 429);
  const missing = reply(404, { error: { message: "models/abc is not found" } });
  await assert.rejects(extractWithGemini("x", "image/png", "k", "abc", missing), /Không có model Gemini "abc"/);
  const blocked = reply(200, { promptFeedback: { blockReason: "SAFETY" } });
  await assert.rejects(extractWithGemini("x", "image/png", "k", "m", blocked), /SAFETY/);
});
