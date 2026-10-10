"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Scheduler } from "tesseract.js";
import { IMAGE_EXTENSIONS, parseFileName } from "@/lib/filename";
import { normalizeBankName } from "@/lib/banks";
import { parseOcrText, type BankFields } from "@/lib/parseText";
import { digitsOnly, looseKey } from "@/lib/text";
import { fileToBase64ForApi, fileToCanvasForTesseract } from "@/lib/image";
import { exportToExcel } from "@/lib/excel";

type Engine = "both" | "claude" | "tesseract";
type Status = "pending" | "processing" | "ok" | "review" | "error";

interface Row extends BankFields {
  id: string;
  file: File;
  url: string;
  fileName: string;
  customerCode: string;
  businessName: string;
  status: Status;
  note: string;
}

const STATUS_LABEL: Record<Status, string> = {
  pending: "Chờ",
  processing: "Đang đọc…",
  ok: "OK",
  review: "Cần kiểm tra",
  error: "Lỗi",
};

const CLAUDE_CONCURRENCY = 3;

interface ClaudeResult {
  bank_raw: string;
  bank_code: string;
  account_number: string;
  recipient_name: string;
  uncertain: boolean;
  note?: string;
}

const PASSWORD_KEY = "ocr-app-password";

async function readWithClaude(file: File, password: string): Promise<ClaudeResult> {
  const payload = await fileToBase64ForApi(file);
  const res = await fetch("/api/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-password": password },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as ClaudeResult;
}

