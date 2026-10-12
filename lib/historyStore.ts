import { blobToBase64 } from "./backup.ts";
import {
  clearHistory,
  deleteHistory,
  findHistory,
  getAllHistory,
  historyKey,
  saveHistory,
  type HistoryRecord,
} from "./history.ts";

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
  /** Số ảnh chưa lên cloud (chỉ lịch sử dùng chung) */
  pendingCount?(): number;
  status?(): SyncStatus;
  dispose?(): void;
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

// ~30 ảnh thu nhỏ (~1,3MB) mỗi lần gửi: dưới xa giới hạn 4,5MB/request của Vercel
const BATCH_SIZE = 30;
const CONCURRENCY = 3;
const FLUSH_DELAY = 2000;
/** Danh sách tên file đã đọc nhưng cloud chưa xác nhận đã lưu (giữ qua lần tải lại trang) */
export const OUTBOX_KEY = "ocr-cloud-outbox";
const RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000];

export interface SyncStatus {
  /** Số ảnh chưa lên cloud */
  pending: number;
  sending: boolean;
  /** Lỗi lần gửi gần nhất (rỗng = không lỗi) */
  error: string;
  code: string;
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export interface SharedStoreOptions {
  onStatus?: (s: SyncStatus) => void;
  onError?: (e: Error) => void;
  fetchImpl?: typeof fetch;
  /** Nơi giữ hàng chờ (mặc định localStorage) */
  storage?: KeyValueStorage | null;
  /** Bản sao trên trình duyệt (mặc định IndexedDB): ảnh đọc xong được ghi ở đây trước, không mất khi cloud lỗi */
  mirror?: {
    save(records: HistoryRecord[]): Promise<void>;
    find(fileNames: string[]): Promise<Map<string, HistoryRecord>>;
    remove(fileNames: string[]): Promise<void>;
    clear(): Promise<void>;
  } | null;
  retryDelays?: number[];
  flushDelay?: number;
  /** Số lô gửi cùng lúc */
  concurrency?: number;
}

const defaultStorage = (): KeyValueStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const idbMirror = {
  save: saveHistory,
  find: findHistory,
  remove: deleteHistory,
  clear: clearHistory,
};

/**
 * Lịch sử trên cloud (/api/history), không để mất dữ liệu:
 * - mỗi ảnh đọc xong được ghi ngay vào trình duyệt (IndexedDB) và vào hàng chờ (localStorage);
 * - chỉ xóa khỏi hàng chờ khi máy chủ trả lời đã lưu; lỗi thì tự gửi lại (5s, 15s, 30s, 1 phút, 2 phút...);
 * - đóng/tải lại trang thì lần sau mở app gửi tiếp phần còn lại.
 */
export function createSharedStore(
  getPassword: () => string,
  opts: SharedStoreOptions = {},
): HistoryStore & { pendingCount(): number; status(): SyncStatus; dispose(): void } {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const mirror = opts.mirror === undefined ? idbMirror : opts.mirror;
  const retryDelays = opts.retryDelays ?? RETRY_DELAYS;
  const flushDelay = opts.flushDelay ?? FLUSH_DELAY;
  const concurrency = Math.max(1, opts.concurrency ?? CONCURRENCY);

  const queue = new Map<string, HistoryRecord>();
  const thumbs = new Map<string, Promise<Blob | undefined>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryCount = 0;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  let state: SyncStatus = { pending: 0, sending: false, error: "", code: "" };

  const readOutbox = (): string[] => {
    try {
      const v = JSON.parse(storage?.getItem(OUTBOX_KEY) || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  const writeOutbox = (names: Iterable<string>) => {
    try {
      storage?.setItem(OUTBOX_KEY, JSON.stringify([...new Set(names)]));
    } catch {}
  };
  const pendingNames = () => new Set([...readOutbox(), ...queue.keys()]);
  const emit = (patch: Partial<SyncStatus>) => {
    state = { ...state, ...patch, pending: pendingNames().size };
    opts.onStatus?.(state);
  };

  async function call(method: string, url: string, body?: unknown) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        cache: "no-store",
        headers: { "Content-Type": "application/json", "x-app-password": getPassword() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new SharedHistoryError("Mất kết nối mạng", "network");
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new SharedHistoryError(data.error || `Lỗi lịch sử máy chủ (HTTP ${res.status})`, data.code || "error");
    }
    return res;
  }

  async function sendChunk(chunk: HistoryRecord[]) {
    const payload = await Promise.all(
      chunk.map(async ({ thumb, hasThumb: _h, ...r }) => ({ ...r, thumb: thumb ? await blobToBase64(thumb) : undefined })),
    );
    const res = await call("POST", "/api/history", { records: payload });
    const data = (await res.json().catch(() => ({}))) as { saved?: number };
    if (data.saved !== chunk.length) throw new SharedHistoryError("Máy chủ chưa xác nhận đã lưu đủ", "error");
  }

  function scheduleRetry(code: string) {
    if (retryTimer || disposed) return;
    // Sai mật khẩu / máy chủ chưa cấu hình: đợi người dùng sửa rồi app gọi flush()
    if (code === "bad_password" || code === "no_password" || code === "no_store") return;
    const delay = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
    retryCount++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, delay);
  }

  async function flushNow() {
    // Phần còn lại từ lần mở app trước (đã ghi vào trình duyệt, chưa lên cloud)
    const leftover = readOutbox().filter((n) => !queue.has(n));
    if (leftover.length && mirror) {
      const found = await mirror.find(leftover).catch(() => new Map<string, HistoryRecord>());
      for (const n of leftover) {
        const rec = found.get(historyKey(n));
        if (rec) queue.set(n, rec);
      }
      // Tên không còn bản ghi trên trình duyệt thì không gửi được: bỏ khỏi hàng chờ
      const lost = leftover.filter((n) => !found.has(historyKey(n)));
      if (lost.length) writeOutbox(readOutbox().filter((n) => !lost.includes(n)));
    }
    if (!queue.size) {
      emit({ sending: false, error: "", code: "" });
      return;
    }
    const pending = [...queue.values()];
    emit({ sending: true });
    const chunks: HistoryRecord[][] = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) chunks.push(pending.slice(i, i + BATCH_SIZE));
    // Gửi song song vài lô: mỗi lần ghi lên cloud có độ trễ cố định ~2 giây, chạy song song nhanh hơn nhiều
    let failure: unknown = null;
    let next = 0;
    const worker = async () => {
      while (!failure && next < chunks.length) {
        const chunk = chunks[next++];
        try {
          await sendChunk(chunk);
        } catch (err) {
          failure ??= err;
          return;
        }
        // Đã lưu xong: bỏ khỏi hàng chờ, trừ khi người dùng vừa sửa lại (bản mới hơn vẫn phải gửi)
        const sent = new Set<string>();
        for (const r of chunk) {
          if (queue.get(r.fileName) === r) {
            queue.delete(r.fileName);
            sent.add(r.fileName);
          }
          if (r.thumb) thumbs.set(r.fileName, Promise.resolve(r.thumb));
        }
        writeOutbox(readOutbox().filter((n) => !sent.has(n)));
        emit({});
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
    if (failure) {
      const err = failure;
      const code = err instanceof SharedHistoryError ? err.code : "error";
      emit({ sending: false, error: err instanceof Error ? err.message : String(err), code });
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      scheduleRetry(code);
      return;
    }
    retryCount = 0;
    emit({ sending: false, error: "", code: "" });
    if (queue.size) scheduleFlush(); // có bản sửa mới trong lúc gửi
  }

  function scheduleFlush() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), flushDelay);
  }

