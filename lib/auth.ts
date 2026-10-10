import { timingSafeEqual } from "node:crypto";

/** So khớp header x-app-password với APP_PASSWORD (true nếu máy chủ không đặt mật khẩu) */
export function checkPassword(req: Request): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return true;
  const given = Buffer.from(req.headers.get("x-app-password") || "");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}
