import Anthropic from "@anthropic-ai/sdk";

export type Provider = "claude" | "gemini";

export const DEFAULT_MODELS: Record<Provider, string> = {
  claude: process.env.OCR_MODEL || "claude-opus-5-5",
  gemini: process.env.GEMINI_MODEL || "gemini-2.5-flash",
};

export interface OcrResult {
  bank_raw: string;
  bank_code: string;
  account_number: string;
  recipient_name: string;
  uncertain: boolean;
  note: string;
}

/** Lỗi từ nhà cung cấp AI, kèm mã HTTP để trình duyệt biết có nên thử lại */
export class ProviderError extends Error {
  status: number;
  code: "bad_key" | "rate_limited" | "api_error";
  constructor(message: string, status: number, code: ProviderError["code"] = "api_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const PROMPT = `Đây là ảnh chụp màn hình ứng dụng ngân hàng, phần "Thông tin người nhận".
Hãy đọc chính xác từng ký tự của 3 trường: "Ngân hàng nhận", "Tài khoản/thẻ nhận", "Tên người nhận".
Quy tắc:
- Không suy đoán, không sửa chính tả, không thêm dấu tiếng Việt nếu ảnh không có dấu.
- Số tài khoản: đếm kỹ từng chữ số, đọc lại lần 2 để kiểm tra trước khi trả lời.
- Tên người nhận (và tên ngân hàng) có thể bị xuống 2-3 dòng trong cùng một ô: phải đọc và ghép ĐỦ TẤT CẢ các dòng
  theo thứ tự, ngăn cách bằng một dấu cách. Ví dụ ô hiển thị "VND-TGTT-HKD NHA THUOC BANG" rồi dòng dưới "NHI"
  thì kết quả là "VND-TGTT-HKD NHA THUOC BANG NHI". Không được bỏ dòng cuối.
- Giữ nguyên dấu gạch nối và chữ viết tắt, không thêm/bớt khoảng trắng bên trong (vd "TGTT" không phải "TGT T").
- Bỏ qua các biểu tượng (icon) cạnh ô nhập.`;

/** Lần đọc thứ 2 (đối chiếu): chỉ tập trung số tài khoản và tên, độc lập với lần 1 */
export const PROMPT_VERIFY = `Kiểm tra độc lập ảnh chụp màn hình chuyển tiền này.
1. Ô "Tài khoản/thẻ nhận": chép lại từng chữ số từ trái sang phải, đếm tổng số chữ số rồi đọc lại lần nữa cho chắc.
   Chú ý phân biệt kỹ các số dễ nhầm: 3/5/8, 1/7, 0/6/9. Nếu số xuống dòng thì ghép đủ.
2. Ô "Tên người nhận": chép NGUYÊN VĂN, nếu tên xuống 2-3 dòng thì ghép đủ tất cả các dòng.
Chỉ cần điền account_number và recipient_name; bank_raw và bank_code để trống. Đặt uncertain = true nếu có chữ số nào không chắc.`;

const FIELDS = {
  bank_raw: "Dòng 'Ngân hàng nhận' chép NGUYÊN VĂN như trong ảnh, kể cả dấu '...' nếu bị cắt.",
  bank_code: "Mã/tên viết tắt ngân hàng (vd AGRIBANK, VIETCOMBANK, BIDV). Rỗng nếu không thấy.",
  account_number: "Số 'Tài khoản/thẻ nhận', chỉ gồm chữ số (giữ nguyên số 0 ở đầu), không có khoảng trắng.",
  recipient_name:
    "'Tên người nhận' chép NGUYÊN VĂN, giữ nguyên chữ hoa/thường như ảnh; tên chủ tài khoản ngân hàng không có dấu, tuyệt đối không tự thêm dấu; nếu tên xuống nhiều dòng thì ghép đủ tất cả các dòng.",
  note: "Ghi chú ngắn nếu uncertain = true hoặc ảnh không đúng dạng.",
} as const;

export function normalizeResult(input: Record<string, unknown>): OcrResult {
  return {
    bank_raw: String(input.bank_raw ?? ""),
    bank_code: String(input.bank_code ?? ""),
    account_number: String(input.account_number ?? ""),
    recipient_name: String(input.recipient_name ?? ""),
    uncertain: Boolean(input.uncertain),
    note: String(input.note ?? ""),
  };
}

const UNCERTAIN = "true nếu có bất kỳ ký tự nào bị mờ, bị che, hoặc không chắc chắn.";

export async function extractWithClaude(image: string, mediaType: string, apiKey: string, model: string, prompt = PROMPT) {
  const tool: Anthropic.Tool = {
    name: "save_bank_info",
    description: "Lưu thông tin người nhận chuyển khoản đọc được từ ảnh chụp màn hình.",
    input_schema: {
      type: "object",
      properties: {
        ...Object.fromEntries(Object.entries(FIELDS).map(([k, d]) => [k, { type: "string", description: d }])),
        uncertain: { type: "boolean", description: UNCERTAIN },
      },
      required: ["bank_raw", "bank_code", "account_number", "recipient_name", "uncertain"],
    },
  };
  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model,
      max_tokens: 1024,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType as "image/png" | "image/jpeg", data: image },
            },
            { type: "text", text: `${prompt}\nGọi công cụ save_bank_info với kết quả.` },
          ],
        },
      ],
    });
    const block = msg.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new ProviderError("Claude không trả về kết quả", 502);
    return normalizeResult(block.input as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Anthropic.APIError) {
      const status = err.status && err.status >= 400 ? err.status : 502;
      if (status === 401 || status === 403) throw new ProviderError("API key Claude không hợp lệ", status, "bad_key");
      if (status === 429 || status === 529) throw new ProviderError("Claude đang quá tải, sẽ thử lại", status, "rate_limited");
      throw new ProviderError(err.message, status);
    }
    throw new ProviderError(err instanceof Error ? err.message : String(err), 502);
  }
}

export async function extractWithGemini(
  image: string,
  mediaType: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
  prompt = PROMPT,
) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ inline_data: { mime_type: mediaType, data: image } }, { text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              ...Object.fromEntries(Object.entries(FIELDS).map(([k, d]) => [k, { type: "STRING", description: d }])),
              uncertain: { type: "BOOLEAN", description: UNCERTAIN },
            },
            required: ["bank_raw", "bank_code", "account_number", "recipient_name", "uncertain"],
          },
        },
      }),
    });
  } catch (err) {
    throw new ProviderError(`Không kết nối được Gemini: ${err instanceof Error ? err.message : err}`, 502);
  }
  const data = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok) {
    const msg: string = data?.error?.message || `Gemini lỗi HTTP ${res.status}`;
    const reason = JSON.stringify(data?.error?.details ?? "");
    if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(msg + reason))
      throw new ProviderError("API key Gemini không hợp lệ", res.status === 400 ? 401 : res.status, "bad_key");
    if (res.status === 429 || res.status === 503)
      throw new ProviderError("Gemini đang quá tải hoặc hết hạn mức, sẽ thử lại", res.status, "rate_limited");
    if (res.status === 404) throw new ProviderError(`Không có model Gemini "${model}"`, 400);
    throw new ProviderError(msg, res.status >= 500 ? 502 : res.status);
  }
  const text: string | undefined = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text ?? "")
    .join("");
  if (!text) {
    const why = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "trống";
    throw new ProviderError(`Gemini không trả về kết quả (${why})`, 502);
  }
  try {
    return normalizeResult(JSON.parse(text));
  } catch {
    throw new ProviderError("Gemini trả về dữ liệu không đúng dạng JSON", 502);
  }
}
