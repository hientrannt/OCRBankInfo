/**
 * Lịch sử các ảnh đã đọc, lưu trong trình duyệt (IndexedDB) để lần sau chọn lại thư mục
 * thì nhận ra ảnh trùng tên và không phải đọc lại. Khóa là tên file (chuẩn hóa NFC).
 */
export interface HistoryRecord {
  fileName: string;
  customerCode: string;
  businessName: string;
  bank: string;
  account: string;
  name: string;
  status: "ok" | "review";
  note: string;
  /** AI/engine đã dùng để đọc, ví dụ "Gemini", "Claude", "Tesseract" */
  engine: string;
  size: number;
  readAt: number;
  /** Ảnh thu nhỏ (JPEG) để xem lại và chèn vào Excel khi không còn file gốc */
  thumb?: Blob;
}

const DB_NAME = "ocr-bank";
const STORE = "history";

export const historyKey = (fileName: string) => fileName.normalize("NFC");

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "fileName" });
          store.createIndex("readAt", "readAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAllHistory(): Promise<HistoryRecord[]> {
  const db = await openDb();
  const all = await done(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<HistoryRecord[]>);
  return all.sort((a, b) => b.readAt - a.readAt);
}

/** Lấy các bản ghi trùng tên với danh sách file (trả về Map tên file -> bản ghi) */
export async function findHistory(fileNames: string[]): Promise<Map<string, HistoryRecord>> {
  const db = await openDb();
  const store = db.transaction(STORE).objectStore(STORE);
  const found = new Map<string, HistoryRecord>();
  await Promise.all(
    fileNames.map(async (n) => {
      const rec = await done(store.get(historyKey(n)) as IDBRequest<HistoryRecord | undefined>);
      if (rec) found.set(historyKey(n), rec);
    }),
  );
  return found;
}

/** Ghi (hoặc ghi đè) bản ghi. Không truyền thumb thì giữ ảnh thu nhỏ cũ nếu có. */
export async function saveHistory(records: HistoryRecord[]): Promise<void> {
  if (!records.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const r of records) {
    const key = historyKey(r.fileName);
    if (r.thumb) {
      store.put({ ...r, fileName: key });
    } else {
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const old = getReq.result as HistoryRecord | undefined;
        store.put({ ...r, fileName: key, thumb: old?.thumb });
      };
    }
  }
  await txDone(tx);
}

export async function deleteHistory(fileNames: string[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  fileNames.forEach((n) => tx.objectStore(STORE).delete(historyKey(n)));
  await txDone(tx);
}

export async function clearHistory(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await txDone(tx);
}
