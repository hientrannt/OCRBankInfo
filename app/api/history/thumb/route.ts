import { getThumb } from "@/lib/sharedHistory";
import { access } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ảnh thu nhỏ của một bản ghi: /api/history/thumb?f=<tên file> (cần header x-app-password) */
export async function GET(req: Request) {
  const a = access(req);
  if ("error" in a) return a.error;
  const fileName = new URL(req.url).searchParams.get("f") || "";
  const jpg = fileName ? await getThumb(a.backend, fileName) : null;
  if (!jpg) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(jpg), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
  });
}
