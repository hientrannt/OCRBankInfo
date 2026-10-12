import { NextResponse } from "next/server";
import { access } from "../history/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOC = "hskh.json";

/** Bảng HSKH dùng chung (mã KH -> MSNV, tên NVBH, STK đăng ký). Cùng quyền với lịch sử dùng chung. */
export async function GET(req: Request) {
  const a = access(req);
  if ("error" in a) return a.error;
  const text = await a.backend.getDoc(DOC);
  return new Response(text ?? "null", { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  const a = access(req);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => null)) as {
    entries?: Record<string, { msnv?: unknown; nvbh?: unknown; account?: unknown; owner?: unknown; bank?: unknown }>;
    fileName?: unknown;
    importedAt?: unknown;
  } | null;
  if (!body || typeof body.entries !== "object" || !body.entries) {
    return NextResponse.json({ error: "Dữ liệu HSKH không hợp lệ" }, { status: 400 });
  }
  // Chỉ lưu đúng các trường cần dùng (không có SĐT, CCCD...), cắt độ dài để tránh dữ liệu rác
  const entries: Record<string, { msnv: string; nvbh: string; account?: string; owner?: string; bank?: string }> = {};
  const opt = (v: unknown, max: number) => (v == null || v === "" ? undefined : String(v).slice(0, max));
  for (const [code, v] of Object.entries(body.entries).slice(0, 50000)) {
    entries[String(code).slice(0, 40)] = {
      msnv: String(v?.msnv ?? "").slice(0, 40),
      nvbh: String(v?.nvbh ?? "").slice(0, 200),
      account: opt(v?.account, 40),
      owner: opt(v?.owner, 200),
      bank: opt(v?.bank, 200),
    };
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
