import ExcelJS from "exceljs";
import { fileToThumbnail } from "./image.ts";

export interface ExportRow {
  customerCode: string;
  businessName: string;
  bank: string;
  account: string;
  name: string;
  fileName: string;
  note: string;
  /** MSNV và tên nhân viên bán hàng (dò từ HSKH) */
  msnv?: string;
  nvbh?: string;
  /** Dòng trùng số tài khoản: tô đỏ cả dòng */
  duplicate?: boolean;
  /** File gốc, ảnh thu nhỏ đã lưu, hoặc hàm tải ảnh khi cần (lịch sử trên máy chủ) */
  image?: Blob | (() => Promise<Blob | undefined>);
}

export interface ExportOptions {
  fileName?: string;
  /** Chèn ảnh đã đọc vào ô Excel (cột "Ảnh") */
  withImages?: boolean;
  onProgress?: (done: number, total: number) => void;
}

// Kích thước ô chứa ảnh. Excel: độ rộng cột tính theo ký tự (~7px/ký tự + 5px), chiều cao dòng theo point.
const IMAGE_COL_WIDTH = 32; // ký tự
const IMAGE_ROW_HEIGHT = 130; // point
const PAD = 4; // px, khoảng cách ảnh với mép ô
const EMU_PER_PX = 9525;
const colWidthPx = (chars: number) => Math.floor(chars * 7 + 5);
const rowHeightPx = (pt: number) => Math.floor((pt * 96) / 72);

export async function exportToExcel(rows: ExportRow[], opts: ExportOptions = {}) {
  const { fileName = "thong-tin-ngan-hang.xlsx", withImages = true, onProgress } = opts;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Thông tin ngân hàng");

  const columns: Partial<ExcelJS.Column>[] = [
    { header: "STT", key: "stt", width: 6 },
    ...(withImages ? [{ header: "Ảnh", key: "image", width: IMAGE_COL_WIDTH }] : []),
    { header: "Mã số KH", key: "customerCode", width: 14 },
    { header: "Tên CSKD", key: "businessName", width: 40 },
    { header: "MSNV", key: "msnv", width: 10 },
    { header: "Tên NVBH", key: "nvbh", width: 24 },
    { header: "Ngân hàng nhận", key: "bank", width: 50 },
    { header: "Tài khoản/thẻ nhận", key: "account", width: 22 },
    { header: "Tên người nhận", key: "name", width: 32 },
    { header: "Tên file", key: "fileName", width: 40 },
    { header: "Ghi chú", key: "note", width: 36 },
  ];
  ws.columns = columns;
  rows.forEach((r, i) => {
    const { image: _image, duplicate: _dup, ...data } = r;
    ws.addRow({ stt: i + 1, ...data, msnv: data.msnv ?? "", nvbh: data.nvbh ?? "" });
  });

  // Số tài khoản & mã KH lưu dạng chữ để không mất số 0 ở đầu / không bị dạng 4.7E+12
  ws.getColumn("account").numFmt = "@";
  ws.getColumn("customerCode").numFmt = "@";
  ws.getColumn("msnv").numFmt = "@";

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.height = 24;
  header.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0A6B4B" } };
  });
  ws.eachRow((row, n) => {
    // Dòng trùng số tài khoản: nền đỏ nhạt, chữ đỏ đậm
    const dup = n > 1 && rows[n - 2]?.duplicate;
    row.eachCell({ includeEmpty: true }, (c) => {
      c.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
      if (n > 1) c.alignment = { vertical: "middle", wrapText: true };
      if (dup) {
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
        c.font = { color: { argb: "FF9C0006" }, bold: c.col === row.getCell("note").col };
      }
    });
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  if (withImages) {
    const imageCol = 1; // cột B (đếm từ 0)
    const boxW = colWidthPx(IMAGE_COL_WIDTH) - PAD * 2;
    const boxH = rowHeightPx(IMAGE_ROW_HEIGHT) - PAD * 2;
    for (let i = 0; i < rows.length; i++) {
      const excelRow = ws.getRow(i + 2);
      excelRow.height = IMAGE_ROW_HEIGHT;
      const src = rows[i].image;
      const file = typeof src === "function" ? await src().catch(() => undefined) : src;
      if (file) {
        try {
          // Làm lần lượt từng ảnh để không giữ hàng nghìn ảnh lớn trong bộ nhớ cùng lúc
          const thumb = await fileToThumbnail(file, boxW, boxH);
          const id = wb.addImage({ base64: thumb.base64, extension: "jpeg" });
          const offX = PAD + Math.floor((boxW - thumb.width) / 2);
          const offY = PAD + Math.floor((boxH - thumb.height) / 2);
          ws.addImage(id, {
            tl: { nativeCol: imageCol, nativeColOff: offX * EMU_PER_PX, nativeRow: i + 1, nativeRowOff: offY * EMU_PER_PX },
            ext: { width: thumb.width, height: thumb.height },
            editAs: "oneCell",
          } as unknown as ExcelJS.ImageRange);
        } catch {
          excelRow.getCell(imageCol + 1).value = "(không đọc được ảnh)";
        }
      }
      onProgress?.(i + 1, rows.length);
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0)); // nhường cho giao diện cập nhật tiến độ
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
