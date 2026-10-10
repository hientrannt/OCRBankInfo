import type { HistoryRecord } from "./history.ts";

/** File sao lưu lịch sử (.json): đủ dữ liệu + ảnh thu nhỏ (base64) để khôi phục sang máy/trình duyệt khác */
export interface BackupFile {
  app: "ocr-bank";
  version: 1;
  exportedAt: number;
  records: Array<Omit<HistoryRecord, "thumb" | "hasThumb"> & { thumb?: string }>;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBlob(b64: string, type = "image/jpeg"): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export { blobToBase64 };

export async function makeBackup(
  records: HistoryRecord[],
  loadThumb: (r: HistoryRecord) => Promise<Blob | undefined>,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const out: BackupFile["records"] = [];
  for (let i = 0; i < records.length; i++) {
    const { thumb: _t, hasThumb: _h, ...rest } = records[i];
    const blob = await loadThumb(records[i]).catch(() => undefined);
    out.push({ ...rest, thumb: blob ? await blobToBase64(blob) : undefined });
    onProgress?.(i + 1, records.length);
  }
  const file: BackupFile = { app: "ocr-bank", version: 1, exportedAt: Date.now(), records: out };
  return JSON.stringify(file);
}

export function parseBackup(text: string): HistoryRecord[] {
  let data: BackupFile;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("File không phải bản sao lưu hợp lệ (không đọc được JSON)");
  }
  if (data?.app !== "ocr-bank" || !Array.isArray(data.records)) {
    throw new Error("File không phải bản sao lưu của app OCR ngân hàng");
  }
  return data.records
    .filter((r) => r && typeof r.fileName === "string" && r.fileName)
    .map((r) => ({
      fileName: r.fileName.normalize("NFC"),
      customerCode: String(r.customerCode ?? ""),
      businessName: String(r.businessName ?? ""),
      bank: String(r.bank ?? ""),
      account: String(r.account ?? ""),
      name: String(r.name ?? ""),
      status: r.status === "ok" ? "ok" : "review",
      note: String(r.note ?? ""),
      engine: String(r.engine ?? ""),
      size: Number(r.size) || 0,
      readAt: Number(r.readAt) || Date.now(),
      thumb: r.thumb ? base64ToBlob(r.thumb) : undefined,
    }));
}
