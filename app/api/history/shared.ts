import { NextResponse } from "next/server";
import { checkPassword } from "@/lib/auth";
import { getBackend, type Backend } from "@/lib/sharedHistory";

/**
 * Kiểm tra lịch sử dùng chung có dùng được không và người gọi có quyền không.
 * Trên Vercel bắt buộc đặt APP_PASSWORD: dữ liệu có số tài khoản ngân hàng, không để ai có link cũng xem được.
 */
export function access(req: Request): { backend: Backend } | { error: NextResponse } {
  const backend = getBackend();
  if (!backend) {
    return {
      error: NextResponse.json(
        {
          enabled: false,
          code: "no_store",
          error: "Máy chủ chưa có kho lưu trữ (Vercel Blob). Vào Vercel → Storage → tạo Blob store và kết nối với project.",
        },
        { status: 503 },
      ),
    };
  }
  if (backend.kind === "blob" && !process.env.APP_PASSWORD) {
    return {
      error: NextResponse.json(
        {
          enabled: false,
          code: "no_password",
          error: "Cần đặt APP_PASSWORD trên Vercel (Settings → Environment Variables) để bật lịch sử dùng chung.",
        },
        { status: 403 },
      ),
    };
  }
  if (!checkPassword(req)) {
    return {
      error: NextResponse.json(
        { enabled: true, code: "bad_password", error: "Sai mật khẩu truy cập" },
        { status: 401 },
      ),
    };
  }
  return { backend };
}
