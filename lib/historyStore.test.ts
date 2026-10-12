import { test } from "node:test";
import assert from "node:assert/strict";
import { createSharedStore, OUTBOX_KEY, type SharedStoreOptions } from "./historyStore.ts";
import type { HistoryRecord } from "./history.ts";

const rec = (fileName: string, extra: Partial<HistoryRecord> = {}): HistoryRecord => ({
  fileName,
  customerCode: "0573/00028",
  businessName: "HỘ KINH DOANH",
  bank: "AGRIBANK",
  account: "4705235387979",
  name: "Ho Kinh Doanh",
  status: "ok",
  note: "",
  engine: "Gemini",
  size: 1,
  readAt: 1,
  ...extra,
});

/** Máy chủ giả: lưu trong bộ nhớ; `fail` = mã lỗi trả về cho các lần gọi tới */
function fakeServer(password = "pw") {
  const db = new Map<string, Record<string, unknown>>();
  const s = { db, fail: "" as "" | "503" | "network", posts: 0, password };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    if (s.fail === "network") throw new TypeError("fetch failed");
    if (s.fail === "503") return Response.json({ error: "Blob lỗi" }, { status: 503 });
    const headers = init.headers as Record<string, string>;
    if (headers["x-app-password"] !== s.password)
      return Response.json({ error: "Sai mật khẩu truy cập", code: "bad_password" }, { status: 401 });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (init.method === "POST") {
      s.posts++;
      for (const r of body.records) db.set(r.fileName, r);
      return Response.json({ saved: body.records.length });
    }
    if (init.method === "DELETE") {
      if (body.all) db.clear();
      else for (const n of body.fileNames) db.delete(n);
      return Response.json({ ok: true });
    }
    return Response.json({ records: [...db.values()] });
  }) as unknown as typeof fetch;
  return { s, fetchImpl };
}

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

function memMirror() {
  const m = new Map<string, HistoryRecord>();
  return {
    m,
    save: async (rs: HistoryRecord[]) => rs.forEach((r) => m.set(r.fileName, r)),
    find: async (ns: string[]) => new Map(ns.filter((n) => m.has(n)).map((n) => [n, m.get(n)!])),
    remove: async (ns: string[]) => ns.forEach((n) => m.delete(n)),
    clear: async () => m.clear(),
  };
}

function setup(over: Partial<SharedStoreOptions> = {}) {
  const server = fakeServer();
  const storage = memStorage();
  const mirror = memMirror();
  let password = "pw";
  const make = () =>
    createSharedStore(() => password, {
      fetchImpl: server.fetchImpl,
      storage,
      mirror,
      retryDelays: [5],
      flushDelay: 1,
      ...over,
    });
  return { server, storage, mirror, make, setPassword: (p: string) => (password = p) };
}

const outbox = (storage: ReturnType<typeof memStorage>) => JSON.parse(storage.getItem(OUTBOX_KEY) || "[]");

test("lưu lên cloud: gửi xong mới bỏ khỏi hàng chờ, chia lô 10 ảnh", async () => {
  const { server, storage, mirror, make } = setup();
  const store = make();
  await store.save(Array.from({ length: 25 }, (_, i) => rec(`${i}.jpg`)));
  assert.equal(mirror.m.size, 25, "ghi vào trình duyệt trước");
  assert.equal(outbox(storage).length, 25);
  await store.flush();
  assert.equal(server.s.db.size, 25);
  assert.equal(server.s.posts, 3);
  assert.equal(outbox(storage).length, 0);
  assert.equal(store.status().pending, 0);
  store.dispose();
});

test("cloud lỗi rồi đóng trang: mở lại app gửi tiếp, không mất ảnh nào", async () => {
  const { server, storage, make } = setup({ retryDelays: [60_000] });
  const first = make();
  server.s.fail = "503";
  await first.save([rec("a.jpg"), rec("b.jpg", { thumb: new Blob(["jpg"]) })]);
  await first.flush();
  assert.equal(server.s.db.size, 0);
  assert.equal(first.status().pending, 2);
  assert.match(first.status().error, /Blob lỗi/);
  first.dispose(); // đóng trang

  server.s.fail = "";
  const second = make(); // mở lại app
  assert.equal(second.pendingCount(), 2);
  await second.flush();
  assert.deepEqual([...server.s.db.keys()].sort(), ["a.jpg", "b.jpg"]);
  assert.ok(server.s.db.get("b.jpg")!.thumb, "gửi cả ảnh thu nhỏ đã lưu trên trình duyệt");
  assert.equal(outbox(storage).length, 0);
  second.dispose();
});

test("mất mạng: tự gửi lại", async () => {
  const { server, make } = setup();
  const store = make();
  server.s.fail = "network";
  await store.save([rec("a.jpg")]);
  await store.flush();
  assert.equal(store.status().code, "network");
  server.s.fail = "";
  await new Promise((r) => setTimeout(r, 30)); // retry sau 5ms
  await store.flush();
  assert.equal(server.s.db.size, 1);
  assert.equal(store.status().pending, 0);
  store.dispose();
});

test("sai mật khẩu: giữ trong hàng chờ, nhập đúng mật khẩu thì gửi", async () => {
  const { server, make, setPassword } = setup();
  setPassword("cu");
  const store = make();
  await store.save([rec("a.jpg")]);
  await store.flush();
  assert.equal(store.status().code, "bad_password");
  assert.equal(server.s.db.size, 0);
  setPassword("pw");
  await store.flush();
  assert.equal(server.s.db.size, 1);
  assert.equal(store.status().code, "");
  store.dispose();
});

test("sửa lại trong lúc đang gửi: bản mới vẫn được gửi", async () => {
  const { server } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = (async (url: string, init: RequestInit) => {
    if (init.method === "POST") await gate;
    return server.fetchImpl(url, init);
  }) as unknown as typeof fetch;
  const s2 = createSharedStore(() => "pw", {
    fetchImpl: slow,
    storage: memStorage(),
    mirror: memMirror(),
    retryDelays: [5],
    flushDelay: 1,
  });
  await s2.save([rec("a.jpg", { account: "111" })]);
  const sending = s2.flush();
  await new Promise((r) => setTimeout(r, 5));
  await s2.save([rec("a.jpg", { account: "222" })]);
  release();
  await sending;
  await s2.flush();
  assert.equal(server.s.db.get("a.jpg")!.account, "222");
  assert.equal(s2.status().pending, 0);
  s2.dispose();
});

test("xóa: mất trên cloud, trên trình duyệt và khỏi hàng chờ; tên NFD/NFC như nhau", async () => {
  const { server, storage, mirror, make } = setup();
  const store = make();
  const name = "0573.00028_NHÀ THUỐC.jpg";
  await store.save([rec(name.normalize("NFD")), rec("b.jpg")]);
  await store.flush();
  assert.ok(server.s.db.has(name.normalize("NFC")));
  await store.remove([name.normalize("NFD")]);
  assert.deepEqual([...server.s.db.keys()], ["b.jpg"]);
  assert.deepEqual([...mirror.m.keys()], ["b.jpg"]);
  await store.save([rec("c.jpg")]);
  await store.clear();
  assert.equal(server.s.db.size, 0);
  assert.equal(mirror.m.size, 0);
  assert.equal(outbox(storage).length, 0);
  store.dispose();
});
