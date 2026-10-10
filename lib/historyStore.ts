import { blobToBase64 } from "./backup.ts";
import { clearHistory, deleteHistory, getAllHistory, saveHistory, type HistoryRecord } from "./history.ts";

export type StoreKind = "local" | "shared";

/** Nơi lưu lịch sử: trình duyệt này (IndexedDB) hoặc máy chủ dùng chung (/api/history) */
export interface HistoryStore {
  kind: StoreKind;
  getAll(): Promise<HistoryRecord[]>;
  save(records: HistoryRecord[]): Promise<void>;
  remove(fileNames: string[]): Promise<void>;
  clear(): Promise<void>;
  loadThumb(record: HistoryRecord): Promise<Blob | undefined>;
  /** Ghi ngay các bản ghi đang chờ (chỉ lịch sử dùng chung có hàng chờ) */
  flush(): Promise<void>;
}

export const localStore: HistoryStore = {
  kind: "local",
  getAll: getAllHistory,
  save: saveHistory,
  remove: deleteHistory,
  clear: clearHistory,
  loadThumb: async (r) => r.thumb,
  flush: async () => {},
};

export class SharedHistoryError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

const BATCH_SIZE = 25; // ~25 ảnh thu nhỏ (~1MB) mỗi lần gửi, dưới giới hạn 4.5MB của Vercel
const FLUSH_DELAY = 3000;

export function createSharedStore(getPassword: () => string, onError?: (e: Error) => void): HistoryStore {
  const queue = new Map<string, HistoryRecord>();
  const thumbs = new Map<string, Promise<Blob | undefined>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> = Promise.resolve();

  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "x-app-password": getPassword() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new SharedHistoryError(data.error || `Lỗi lịch sử máy chủ (HTTP ${res.status})`, data.code || "error");
    }
    return res;
  }

  async function send(records: HistoryRecord[]) {
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      const payload = await Promise.all(
        chunk.map(async ({ thumb, hasThumb: _h, ...r }) => ({ ...r, thumb: thumb ? await blobToBase64(thumb) : undefined })),
      );
      // Lỗi tạm thời: thử lại 3 lần
      for (let attempt = 0; ; attempt++) {
        try {
          await call("POST", "/api/history", { records: payload });
          break;
        } catch (err) {
          if (attempt >= 2 || (err instanceof SharedHistoryError && err.code !== "error")) throw err;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      chunk.forEach((r) => r.thumb && thumbs.set(r.fileName, Promise.resolve(r.thumb)));
    }
  }

  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const pending = [...queue.values()];
    queue.clear();
    if (!pending.length) return flushing;
    flushing = flushing.then(() => send(pending)).catch((err) => {
      // Gửi lỗi: đưa lại vào hàng chờ (trừ khi đã có bản mới hơn) để lần sau gửi tiếp
      pending.forEach((r) => !queue.has(r.fileName) && queue.set(r.fileName, r));
      onError?.(err);
    });
    return flushing;
  }

  return {
    kind: "shared",
    async getAll() {
      const res = await call("GET", "/api/history");
      const data = (await res.json()) as { records: HistoryRecord[] };
      return data.records.sort((a, b) => b.readAt - a.readAt);
    },
    async save(records) {
      records.forEach((r) => queue.set(r.fileName, { ...queue.get(r.fileName), ...r, thumb: r.thumb ?? queue.get(r.fileName)?.thumb }));
      if (queue.size >= BATCH_SIZE) {
        void flush();
      } else {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void flush(), FLUSH_DELAY);
      }
    },
    async remove(fileNames) {
      await flush();
      fileNames.forEach((n) => thumbs.delete(n));
      await call("DELETE", "/api/history", { fileNames });
    },
    async clear() {
      queue.clear();
      await flushing;
      thumbs.clear();
      await call("DELETE", "/api/history", { all: true });
    },
    loadThumb(record) {
      if (record.thumb) return Promise.resolve(record.thumb);
      if (!record.hasThumb) return Promise.resolve(undefined);
      let p = thumbs.get(record.fileName);
      if (!p) {
        p = call("GET", `/api/history/thumb?f=${encodeURIComponent(record.fileName)}`)
          .then((res) => res.blob())
          .catch(() => {
            thumbs.delete(record.fileName);
            return undefined;
          });
        thumbs.set(record.fileName, p);
      }
      return p;
    },
    flush,
  };
}
