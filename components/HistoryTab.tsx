"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryRecord } from "@/lib/history";
import { looseKey } from "@/lib/text";

const PAGE_SIZE = 100;

function fmtTime(t: number) {
  return new Date(t).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}

/** Ảnh thu nhỏ trong lịch sử (có sẵn hoặc tải từ máy chủ) -> URL tạm, thu hồi khi không còn hiển thị */
function Thumb({
  record,
  load,
  alt,
  onOpen,
}: {
  record: HistoryRecord;
  load: (r: HistoryRecord) => Promise<Blob | undefined>;
  alt: string;
  onOpen: (url: string) => void;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let u = "";
    let alive = true;
    load(record).then((blob) => {
      if (!alive || !blob) return;
      u = URL.createObjectURL(blob);
      setUrl(u);
    });
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [record, load]);
  if (!url) return <div className="thumb ph">ảnh</div>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className="thumb" loading="lazy" onClick={() => onOpen(url)} />;
}

export default function HistoryTab({
  records,
  busy,
  storeLabel,
  warnings,
  staffOf,
  loadThumb,
  onDelete,
  onClear,
  onExport,
  onBackup,
  onRestore,
  onImportExcel,
}: {
  records: HistoryRecord[];
  busy: boolean;
  storeLabel: string;
  warnings: Map<string, string[]>;
  staffOf: (customerCode: string) => { msnv: string; nvbh: string } | undefined;
  loadThumb: (r: HistoryRecord) => Promise<Blob | undefined>;
  onDelete: (fileNames: string[]) => void;
  onClear: () => void;
  onExport: (records: HistoryRecord[]) => void;
  onBackup: () => void;
  onRestore: (file: File) => void;
  onImportExcel: (file: File) => void;
}) {
  const [query, setQuery] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [onlyDup, setOnlyDup] = useState(false);
  const restoreRef = useRef<HTMLInputElement>(null);
  const excelRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);

  const filtered = useMemo(() => {
    const q = looseKey(query);
    return records.filter(
      (r) =>
        (!onlyReview || r.status === "review") &&
        (!onlyDup || warnings.has(r.fileName)) &&
        (!q || looseKey(`${r.fileName} ${r.customerCode} ${r.businessName} ${r.account} ${r.name} ${r.bank}`).includes(q)),
    );
  }, [records, query, onlyReview, onlyDup, warnings]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const reviewCount = records.filter((r) => r.status === "review").length;
  const dupCount = records.filter((r) => warnings.has(r.fileName)).length;

  return (
    <>
      <section className="panel">
        <input
          className="text-input search"
          placeholder="Tìm theo mã KH, tên CSKD, số tài khoản, tên người nhận…"
          aria-label="Tìm trong lịch sử"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <label className="check">
          <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
          Chỉ dòng cần kiểm tra ({reviewCount})
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyDup} onChange={(e) => setOnlyDup(e.target.checked)} />
          Chỉ dòng trùng STK ({dupCount})
        </label>
        <span className="spacer" />
        <button className="btn primary" disabled={busy || !filtered.length} onClick={() => onExport(filtered)}>
          Xuất Excel {filtered.length !== records.length ? `(${filtered.length} dòng đang lọc)` : `(${records.length})`}
        </button>
        <button
          className="btn danger-outline"
          disabled={busy || !records.length}
          onClick={() => {
            if (window.confirm(`Xóa toàn bộ ${records.length} ảnh trong lịch sử? Lần sau chọn thư mục sẽ phải đọc lại.`))
              onClear();
          }}
        >
          Xóa toàn bộ
        </button>
      </section>

      <section className="panel">
        <span className="hint">
          Đang lưu: <b>{storeLabel}</b>
        </span>
        <span className="spacer" />
        <button className="btn" disabled={busy || !records.length} onClick={onBackup}>
          Sao lưu (tải file .json)
        </button>
        <button className="btn" disabled={busy} onClick={() => restoreRef.current?.click()}>
          Khôi phục từ file sao lưu
        </button>
        <button className="btn" disabled={busy} onClick={() => excelRef.current?.click()}>
          Nhập từ file Excel cũ
        </button>
        <input
          ref={restoreRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onRestore(f);
          }}
        />
        <input
          ref={excelRef}
          type="file"
          accept=".xlsx"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onImportExcel(f);
          }}
        />
      </section>

      {!records.length ? (
        <div className="empty">
          Chưa có lịch sử. Ảnh đọc xong ở tab <b>Đọc ảnh</b> sẽ được lưu tại đây (trên trình duyệt này) để lần sau
          không phải đọc lại.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ảnh</th>
                <th>Mã số KH</th>
                <th>Tên CSKD</th>
                <th>MSNV · NVBH</th>
                <th>Ngân hàng nhận</th>
                <th>Tài khoản/thẻ nhận</th>
                <th>Tên người nhận</th>
                <th>Trạng thái</th>
                <th>Đọc lúc</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.fileName} className={warnings.has(r.fileName) ? "dup" : r.status}>
                  <td>
                    <Thumb
                      record={r}
                      load={loadThumb}
                      alt={r.fileName}
                      onOpen={(url) => setPreview({ url, name: r.fileName })}
                    />
                  </td>
                  <td>{r.customerCode}</td>
                  <td className="cell-wide">{r.businessName}</td>
                  <td className="staff">
                    {staffOf(r.customerCode) ? (
                      <>
                        <b className="mono">{staffOf(r.customerCode)!.msnv}</b>
                        <div className="note">{staffOf(r.customerCode)!.nvbh}</div>
                      </>
                    ) : (
                      <span className="note">–</span>
                    )}
                  </td>
                  <td className="cell-wide">{r.bank}</td>
                  <td className="mono">{r.account}</td>
                  <td>{r.name}</td>
                  <td>
                    <span className={`pill ${r.status}`}>{r.status === "ok" ? "OK" : "Cần kiểm tra"}</span>
                    {warnings.has(r.fileName) && <span className="pill error">Trùng STK</span>}
                    {warnings.get(r.fileName)?.map((w) => (
                      <div key={w} className="note warn">
                        {w}
                      </div>
                    ))}
                    {r.note && <div className="note">{r.note}</div>}
                  </td>
                  <td className="nowrap">
                    {fmtTime(r.readAt)}
                    <div className="note">{r.engine}</div>
                  </td>
                  <td>
                    <button className="btn sm" disabled={busy} onClick={() => onDelete([r.fileName])}>
                      Xóa
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="pager">
          <button className="btn sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
            ‹ Trước
          </button>
          <span>
            Trang {current + 1}/{pages} · {filtered.length} dòng
          </span>
          <button className="btn sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            Sau ›
          </button>
        </div>
      )}

      {preview && (
        <div className="modal" onClick={() => setPreview(null)}>
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview.url} alt={preview.name} />
            <figcaption>{preview.name}</figcaption>
          </figure>
        </div>
      )}
    </>
  );
}
