"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Scheduler } from "tesseract.js";
import { IMAGE_EXTENSIONS, parseFileName } from "@/lib/filename";
import { normalizeBankName } from "@/lib/banks";
import { parseOcrText, type BankFields } from "@/lib/parseText";
import { digitsOnly, looseKey } from "@/lib/text";
import { fileToBase64ForApi, fileToCanvasForTesseract } from "@/lib/image";
import { exportToExcel } from "@/lib/excel";
import { FatalOcrError, postOcr } from "@/lib/ocrClient";

type Engine = "both" | "claude" | "tesseract";
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

type ServerInfo = { hasKey: boolean; needPassword: boolean };

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
    } catch {}
    fetch("/api/ocr")
      .then((r) => r.json())
      .then((info: ServerInfo) => {
        setServer(info);
        if (!info.hasKey) setEngine("tesseract");
      })
      .catch(() => setServer(null));
  }, []);

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

  function setFiles(all: File[], folder: string) {
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
    rowsRef.current.forEach((r) => r.url && URL.revokeObjectURL(r.url));
    files.sort((a, b) => a.name.localeCompare(b.name, "vi", { numeric: true }));
    setFolderName(folder);
    setMessage(skipped ? `Đã bỏ qua ${skipped} file không phải ảnh .jpg/.png.` : "");
    setRows(
      files.map((file, i) => {
        const { customerCode, businessName } = parseFileName(file.name);
        return {
          id: `r${i}`,
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
      }),
    );
  }

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
      update(row.id, {
        ...t,
        bank: normalizeBankName(t.bank),
        // Tesseract hay nhầm 3/5, 6/8... nên luôn cần người kiểm tra
        status: "review",
        note: ["Chỉ đọc bằng Tesseract - đối chiếu với ảnh rồi bấm Đã kiểm tra", ...validate(t)].join("; "),
      });
      return;
    }

    const [c, t] = await Promise.all([
      fileToBase64ForApi(file).then((payload) =>
        postOcr(payload, { password, shouldStop: () => stopRef.current }),
      ),
      engine === "both" ? readWithTesseract(file).catch(() => null) : Promise.resolve(null),
    ]);
    const result: BankFields = {
      bank: normalizeBankName(String(c.bank_raw ?? ""), String(c.bank_code ?? "")),
      account: digitsOnly(String(c.account_number ?? "")),
      name: String(c.recipient_name ?? "").replace(/\s+/g, " ").trim(),
    };
    const issues = validate(result);
    if (c.uncertain) issues.push(c.note ? `AI không chắc chắn: ${c.note}` : "AI không chắc chắn");
    let note = "";
    if (t) {
      const diffs: string[] = [];
      if (t.account !== result.account) diffs.push(`STK Tesseract: ${t.account || "(trống)"}`);
      if (looseKey(t.name) !== looseKey(result.name)) diffs.push(`Tên Tesseract: ${t.name || "(trống)"}`);
      if (diffs.length) issues.push(...diffs);
      else note = "Khớp 2 engine";
    }
    update(row.id, { ...result, status: issues.length ? "review" : "ok", note: issues.length ? issues.join("; ") : note });
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
    const engine: Engine = info && !info.hasKey ? "tesseract" : selectedEngine;
    if (engine !== "tesseract" && info?.needPassword && !password) {
      setMessage("Nhập mật khẩu truy cập trước khi đọc bằng Claude.");
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
  const visible = onlyReview ? rows.filter((r) => r.status === "review" || r.status === "error") : rows;

  function noteFor(r: Row) {
    return r.status === "ok" ? (r.note.startsWith("Đã kiểm tra") ? "Đã kiểm tra" : "") : r.note || STATUS_LABEL[r.status];
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
          file: r.file ?? undefined,
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
    [server, selectedEngine, password]);
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

      {server && !server.hasKey && (
        <div className="notice">
          Máy chủ chưa có <code>ANTHROPIC_API_KEY</code> nên chỉ đọc được bằng Tesseract (kém chính xác hơn). Thêm
          key trong Vercel → Settings → Environment Variables rồi Redeploy.
        </div>
      )}

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
          <select value={selectedEngine} onChange={(e) => setEngine(e.target.value as Engine)} disabled={busy}>
            <option value="both" disabled={server?.hasKey === false}>
              Claude AI + Tesseract kiểm tra chéo (khuyên dùng)
            </option>
            <option value="claude" disabled={server?.hasKey === false}>
              Chỉ Claude AI (nhanh hơn)
            </option>
            <option value="tesseract">Chỉ Tesseract (miễn phí, kém chính xác)</option>
          </select>
        </label>
        {server?.needPassword && selectedEngine !== "tesseract" && (
          <input
            type="password"
            className="password"
            placeholder="Mật khẩu truy cập"
            aria-label="Mật khẩu truy cập"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            disabled={busy}
          />
        )}
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
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
          Chỉ hiện dòng cần kiểm tra
        </label>
        <div className="bar">
          <div style={{ width: stats.total ? `${(stats.done / stats.total) * 100}%` : 0 }} />
        </div>
      </section>

      {message && <div className="notice">{message}</div>}

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
                onUpdate={update}
                onPreview={setPreview}
                onReread={reread}
              />
            ))}
          </tbody>
        </table>
      </div>

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
  onUpdate,
  onPreview,
  onReread,
}: {
  row: Row;
  index: number;
  running: boolean;
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
    <tr className={r.status}>
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
