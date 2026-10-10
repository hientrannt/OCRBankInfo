/**
 * Lịch sử dùng chung lưu trên máy chủ.
 * - Vercel: Vercel Blob (store riêng tư), cần BLOB_READ_WRITE_TOKEN (tự có khi kết nối store với project).
 * - Chạy trên máy: thư mục .data/ocr-history (hoặc OCR_HISTORY_DIR).
 *
 * Cấu trúc: một file index.json chứa toàn bộ dữ liệu (không có ảnh), ảnh thu nhỏ gom theo từng lô
 * (thumbs/<lô>.json: { id: base64 }) để mỗi lần lưu chỉ tốn 2 lượt ghi dù lô có nhiều ảnh
 * (gói miễn phí của Vercel Blob giới hạn số lượt ghi mỗi tháng).
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface SharedRecord {
  fileName: string;
  customerCode: string;
  businessName: string;
  bank: string;
  account: string;
  name: string;
  status: "ok" | "review";
  note: string;
  engine: string;
  size: number;
  readAt: number;
  /** Lô chứa ảnh thu nhỏ (rỗng = không có ảnh) */
  thumbBatch?: string;
}

export interface IncomingRecord extends Omit<SharedRecord, "thumbBatch"> {
  /** Ảnh thu nhỏ JPEG dạng base64 (không bắt buộc; không gửi thì giữ ảnh cũ) */
  thumb?: string;
}

export class ConflictError extends Error {}

export interface Backend {
  kind: "blob" | "fs";
  readIndex(): Promise<{ records: SharedRecord[]; etag: string | null }>;
  /** Ghi đè index; ném ConflictError nếu index đã bị người khác sửa từ lúc đọc (etag khác) */
  writeIndex(records: SharedRecord[], etag: string | null): Promise<void>;
  putThumbBatch(batch: string, thumbs: Record<string, string>): Promise<void>;
  getThumbBatch(batch: string): Promise<Record<string, string> | null>;
  deleteThumbBatches(batches: string[]): Promise<void>;
  clearAll(): Promise<void>;
}

export const recordId = (fileName: string) =>
  createHash("sha256").update(fileName.normalize("NFC")).digest("hex").slice(0, 32);

const PREFIX = "ocr-history";
const INDEX = `${PREFIX}/index.json`;
const thumbPath = (batch: string) => `${PREFIX}/thumbs/${batch}.json`;

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function blobBackend(): Backend {
  // Nạp động để môi trường không dùng Blob (chạy trên máy, test) không cần token
  const lib = () => import("@vercel/blob");
  const opts = { access: "private" as const };
  return {
    kind: "blob",
    async readIndex() {
      const { get } = await lib();
      const res = await get(INDEX, { ...opts, useCache: false });
      if (!res || res.statusCode !== 200) return { records: [], etag: null };
      const records = JSON.parse(await streamToText(res.stream)) as SharedRecord[];
      return { records, etag: (res.blob as { etag?: string }).etag ?? null };
    },
    async writeIndex(records, etag) {
      const { put, BlobPreconditionFailedError } = await lib();
      try {
        await put(INDEX, JSON.stringify(records), {
          ...opts,
          contentType: "application/json",
          addRandomSuffix: false,
          allowOverwrite: true,
          ...(etag ? { ifMatch: etag } : {}),
        });
      } catch (err) {
        if (err instanceof BlobPreconditionFailedError) throw new ConflictError("index changed");
        throw err;
      }
    },
    async putThumbBatch(batch, thumbs) {
      const { put } = await lib();
      await put(thumbPath(batch), JSON.stringify(thumbs), {
        ...opts,
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    },
    async getThumbBatch(batch) {
      const { get } = await lib();
      const res = await get(thumbPath(batch), opts);
      if (!res || res.statusCode !== 200) return null;
      return JSON.parse(await streamToText(res.stream));
    },
    async deleteThumbBatches(batches) {
      if (!batches.length) return;
      const { del } = await lib();
      await del(batches.map(thumbPath)).catch(() => {});
    },
    async clearAll() {
      const { list, del } = await lib();
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: `${PREFIX}/`, cursor, limit: 1000 });
        if (page.blobs.length) await del(page.blobs.map((b) => b.url));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    },
  };
}

