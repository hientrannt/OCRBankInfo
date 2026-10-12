import { NextResponse } from "next/server";
import { checkPassword } from "@/lib/auth";
import { DEFAULT_MODELS, type Provider } from "@/lib/providers";

export const runtime = "nodejs";

const ENV_KEYS: Record<Provider, string | undefined> = {
  claude: process.env.ANTHROPIC_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
};

/**
 * Kiểm tra API key + model có dùng được không, không tốn lượt đọc ảnh:
 * hỏi thông tin model (Gemini: models.get, Claude: /v1/models/{id}).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { provider?: string; model?: string };
  const provider: Provider = body.provider === "gemini" ? "gemini" : "claude";
  const model = (body.model || "").trim() || DEFAULT_MODELS[provider];
  const userKey = (req.headers.get("x-user-api-key") || "").trim();
  let key = userKey;
  if (!key) {
    if (!checkPassword(req)) return NextResponse.json({ ok: false, error: "Sai mật khẩu truy cập" }, { status: 401 });
    key = ENV_KEYS[provider] || "";
    if (!key) return NextResponse.json({ ok: false, error: "Chưa nhập API key" }, { status: 400 });
  }
  try {
    const res =
      provider === "gemini"
        ? await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
            headers: { "x-goog-api-key": key },
          })
        : await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { displayName?: string; display_name?: string };
      return NextResponse.json({ ok: true, model, displayName: data.displayName || data.display_name || model });
    }
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    const msg = data?.error?.message || "";
    const error =
      res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid|invalid x-api-key/i.test(msg)
        ? `API key ${provider === "gemini" ? "Gemini" : "Claude"} không hợp lệ`
        : res.status === 404
          ? `Không có model "${model}" (hoặc key không được dùng model này)`
          : res.status === 429
            ? "Key đúng nhưng đang hết hạn mức (quota), thử lại sau"
            : msg || `Lỗi HTTP ${res.status}`;
    return NextResponse.json({ ok: false, error, status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Không kết nối được: ${err instanceof Error ? err.message : err}` });
  }
}
