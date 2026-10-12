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
// Ảnh đọc xong được gửi gần như ngay: chỉ chờ 0,3 giây để gom các ảnh xong cùng lúc vào một lần gửi
const FLUSH_DELAY = 300;
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
  // Ảnh đang được gửi (không gửi trùng; bản sửa mới hơn đợi lần gửi này xong rồi gửi tiếp)
  const inflight = new Set<string>();
  let active = 0;
  // Lần gửi gần nhất lỗi: tạm dừng, chờ tự gửi lại (retry) hoặc flush()
  let paused = false;
  let idleWaiters: (() => void)[] = [];
  let loading: Promise<void> | null = null;
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

  const sendable = () => [...queue.values()].filter((r) => !inflight.has(r.fileName));
  function checkIdle() {
    if (active === 0 && (paused || disposed || sendable().length === 0)) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }
  const idle = () =>
    new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
      checkIdle();
    });

  /**
   * Gửi liên tục: còn chỗ (tối đa `concurrency` lần gửi cùng lúc) là lấy ngay các ảnh đang chờ để gửi,
   * không đợi lần gửi trước xong. Ảnh đọc xong lên cloud sau vài giây, không dồn lại đẩy một loạt.
   */
  function pump() {
    while (!paused && !disposed && active < concurrency) {
      const chunk = sendable().slice(0, BATCH_SIZE);
      if (!chunk.length) break;
      chunk.forEach((r) => inflight.add(r.fileName));
      active++;
      emit({ sending: true });
      sendChunk(chunk)
        .then(
          () => {
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
            retryCount = 0;
            emit(paused ? {} : { error: "", code: "" });
          },
          (err) => {
            const code = err instanceof SharedHistoryError ? err.code : "error";
            paused = true;
            emit({ error: err instanceof Error ? err.message : String(err), code });
            opts.onError?.(err instanceof Error ? err : new Error(String(err)));
            scheduleRetry(code);
          },
        )
        .finally(() => {
          chunk.forEach((r) => inflight.delete(r.fileName));
          active--;
          pump();
          if (!active) emit({ sending: false });
          checkIdle();
        });
    }
    checkIdle();
  }

  /** Phần còn lại từ lần mở app trước (đã ghi vào trình duyệt, chưa lên cloud) */
  async function loadLeftover() {
    const leftover = readOutbox().filter((n) => !queue.has(n));
    if (!leftover.length || !mirror) return;
    const found = await mirror.find(leftover).catch(() => new Map<string, HistoryRecord>());
    for (const n of leftover) {
      const rec = found.get(historyKey(n));
      if (rec && !queue.has(n)) queue.set(n, rec);
    }
    // Tên không còn bản ghi trên trình duyệt thì không gửi được: bỏ khỏi hàng chờ
    const lost = leftover.filter((n) => !found.has(historyKey(n)));
    if (lost.length) writeOutbox(readOutbox().filter((n) => !lost.includes(n)));
  }

  function schedulePump() {
    if (timer || paused || disposed) return; // không dời lại: ảnh xong liên tục vẫn được gửi đều
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, flushDelay);
  }

  /** Gửi ngay mọi ảnh đang chờ (kể cả lần trước lỗi); xong khi hết ảnh chờ hoặc gặp lỗi. Không ném lỗi. */
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    paused = false;
    loading ??= loadLeftover().finally(() => (loading = null));
    return loading
      .then(() => {
        pump();
        return idle();
      })
      .then(() => {
        if (!paused) emit({ sending: active > 0, error: "", code: "" });
      });
  }

  const waitNotSending = async (names: Set<string>) => {
    while ([...names].some((n) => inflight.has(n))) await new Promise((r) => setTimeout(r, 50));
  };

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
      // 2) Gửi lên cloud ngay
      schedulePump();
    },
    async remove(input) {
      const fileNames = input.map(historyKey);
      const names = new Set(fileNames);
      names.forEach((n) => {
        queue.delete(n);
        thumbs.delete(n);
      });
      writeOutbox(readOutbox().filter((n) => !names.has(n)));
      await waitNotSending(names); // tránh lần gửi đang chạy ghi lại ảnh vừa xóa
      await call("DELETE", "/api/history", { fileNames });
      await mirror?.remove(fileNames).catch(() => {});
      emit({});
    },
    async clear() {
      queue.clear();
      writeOutbox([]);
      await idle();
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
      checkIdle();
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}
