export interface ClaudeResult {
  bank_raw: string;
  bank_code: string;
  account_number: string;
  recipient_name: string;
  uncertain: boolean;
  note?: string;
}

/** Lỗi khiến mọi ảnh sau đều hỏng (sai mật khẩu, thiếu/sai key): dừng cả lượt đọc */
export class FatalOcrError extends Error {}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const FATAL_CODES = new Set(["bad_password", "no_key", "bad_key"]);

export interface ReadOptions {
  password: string;
  /** Dừng việc chờ thử lại khi người dùng bấm Dừng */
  shouldStop?: () => boolean;
  retries?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Gửi ảnh lên /api/ocr. Tự thử lại khi Claude quá tải (429/529), máy chủ lỗi tạm thời
 * hoặc mất mạng, chờ tăng dần 2s, 4s, 8s...
 */
export async function postOcr(
  payload: { image: string; mediaType: string },
  opts: ReadOptions,
): Promise<ClaudeResult> {
  const { retries = 4, baseDelayMs = 2000, fetchImpl = fetch, sleep = defaultSleep } = opts;
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(baseDelayMs * 2 ** (attempt - 1));
      if (opts.shouldStop?.()) break;
    }
    let res: Response;
    try {
      res = await fetchImpl("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-password": opts.password },
        body: JSON.stringify(payload),
      });
    } catch {
      lastError = "Mất kết nối mạng";
      continue;
    }
    // Vercel trả trang lỗi HTML/text khi quá thời gian (504) hoặc ảnh quá lớn (413)
    const text = await res.text();
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (res.ok && data) return data as unknown as ClaudeResult;

    const code = typeof data?.code === "string" ? data.code : "";
    const message =
      (typeof data?.error === "string" && data.error) ||
      (res.status === 413 ? "Ảnh quá lớn" : res.status === 504 ? "Máy chủ xử lý quá lâu" : `Lỗi máy chủ (HTTP ${res.status})`);
    if (FATAL_CODES.has(code)) throw new FatalOcrError(message);
    if (!RETRY_STATUS.has(res.status)) throw new Error(message);
    lastError = message;
  }
  throw new Error(`${lastError || "Lỗi"} - đã thử lại nhiều lần, bấm Đọc lại để thử lại`);
}
