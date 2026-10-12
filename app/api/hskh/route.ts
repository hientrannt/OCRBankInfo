import { NextResponse } from "next/server";
import { access } from "../history/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOC = "hskh.json";

/** Bảng HSKH dùng chung (chỉ mã KH -> MSNV, tên NVBH). Cùng quyền với lịch sử dùng chung. */
export async function GET(req: Request) {
  const a = access(req);
  if ("error" in a) return a.error;
  const text = await a.backend.getDoc(DOC);
  return new Response(text ?? "null", { headers: { "Content-Type": "application/json" } });
}

export async function PUT(req: Request) {
  const a = access(req);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => null)) as {
    entries?: Record<string, { msnv?: unknown; nvbh?: unknown }>;
    fileName?: unknown;
    importedAt?: unknown;
  } | null;
  if (!body || typeof body.entries !== "object" || !body.entries) {
    return NextResponse.json({ error: "Dữ liệu HSKH không hợp lệ" }, { status: 400 });
  }
  // Chỉ lưu đúng 3 trường cần dùng, cắt độ dài để tránh dữ liệu rác
  const entries: Record<string, { msnv: string; nvbh: string }> = {};
  for (const [code, v] of Object.entries(body.entries).slice(0, 50000)) {
    entries[String(code).slice(0, 40)] = { msnv: String(v?.msnv ?? "").slice(0, 40), nvbh: String(v?.nvbh ?? "").slice(0, 200) };
  }
  const data = {
    entries,
    fileName: String(body.fileName ?? "HSKH.xlsx").slice(0, 200),
    importedAt: Number(body.importedAt) || Date.now(),
    count: Object.keys(entries).length,
  };
  await a.backend.putDoc(DOC, JSON.stringify(data));
  return NextResponse.json({ ok: true, count: data.count });
}
