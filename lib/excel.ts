import ExcelJS from "exceljs";

export interface ExportRow {
  customerCode: string;
  businessName: string;
  bank: string;
  account: string;
  name: string;
  fileName: string;
  note: string;
}

export async function exportToExcel(rows: ExportRow[], fileName = "thong-tin-ngan-hang.xlsx") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Thông tin ngân hàng");
  ws.columns = [
    { header: "STT", key: "stt", width: 6 },
    { header: "Mã số KH", key: "customerCode", width: 14 },
    { header: "Tên CSKD", key: "businessName", width: 45 },
    { header: "Ngân hàng nhận", key: "bank", width: 55 },
    { header: "Tài khoản/thẻ nhận", key: "account", width: 22 },
    { header: "Tên người nhận", key: "name", width: 35 },
    { header: "Tên file", key: "fileName", width: 45 },
    { header: "Ghi chú", key: "note", width: 35 },
  ];
  rows.forEach((r, i) => ws.addRow({ stt: i + 1, ...r }));

  // Số tài khoản & mã KH lưu dạng chữ để không mất số 0 ở đầu / không bị dạng 4.7E+12
  ws.getColumn("account").numFmt = "@";
  ws.getColumn("customerCode").numFmt = "@";

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.height = 24;
  header.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B6E4F" } };
  });
  ws.eachRow((row) =>
    row.eachCell((c) => {
      c.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    }),
  );
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: "A1", to: "H1" };

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