  /** Gửi ngay các ảnh đang chờ; không ném lỗi (xem status() / onStatus) */
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    chain = chain.then(flushNow).catch(() => {});
    return chain;
  }

  // Báo số ảnh còn chờ từ lần trước ngay khi mở app
  queueMicrotask(() => emit({}));

  return {
    kind: "shared",
    async getAll() {
      const res = await call("GET", "/api/history");
      const data = (await res.json()) as { records: HistoryRecord[] };
      return data.records.sort((a, b) => b.readAt - a.readAt);
    },
    async save(input) {
      if (!input.length) return;
      const records = input.map((r) => ({ ...r, fileName: historyKey(r.fileName) }));
      // 1) Ghi vào trình duyệt trước: cloud lỗi hay đóng trang cũng không mất
      await mirror?.save(records).catch(() => {});
      for (const r of records) {
        const old = queue.get(r.fileName);
        queue.set(r.fileName, { ...old, ...r, thumb: r.thumb ?? old?.thumb });
      }
      writeOutbox([...readOutbox(), ...records.map((r) => r.fileName)]);
      emit({});
      // 2) Gửi lên cloud
      if (queue.size >= BATCH_SIZE * concurrency) void flush();
      else scheduleFlush();
    },
    async remove(input) {
      const fileNames = input.map(historyKey);
      const names = new Set(fileNames);
      names.forEach((n) => {
        queue.delete(n);
        thumbs.delete(n);
      });
      writeOutbox(readOutbox().filter((n) => !names.has(n)));
      await chain;
      await call("DELETE", "/api/history", { fileNames });
      await mirror?.remove(fileNames).catch(() => {});
      emit({});
    },
    async clear() {
      queue.clear();
      writeOutbox([]);
      await chain;
      thumbs.clear();
      await call("DELETE", "/api/history", { all: true });
      await mirror?.clear().catch(() => {});
      emit({ error: "", code: "" });
    },
    loadThumb(record) {
      if (record.thumb) return Promise.resolve(record.thumb);
      const queued = queue.get(record.fileName)?.thumb;
      if (queued) return Promise.resolve(queued);
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
    pendingCount: () => pendingNames().size,
    status: () => state,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}
