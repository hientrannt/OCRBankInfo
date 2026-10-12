import { NextResponse } from "next/server";
import { removeRecords, upsertRecords, type IncomingRecord } from "@/lib/sharedHistory";
import { access } from "./shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Toàn bộ lịch sử dùng chung (không kèm ảnh; ảnh lấy qua /api/history/thumb) */
export async function GET(req: Request) {
  const a = access(req);
  if ("error" in a) return a.error;
  const { records } = await a.backend.readIndex();
  return NextResponse.json({
    enabled: true,
    records: records.map(({ thumbBatch, ...r }) => ({ ...r, hasThumb: Boolean(thumbBatch) })),
  }, { headers: { "Cache-Control": "no-store" } });
}

/** Ghi/ghi đè một lô bản ghi (kèm ảnh thu nhỏ base64 nếu có) */
export async function POST(req: Request) {
  const a = access(req);
  if ("error" in a) return a.error;
  let body: { records?: IncomingRecord[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });
  }
  if (!Array.isArray(body.records)) return NextResponse.json({ error: "Thiếu records" }, { status: 400 });
  if (body.records.length > 200) return NextResponse.json({ error: "Tối đa 200 bản ghi mỗi lần" }, { status: 400 });
  try {
    const saved = await upsertRecords(a.backend, body.records);
    return NextResponse.json({ saved });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}

/** Xóa theo tên file, hoặc xóa toàn bộ ({ all: true }) */
export async function DELETE(req: Request) {
  const a = access(req);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => ({}))) as { fileNames?: string[]; all?: boolean };
  try {
    if (body.all) await a.backend.clearAll();
    else if (Array.isArray(body.fileNames)) await removeRecords(a.backend, body.fileNames);
    else return NextResponse.json({ error: "Thiếu fileNames" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