export default function Home() {
  const [rows, setRows] = useState<Row[]>([]);
  const [engine, setEngine] = useState<Engine>("both");
  const [running, setRunning] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);
  const [preview, setPreview] = useState<Row | null>(null);
  const [folderName, setFolderName] = useState("");
  const [server, setServer] = useState<{ hasKey: boolean; needPassword: boolean } | null>(null);
  const [password, setPassword] = useState("");
  const stopRef = useRef(false);

  useEffect(() => {
    try {
      setPassword(localStorage.getItem(PASSWORD_KEY) || "");
    } catch {}
    fetch("/api/ocr")
      .then((r) => r.json())
      .then((info) => {
        setServer(info);
        if (!info.hasKey) setEngine("tesseract");
      })
      .catch(() => setServer(null));
  }, []);

  function onPasswordChange(value: string) {
    setPassword(value);
    try {
      localStorage.setItem(PASSWORD_KEY, value);
    } catch {}
  }
  const schedulerRef = useRef<Scheduler | null>(null);

  const update = (id: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).filter((f) => IMAGE_EXTENSIONS.test(f.name));
    rows.forEach((r) => URL.revokeObjectURL(r.url));
    files.sort((a, b) => a.name.localeCompare(b.name, "vi", { numeric: true }));
    const first = (files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath || "";
    setFolderName(first.split("/")[0] || "");
    setRows(
      files.map((file, i) => {
        const { customerCode, businessName } = parseFileName(file.name);
        return {
          id: `${i}-${file.name}`,
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
    e.target.value = "";
  }

  async function getScheduler() {
    if (schedulerRef.current) return schedulerRef.current;
    const { createScheduler, createWorker } = await import("tesseract.js");
    const scheduler = createScheduler();
    const workers = await Promise.all([createWorker(["vie", "eng"]), createWorker(["vie", "eng"])]);
    workers.forEach((w) => scheduler.addWorker(w));
    schedulerRef.current = scheduler;
    return scheduler;
  }

  async function readWithTesseract(file: File): Promise<BankFields> {
    const scheduler = await getScheduler();
    const canvas = await fileToCanvasForTesseract(file);
    const { data } = await scheduler.addJob("recognize", canvas);
    return parseOcrText(data.text);
  }

  async function processRow(row: Row) {
    update(row.id, { status: "processing", note: "" });
    try {
      if (engine === "tesseract") {
        const t = await readWithTesseract(row.file);
        const issues = validate(t);
        update(row.id, {
          ...t,
          bank: normalizeBankName(t.bank),
          // Tesseract hay nhầm 3/5, 6/8... nên luôn cần người kiểm tra
          status: "review",
          note: ["Chỉ đọc bằng Tesseract - đối chiếu với ảnh rồi bấm ✓", ...issues].join("; "),
        });
        return;
      }

      const [c, t] = await Promise.all([
        readWithClaude(row.file, password),
        engine === "both" ? readWithTesseract(row.file).catch(() => null) : Promise.resolve(null),
      ]);
      const result: BankFields = {
        bank: normalizeBankName(c.bank_raw, c.bank_code),
        account: digitsOnly(c.account_number),
        name: c.recipient_name.replace(/\s+/g, " ").trim(),
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
      update(row.id, {
        ...result,
        status: issues.length ? "review" : "ok",
        note: issues.length ? issues.join("; ") : note,
      });
    } catch (err) {
      update(row.id, { status: "error", note: err instanceof Error ? err.message : String(err) });
    }
  }

  async function run(targets: Row[]) {
    if (!targets.length) return;
    stopRef.current = false;
    setRunning(true);
    const queue = [...targets];
    const concurrency = engine === "tesseract" ? 2 : CLAUDE_CONCURRENCY;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (queue.length && !stopRef.current) {
          await processRow(queue.shift()!);
        }
      }),
    );
    setRunning(false);
  }

  const stats = useMemo(() => {
    const s = { total: rows.length, done: 0, ok: 0, review: 0, error: 0 };
    rows.forEach((r) => {
      if (r.status === "ok" || r.status === "review" || r.status === "error") s.done++;
      if (r.status === "ok") s.ok++;
      if (r.status === "review") s.review++;
      if (r.status === "error") s.error++;
    });
    return s;
  }, [rows]);

  const visible = onlyReview ? rows.filter((r) => r.status === "review" || r.status === "error") : rows;

  function onExport() {
    const name = folderName ? `thong-tin-ngan-hang_${folderName}.xlsx` : "thong-tin-ngan-hang.xlsx";
    exportToExcel(
      rows.map((r) => ({
        customerCode: r.customerCode,
        businessName: r.businessName,
        bank: r.bank,
        account: r.account,
        name: r.name,
        fileName: r.fileName,
        note: r.status === "ok" ? "" : r.note || STATUS_LABEL[r.status],
      })),
      name,
    );
  }

  return (
    <main>
      <header>
        <h1>OCR Thông tin ngân hàng → Excel</h1>
        <p className="muted">
          Chọn thư mục chứa ảnh (.jpg, .png) có tên dạng <code>0573.00028_TÊN CSKD.JPG</code>. Ảnh được đọc
          lần lượt, kết quả hiển thị bên dưới, có thể sửa trực tiếp trước khi xuất Excel.
        </p>
      </header>

      {server && !server.hasKey && (
        <p className="alert">
          Máy chủ chưa có <code>ANTHROPIC_API_KEY</code> nên chỉ đọc được bằng Tesseract (kém chính xác hơn). Thêm key
          vào <code>.env.local</code> hoặc Environment Variables trên Vercel rồi chạy lại / Redeploy.
        </p>
      )}

      <section className="toolbar">
        <label className="btn primary">
          📁 Chọn thư mục
          <input
            type="file"
            multiple
            hidden
            onChange={onPickFolder}
            disabled={running}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
        </label>

        <select value={engine} onChange={(e) => setEngine(e.target.value as Engine)} disabled={running}>
          <option value="both" disabled={server?.hasKey === false}>
            Claude AI + Tesseract kiểm tra chéo (khuyên dùng)
          </option>
          <option value="claude" disabled={server?.hasKey === false}>
            Chỉ Claude AI
          </option>
          <option value="tesseract">Chỉ Tesseract (offline, miễn phí)</option>
        </select>

        {server?.needPassword && engine !== "tesseract" && (
          <input
            type="password"
            className="password"
            placeholder="Mật khẩu truy cập"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            disabled={running}
          />
        )}

        {!running ? (
          <>
            <button
              className="btn primary"
              disabled={!rows.length}
              onClick={() => run(rows.filter((r) => r.status === "pending" || r.status === "error"))}
            >
              ▶ Bắt đầu đọc
            </button>
            <button className="btn" disabled={!rows.length} onClick={() => run(rows)}>
              ↻ Đọc lại tất cả
            </button>
          </>
        ) : (
          <button className="btn danger" onClick={() => (stopRef.current = true)}>
            ■ Dừng
          </button>
        )}

        <button className="btn success" disabled={!stats.done || running} onClick={onExport}>
          ⬇ Xuất Excel
        </button>
      </section>

      {rows.length > 0 && (
        <section className="stats">
          <span>
            {folderName && <b>{folderName}</b>} · {stats.done}/{stats.total} ảnh
          </span>
          <span className="badge ok">OK: {stats.ok}</span>
          <span className="badge review">Cần kiểm tra: {stats.review}</span>
          <span className="badge error">Lỗi: {stats.error}</span>
          <label className="check">
            <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
            Chỉ hiện dòng cần kiểm tra
          </label>
          <div className="progress">
            <div style={{ width: `${(stats.done / stats.total) * 100}%` }} />
          </div>
        </section>
      )}

      {rows.length > 0 && (
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
                <tr key={r.id} className={r.status}>
                  <td>{rows.indexOf(r) + 1}</td>
                  <td>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.url} alt={r.fileName} className="thumb" onClick={() => setPreview(r)} />
                  </td>
                  <td>
                    <input value={r.customerCode} onChange={(e) => update(r.id, { customerCode: e.target.value })} />
                  </td>
                  <td>
                    <input
                      className="wide"
                      value={r.businessName}
                      onChange={(e) => update(r.id, { businessName: e.target.value })}
                    />
                  </td>
                  <td>
                    <input className="wide" value={r.bank} onChange={(e) => update(r.id, { bank: e.target.value })} />
                  </td>
                  <td>
                    <input
                      className="mono"
                      value={r.account}
                      onChange={(e) => update(r.id, { account: digitsOnly(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input className="wide" value={r.name} onChange={(e) => update(r.id, { name: e.target.value })} />
                  </td>
                  <td>
                    <span className={`badge ${r.status}`}>{STATUS_LABEL[r.status]}</span>
                    {r.note && <div className="note">{r.note}</div>}
                  </td>
                  <td className="actions">
                    {r.status === "review" && (
                      <button className="btn small" onClick={() => update(r.id, { status: "ok" })} title="Đã kiểm tra">
                        ✓
                      </button>
                    )}
                    <button
                      className="btn small"
                      disabled={running}
                      onClick={() => run([r])}
                      title="Đọc lại ảnh này"
                    >
                      ↻
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <div className="modal" onClick={() => setPreview(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview.url} alt={preview.fileName} />
          <p>{preview.fileName}</p>
        </div>
      )}
    </main>
  );
}

function validate(f: BankFields): string[] {
  const issues: string[] = [];
  if (!f.bank) issues.push("Thiếu ngân hàng");
  if (!f.account) issues.push("Thiếu số tài khoản");
  else if (f.account.length < 6 || f.account.length > 19) issues.push(`STK ${f.account.length} chữ số - bất thường`);
  if (!f.name) issues.push("Thiếu tên người nhận");
  return issues;
}
