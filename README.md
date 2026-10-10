# OCR Thông tin ngân hàng → Excel

Ứng dụng web (Next.js) đọc ảnh chụp màn hình **"Thông tin người nhận"** trong một thư mục
và xuất ra file Excel.

| Cột Excel | Lấy từ |
|---|---|
| Mã số KH | Phần trước dấu `_` trong tên file, `.` đổi thành `/` (`0573.00028` → `0573/00028`) |
| Tên CSKD | Phần sau dấu `_` trong tên file (bỏ đuôi `.JPG/.png`) |
| Ngân hàng nhận | Đọc từ ảnh (tên bị cắt `...` được khôi phục, vd `AGRIBANK - Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam`) |
| Tài khoản/thẻ nhận | Đọc từ ảnh, lưu dạng chữ (giữ số 0 đầu, không bị `4.7E+12`) |
| Tên người nhận | Đọc từ ảnh |
| Tên file, Ghi chú | Để đối chiếu |

## Cài đặt & chạy

Yêu cầu Node.js 20+.

```bash
npm install
cp .env.example .env.local     # rồi điền ANTHROPIC_API_KEY
npm run build && npm start     # mở http://localhost:3000
```

**Cách nhanh:** cài [Node.js](https://nodejs.org) rồi nhấp đúp `start-windows.bat` (Windows)
hoặc chạy `./start-mac-linux.sh` (macOS/Linux). Lần đầu script tạo `.env.local` để bạn điền API key,
lần sau tự cài đặt, build và mở trình duyệt.

(Chạy chế độ phát triển: `npm run dev`. Sau khi cập nhật code, xóa thư mục `.next` để script build lại.)

## Sử dụng

1. Bấm **📁 Chọn thư mục** → chọn thư mục chứa ảnh (Chrome / Edge / Firefox).
2. Chọn chế độ đọc:
   - **Claude AI + Tesseract kiểm tra chéo (khuyên dùng)**: Claude đọc ảnh, Tesseract đọc độc lập; nếu số tài khoản
     hoặc tên không khớp, dòng được đánh dấu **Cần kiểm tra**.
   - **Chỉ Claude AI**: nhanh hơn.
   - **Chỉ Tesseract**: chạy offline, miễn phí, nhưng hay nhầm số (3↔5, 6↔8) nên mọi dòng đều phải kiểm tra.
3. Bấm **▶ Bắt đầu đọc**. Bấm vào ảnh nhỏ để phóng to, sửa trực tiếp ô bị sai, bấm **✓** khi đã kiểm tra.
4. Bấm **⬇ Xuất Excel**.

## Về độ chính xác

Không công cụ OCR nào cam kết đúng 100%. Để đạt mức gần 100%, ứng dụng:

- dùng model AI đọc ảnh (Claude) với yêu cầu chép nguyên văn, đọc lại số tài khoản 2 lần;
- kiểm tra chéo với Tesseract và kiểm tra độ dài số tài khoản;
- đánh dấu mọi dòng nghi ngờ để người dùng xem lại ảnh trước khi xuất.

Chỉ cần rà các dòng **Cần kiểm tra** (tích "Chỉ hiện dòng cần kiểm tra").

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | API key Claude |
| `OCR_MODEL` | `claude-opus-5-5` | Đổi sang `claude-sonnet-5-5` để rẻ hơn |

Ảnh chỉ được gửi tới API Claude để đọc, không lưu trên máy chủ.

## Kiểm thử

```bash
npm test           # kiểm thử tách tên file / phân tích văn bản OCR
npm run typecheck
```
