"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Scheduler } from "tesseract.js";
import { IMAGE_EXTENSIONS, parseFileName } from "@/lib/filename";
import { normalizeBankName } from "@/lib/banks";
import { parseOcrText, type BankFields } from "@/lib/parseText";
import { bankName, digitsOnly, looseKey } from "@/lib/text";
import { fileToBase64ForApi, fileToCanvasForTesseract, fileToThumbBlob } from "@/lib/image";
import { getAllHistory, historyKey, type HistoryRecord } from "@/lib/history";
import { createSharedStore, localStore, type HistoryStore, type StoreKind, type SyncStatus } from "@/lib/historyStore";
import { makeBackup, parseBackup } from "@/lib/backup";
import { importExcel } from "@/lib/excelImport";
import { findDuplicateAccounts } from "@/lib/duplicates";
import HistoryTab from "@/components/HistoryTab";
import HskhTab from "@/components/HskhTab";
import {
  accountCheckText,
  checkAccount,
  loadLocalHskh,
  lookupHskh,
  parseHskh,
  saveLocalHskh,
  type HskhData,
} from "@/lib/hskh";
import { exportToExcel } from "@/lib/excel";
import { FatalOcrError, postOcr } from "@/lib/ocrClient";

type Engine = "both" | "ai" | "tesseract";
type Provider = "claude" | "gemini";
type Tab = "read" | "history" | "hskh" | "settings";

/** Hỏi người dùng khi thư mục mới chọn có ảnh trùng tên với ảnh đã đọc trước đây */
interface DupPrompt {
  files: File[];
  folder: string;
  skippedMsg: string;
  existing: Map<string, HistoryRecord>;
}

const fmtTime = (t: number) => new Date(t).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
type Status = "example" | "pending" | "processing" | "ok" | "review" | "error";

interface Row extends BankFields {
  id: string;
  file: File | null;
  url: string;
  fileName: string;
  customerCode: string;
  businessName: string;
  status: Status;
  note: string;
}

type ServerInfo = {
  hasKey: boolean;
  serverKeys?: Record<Provider, boolean>;
  needPassword: boolean;
  defaultModels?: Record<Provider, string>;
};

const AI: Record<Provider, { label: string; keyHint: string; keyUrl: string; model: string }> = {
  claude: {
    label: "Claude (Anthropic)",
    keyHint: "sk-ant-...",
    keyUrl: "https://console.anthropic.com/settings/keys",
    model: "claude-opus-5-5",
  },
  gemini: {
    label: "Gemini (Google)",
    keyHint: "AIza...",
    keyUrl: "https://aistudio.google.com/apikey",
    model: "gemini-2.5-flash",
  },
};
const SETTINGS_KEY = "ocr-ai-settings";
type AiSettings = { provider: Provider; keys: Record<Provider, string>; models: Record<Provider, string> };
const DEFAULT_SETTINGS: AiSettings = { provider: "claude", keys: { claude: "", gemini: "" }, models: { claude: "", gemini: "" } };

const STATUS_LABEL: Record<Status, string> = {
  example: "Ví dụ",
  pending: "Chờ",
  processing: "Đang đọc…",
  ok: "OK",
  review: "Cần kiểm tra",
  error: "Lỗi",
};

const CLAUDE_CONCURRENCY = 3;
const TESSERACT_WORKERS = 2;
const PASSWORD_KEY = "ocr-app-password";
const ENGINE_KEY = "ocr-engine";
// v2: mặc định lưu trên cloud (máy nào cũng thấy); chỉ dùng trình duyệt khi người dùng chọn rõ
const STORE_KEY = "ocr-store-v2";
const VERIFY_KEY = "ocr-verify-twice";
const HEAD = ["STT", "Mã số KH", "Tên CSKD", "MSNV", "Tên NVBH", "Ngân hàng nhận", "Tài khoản/thẻ nhận", "Tên người nhận", "Tên file", "Ghi chú"];

const EXAMPLE: Row = {
  id: "example",
  file: null,
  url: "",
  fileName: "0573.00028_HỘ KINH DOANH NHÀ THUỐC MỸ  THỂ.JPG",
  customerCode: "0573/00028",
  businessName: "HỘ KINH DOANH NHÀ THUỐC MỸ THỂ",
  bank: "AGRIBANK - Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam",
  account: "4705235387979",
  name: "Ho Kinh Doanh An Binh",
  status: "example",
  note: "Dòng minh họa, sẽ biến mất khi bạn chọn thư mục",
};

/** Lấy toàn bộ file trong thư mục được kéo thả (kể cả thư mục con) */
async function filesFromDrop(dt: DataTransfer): Promise<{ files: File[]; folder: string }> {
  const entries = Array.from(dt.items)
    .map((it) => it.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return { files: Array.from(dt.files), folder: "" };
  const files: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      files.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child);
    }
  };
  for (const e of entries) await walk(e);
  return { files, folder: entries.length === 1 && entries[0].isDirectory ? entries[0].name : "" };
}