function fsBackend(dir: string): Backend {
  const file = (p: string) => path.join(dir, p.replace(`${PREFIX}/`, ""));
  // ETag = băm nội dung (thời gian sửa file không đủ: hai lần ghi trong cùng 1ms có thể trùng)
  const etagOf = async () => {
    const text = await fs.readFile(file(INDEX)).catch(() => null);
    return text ? createHash("sha256").update(text).digest("hex") : null;
  };
  let lock: Promise<unknown> = Promise.resolve();
  return {
    kind: "fs",
    async readIndex() {
      const text = await fs.readFile(file(INDEX), "utf8").catch(() => null);
      return {
        records: text ? JSON.parse(text) : [],
        etag: text ? createHash("sha256").update(text).digest("hex") : null,
      };
    },
    async writeIndex(records, etag) {
      // Khóa trong tiến trình để so sánh etag rồi ghi là một bước liền
      const run = lock.then(async () => {
        if ((await etagOf()) !== etag) throw new ConflictError("index changed");
        await fs.mkdir(path.dirname(file(INDEX)), { recursive: true });
        const tmp = `${file(INDEX)}.${randomUUID()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(records));
        await fs.rename(tmp, file(INDEX));
      });
      lock = run.catch(() => {});
      await run;
    },
    async putThumbBatch(batch, thumbs) {
      await fs.mkdir(path.dirname(file(thumbPath(batch))), { recursive: true });
      await fs.writeFile(file(thumbPath(batch)), JSON.stringify(thumbs));
    },
    async getThumbBatch(batch) {
      const text = await fs.readFile(file(thumbPath(batch)), "utf8").catch(() => null);
      return text ? JSON.parse(text) : null;
    },
    async deleteThumbBatches(batches) {
      await Promise.all(batches.map((b) => fs.rm(file(thumbPath(b)), { force: true })));
    },
    async clearAll() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Chọn nơi lưu: Vercel Blob nếu có token, thư mục trên máy khi không chạy trên Vercel; null = chưa cấu hình */
export function getBackend(): Backend | null {
  if (process.env.BLOB_READ_WRITE_TOKEN) return blobBackend();
  if (process.env.OCR_HISTORY_DIR) return fsBackend(process.env.OCR_HISTORY_DIR);
  if (!process.env.VERCEL) return fsBackend(path.join(process.cwd(), ".data", "ocr-history"));
  return null;
}

/** Đọc index, sửa, ghi lại; nếu người khác vừa ghi (xung đột) thì đọc lại và thử tiếp */
async function mutate(backend: Backend, change: (records: SharedRecord[]) => SharedRecord[]) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { records, etag } = await backend.readIndex();
    const next = change(records);
    try {
      await backend.writeIndex(next, etag);
      return next;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200 * (attempt + 1)));
    }
  }
  throw new Error("Lịch sử đang được nhiều người ghi cùng lúc, thử lại sau");
}

const str = (v: unknown, max = 2000) => String(v ?? "").slice(0, max);

/** Ghi/ghi đè nhiều bản ghi; ảnh thu nhỏ của cả lô lưu vào một file */
export async function upsertRecords(backend: Backend, incoming: IncomingRecord[]) {
  const clean = incoming
    .filter((r) => r && typeof r.fileName === "string" && r.fileName.trim())
    .map((r) => ({
      fileName: r.fileName.normalize("NFC").slice(0, 500),
      customerCode: str(r.customerCode, 100),
      businessName: str(r.businessName, 500),
      bank: str(r.bank, 300),
      account: str(r.account, 40),
      name: str(r.name, 300),
      status: r.status === "ok" ? ("ok" as const) : ("review" as const),
      note: str(r.note),
      engine: str(r.engine, 100),
      size: Number(r.size) || 0,
      readAt: Number(r.readAt) || Date.now(),
      thumb: typeof r.thumb === "string" && r.thumb.length < 2_000_000 ? r.thumb : undefined,
    }));
  if (!clean.length) return 0;
  const thumbs: Record<string, string> = {};
  for (const r of clean) if (r.thumb) thumbs[recordId(r.fileName)] = r.thumb;
  const batch = Object.keys(thumbs).length ? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}` : "";
  if (batch) await backend.putThumbBatch(batch, thumbs);

  let orphaned: string[] = [];
  await mutate(backend, (records) => {
    const byName = new Map(records.map((r) => [r.fileName, r]));
    for (const { thumb, ...r } of clean) {
      const old = byName.get(r.fileName);
      byName.set(r.fileName, { ...r, thumbBatch: thumb ? batch : old?.thumbBatch });
    }
    const next = [...byName.values()];
    const used = new Set(next.map((r) => r.thumbBatch).filter(Boolean));
    orphaned = [...new Set(records.map((r) => r.thumbBatch).filter((b): b is string => !!b && !used.has(b)))];
    return next;
  });
  // Lô ảnh không còn bản ghi nào dùng (đã bị ghi đè hết) thì xóa cho gọn
  await backend.deleteThumbBatches(orphaned);
  return clean.length;
}

export async function removeRecords(backend: Backend, fileNames: string[]) {
  const names = new Set(fileNames.map((n) => String(n).normalize("NFC")));
  let orphaned: string[] = [];
  await mutate(backend, (records) => {
    const next = records.filter((r) => !names.has(r.fileName));
    const used = new Set(next.map((r) => r.thumbBatch).filter(Boolean));
    orphaned = [...new Set(records.map((r) => r.thumbBatch).filter((b): b is string => !!b && !used.has(b)))];
    return next;
  });
  await backend.deleteThumbBatches(orphaned);
}

export async function getThumb(backend: Backend, fileName: string): Promise<Buffer | null> {
  const { records } = await backend.readIndex();
  const rec = records.find((r) => r.fileName === fileName.normalize("NFC"));
  if (!rec?.thumbBatch) return null;
  const batch = await backend.getThumbBatch(rec.thumbBatch);
  const b64 = batch?.[recordId(rec.fileName)];
  return b64 ? Buffer.from(b64, "base64") : null;
}
