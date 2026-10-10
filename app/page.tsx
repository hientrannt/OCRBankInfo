"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Scheduler } from "tesseract.js";
import { IMAGE_EXTENSIONS, parseFileName } from "@/lib/filename";
import { normalizeBankName } from "@/lib/banks";
import { parseOcrText, type BankFields } from "@/lib/parseText";
import { digitsOnly, looseKey } from "@/lib/text";
import { fileToBase64ForApi, fileToCanvasForTesseract, fileToThumbBlob } from "@/lib/image";
import { getAllHistory, historyKey, type HistoryRecord } from "@/lib/history";
import { createSharedStore, localStore, type HistoryStore, type StoreKind } from "@/lib/historyStore";
import { makeBackup, parseBackup } from "@/lib/backup";
import { importExcel } from "@/lib/excelImport";
import { findDuplicateAccounts } from "@/lib/duplicates";
import HistoryTab from "@/components/HistoryTab";
import { exportToExcel } from "@/lib/excel";
import { FatalOcrError, postOcr } from "@/lib/ocrClient";

type Engine = "both" | "ai" | "tesseract";
type Provider = "claude" | "gemini";
type Tab = "read" | "history" | "settings";

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
const STORE_KEY = "ocr-history-store";
const HEAD = ["STT", "Mã số KH", "Tên CSKD", "Ngân hàng nhận", "Tài khoản/thẻ nhận", "Tên người nhận", "Tên file", "Ghi chú"];

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
  const [tab, setTab] = useState<Tab>("read");
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [storeKind, setStoreKind] = useState<StoreKind>("local");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const passwordRef = useRef("");
  passwordRef.current = password;
  const store: HistoryStore = useMemo(
    () =>
      storeKind === "shared"
        ? createSharedStore(
            () => passwordRef.current,
            (e) => setHistoryError(`Chưa lưu được lên máy chủ: ${e.message}`),
          )
        : localStore,
    [storeKind],
  );
  const historyRef = useRef<HistoryRecord[]>([]);
  const [dup, setDup] = useState<DupPrompt | null>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [withImages, setWithImages] = useState(true);
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const stopRef = useRef(false);
  const schedulerRef = useRef<Promise<Scheduler> | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    try {
      setPassword(localStorage.getItem(PASSWORD_KEY) || "");
      const savedEngine = localStorage.getItem(ENGINE_KEY);
      if (savedEngine === "both" || savedEngine === "ai" || savedEngine === "tesseract") setEngine(savedEngine);
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (saved) setAi({ ...DEFAULT_SETTINGS, ...saved, keys: { ...DEFAULT_SETTINGS.keys, ...saved.keys }, models: { ...DEFAULT_SETTINGS.models, ...saved.models } });
      if (localStorage.getItem(STORE_KEY) === "shared") setStoreKind("shared");
    } catch {}
    fetch("/api/ocr")
      .then((r) => r.json())
      .then((info: ServerInfo) => setServer(info))
      .catch(() => setServer(null));
  }, []);

  // Nạp lịch sử từ nơi lưu đang chọn (trình duyệt hoặc máy chủ); đổi nơi lưu / mật khẩu thì nạp lại
  const reloadHistory = useCallback(async () => {
    setHistoryLoaded(false);
    try {
      setHistory(await store.getAll());
      setHistoryError("");
    } catch (err) {
      setHistory([]);
      setHistoryError(
        store.kind === "shared"
          ? `Lịch sử dùng chung: ${err instanceof Error ? err.message : err}`
          : "Trình duyệt không cho lưu lịch sử (có thể đang ở chế độ ẩn danh). Kết quả sẽ không được nhớ.",
      );
    } finally {
      setHistoryLoaded(true);
    }
  }, [store]);
  useEffect(() => {
    void reloadHistory();
  }, [reloadHistory]);
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
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

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
  const userKey = ai.keys[provider].trim();
  const serverHasKey = (info: ServerInfo | null, p: Provider) =>
    Boolean(info?.serverKeys ? info.serverKeys[p] : p === "claude" && info?.hasKey);
  const aiReady = Boolean(userKey) || serverHasKey(server, provider);
  const usingServerKey = !userKey && serverHasKey(server, provider);
  const engineShown: Engine = aiReady ? selectedEngine : "tesseract";
  const aiName = provider === "gemini" ? "Gemini" : "Claude";

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

  /** Lưu dòng vào lịch sử (chỉ dòng đọc xong: OK hoặc Cần kiểm tra) */
  async function persist(row: Row, engineLabel: string | null, withThumb: boolean) {
    if (row.status !== "ok" && row.status !== "review") return;
    const prev = history.find((h) => h.fileName === row.fileName);
    let thumb: Blob | undefined;
    if (withThumb && row.file) thumb = await fileToThumbBlob(row.file).catch(() => undefined);
    const rec: HistoryRecord = {
      fileName: row.fileName,
      customerCode: row.customerCode,
      businessName: row.businessName,
      bank: row.bank,
      account: row.account,
      name: row.name,
      status: row.status,
      note: row.note.replace(/^Đã có từ [^·]*(· )?/, ""),
      engine: engineLabel ?? prev?.engine ?? "",
      size: row.file?.size ?? prev?.size ?? 0,
      readAt: engineLabel ? Date.now() : (prev?.readAt ?? Date.now()),
      thumb,
    };
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

  function getScheduler(): Promise<Scheduler> {
    // Giữ một lời hứa duy nhất để các luồng song song không tạo trùng worker
    if (!schedulerRef.current) {
      schedulerRef.current = (async () => {
        const { createScheduler, createWorker } = await import("tesseract.js");
        const scheduler = createScheduler();
        const workers = await Promise.all(
          Array.from({ length: TESSERACT_WORKERS }, () => createWorker(["vie", "eng"])),
        );
        workers.forEach((w) => scheduler.addWorker(w));
        return scheduler;
      })();
      schedulerRef.current.catch(() => (schedulerRef.current = null));
    }
    return schedulerRef.current;
  }

  async function readWithTesseract(file: File): Promise<BankFields> {
    const scheduler = await getScheduler();
    const canvas = await fileToCanvasForTesseract(file);
    const { data } = await scheduler.addJob("recognize", canvas);
    canvas.width = canvas.height = 0; // giải phóng bộ nhớ canvas ngay
    return parseOcrText(data.text);
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

    const [c, t] = await Promise.all([
      fileToBase64ForApi(file).then((payload) =>
        postOcr(
          { ...payload, provider, model: ai.models[provider].trim() || undefined },
          { password, apiKey: userKey || undefined, shouldStop: () => stopRef.current },
        ),
      ),
      engine === "both" ? readWithTesseract(file).catch(() => null) : Promise.resolve(null),
    ]);
    const result: BankFields = {
      bank: normalizeBankName(String(c.bank_raw ?? ""), String(c.bank_code ?? "")),
      account: digitsOnly(String(c.account_number ?? "")),
      name: String(c.recipient_name ?? "").replace(/\s+/g, " ").trim(),
    };
    const issues = validate(result);
    if (c.uncertain) issues.push(c.note ? `${aiName} không chắc chắn: ${c.note}` : `${aiName} không chắc chắn`);
    let note = "";
    if (t) {
      const diffs: string[] = [];
      if (t.account !== result.account) diffs.push(`STK Tesseract: ${t.account || "(trống)"}`);
      if (looseKey(t.name) !== looseKey(result.name)) diffs.push(`Tên Tesseract: ${t.name || "(trống)"}`);
      if (diffs.length) issues.push(...diffs);
      else note = "Khớp 2 engine";
    }
    const patch: Partial<Row> = {
      ...result,
      status: issues.length ? "review" : "ok",
      note: issues.length ? issues.join("; ") : note,
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
      if (r.status === "ok" || r.status === "review" || r.status === "error") s.done++;
      if (r.status === "ok") s.ok++;
      if (r.status === "review") s.review++;
      if (r.status === "error") s.error++;
    });
    return s;
  }, [rows]);

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
    ? rows.filter((r) => r.status === "review" || r.status === "error" || rowWarnings.has(r.fileName))
    : rows;

  function noteFor(r: Row) {
    const base = r.status === "ok" ? (r.note.startsWith("Đã kiểm tra") ? "Đã kiểm tra" : "") : r.note || STATUS_LABEL[r.status];
    return [...(rowWarnings.get(r.fileName) ?? []), base].filter(Boolean).join("; ");
  }

  async function onExport() {
    const list = realRows;
    setExporting({ done: 0, total: list.length });
    try {
      await exportToExcel(
        list.map((r) => ({
          customerCode: r.customerCode,
          businessName: r.businessName,
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

      {historyError && <div className="notice">{historyError}</div>}
      {message && <div className="notice">{message}</div>}

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
              Trình duyệt này
            </label>
            <label className="radio">
              <input
                type="radio"
                name="store"
                checked={storeKind === "shared"}
                disabled={busy}
                onChange={() => changeStore("shared")}
              />
              Máy chủ (dùng chung nhiều máy / nhiều người)
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
                  Chuyển lịch sử từ trình duyệt lên máy chủ
                </button>
              </>
            )}
            <span className="hint full">
              {storeKind === "shared"
                ? "Lịch sử nằm trên máy chủ (Vercel Blob, riêng tư), ai có mật khẩu truy cập đều thấy. Nhập mật khẩu ở trên rồi bấm Kết nối lại."
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
            <label className="check">
              <input type="checkbox" checked={withImages} onChange={(e) => setWithImages(e.target.checked)} disabled={busy} />
              Kèm ảnh
            </label>
            <button className="btn primary" disabled={busy || !stats.done} onClick={onExport}>
              {exporting ? `Đang tạo Excel ${exporting.done}/${exporting.total}…` : "Xuất Excel"}
            </button>
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

      {tab === "history" && (
        <HistoryTab
          records={history}
          busy={busy || !historyLoaded}
          storeLabel={storeKind === "shared" ? "Máy chủ (dùng chung)" : "Trình duyệt này"}
          warnings={historyWarnings}
          loadThumb={store.loadThumb}
          onDelete={async (names) => {
            try {
              await store.remove(names);
              setHistory((list) => list.filter((h) => !names.includes(h.fileName)));
            } catch (err) {
              setMessage(`Không xóa được: ${err instanceof Error ? err.message : err}`);
            }
          }}
          onClear={async () => {
            try {
              await store.clear();
              setHistory([]);
            } catch (err) {
              setMessage(`Không xóa được: ${err instanceof Error ? err.message : err}`);
            }
          }}
          onExport={exportHistory}
          onBackup={onBackup}
          onRestore={onRestore}
          onImportExcel={onImportExcel}
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
  onUpdate,
  onPreview,
  onReread,
}: {
  row: Row;
  index: number;
  running: boolean;
  /** Cảnh báo trùng STK, mỗi dòng một cảnh báo (chuỗi để memo so sánh được) */
  warning: string;
  onUpdate: (id: string, patch: Partial<Row>) => void;
  onPreview: (r: Row) => void;
  onReread: (r: Row) => void;
}) {
  const example = r.status === "example";
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
    <tr className={warning && r.status !== "error" ? "error" : r.status}>
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
      {input("bank", "w-bank")}
      {input("account", "w-acc")}
      {input("name", "w-name")}
      <td>
        <span className={`pill ${r.status}`}>{STATUS_LABEL[r.status]}</span>
        {warning && <span className="pill error">Trùng STK</span>}
        {warning &&
          warning.split("\n").map((w) => (
            <div key={w} className="note warn">
              {w}
            </div>
          ))}
        {r.note && <div className="note">{r.note}</div>}
      </td>
      <td className="acts">
        {!example && r.status === "review" && (
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
