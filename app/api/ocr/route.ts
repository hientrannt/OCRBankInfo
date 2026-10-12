import { NextResponse } from "next/server";
import { checkPassword } from "@/lib/auth";
import {
  DEFAULT_MODELS,
  PROMPT,
  PROMPT_VERIFY,
  ProviderError,
  extractWithClaude,
  extractWithGemini,
  type Provider,
} from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 60;

const ENV_KEYS: Record<Provider, string | undefined> = {
  claude: process.env.ANTHROPIC_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
};
const KEY_NAMES: Record<Provider, string> = { claude: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };

export async function GET() {
  return NextResponse.json({
    // hasKey: giữ cho tương thích với bản cũ (có key Claude trên máy chủ)
    hasKey: Boolean(ENV_KEYS.claude),
    serverKeys: { claude: Boolean(ENV_KEYS.claude), gemini: Boolean(ENV_KEYS.gemini) },
    needPassword: Boolean(process.env.APP_PASSWORD),
    defaultModels: DEFAULT_MODELS,
  });
}

export async function POST(req: Request) {
  let body: { image?: string; mediaType?: string; provider?: string; model?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });
  }
  const provider: Provider = body.provider === "gemini" ? "gemini" : "claude";
  const mediaType = body.mediaType === "image/png" ? "image/png" : "image/jpeg";
  if (!body.image) return NextResponse.json({ error: "Thiếu ảnh" }, { status: 400 });

  // Người dùng tự nhập key trên giao diện: dùng key đó (không cần mật khẩu, không lưu lại trên máy chủ)
  const userKey = (req.headers.get("x-user-api-key") || "").trim();
  let apiKey = userKey;
  if (!apiKey) {
    if (!checkPassword(req)) {
      return NextResponse.json(
        { error: "Sai mật khẩu truy cập", code: "bad_password", needPassword: true },
        { status: 401 },
      );
    }
    apiKey = ENV_KEYS[provider] || "";
    if (!apiKey) {
      return NextResponse.json(
        {
          error: `Chưa có API key ${provider === "gemini" ? "Gemini" : "Claude"}: nhập key trên giao diện hoặc đặt ${KEY_NAMES[provider]} trên Vercel`,
          code: "no_key",
        },
        { status: 400 },
      );
    }
  }
  const model = (body.model || "").trim() || DEFAULT_MODELS[provider];
  // mode "verify": lần đọc thứ 2 chỉ để đối chiếu số tài khoản và tên
  const prompt = body.mode === "verify" ? PROMPT_VERIFY : PROMPT;

  try {
    const result =
      provider === "gemini"
        ? await extractWithGemini(body.image, mediaType, apiKey, model, fetch, prompt)
        : await extractWithClaude(body.image, mediaType, apiKey, model, prompt);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ProviderError) {
      // Key sai là lỗi phía cấu hình: trả 400 kèm mã để trình duyệt dừng cả lượt, không thử lại
      const status = err.code === "bad_key" ? 400 : err.status;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
