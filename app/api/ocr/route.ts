import Anthropic from "@anthropic-ai/sdk";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.OCR_MODEL || "claude-opus-5-5";

const TOOL: Anthropic.Tool = {
  name: "save_bank_info",
  description: "Lưu thông tin người nhận chuyển khoản đọc được từ ảnh chụp màn hình.",
  input_schema: {
    type: "object",
    properties: {
      bank_raw: {
        type: "string",
        description: "Dòng 'Ngân hàng nhận' chép NGUYÊN VĂN như trong ảnh, kể cả dấu '...' nếu bị cắt.",
      },
      bank_code: {
        type: "string",
        description: "Mã/tên viết tắt ngân hàng (vd AGRIBANK, VIETCOMBANK, BIDV). Rỗng nếu không thấy.",
      },
      account_number: {
        type: "string",
        description: "Số 'Tài khoản/thẻ nhận', chỉ gồm chữ số (giữ nguyên số 0 ở đầu), không có khoảng trắng.",
      },
      recipient_name: {
        type: "string",
        description: "'Tên người nhận' chép NGUYÊN VĂN, giữ nguyên dấu/không dấu và chữ hoa/thường như trong ảnh.",
      },
      uncertain: {
        type: "boolean",
        description: "true nếu có bất kỳ ký tự nào bị mờ, bị che, hoặc không chắc chắn.",
      },
      note: { type: "string", description: "Ghi chú ngắn nếu uncertain = true hoặc ảnh không đúng dạng." },
    },
    required: ["bank_raw", "bank_code", "account_number", "recipient_name", "uncertain"],
  },
};

const PROMPT = `Đây là ảnh chụp màn hình ứng dụng ngân hàng, phần "Thông tin người nhận".
Hãy đọc chính xác từng ký tự của 3 trường: "Ngân hàng nhận", "Tài khoản/thẻ nhận", "Tên người nhận".
Quy tắc:
- Không suy đoán, không sửa chính tả, không thêm dấu tiếng Việt nếu ảnh không có dấu.
- Số tài khoản: đếm kỹ từng chữ số, đọc lại lần 2 để kiểm tra trước khi trả lời.
- Bỏ qua các biểu tượng (icon) cạnh ô nhập.
Gọi công cụ save_bank_info với kết quả.`;

/** Khi đặt APP_PASSWORD, chỉ người biết mật khẩu mới dùng được API key (tránh bị người lạ dùng tốn tiền) */
function checkPassword(req: Request): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return true;
  const given = Buffer.from(req.headers.get("x-app-password") || "");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function GET() {
  return NextResponse.json({
    hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
    needPassword: Boolean(process.env.APP_PASSWORD),
  });
}

export async function POST(req: Request) {
  if (!checkPassword(req)) {
    return NextResponse.json(
      { error: "Sai mật khẩu truy cập", code: "bad_password", needPassword: true },
      { status: 401 },
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      {
        error: "Chưa cấu hình ANTHROPIC_API_KEY (file .env.local hoặc Environment Variables trên Vercel)",
        code: "no_key",
      },
      { status: 500 },
    );
  }

  let body: { image?: string; mediaType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });
  }
  const mediaType = body.mediaType === "image/png" ? "image/png" : "image/jpeg";
  if (!body.image) {
    return NextResponse.json({ error: "Thiếu ảnh" }, { status: 400 });
  }

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: body.image } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
    const block = msg.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      return NextResponse.json({ error: "Model không trả về kết quả" }, { status: 502 });
    }
    const input = block.input as Record<string, unknown>;
    return NextResponse.json({
      bank_raw: String(input.bank_raw ?? ""),
      bank_code: String(input.bank_code ?? ""),
      account_number: String(input.account_number ?? ""),
      recipient_name: String(input.recipient_name ?? ""),
      uncertain: Boolean(input.uncertain),
      note: String(input.note ?? ""),
    });
  } catch (err) {
    // Giữ nguyên mã lỗi của Claude (429 quá tải, 529 bận, 401 sai key...) để trình duyệt biết có nên thử lại
    if (err instanceof Anthropic.APIError) {
      const status = err.status && err.status >= 400 ? err.status : 502;
      const code = status === 401 ? "bad_key" : status === 429 || status === 529 ? "rate_limited" : "api_error";
      const error =
        code === "bad_key"
          ? "ANTHROPIC_API_KEY không hợp lệ"
          : code === "rate_limited"
            ? "Claude đang quá tải, sẽ thử lại"
            : err.message;
      return NextResponse.json({ error, code }, { status: status === 401 ? 500 : status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
