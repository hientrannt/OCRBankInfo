"use client";

import { useMemo, useRef, useState } from "react";
import type { HskhData } from "@/lib/hskh";
import { looseKey } from "@/lib/text";

const PAGE_SIZE = 100;
const fmtTime = (t: number) => new Date(t).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });

export default function HskhTab({
  hskh,
  busy,
  storeLabel,
  unmatched,
  onUpload,
  onClear,
}: {
  hskh: HskhData | null;
  busy: boolean;
  storeLabel: string;
  /** Mã KH đang có trong bảng đọc ảnh / lịch sử mà HSKH không có */
  unmatched: string[];
  onUpload: (file: File) => void;
  onClear: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const list = useMemo(
    () => Object.entries(hskh?.entries ?? {}).map(([code, e]) => ({ code, ...e })),
    [hskh],
  );
  const staff = useMemo(() => {
    const m = new Map<string, { msnv: string; nvbh: string; n: number }>();
    for (const e of list) {
      const k = `${e.msnv}|${e.nvbh}`;
      m.set(k, { msnv: e.msnv, nvbh: e.nvbh, n: (m.get(k)?.n ?? 0) + 1 });
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [list]);
  const filtered = useMemo(() => {
    const q = looseKey(query);
    return q ? list.filter((e) => looseKey(`${e.code} ${e.msnv} ${e.nvbh} ${e.account ?? ""}`).includes(q)) : list;
  }, [list, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);

  return (
    <>
      <section className="panel">
        <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {hskh ? "Tải lên file HSKH mới (thay thế)" : "Tải lên file HSKH"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onUpload(f);
          }}
        />
        {hskh ? (
          <span className="hint">
            Đang dùng <b>{hskh.fileName}</b> · {hskh.count} khách hàng · {staff.length} nhân viên · cập nhật{" "}
            {fmtTime(hskh.importedAt)} · lưu: {storeLabel}
          </span>
        ) : (
          <span className="hint">Chưa có HSKH. Tải file Excel hồ sơ khách hàng để dò MSNV theo Mã số KH.</span>
        )}
        <span className="spacer" />
        {hskh && (
          <button
            className="btn danger-outline"
            disabled={busy}
            onClick={() => window.confirm("Bỏ file HSKH đang dùng? Cột MSNV sẽ trống cho tới khi tải file mới.") && onClear()}
          >
            Bỏ HSKH
          </button>
        )}
      </section>

      <section className="panel tips">
        <span className="hint">
          App lấy cột <b>Số</b> (mã KH, vd 0573/00028), <b>Nhân Viên Bán</b> (MSNV), <b>Tên NVBH</b> và{" "}
          <b>Số Tài Khoản Khách hàng</b> / <b>Tên Chủ TK</b> / <b>Tên Ngân hàng</b> (để đối chiếu STK đọc từ ảnh: lệch 1-2
          chữ số thì báo nghi đọc nhầm). File được đọc ngay trên trình duyệt; số điện thoại, CCCD, địa chỉ… không được lưu
          hay gửi đi. Mỗi lần HSKH thay đổi, tải file mới lên để dò cho đúng.
        </span>
      </section>

      {hskh && unmatched.length > 0 && (
        <div className="notice">
          {unmatched.length} mã KH đang đọc/trong lịch sử không có trong HSKH: {unmatched.slice(0, 20).join(", ")}
          {unmatched.length > 20 ? ` và ${unmatched.length - 20} mã khác` : ""}.
        </div>
      )}

      {hskh && (
        <>
          <section className="panel">
            <input
              className="text-input search"
              placeholder="Tìm theo mã KH, MSNV hoặc tên nhân viên…"
              aria-label="Tìm trong HSKH"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            <span className="hint">{filtered.length} dòng</span>
          </section>
          <div className="hskh-grid">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Mã số KH</th>
                    <th>MSNV</th>
                    <th>Tên NVBH</th>
                    <th>STK trong HSKH</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((e) => (
                    <tr key={e.code}>
                      <td className="mono">{e.code}</td>
                      <td className="mono">{e.msnv}</td>
                      <td>{e.nvbh}</td>
                      <td className="mono">
                        {e.account || "–"}
                        {e.bank && <div className="note">{e.bank}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>MSNV</th>
                    <th>Nhân viên bán hàng</th>
                    <th>Số KH</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((s) => (
                    <tr key={`${s.msnv}|${s.nvbh}`} className="clickable" onClick={() => setQuery(s.msnv)}>
                      <td className="mono">{s.msnv}</td>
                      <td>{s.nvbh}</td>
                      <td className="mono">{s.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {pages > 1 && (
            <div className="pager">
              <button className="btn sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
                ‹ Trước
              </button>
              <span>
                Trang {current + 1}/{pages}
              </span>
              <button className="btn sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                Sau ›
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