export default function Home() {
  const [rows, setRows] = useState<Row[]>([EXAMPLE]);
  const [selectedEngine, setEngine] = useState<Engine>("both");
  const [running, setRunning] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);
  const [preview, setPreview] = useState<Row | null>(null);
  const [folderName, setFolderName] = useState("");
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [ai, setAi] = useState<AiSettings>(DEFAULT_SETTINGS);
  const [showKey, setShowKey] = useState(false);
  const [keyCheck, setKeyCheck] = useState<{ state: "idle" | "checking" | "ok" | "bad"; text: string }>({
    state: "idle",
    text: "",
  });
  const [tab, setTab] = useState<Tab>("read");
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [storeKind, setStoreKind] = useState<StoreKind>("shared");
  // Mã lỗi cloud gần nhất: bad_password (cần nhập mật khẩu), no_password / no_store (máy chủ chưa cấu hình)
  const [cloudError, setCloudError] = useState("");
  // Đã đọc xong cài đặt lưu trong trình duyệt (mật khẩu, nơi lưu...) - phải đợi rồi mới kết nối cloud
  const [settingsReady, setSettingsReady] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const passwordRef = useRef("");
  passwordRef.current = password;
  // Trạng thái gửi lên cloud: số ảnh còn chờ, lỗi gần nhất
  const [sync, setSync] = useState<SyncStatus>({ pending: 0, sending: false, error: "", code: "" });
  // Số ảnh có trên trình duyệt này mà cloud chưa có (người dùng tự bấm để đưa lên)
  const [localOnly, setLocalOnly] = useState<HistoryRecord[]>([]);
  const [cloudSync, setCloudSync] = useState<null | "ask" | "working">(null);
  const store = useMemo(
    () =>
      storeKind === "shared"
        ? createSharedStore(() => passwordRef.current, {
            onStatus: setSync,
            onError: (e) => {
              const code = (e as { code?: string }).code;
              if (code === "bad_password" || code === "no_password" || code === "no_store") setCloudError(code);
            },
          })
        : localStore,
    [storeKind],
  );
  useEffect(() => {
    if (store.kind !== "shared") setSync({ pending: 0, sending: false, error: "", code: "" });
    return () => store.dispose?.();
  }, [store]);
  const historyRef = useRef<HistoryRecord[]>([]);
  const [hskh, setHskh] = useState<HskhData | null>(null);
  const [dup, setDup] = useState<DupPrompt | null>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [withImages, setWithImages] = useState(true);
  // AI đọc số tài khoản 2 lần độc lập để bắt lỗi đọc nhầm
  const [verifyTwice, setVerifyTwice] = useState(true);
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
  const [rereading, setRereading] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const stopRef = useRef(false);
  const schedulerRef = useRef<Promise<{ text: Scheduler; digits: Scheduler }> | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    try {
      setPassword(localStorage.getItem(PASSWORD_KEY) || "");
      const savedEngine = localStorage.getItem(ENGINE_KEY);
      if (savedEngine === "both" || savedEngine === "ai" || savedEngine === "tesseract") setEngine(savedEngine);
      if (localStorage.getItem(VERIFY_KEY) === "0") setVerifyTwice(false);
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (saved) setAi({ ...DEFAULT_SETTINGS, ...saved, keys: { ...DEFAULT_SETTINGS.keys, ...saved.keys }, models: { ...DEFAULT_SETTINGS.models, ...saved.models } });
      if (localStorage.getItem(STORE_KEY) === "local") setStoreKind("local");
    } catch {}
    setSettingsReady(true);
    fetch("/api/ocr")
      .then((r) => r.json())
      .then((info: ServerInfo) => setServer(info))
      .catch(() => setServer(null));
  }, []);

  // Nạp lịch sử từ nơi lưu đang chọn (trình duyệt hoặc máy chủ); đổi nơi lưu / mật khẩu thì nạp lại
  // HSKH: lấy bản trên trình duyệt; khi dùng chung thì lấy bản máy chủ nếu mới hơn
  useEffect(() => {
    const local = loadLocalHskh();
    setHskh(local);
    if (store.kind !== "shared" || !settingsReady) return;
    if (!historyLoaded || historyError) return; // chờ kết nối cloud thành công
    fetch("/api/hskh", { headers: { "x-app-password": passwordRef.current } })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (remote: HskhData | null) => {
        if (remote?.entries && (!local || remote.importedAt >= local.importedAt)) {
          // count 0 = đã bấm "Bỏ HSKH" ở một máy: máy nào cũng bỏ theo
          const data = Object.keys(remote.entries).length ? remote : null;
          setHskh(data);
          saveLocalHskh(data);
        } else if (local) {
          // Cloud chưa có HSKH hoặc bản trên máy này mới hơn: đưa lên cloud
          const res = await fetch("/api/hskh", {
            method: "PUT",
            headers: { "Content-Type": "application/json", "x-app-password": passwordRef.current },
            body: JSON.stringify(local),
          });
          if (res.ok)
            setMessage((m) =>
              [m, `Đã đưa HSKH "${local.fileName}" (${local.count} KH) của máy này lên cloud.`].filter(Boolean).join(" "),
            );
        }
      })
      .catch(() => {});
  }, [store, historyLoaded, historyError, settingsReady]);

  async function onUploadHskh(file: File) {
    try {
      const data = await parseHskh(await file.arrayBuffer(), file.name);
      setHskh(data);
      saveLocalHskh(data);
      let where = "trình duyệt này";
      if (store.kind === "shared") {
        const res = await fetch("/api/hskh", {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-app-password": password },
          body: JSON.stringify(data),
        });
        where = res.ok ? "cloud (máy nào cũng thấy)" : "trình duyệt này (chưa lưu được lên cloud)";
      }
      setMessage(`Đã nạp HSKH "${file.name}": ${data.count} khách hàng, lưu trên ${where}.`);
    } catch (err) {
      setMessage(`Không đọc được file HSKH: ${err instanceof Error ? err.message : err}`);
    }
  }

  const reloadHistory = useCallback(async () => {
    setHistoryLoaded(false);
    try {
      let list = await store.getAll();
      setHistoryError("");
      setCloudError("");
      if (store.kind === "shared") {
        // Gửi nốt ảnh đọc xong mà chưa lên được cloud (lần trước lỗi mạng, sai mật khẩu, đóng trang...)
        if (store.pendingCount?.()) {
          await store.flush();
          list = await store.getAll();
        }
        // Ảnh chỉ có trên trình duyệt này: không tự đưa lên (tránh ảnh đã xóa trên cloud hiện lại), chỉ báo để bấm
        const onCloud = new Set(list.map((h) => h.fileName));
        setLocalOnly((await getAllHistory().catch(() => [])).filter((h) => !onCloud.has(h.fileName)));
      }
      // Tên người nhận lưu từ trước còn dấu / chữ thường (Tesseract tự thêm dấu): sửa về IN HOA KHÔNG DẤU như ảnh
      const wrong = list.filter((h) => h.name !== bankName(h.name));
      if (wrong.length) {
        const fixed = wrong.map(({ thumb: _t, hasThumb: _h, ...h }) => ({ ...h, name: bankName(h.name) }));
        await store.save(fixed);
        const names = new Map(fixed.map((h) => [h.fileName, h.name]));
        list = list.map((h) => (names.has(h.fileName) ? { ...h, name: names.get(h.fileName)! } : h));
        setMessage((m) =>
          [m, `Đã bỏ dấu, viết hoa tên người nhận của ${wrong.length} ảnh trong lịch sử (tên tài khoản ngân hàng không có dấu).`]
            .filter(Boolean)
            .join(" "),
        );
      }
      setHistory(list);
    } catch (err) {
      setHistory([]);
      setCloudError(store.kind === "shared" ? ((err as { code?: string }).code ?? "error") : "");
      setHistoryError(
        store.kind === "shared"
          ? `Lịch sử trên cloud: ${err instanceof Error ? err.message : err}`
          : "Trình duyệt không cho lưu lịch sử (có thể đang ở chế độ ẩn danh). Kết quả sẽ không được nhớ.",
      );
    } finally {
      setHistoryLoaded(true);
    }
  }, [store]);
  useEffect(() => {
    if (settingsReady) void reloadHistory();
  }, [reloadHistory, settingsReady]);
  historyRef.current = history;

  // Lịch sử dùng chung: gửi nốt phần đang chờ khi rời tab
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && void store.flush();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void store.flush();
    };
  }, [store]);

  // Cảnh báo khi đóng/tải lại trang lúc đang đọc (mất kết quả)
  useEffect(() => {
    if (!running && !sync.pending && !rereading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running, sync.pending, rereading]);

  function changeAi(patch: (prev: AiSettings) => AiSettings) {
    setAi((prev) => {
      const next = patch(prev);
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  const provider = ai.provider;
  useEffect(() => setKeyCheck({ state: "idle", text: "" }), [ai]);
  const userKey = ai.keys[provider].trim();
  const serverHasKey = (info: ServerInfo | null, p: Provider) =>
    Boolean(info?.serverKeys ? info.serverKeys[p] : p === "claude" && info?.hasKey);
  const aiReady = Boolean(userKey) || serverHasKey(server, provider);
  const usingServerKey = !userKey && serverHasKey(server, provider);
  const engineShown: Engine = aiReady ? selectedEngine : "tesseract";
  const aiName = provider === "gemini" ? "Gemini" : "Claude";

  /** Gọi /api/check-key: hỏi thông tin model bằng key đang dùng (không tốn lượt đọc ảnh) */
  async function checkKey() {
    setKeyCheck({ state: "checking", text: "" });
    try {
      const res = await fetch("/api/check-key", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-app-password": password,
          ...(userKey ? { "x-user-api-key": userKey } : {}),
        },
        body: JSON.stringify({ provider, model: ai.models[provider].trim() || undefined }),
      });
      const data = await res.json();
      setKeyCheck(
        data.ok
          ? { state: "ok", text: `Key dùng được · model ${data.displayName || data.model}` }
          : { state: "bad", text: data.error || "Key không dùng được" },
      );
    } catch {
      setKeyCheck({ state: "bad", text: "Không kết nối được máy chủ" });
    }
  }

  function onPasswordChange(value: string) {
    setPassword(value);
    try {
      localStorage.setItem(PASSWORD_KEY, value);
    } catch {}
  }

  const update = useCallback(
    (id: string, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r))),
    [],
  );

  async function setFiles(all: File[], folder: string) {
    const files = all.filter((f) => IMAGE_EXTENSIONS.test(f.name));
    const skipped = all.filter((f) => !IMAGE_EXTENSIONS.test(f.name) && !f.name.startsWith(".")).length;
    if (!files.length) {
      setMessage(
        all.length
          ? `Không có ảnh .jpg/.png trong ${all.length} file đã chọn (ảnh HEIC của iPhone cần chuyển sang JPG trước).`
          : "Thư mục trống.",
      );
      return;
    }
    files.sort((a, b) => a.name.localeCompare(b.name, "vi", { numeric: true }));
    const skippedMsg = skipped ? `Đã bỏ qua ${skipped} file không phải ảnh .jpg/.png.` : "";
    const byName = new Map(historyRef.current.map((h) => [h.fileName, h]));
    const existing = new Map<string, HistoryRecord>();
    for (const f of files) {
      const rec = byName.get(historyKey(f.name));
      if (rec) existing.set(historyKey(f.name), rec);
    }
    if (existing.size) {
      // Có ảnh đã đọc trước đây: hỏi đọc lại (ghi đè) hay bỏ qua
      setDup({ files, folder, skippedMsg, existing });
      return;
    }
    loadRows(files, folder, skippedMsg, new Map(), false);
  }

  /** Nạp danh sách ảnh vào bảng; useSaved = lấy dữ liệu cũ cho ảnh đã có trong lịch sử. Trả về các dòng mới tạo. */
  function loadRows(
    files: File[],
    folder: string,
    msg: string,
    existing: Map<string, HistoryRecord>,
    useSaved: boolean,
  ): Row[] {
    rowsRef.current.forEach((r) => r.url && URL.revokeObjectURL(r.url));
    setFolderName(folder);
    setMessage(msg);
    const next: Row[] = files.map((file, i) => {
      const { customerCode, businessName } = parseFileName(file.name);
      const base: Row = {
        id: `r${i}-${Date.now()}`,
        file,
        url: URL.createObjectURL(file),
        fileName: file.name.normalize("NFC"),
        customerCode,
        businessName,
        bank: "",
        account: "",
        name: "",
        status: "pending",
        note: "",
      };
      const saved = useSaved ? existing.get(historyKey(file.name)) : undefined;
      if (!saved) return base;
      return {
        ...base,
        customerCode: saved.customerCode,
        businessName: saved.businessName,
        bank: saved.bank,
        account: saved.account,
        name: saved.name,
        status: saved.status,
        note: [`Đã có từ ${fmtTime(saved.readAt)} (${saved.engine})`, saved.note].filter(Boolean).join(" · "),
      };
    });
    setRows(next);
    return next;
  }

  function answerDup(choice: "reread" | "skip" | "cancel") {
    const d = dup;
    setDup(null);
    if (!d || choice === "cancel") return;
    const next = loadRows(d.files, d.folder, d.skippedMsg, d.existing, choice === "skip");
    const todo = next.filter((r) => r.status === "pending");
    if (!todo.length) {
      setMessage(`Tất cả ${next.length} ảnh đã có dữ liệu, đã lấy từ lịch sử. ${d.skippedMsg}`.trim());
      return;
    }
    run(todo);
  }

  function toRecord(row: Row, prev: HistoryRecord | undefined, engineLabel: string | null, thumb?: Blob): HistoryRecord {
    return {
      fileName: historyKey(row.fileName),
      customerCode: row.customerCode,
      businessName: row.businessName,
      bank: row.bank,
      account: row.account,
      name: row.name,
      status: row.status === "ok" ? "ok" : "review",
      note: row.note.replace(/^Đã có từ [^·]*(· )?/, ""),
      engine: engineLabel ?? prev?.engine ?? "",
      size: row.file?.size ?? prev?.size ?? 0,
      readAt: engineLabel ? Date.now() : (prev?.readAt ?? Date.now()),
      thumb,
    };
  }

  /** Lưu dòng vào lịch sử (chỉ dòng đọc xong: OK hoặc Cần kiểm tra) */
  async function persist(row: Row, engineLabel: string | null, withThumb: boolean) {
    if (row.status !== "ok" && row.status !== "review") return;
    const prev = history.find((h) => h.fileName === historyKey(row.fileName));
    let thumb: Blob | undefined;
    if (withThumb && row.file) thumb = await fileToThumbBlob(row.file).catch(() => undefined);
    const rec = toRecord(row, prev, engineLabel, thumb);
    try {
      await store.save([rec]);
      setHistory((list) => {
        const old = list.find((h) => h.fileName === rec.fileName);
        const merged = { ...rec, thumb: rec.thumb ?? old?.thumb };
        return [merged, ...list.filter((h) => h.fileName !== rec.fileName)];
      });
    } catch {
      setHistoryError(store.kind === "shared" ? "Không lưu được lịch sử lên máy chủ." : "Không lưu được lịch sử trên trình duyệt này.");
    }
  }

  /**
   * Lưu các dòng ở tab Đọc ảnh lên cloud. replace = xóa trên cloud các ảnh không có trong bảng.
   * Xong thì đọc lại từ cloud để kiểm tra từng ảnh đã có đủ, đúng STK và tên.
   */
  async function syncTable(replace: boolean) {
    const list = rowsRef.current.filter((r) => r.status === "ok" || r.status === "review");
    if (!list.length || store.kind !== "shared") return;
    setCloudSync("working");
    try {
      const byName = new Map(historyRef.current.map((h) => [h.fileName, h]));
      const records: HistoryRecord[] = [];
      for (const row of list) {
        const prev = byName.get(historyKey(row.fileName));
        // Cloud chưa có ảnh thu nhỏ thì tạo từ file gốc
        const thumb =
          prev?.thumb ?? (row.file && !prev?.hasThumb ? await fileToThumbBlob(row.file).catch(() => undefined) : undefined);
        records.push(toRecord(row, prev, null, thumb));
      }
      await store.save(records);
      await store.flush();
      const left = store.pendingCount?.() ?? 0;
      if (left) throw new Error(`còn ${left} ảnh chưa gửi được (${store.status?.().error || "lỗi máy chủ"}). App sẽ tự gửi lại`);
      const keep = new Set(records.map((r) => r.fileName));
      let removed = 0;
      if (replace) {
        const extra = (await store.getAll()).filter((h) => !keep.has(h.fileName)).map((h) => h.fileName);
        if (extra.length) await store.remove(extra);
        removed = extra.length;
      }
      // Kiểm tra lại: đọc từ cloud, so từng ảnh
      const cloud = await store.getAll();
      const onCloud = new Map(cloud.map((h) => [h.fileName, h]));
      const bad = records.filter((r) => {
        const c = onCloud.get(r.fileName);
        return !c || c.account !== r.account || c.name !== r.name || c.bank !== r.bank;
      });
      setHistory(cloud);
      setLocalOnly((l) => (replace ? [] : l.filter((h) => !onCloud.has(h.fileName))));
      setMessage(
        bad.length
          ? `Cảnh báo: ${bad.length} ảnh chưa khớp trên cloud (${bad
              .slice(0, 5)
              .map((r) => r.fileName)
              .join(", ")}${bad.length > 5 ? "…" : ""}). Bấm Lưu bảng lên cloud lần nữa.`
          : `Đã lưu ${records.length} ảnh lên cloud${removed ? ` và xóa ${removed} ảnh cũ không có trong bảng` : ""}. ` +
              `Đã kiểm tra lại trên cloud: đủ ${records.length}/${records.length} ảnh, đúng ngân hàng, STK và tên. ` +
              `Lịch sử cloud hiện có ${cloud.length} ảnh.`,
      );
    } catch (err) {
      setMessage(`Chưa lưu xong lên cloud: ${err instanceof Error ? err.message : err}`);
    } finally {
      setCloudSync(null);
    }
  }

  async function uploadLocalOnly() {
    const list = localOnly;
    if (!list.length) return;
    if (!window.confirm(`Đưa ${list.length} ảnh chỉ có trên trình duyệt này lên lịch sử cloud?`)) return;
    await store.save(list);
    await store.flush();
    await reloadHistory();
    const left = store.pendingCount?.() ?? 0;
    setMessage(left ? `Còn ${left} ảnh chưa lên được cloud, app sẽ tự gửi lại.` : `Đã đưa ${list.length} ảnh lên cloud.`);
  }

  /** Sửa tay trong bảng: cập nhật ngay, lưu lịch sử sau 0,6 giây ngừng gõ */
  const editRow = useCallback((id: string, patch: Partial<Row>) => {
    const cur = rowsRef.current.find((r) => r.id === id);
    update(id, patch);
    if (!cur) return;
    const next = { ...cur, ...patch };
    const timers = saveTimers.current;
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => persistRef.current(next, null, false), 600));
  }, [update]);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const first = (files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath || "";
    setFiles(files, first.split("/")[0] || "");
    e.target.value = "";
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(e.target.files || []), "");
    e.target.value = "";
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (running) return;
    const { files, folder } = await filesFromDrop(e.dataTransfer);
    setFiles(files, folder);
  }

  function getSchedulers(): Promise<{ text: Scheduler; digits: Scheduler }> {
    // Giữ một lời hứa duy nhất để các luồng song song không tạo trùng worker
    if (!schedulerRef.current) {
      schedulerRef.current = (async () => {
        const { createScheduler, createWorker } = await import("tesseract.js");
        const make = async (langs: string[]) => {
          const scheduler = createScheduler();
          const workers = await Promise.all(Array.from({ length: TESSERACT_WORKERS }, () => createWorker(langs)));
          workers.forEach((w) => scheduler.addWorker(w));
          return scheduler;
        };
        // Bộ tiếng Việt đọc ngân hàng, tên; bộ tiếng Anh đọc số tài khoản (bộ tiếng Việt hay đọc 3 thành 5)
        const [text, digits] = await Promise.all([make(["vie", "eng"]), make(["eng"])]);
        return { text, digits };
      })();
      schedulerRef.current.catch(() => (schedulerRef.current = null));
    }
    return schedulerRef.current;
  }

  /** accountDigits: STK do bộ tiếng Anh đọc (rỗng nếu không thấy); account: STK dùng (bộ tiếng Anh, không có thì bộ tiếng Việt) */
  async function readWithTesseract(file: Blob): Promise<BankFields & { accountDigits: string }> {
    const { text, digits } = await getSchedulers();
    const canvas = await fileToCanvasForTesseract(file);
    const [a, b] = await Promise.all([text.addJob("recognize", canvas), digits.addJob("recognize", canvas)]);
    canvas.width = canvas.height = 0; // giải phóng bộ nhớ canvas ngay
    const t = parseOcrText(a.data.text);
    const accountDigits = parseOcrText(b.data.text).account;
    return { ...t, account: accountDigits || t.account, accountDigits };
  }

  /**
   * Sửa lịch sử đã đọc bằng Tesseract: đọc lại STK từ ảnh thu nhỏ đã lưu bằng bộ đọc số (bộ tiếng Việt hay đọc 3 thành 5),
   * và khôi phục chữ hoa/thường của tên khi chữ đọc được khớp hoàn toàn với tên đang lưu.
   */
  async function rereadFromThumbs() {
    const list = history.filter((h) => /tesseract/i.test(h.engine) && (h.thumb || h.hasThumb));
    if (!list.length) {
      setMessage("Không có ảnh nào đọc bằng Tesseract có ảnh thu nhỏ đã lưu.");
      return;
    }
    const minutes = Math.max(1, Math.ceil((list.length * 2.5) / 60 / TESSERACT_WORKERS));
    if (
      !window.confirm(
        `Đọc lại số tài khoản cho ${list.length} ảnh đã đọc bằng Tesseract (từ ảnh thu nhỏ đã lưu)?\n` +
          `Số nào khác sẽ được sửa và ghi chú số cũ. Mất khoảng ${minutes} phút, đừng đóng trang.`,
      )
    )
      return;
    setRereading({ done: 0, total: list.length });
    const changed: HistoryRecord[] = [];
    let accFixed = 0;
    let nameFixed = 0;
    let skipped = 0;
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < list.length) {
        const h = list[next++];
        try {
          const blob = await store.loadThumb(h);
          if (!blob) {
            skipped++;
            continue;
          }
          const r = await readWithTesseract(blob);
          let rec: HistoryRecord | null = null;
          const staffAcc = digitsOnly(lookupHskh(hskh, h.customerCode)?.account ?? "");
          // Biểu tượng sổ ngay sau STK đôi khi bị đọc thành thêm 1 chữ số ở cuối: bỏ đi nếu dài hơn số cũ đúng 1 số
          const cand =
            r.accountDigits.length === h.account.length + 1 && r.accountDigits !== staffAcc
              ? r.accountDigits.slice(0, -1)
              : r.accountDigits;
          // Chỉ sửa khi bộ đọc số đọc ra số hợp lý: cùng độ dài số cũ, hoặc khớp STK trong HSKH
          if (cand.length >= 6 && cand !== h.account && (cand.length === h.account.length || cand === staffAcc)) {
            rec = {
              ...h,
              account: cand,
              note: [h.note, `STK đọc lại bằng bộ đọc số (trước đây ${h.account || "trống"})`].filter(Boolean).join("; "),
            };
            accFixed++;
          } else if (cand && cand !== h.account && cand.length !== h.account.length) {
            skipped++;
          }
          const name = bankName(r.name);
          if (name !== h.name && name.toUpperCase() === h.name.toUpperCase()) {
            rec = { ...(rec ?? h), name };
            nameFixed++;
          }
          if (rec) {
            const { thumb: _t, hasThumb: _h, ...plain } = rec;
            changed.push(plain);
          }
        } catch {
          skipped++;
        } finally {
          setRereading({ done: ++done, total: list.length });
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: TESSERACT_WORKERS }, worker));
      if (changed.length) {
        await store.save(changed);
        await store.flush();
        const byName = new Map(changed.map((c) => [c.fileName, c]));
        setHistory((l) => l.map((h) => (byName.has(h.fileName) ? { ...h, ...byName.get(h.fileName)! } : h)));
      }
      setMessage(
        `Đã đọc lại ${list.length} ảnh: sửa số tài khoản ở ${accFixed} ảnh, khôi phục chữ hoa/thường tên ở ${nameFixed} ảnh` +
          (skipped ? `; ${skipped} ảnh không đọc được rõ, giữ nguyên (nên xem lại ảnh)` : "") +
          ". Các số đã sửa có ghi chú \"STK đọc lại\" kèm số cũ.",
      );
    } finally {
      setRereading(null);
    }
  }

  async function processRow(row: Row, engine: Engine) {
    const file = row.file!;
    update(row.id, { status: "processing", note: "" });
    if (engine === "tesseract") {
      const t = await readWithTesseract(file);
      const patch: Partial<Row> = {
        ...t,
        bank: normalizeBankName(t.bank),
        // Tesseract hay nhầm 3/5, 6/8... nên luôn cần người kiểm tra
        status: "review",
        note: ["Chỉ đọc bằng Tesseract - đối chiếu với ảnh rồi bấm Đã kiểm tra", ...validate(t)].join("; "),
      };
      update(row.id, patch);
      await persist({ ...row, ...patch } as Row, "Tesseract", true);
      return;
    }

    const payload = await fileToBase64ForApi(file);
    const callOpts = { password, apiKey: userKey || undefined, shouldStop: () => stopRef.current };
    const model = ai.models[provider].trim() || undefined;
    const [c, v, t] = await Promise.all([
      postOcr({ ...payload, provider, model }, callOpts),
      // Lần đọc thứ 2 độc lập, chỉ tập trung STK và tên (lỗi lần 2 không làm hỏng kết quả lần 1)
      verifyTwice ? postOcr({ ...payload, provider, model, mode: "verify" }, callOpts).catch(() => null) : Promise.resolve(null),
      engine === "both" ? readWithTesseract(file).catch(() => null) : Promise.resolve(null),
    ]);
    const result: BankFields = {
      bank: normalizeBankName(String(c.bank_raw ?? ""), String(c.bank_code ?? "")),
      account: digitsOnly(String(c.account_number ?? "")),
      name: bankName(String(c.recipient_name ?? "")),
    };
    const issues = validate(result);
    if (c.uncertain) issues.push(c.note ? `${aiName} không chắc chắn: ${c.note}` : `${aiName} không chắc chắn`);
    const notes: string[] = [];
    if (verifyTwice) {
      if (!v) issues.push("Không đọc được lần 2 để đối chiếu STK");
      else {
        const acc2 = digitsOnly(String(v.account_number ?? ""));
        const name2 = String(v.recipient_name ?? "").replace(/\s+/g, " ").trim();
        if (acc2 !== result.account) issues.push(`2 lần đọc STK khác nhau: lần 2 đọc ${acc2 || "(trống)"}`);
        if (looseKey(name2) !== looseKey(result.name)) issues.push(`2 lần đọc tên khác nhau: lần 2 đọc "${name2 || "(trống)"}"`);
        if (v.uncertain) issues.push("Lần 2: AI không chắc số tài khoản");
        if (acc2 === result.account && looseKey(name2) === looseKey(result.name)) notes.push("2 lần đọc STK khớp");
      }
    }
    let note = "";
    if (t) {
      const diffs: string[] = [];
      if (t.account !== result.account) diffs.push(`STK Tesseract: ${t.account || "(trống)"}`);
      if (looseKey(t.name) !== looseKey(result.name)) diffs.push(`Tên Tesseract: ${t.name || "(trống)"}`);
      if (diffs.length) issues.push(...diffs);
      else note = "Khớp 2 engine";
    }
    if (note) notes.push(note);
    const patch: Partial<Row> = {
      ...result,
      status: issues.length ? "review" : "ok",
      note: issues.length ? issues.join("; ") : notes.join("; "),
    };
    update(row.id, patch);
    await persist({ ...row, ...patch } as Row, engine === "both" ? `${aiName} + Tesseract` : aiName, true);
  }

  async function run(targets: Row[]) {
    targets = targets.filter((r) => r.file);
    if (!targets.length) return;
    stopRef.current = false;
    setRunning(true);
    setMessage("");
    // Bấm Bắt đầu trước khi kiểm tra máy chủ xong: hỏi lại để biết có API key không
    const info: ServerInfo | null =
      server ?? (await fetch("/api/ocr").then((r) => r.json()).catch(() => null));
    const ready = Boolean(userKey) || serverHasKey(info, provider);
    const engine: Engine = ready ? selectedEngine : "tesseract";
    if (engine !== "tesseract" && !userKey && info?.needPassword && !password) {
      setMessage(`Nhập mật khẩu truy cập hoặc API key ${aiName} của bạn ở tab Cài đặt AI trước khi đọc bằng AI.`);
      setTab("settings");
      setRunning(false);
      return;
    }
    const queue = [...targets];
    const concurrency = engine === "tesseract" ? TESSERACT_WORKERS : CLAUDE_CONCURRENCY;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (queue.length && !stopRef.current) {
          const row = queue.shift()!;
          try {
            await processRow(row, engine);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            update(row.id, { status: "error", note: msg || "Không đọc được ảnh" });
            if (err instanceof FatalOcrError) {
              // Sai mật khẩu / thiếu key: các ảnh sau cũng sẽ lỗi, dừng luôn
              stopRef.current = true;
              setMessage(`${msg}. Đã dừng đọc.`);
            }
          }
        }
      }),
    );
    // Ảnh còn đang "Đang đọc" khi bấm Dừng sẽ đọc xong; ảnh chưa đọc vẫn ở trạng thái Chờ
    setRunning(false);
    void store.flush();
  }

  const realRows = rows.filter((r) => r.status !== "example");
  const stats = useMemo(() => {
    const s = { total: 0, done: 0, ok: 0, review: 0, error: 0 };
    rows.forEach((r) => {
      if (r.status === "example") return;
      s.total++;
      // STK gần giống HSKH (nghi đọc nhầm) chưa bấm "Đã kiểm tra" thì tính là Cần kiểm tra
      const near =
        r.status === "ok" &&
        !r.note.startsWith("Đã kiểm tra") &&
        checkAccount(lookupHskh(hskh, r.customerCode), r.account).kind === "near";
      const st = near ? "review" : r.status;
      if (st === "ok" || st === "review" || st === "error") s.done++;
      if (st === "ok") s.ok++;
      if (st === "review") s.review++;
      if (st === "error") s.error++;
    });
    return s;
  }, [rows, hskh]);

  const indexById = useMemo(() => new Map(rows.map((r, i) => [r.id, i + 1])), [rows]);

  // Cảnh báo trùng STK: so các dòng đang đọc với nhau và với lịch sử
  const rowWarnings = useMemo(() => {
    const current = rows.filter((r) => r.status !== "example" && r.account);
    const names = new Set(current.map((r) => r.fileName));
    return findDuplicateAccounts([...current, ...history.filter((h) => !names.has(h.fileName))]);
  }, [rows, history]);
  const historyWarnings = useMemo(() => findDuplicateAccounts(history), [history]);
  const dupRowCount = rows.filter((r) => rowWarnings.has(r.fileName)).length;

  const visible = onlyReview
    ? rows.filter(
        (r) =>
          r.status === "review" ||
          r.status === "error" ||
          rowWarnings.has(r.fileName) ||
          checkAccount(lookupHskh(hskh, r.customerCode), r.account).kind === "near",
      )
    : rows;

  /** Đối chiếu STK với HSKH: "near" (lệch 1-2 số, nghi đọc nhầm) / "different" / "match" */
  function hskhCheck(r: { customerCode: string; account: string }) {
    return checkAccount(lookupHskh(hskh, r.customerCode), r.account);
  }
  const nearCount = rows.filter((r) => r.status !== "example" && hskhCheck(r).kind === "near").length;

  function staffLabel(code: string) {
    if (!hskh || !code) return "";
    const e = lookupHskh(hskh, code);
    return e ? `${e.msnv}|${e.nvbh}` : "?";
  }
  const hskhUnmatched = useMemo(() => {
    if (!hskh) return [];
    const codes = new Set([...rows.filter((r) => r.status !== "example").map((r) => r.customerCode), ...history.map((h) => h.customerCode)]);
    return [...codes].filter((c) => c && !lookupHskh(hskh, c)).sort();
  }, [hskh, rows, history]);

  function noteFor(r: Row) {
    const hc = hskhCheck(r);
    const base = r.status === "ok" ? (r.note.startsWith("Đã kiểm tra") ? "Đã kiểm tra" : "") : r.note || STATUS_LABEL[r.status];
    return [...(rowWarnings.get(r.fileName) ?? []), hc.kind === "near" || hc.kind === "different" ? accountCheckText(hc) : "", base]
      .filter(Boolean)
      .join("; ");
  }

  async function onExport() {
    const list = realRows;
    setExporting({ done: 0, total: list.length });
    try {
      await exportToExcel(
        list.map((r) => ({
          customerCode: r.customerCode,
          businessName: r.businessName,
          msnv: lookupHskh(hskh, r.customerCode)?.msnv ?? "",
          nvbh: lookupHskh(hskh, r.customerCode)?.nvbh ?? "",
          hskhAccount: lookupHskh(hskh, r.customerCode)?.account ?? "",
          hskhCheck: accountCheckText(hskhCheck(r)),
          suspicious: hskhCheck(r).kind === "near",
          duplicate: rowWarnings.has(r.fileName),
          bank: r.bank,
          account: r.account,
          name: r.name,
          fileName: r.fileName,
          note: noteFor(r),
          image: r.file ?? (() => {
            const h = history.find((x) => x.fileName === r.fileName);
            return h ? store.loadThumb(h) : Promise.resolve(undefined);
          }),
        })),
        {
          fileName: folderName ? `thong-tin-ngan-hang_${folderName}.xlsx` : "thong-tin-ngan-hang.xlsx",
          withImages,
          onProgress: (done, total) => setExporting({ done, total }),
        },
      );
    } catch (err) {
      setMessage(`Không tạo được file Excel: ${err instanceof Error ? err.message : err}`);
    } finally {
      setExporting(null);
    }
  }

  async function exportHistory(records: HistoryRecord[]) {
    setExporting({ done: 0, total: records.length });
    try {
      await exportToExcel(
        records.map((r) => ({
          customerCode: r.customerCode,
          businessName: r.businessName,
          msnv: lookupHskh(hskh, r.customerCode)?.msnv ?? "",
          nvbh: lookupHskh(hskh, r.customerCode)?.nvbh ?? "",
          hskhAccount: lookupHskh(hskh, r.customerCode)?.account ?? "",
          hskhCheck: accountCheckText(hskhCheck(r)),
          suspicious: hskhCheck(r).kind === "near",
          duplicate: historyWarnings.has(r.fileName),
          bank: r.bank,
          account: r.account,
          name: r.name,
          fileName: r.fileName,
          note: [
            ...(historyWarnings.get(r.fileName) ?? []),
            r.status === "ok" ? (r.note.startsWith("Đã kiểm tra") ? "Đã kiểm tra" : "") : r.note || "Cần kiểm tra",
          ]
            .filter(Boolean)
            .join("; "),
          image: () => store.loadThumb(r),
        })),
        {
          fileName: `lich-su-ocr-ngan-hang_${new Date().toISOString().slice(0, 10)}.xlsx`,
          withImages,
          onProgress: (done, total) => setExporting({ done, total }),
        },
      );
    } catch (err) {
      setMessage(`Không tạo được file Excel: ${err instanceof Error ? err.message : err}`);
    } finally {
      setExporting(null);
    }
  }

  function download(data: BlobPart, fileName: string, type: string) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function onBackup() {
    setExporting({ done: 0, total: history.length });
    try {
      const json = await makeBackup(history, store.loadThumb, (done, total) => setExporting({ done, total }));
      download(json, `sao-luu-ocr-ngan-hang_${new Date().toISOString().slice(0, 10)}.json`, "application/json");
      setMessage(`Đã sao lưu ${history.length} dòng lịch sử. Giữ file .json này để khôi phục sang máy/trình duyệt khác.`);
    } catch (err) {
      setMessage(`Không sao lưu được: ${err instanceof Error ? err.message : err}`);
    } finally {
      setExporting(null);
    }
  }

  /** Đưa bản ghi (từ file sao lưu / Excel) vào lịch sử; hỏi trước khi ghi đè dòng đã có */
  async function importRecords(records: HistoryRecord[], source: string, extra = "") {
    if (!records.length) {
      setMessage(`Không có dòng nào để nhập từ ${source}. ${extra}`.trim());
      return;
    }
    const have = new Set(history.map((h) => h.fileName));
    const dupCount = records.filter((r) => have.has(r.fileName)).length;
    let list = records;
    if (dupCount) {
      const overwrite = window.confirm(
        `${dupCount}/${records.length} dòng trong ${source} trùng tên file với lịch sử hiện có.\n\n` +
          "OK = ghi đè bằng dữ liệu trong file\nHủy = giữ dữ liệu hiện có, chỉ thêm dòng mới",
      );
      if (!overwrite) list = records.filter((r) => !have.has(r.fileName));
    }
    setExporting({ done: 0, total: list.length });
    try {
      await store.save(list);
      await store.flush();
      await reloadHistory();
      const added = list.filter((r) => !have.has(r.fileName)).length;
      setMessage(
        `Đã nhập ${list.length} dòng từ ${source}: ${added} mới, ${list.length - added} ghi đè${
          list.length < records.length ? `, giữ nguyên ${records.length - list.length} dòng đã có` : ""
        }. ${extra}`.trim(),
      );
    } catch (err) {
      setMessage(`Không nhập được: ${err instanceof Error ? err.message : err}`);
    } finally {
      setExporting(null);
    }
  }

  async function onRestore(file: File) {
    try {
      await importRecords(parseBackup(await file.text()), "file sao lưu");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function onImportExcel(file: File) {
    try {
      const { records, skippedNoFileName } = await importExcel(await file.arrayBuffer());
      await importRecords(
        records,
        "file Excel",
        skippedNoFileName ? `Bỏ qua ${skippedNoFileName} dòng không có tên file.` : "",
      );
    } catch (err) {
      setMessage(`Không đọc được file Excel: ${err instanceof Error ? err.message : err}`);
    }
  }

  function changeStore(kind: StoreKind) {
    void store.flush();
    setStoreKind(kind);
    try {
      localStorage.setItem(STORE_KEY, kind);
    } catch {}
  }

  /** Chép lịch sử đang có trên trình duyệt lên máy chủ (dùng chung) */
  async function copyLocalToShared() {
    try {
      const local = await getAllHistory();
      if (!local.length) {
        setMessage("Trình duyệt này chưa có lịch sử để chuyển.");
        return;
      }
      await importRecords(local, "lịch sử trên trình duyệt");
    } catch (err) {
      setMessage(`Không chuyển được: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function onCopy() {
    // Thêm dấu ' trước số để Excel giữ nguyên dạng chữ (không mất số 0, không ra 4.7E+12)
    const tsv = [
      HEAD,
      ...realRows.map((r, i) => [
        i + 1,
        r.customerCode ? `'${r.customerCode}` : "",
        r.businessName,
        lookupHskh(hskh, r.customerCode)?.msnv ? `'${lookupHskh(hskh, r.customerCode)!.msnv}` : "",
        lookupHskh(hskh, r.customerCode)?.nvbh ?? "",
        r.bank,
        r.account ? `'${r.account}` : "",
        r.name,
        r.fileName,
        noteFor(r),
      ]),
    ]
      .map((line) => line.map((v) => String(v).replace(/[\t\n]/g, " ")).join("\t"))
      .join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      setMessage("Đã sao chép bảng. Mở Excel, chọn ô A1 rồi dán (Ctrl+V).");
    } catch {
      setMessage("Trình duyệt chặn sao chép. Hãy dùng nút Xuất Excel.");
    }
  }

  const reread = useCallback((r: Row) => run([r]), // eslint-disable-line react-hooks/exhaustive-deps
    [server, selectedEngine, password, ai]);
  const busy = running || !!exporting;
  const pendingCount = realRows.filter((r) => r.status === "pending" || r.status === "error").length;

  return (
    <main className="wrap">
      <header>
        <h1>OCR thông tin ngân hàng → Excel</h1>
        <p className="lead">
          Chọn thư mục ảnh chụp “Thông tin người nhận”. Tên file dạng <code>0573.00028_TÊN CSKD.JPG</code> cho ra
          Mã số KH <code>0573/00028</code> và Tên CSKD. Ảnh được đọc lấy Ngân hàng nhận, Tài khoản/thẻ nhận, Tên
          người nhận. Sửa trực tiếp trong bảng rồi xuất Excel (kèm ảnh trong ô).
        </p>
      </header>

      <nav className="tabs" role="tablist">
        {(
          [
            ["read", `Đọc ảnh${stats.total ? ` (${stats.total})` : ""}`],
            ["history", `Lịch sử (${history.length})`],
            ["hskh", `HSKH${hskh ? ` (${hskh.count})` : ""}`],
            ["settings", "Cài đặt AI"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {storeKind === "shared" && historyLoaded && !cloudError && (
        <div className={`sync-bar ${sync.error ? "bad" : sync.pending ? "busy" : "ok"}`} role="status">
          {sync.error ? (
            <>
              <span>
                {sync.pending} ảnh chưa lên cloud: {sync.error}. Ảnh vẫn giữ trên máy này, app tự gửi lại.
              </span>
              <button className="btn sm" onClick={() => void store.flush()}>
                Gửi lại ngay
              </button>
            </>
          ) : sync.pending ? (
            <span>Đang lưu {sync.pending} ảnh lên cloud…</span>
          ) : (
            <span>Đã lưu hết lên cloud · lịch sử cloud có {history.length} ảnh</span>
          )}
          {localOnly.length > 0 && (
            <button className="btn sm" onClick={() => void uploadLocalOnly()}>
              Đưa {localOnly.length} ảnh chỉ có trên máy này lên cloud
            </button>
          )}
        </div>
      )}
      {historyError && <div className="notice">{historyError}</div>}
      {message && <div className="notice">{message}</div>}

      {storeKind === "shared" && cloudError === "bad_password" && (
        <section className="panel cloud-gate">
          <span className="field-label">Dữ liệu chung trên cloud</span>
          <span className="hint">
            Nhập mật khẩu truy cập để xem Lịch sử và HSKH dùng chung (mỗi máy chỉ cần nhập một lần).
            {sync.pending > 0 && ` Có ${sync.pending} ảnh đang chờ lên cloud (vẫn giữ trên máy này), nhập đúng mật khẩu là gửi.`}
          </span>
          <input
            type="password"
            className="password"
            placeholder="Mật khẩu truy cập"
            aria-label="Mật khẩu cloud"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void reloadHistory()}
          />
          <button className="btn primary" onClick={() => void reloadHistory()}>
            Kết nối
          </button>
        </section>
      )}
      {storeKind === "shared" && (cloudError === "no_password" || cloudError === "no_store") && (
        <div className="notice">
          Cloud chưa sẵn sàng trên máy chủ ({historyError.replace(/^Lịch sử trên cloud: /, "")}). Tạm thời có thể chọn
          &quot;Chỉ trình duyệt này&quot; ở tab Cài đặt AI.
        </div>
      )}

      {tab === "settings" && (
        <>
          <section className="panel ai">
            <span className="field-label">AI đọc ảnh</span>
            {(Object.keys(AI) as Provider[]).map((p) => (
              <label key={p} className="radio">
                <input
                  type="radio"
                  name="provider"
                  value={p}
                  checked={provider === p}
                  disabled={busy}
                  onChange={() => changeAi((prev) => ({ ...prev, provider: p }))}
                />
                {AI[p].label}
              </label>
            ))}
            <span className="key-box">
              <input
                type={showKey ? "text" : "password"}
                className="text-input key"
                placeholder={`API key ${aiName} (${AI[provider].keyHint})`}
                aria-label={`API key ${aiName}`}
                autoComplete="off"
                spellCheck={false}
                value={ai.keys[provider]}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value;
                  changeAi((prev) => ({ ...prev, keys: { ...prev.keys, [prev.provider]: v } }));
                }}
              />
              <button type="button" className="btn sm" onClick={() => setShowKey((v) => !v)}>
                {showKey ? "Ẩn" : "Hiện"}
              </button>
            </span>
            <input
              className="text-input model"
              placeholder={`Model: ${server?.defaultModels?.[provider] || AI[provider].model}`}
              aria-label="Model"
              spellCheck={false}
              value={ai.models[provider]}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value;
                changeAi((prev) => ({ ...prev, models: { ...prev.models, [prev.provider]: v } }));
              }}
            />
            <a href={AI[provider].keyUrl} target="_blank" rel="noreferrer">
              Lấy API key {aiName}
            </a>
            <button
              className="btn sm"
              disabled={busy || keyCheck.state === "checking" || !aiReady}
              onClick={checkKey}
            >
              {keyCheck.state === "checking" ? "Đang kiểm tra…" : "Kiểm tra key"}
            </button>
            {keyCheck.state !== "idle" && keyCheck.state !== "checking" && (
              <span className={`key-status ${keyCheck.state === "ok" ? "ok" : "missing"}`}>{keyCheck.text}</span>
            )}
            <span className={`key-status ${aiReady ? "ok" : "missing"}`}>
              {userKey
                ? "Dùng key bạn nhập (lưu trên trình duyệt này)"
                : usingServerKey
                  ? "Dùng key trên máy chủ"
                  : `Chưa có key ${aiName}: chỉ đọc được bằng Tesseract`}
            </span>
          </section>
          <section className="panel">
            <span className="field-label">Mật khẩu truy cập</span>
            {server?.needPassword ? (
              <>
                <input
                  type="password"
                  className="password"
                  placeholder="Mật khẩu truy cập"
                  aria-label="Mật khẩu truy cập"
                  value={password}
                  onChange={(e) => onPasswordChange(e.target.value)}
                  disabled={busy}
                />
                <span className="hint">Chỉ cần khi dùng key đặt trên máy chủ (Vercel). Đã nhập key riêng thì bỏ trống.</span>
              </>
            ) : (
              <span className="hint">Máy chủ không đặt mật khẩu (APP_PASSWORD).</span>
            )}
          </section>
          <section className="panel ai">
            <span className="field-label">Nơi lưu lịch sử</span>
            <label className="radio">
              <input
                type="radio"
                name="store"
                checked={storeKind === "local"}
                disabled={busy}
                onChange={() => changeStore("local")}
              />
              Chỉ trình duyệt này
            </label>
            <label className="radio">
              <input
                type="radio"
                name="store"
                checked={storeKind === "shared"}
                disabled={busy}
                onChange={() => changeStore("shared")}
              />
              Cloud - máy nào cũng thấy (khuyên dùng)
            </label>
            {storeKind === "shared" && (
              <>
                <span className={`key-status ${historyError ? "missing" : "ok"}`}>
                  {!historyLoaded ? "Đang kết nối…" : historyError ? "Chưa dùng được" : `Đã kết nối · ${history.length} dòng`}
                </span>
                <button className="btn sm" disabled={busy} onClick={() => void reloadHistory()}>
                  Kết nối lại
                </button>
                <button className="btn sm" disabled={busy || !!historyError} onClick={copyLocalToShared}>
                  Đưa lịch sử của máy này lên cloud
                </button>
              </>
            )}
            <span className="hint full">
              {storeKind === "shared"
                ? "Lịch sử và HSKH nằm trên cloud (Vercel Blob, riêng tư): mở web ở máy nào cũng thấy, ai có mật khẩu truy cập đều xem được. Nhập mật khẩu ở trên rồi bấm Kết nối lại."
                : "Lịch sử chỉ nằm trên trình duyệt này: máy khác hoặc trình duyệt khác sẽ không thấy. Dùng Sao lưu ở tab Lịch sử để giữ một bản."}{" "}
              Key và mật khẩu luôn chỉ lưu trên trình duyệt này.
            </span>
          </section>
        </>
      )}

      {tab === "read" && (
        <>
          <section className="panel ai-status">
            <span>
              AI: <b>{AI[provider].label}</b>
            </span>
            <span className={`key-status ${aiReady ? "ok" : "missing"}`}>
              {userKey ? "Dùng key bạn nhập" : usingServerKey ? "Dùng key trên máy chủ" : `Chưa có key ${aiName}`}
            </span>
            <button className="btn sm" onClick={() => setTab("settings")}>
              Đổi AI / nhập key
            </button>
          </section>
          <section
            className={`panel drop${dragOver ? " over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <label className={`btn primary${busy ? " disabled" : ""}`}>
              Chọn thư mục ảnh
              <input
                type="file"
                multiple
                hidden
                onChange={onPickFolder}
                disabled={busy}
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              />
            </label>
            <label className={`btn${busy ? " disabled" : ""}`}>
              Chọn nhiều ảnh
              <input type="file" multiple hidden accept=".jpg,.jpeg,.png,image/jpeg,image/png" onChange={onPickFiles} disabled={busy} />
            </label>
            <span className="hint">hoặc kéo thả thư mục / ảnh vào đây</span>
          </section>

          <section className="panel">
            <label className="field">
              Chế độ đọc
              <select
                value={engineShown}
                onChange={(e) => {
                  const v = e.target.value as Engine;
                  setEngine(v);
                  try {
                    localStorage.setItem(ENGINE_KEY, v);
                  } catch {}
                }}
                disabled={busy}
              >
                <option value="both" disabled={!aiReady}>
                  {aiName} + Tesseract kiểm tra chéo (khuyên dùng)
                </option>
                <option value="ai" disabled={!aiReady}>
                  Chỉ {aiName} (nhanh hơn)
                </option>
                <option value="tesseract">Chỉ Tesseract (miễn phí, kém chính xác)</option>
              </select>
            </label>
            <span className="spacer" />
            {!running ? (
              <>
                <button
                  className="btn primary"
                  disabled={busy || !pendingCount}
                  onClick={() => run(rowsRef.current.filter((r) => r.status === "pending" || r.status === "error"))}
                >
                  Bắt đầu đọc
                </button>
                <button className="btn" disabled={busy || !realRows.length} onClick={() => run(rowsRef.current)}>
                  Đọc lại tất cả
                </button>
              </>
            ) : (
              <button className="btn danger" onClick={() => (stopRef.current = true)}>
                Dừng
              </button>
            )}
            <button className="btn" disabled={busy || !stats.done} onClick={onCopy}>
              Sao chép bảng
            </button>
            {engineShown !== "tesseract" && (
              <label className="check" title="AI đọc số tài khoản và tên 2 lần độc lập; khác nhau thì báo Cần kiểm tra">
                <input
                  type="checkbox"
                  checked={verifyTwice}
                  disabled={busy}
                  onChange={(e) => {
                    setVerifyTwice(e.target.checked);
                    try {
                      localStorage.setItem(VERIFY_KEY, e.target.checked ? "1" : "0");
                    } catch {}
                  }}
                />
                Đọc STK 2 lần
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={withImages} onChange={(e) => setWithImages(e.target.checked)} disabled={busy} />
              Kèm ảnh
            </label>
            <button className="btn primary" disabled={busy || !stats.done} onClick={onExport}>
              {exporting ? `Đang tạo Excel ${exporting.done}/${exporting.total}…` : "Xuất Excel"}
            </button>
            {storeKind === "shared" && (
              <button
                className="btn"
                disabled={busy || !(stats.ok + stats.review) || cloudSync !== null}
                onClick={async () => {
                  await reloadHistory(); // lấy số ảnh mới nhất trên cloud để hỏi cho đúng
                  setCloudSync("ask");
                }}
              >
                {cloudSync === "working" ? "Đang lưu lên cloud…" : "Lưu bảng lên cloud"}
              </button>
            )}
          </section>

          <section className="panel summary">
            <span>
              {stats.total
                ? `${folderName ? folderName + " · " : ""}${stats.done}/${stats.total} ảnh đã đọc`
                : "Ví dụ minh họa: chọn thư mục để bắt đầu"}
            </span>
            <span className="pill ok">OK: {stats.ok}</span>
            <span className="pill review">Cần kiểm tra: {stats.review}</span>
            <span className="pill error">Lỗi: {stats.error}</span>
            {dupRowCount > 0 && <span className="pill error">Trùng STK: {dupRowCount}</span>}
            {nearCount > 0 && <span className="pill review">Nghi đọc nhầm (so HSKH): {nearCount}</span>}
            <span className="spacer" />
            <label className="check">
              <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
              Chỉ hiện dòng cần kiểm tra / trùng STK
            </label>
            <div className="bar">
              <div style={{ width: stats.total ? `${(stats.done / stats.total) * 100}%` : 0 }} />
            </div>
          </section>


          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>STT</th>
                  <th>Ảnh</th>
                  <th>Mã số KH</th>
                  <th>Tên CSKD</th>
                  <th>MSNV · NVBH</th>
                  <th>Ngân hàng nhận</th>
                  <th>Tài khoản/thẻ nhận</th>
                  <th>Tên người nhận</th>
                  <th>Trạng thái</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <RowView
                    key={r.id}
                    row={r}
                    index={indexById.get(r.id)!}
                    running={busy}
                    warning={rowWarnings.get(r.fileName)?.join("\n") ?? ""}
                    staff={staffLabel(r.customerCode)}
                    check={(() => {
                      const c = hskhCheck(r);
                      return c.kind === "none" ? "" : `${c.kind}|${accountCheckText(c)}`;
                    })()}
                    onUpdate={editRow}
                    onPreview={setPreview}
                    onReread={reread}
                  />
                ))}
              </tbody>
            </table>
          </div>

        </>
      )}

      {tab === "hskh" && (
        <HskhTab
          hskh={hskh}
          busy={busy}
          storeLabel={storeKind === "shared" ? "cloud (máy nào cũng thấy)" : "chỉ trình duyệt này"}
          unmatched={hskhUnmatched}
          onUpload={onUploadHskh}
          onClear={() => {
            setHskh(null);
            saveLocalHskh(null);
            if (store.kind === "shared")
              void fetch("/api/hskh", {
                method: "PUT",
                headers: { "Content-Type": "application/json", "x-app-password": passwordRef.current },
                body: JSON.stringify({ entries: {}, fileName: "", importedAt: Date.now() }),
              }).then((r) => !r.ok && setMessage("Chưa bỏ được HSKH trên cloud (máy khác vẫn thấy). Thử lại sau."));
          }}
        />
      )}

      {tab === "history" && (
        <HistoryTab
          records={history}
          busy={busy || !historyLoaded}
          storeLabel={storeKind === "shared" ? "Cloud (máy nào cũng thấy)" : "Chỉ trình duyệt này"}
          warnings={historyWarnings}
          staffOf={(code) => lookupHskh(hskh, code)}
          loadThumb={store.loadThumb}
          onDelete={async (names) => {
            try {
              await store.remove(names);
              setHistory((list) => list.filter((h) => !names.includes(h.fileName)));
              setLocalOnly((list) => list.filter((h) => !names.includes(h.fileName)));
            } catch (err) {
              setMessage(`Không xóa được: ${err instanceof Error ? err.message : err}`);
            }
          }}
          onClear={async () => {
            try {
              await store.clear();
              setHistory([]);
              setLocalOnly([]);
            } catch (err) {
              setMessage(`Không xóa được: ${err instanceof Error ? err.message : err}`);
            }
          }}
          onExport={exportHistory}
          onBackup={onBackup}
          onRestore={onRestore}
          onImportExcel={onImportExcel}
          onReread={rereadFromThumbs}
          rereading={rereading}
        />
      )}

      {dup && (
        <div className="modal dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="dup-title">
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2 id="dup-title">
              {dup.existing.size}/{dup.files.length} ảnh đã đọc trước đây
            </h2>
            <p>
              Các ảnh này trùng tên với ảnh đã có dữ liệu trong lịch sử
              {(() => {
                const last = Math.max(...[...dup.existing.values()].map((r) => r.readAt));
                return ` (lần gần nhất ${fmtTime(last)})`;
              })()}
              . Bạn có muốn <b>đọc lại và ghi đè</b> không?
            </p>
            <ul className="dup-list">
              {[...dup.existing.values()].slice(0, 5).map((r) => (
                <li key={r.fileName}>
                  {r.fileName} <span className="hint">· {r.account || "chưa có STK"}</span>
                </li>
              ))}
              {dup.existing.size > 5 && <li className="hint">… và {dup.existing.size - 5} ảnh khác</li>}
            </ul>
            <div className="dialog-actions">
              <button className="btn primary" onClick={() => answerDup("skip")} autoFocus>
                Không, bỏ qua {dup.existing.size} ảnh đã có
                {dup.files.length > dup.existing.size ? ` (chỉ đọc ${dup.files.length - dup.existing.size} ảnh mới)` : ""}
              </button>
              <button className="btn" onClick={() => answerDup("reread")}>
                Có, đọc lại toàn bộ {dup.files.length} ảnh
              </button>
              <button className="btn ghost" onClick={() => answerDup("cancel")}>
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}

      {cloudSync === "ask" &&
        (() => {
          const names = new Set(
            rows.filter((r) => r.status === "ok" || r.status === "review").map((r) => historyKey(r.fileName)),
          );
          const extra = history.filter((h) => !names.has(h.fileName)).length;
          return (
            <div className="modal dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="sync-title">
              <div className="dialog" onClick={(e) => e.stopPropagation()}>
                <h2 id="sync-title">Lưu {names.size} ảnh trong bảng lên cloud</h2>
                <p>
                  Lịch sử cloud đang có {history.length} ảnh
                  {extra ? `, trong đó ${extra} ảnh không có trong bảng này` : ""}. Sau khi lưu, app đọc lại từ cloud để
                  kiểm tra từng ảnh.
                </p>
                <div className="dialog-actions">
                  <button className="btn primary" onClick={() => void syncTable(false)} autoFocus>
                    Thêm / cập nhật {names.size} ảnh vào lịch sử cloud
                  </button>
                  <button
                    className="btn danger-outline"
                    onClick={() =>
                      (!extra ||
                        window.confirm(
                          `Xóa ${extra} ảnh trên cloud không có trong bảng? Máy nào cũng sẽ không còn thấy các ảnh này.`,
                        )) &&
                      void syncTable(true)
                    }
                  >
                    Thay toàn bộ lịch sử cloud bằng bảng này{extra ? ` (xóa ${extra} ảnh cũ)` : ""}
                  </button>
                  <button className="btn ghost" onClick={() => setCloudSync(null)}>
                    Hủy
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {preview && (
        <div className="modal" onClick={() => setPreview(null)}>
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview.url} alt={preview.fileName} />
            <figcaption>{preview.fileName}</figcaption>
          </figure>
        </div>
      )}
    </main>
  );
}

/** Một dòng của bảng; chỉ vẽ lại khi chính dòng đó thay đổi (quan trọng khi thư mục có hàng nghìn ảnh) */
const RowView = memo(function RowView({
  row: r,
  index,
  running,
  warning,
  staff,
  check,
  onUpdate,
  onPreview,
  onReread,
}: {
  row: Row;
  index: number;
  running: boolean;
  /** Cảnh báo trùng STK, mỗi dòng một cảnh báo (chuỗi để memo so sánh được) */
  warning: string;
  /** "MSNV|Tên NVBH" dò từ HSKH ("" = chưa có HSKH, "?" = không có trong HSKH) */
  staff: string;
  /** Đối chiếu STK với HSKH: "kind|nội dung" */
  check: string;
  onUpdate: (id: string, patch: Partial<Row>) => void;
  onPreview: (r: Row) => void;
  onReread: (r: Row) => void;
}) {
  const example = r.status === "example";
  const checked = r.note.startsWith("Đã kiểm tra");
  const near = check.startsWith("near|") && !checked;
  // Nghi đọc nhầm (so HSKH) mà chưa kiểm tra thì hiện là Cần kiểm tra
  const shownStatus: Status = r.status === "ok" && near ? "review" : r.status;
  const input = (key: "customerCode" | "businessName" | "bank" | "account" | "name", cls = "") => (
    <td className={cls}>
      <input
        aria-label={key}
        value={r[key]}
        disabled={example}
        onChange={(e) => onUpdate(r.id, { [key]: key === "account" ? digitsOnly(e.target.value) : e.target.value })}
      />
    </td>
  );
  return (
    <tr className={warning ? "dup" : near ? "near" : r.status}>
      <td>{example ? "–" : index}</td>
      <td>
        {r.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={r.url}
            alt={r.fileName}
            className="thumb"
            loading="lazy"
            decoding="async"
            onClick={() => onPreview(r)}
          />
        ) : (
          <div className="thumb ph">ảnh</div>
        )}
      </td>
      {input("customerCode")}
      {input("businessName", "w-name")}
      <td className="staff">
        {staff === "?" ? (
          <span className="note warn">Không có trong HSKH</span>
        ) : staff ? (
          <>
            <b className="mono">{staff.split("|")[0]}</b>
            <div className="note">{staff.split("|")[1]}</div>
          </>
        ) : (
          <span className="note">–</span>
        )}
      </td>
      {input("bank", "w-bank")}
      {input("account", "w-acc")}
      {input("name", "w-name")}
      <td>
        <span className={`pill ${shownStatus}`}>{STATUS_LABEL[shownStatus]}</span>
        {warning && <span className="pill error">Trùng STK</span>}
        {near && <span className="pill review">Nghi đọc nhầm</span>}
        {check && (
          <div className={`note ${check.startsWith("near|") ? "warn-orange" : check.startsWith("match|") ? "ok-text" : "info"}`}>
            {check.split("|")[1]}
          </div>
        )}
        {warning &&
          warning.split("\n").map((w) => (
            <div key={w} className="note warn">
              {w}
            </div>
          ))}
        {r.note && <div className="note">{r.note}</div>}
      </td>
      <td className="acts">
        {!example && shownStatus === "review" && (
          <button
            className="btn sm"
            onClick={() => onUpdate(r.id, { status: "ok", note: r.note ? `Đã kiểm tra · ${r.note}` : "Đã kiểm tra" })}
          >
            Đã kiểm tra
          </button>
        )}
        {!example && (
          <button className="btn sm" disabled={running} onClick={() => onReread(r)}>
            Đọc lại
          </button>
        )}
      </td>
    </tr>
  );
});

function validate(f: BankFields): string[] {
  const issues: string[] = [];
  if (!f.bank) issues.push("Thiếu ngân hàng");
  if (!f.account) issues.push("Thiếu số tài khoản");
  else if (f.account.length < 6 || f.account.length > 19) issues.push(`STK ${f.account.length} chữ số - bất thường`);
  if (!f.name) issues.push("Thiếu tên người nhận");
  return issues;
}
