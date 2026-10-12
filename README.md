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
| Ảnh | Ảnh đã đọc, thu nhỏ gọn trong ô (bỏ chọn "Kèm ảnh" nếu không cần) |
| Tên file, Ghi chú | Để đối chiếu |

## Đưa lên Vercel (link public)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhientrannt%2FOCRBankInfo&env=ANTHROPIC_API_KEY,APP_PASSWORD&envDescription=ANTHROPIC_API_KEY%3A%20API%20key%20Claude.%20APP_PASSWORD%3A%20m%E1%BA%ADt%20kh%E1%BA%A9u%20truy%20c%E1%BA%ADp%20%C4%91%E1%BB%83%20ng%C6%B0%E1%BB%9Di%20l%E1%BA%A1%20kh%C3%B4ng%20d%C3%B9ng%20%C4%91%C6%B0%E1%BB%A3c%20API%20key&project-name=ocr-bank-info&repository-name=ocr-bank-info)

Cách 1: bấm nút **Deploy with Vercel** ở trên. Cách 2 (giữ nguyên repo này, tự deploy lại mỗi khi có code mới):

1. Vào https://vercel.com/new, đăng nhập bằng GitHub, chọn **Import** repo `hientrannt/OCRBankInfo`
   (nếu không thấy repo: bấm *Adjust GitHub App Permissions* và cho Vercel quyền truy cập repo này).
2. Framework tự nhận là **Next.js**, giữ nguyên các thiết lập build.
3. Mở **Environment Variables**, thêm:
   - `ANTHROPIC_API_KEY` = API key Claude (lấy tại https://console.anthropic.com)
   - `APP_PASSWORD` = một mật khẩu bạn tự đặt (**bắt buộc nên có**: link public ai cũng mở được,
     không có mật khẩu thì người lạ có thể dùng API key của bạn)
   - (tuỳ chọn) `OCR_MODEL` = `claude-sonnet-5-5` để rẻ hơn
4. Bấm **Deploy**. Sau khoảng 1–2 phút bạn có link dạng `https://ocr-bank-info.vercel.app`.
5. Mở link, nhập mật khẩu ở ô **Mật khẩu truy cập** (trình duyệt sẽ nhớ), chọn thư mục ảnh và đọc như bình thường.

Đổi biến môi trường sau này: Vercel → Project → Settings → Environment Variables, rồi **Redeploy**.

## Cài đặt & chạy trên máy

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

## Các tab

- **Đọc ảnh**: chọn thư mục, đọc, sửa, xuất Excel.
- **Lịch sử**: mọi ảnh đã đọc xong (OK / Cần kiểm tra) được lưu trên trình duyệt này kèm ảnh thu nhỏ.
  Tìm theo mã KH, tên, số tài khoản; xuất Excel toàn bộ lịch sử (kèm ảnh); xóa từng dòng hoặc xóa hết.
- **Cài đặt AI**: chọn Claude / Gemini, nhập API key, model, mật khẩu truy cập.

## Ảnh đã đọc rồi thì bỏ qua

Khi chọn thư mục có ảnh **trùng tên file** với ảnh đã có trong lịch sử, app hỏi:

- **Không, bỏ qua ảnh đã có** → lấy lại dữ liệu cũ cho các ảnh đó (ghi chú "Đã có từ …") và chỉ đọc ảnh mới.
- **Có, đọc lại toàn bộ** → đọc lại tất cả và ghi đè lịch sử.
- **Hủy** → không làm gì.

Sửa tay trong bảng hoặc bấm "Đã kiểm tra" cũng được lưu vào lịch sử. Lịch sử nằm trong trình duyệt (IndexedDB):
dùng máy khác/trình duyệt khác hoặc xóa dữ liệu trình duyệt sẽ không còn. Ảnh lỗi không được lưu (lần sau sẽ đọc lại).

## Sao lưu, khôi phục, nhập từ Excel

Ở tab **Lịch sử**:

- **Sao lưu (tải file .json)**: toàn bộ lịch sử kèm ảnh thu nhỏ vào một file. Dùng để chuyển sang máy khác
  hoặc giữ phòng khi xóa dữ liệu trình duyệt.
- **Khôi phục từ file sao lưu**: nạp lại file .json. Dòng trùng tên file sẽ hỏi ghi đè hay giữ dữ liệu hiện có.
- **Nhập từ file Excel cũ**: đọc file Excel do app này xuất ra (cần cột "Tên file"; ảnh trong ô cũng được lấy).
  Ảnh có trong file này sẽ được bỏ qua khi đọc thư mục lần sau.

## Lưu trên cloud: máy nào cũng thấy

Mặc định **Lịch sử** và **HSKH** được lưu trên cloud (Vercel Blob, riêng tư): mở web ở máy tính nào cũng thấy cùng
dữ liệu.

- Lần đầu mở web trên một máy, app hiện ô **Dữ liệu chung trên cloud** ở đầu trang: nhập mật khẩu truy cập
  (`APP_PASSWORD`) một lần, trình duyệt sẽ nhớ.
- Máy đó đang có lịch sử / HSKH lưu riêng trên trình duyệt thì app **tự đưa lên cloud** (chỉ phần cloud chưa có,
  không ghi đè). HSKH trên máy mới hơn bản trên cloud cũng được đưa lên.
- Muốn chỉ lưu trên một máy: tab **Cài đặt AI** → Nơi lưu lịch sử → **Chỉ trình duyệt này**.
- Gói miễn phí của Vercel Blob giới hạn số lượt ghi mỗi tháng; app gom 25 ảnh/lần ghi để tiết kiệm.
- Chạy trên máy riêng (không phải Vercel): dữ liệu "cloud" lưu ở thư mục `.data/ocr-history`.

## HSKH: dò MSNV nhân viên bán hàng

Tab **HSKH** → **Tải lên file HSKH** (Excel hồ sơ khách hàng). App lấy cột **Số** (mã KH, vd `0573/00028`),
**Nhân Viên Bán** (MSNV) và **Tên NVBH**, rồi tự điền cột **MSNV · NVBH** cho từng ảnh theo Mã số KH (trong bảng,
tab Lịch sử và file Excel xuất ra). Mỗi lần HSKH thay đổi, tải file mới lên để thay thế.

- File được đọc ngay trên trình duyệt, chỉ giữ 3 cột trên; SĐT, CCCD… không được lưu hay gửi đi.
- Đang dùng lịch sử trên máy chủ thì bảng HSKH cũng được lưu lên máy chủ, máy khác tự nhận.
- Tab HSKH liệt kê các mã KH đang đọc mà HSKH không có, và thống kê số KH theo từng nhân viên.

## Kiểm tra số tài khoản kỹ

- **Đọc STK 2 lần (AI)** (bật sẵn, ở tab Đọc ảnh): mỗi ảnh được AI đọc thêm một lần độc lập chỉ tập trung số tài
  khoản và tên. Hai lần lệch nhau → **Cần kiểm tra**, ghi rõ số đọc được ở lần 2. Tốn gấp đôi lượt gọi AI.
- **Đối chiếu với HSKH** (khi đã tải HSKH): so STK đọc được với cột "Số Tài Khoản Khách hàng":
  - lệch 1-2 chữ số → tô **cam**, "Nghi đọc nhầm" (rất có thể AI/Tesseract đọc sai một vài số);
  - khác hẳn → ghi chú "Khác STK trong HSKH … đổi tài khoản?" (khách dùng tài khoản mới);
  - Excel có thêm cột **STK trong HSKH** và **Đối chiếu HSKH**.
- Tên người nhận, tên ngân hàng và số tài khoản bị **xuống dòng** đều được ghép đủ các dòng.

## Cảnh báo trùng số tài khoản

App tự đánh dấu **Trùng STK** khi cùng một số tài khoản thuộc nhiều mã KH khác nhau, hoặc một mã KH có nhiều
số tài khoản khác nhau (so cả với lịch sử). Ghi chú nêu cụ thể các MSKH bị trùng (vd "Trùng STK với MSKH
0573/00002, 0573/00015"). Các dòng trùng được **tô đỏ** trong bảng, tab Lịch sử và cả file Excel xuất ra; tab
Lịch sử có bộ lọc "Chỉ dòng trùng STK".

## Chọn AI và nhập API key ngay trên giao diện

Ở tab **Cài đặt AI**:

- Tick chọn **Claude (Anthropic)** hoặc **Gemini (Google)**.
- Dán API key vào ô bên cạnh (bấm **Lấy API key** để mở trang tạo key). Key chỉ lưu trong trình duyệt của bạn
  (localStorage), được gửi kèm từng lần đọc qua máy chủ của app tới Claude/Gemini và không lưu lại trên máy chủ.
- Có key riêng thì **không cần mật khẩu truy cập**. Để trống ô key thì app dùng key đặt trên Vercel
  (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) và hỏi mật khẩu `APP_PASSWORD`.
- Ô **Model** để trống = dùng mặc định (`claude-opus-5-5`, `gemini-2.5-flash`); có thể gõ model khác, ví dụ
  `claude-sonnet-5-5` hoặc `gemini-2.5-pro`.

## Sử dụng

1. Bấm **Chọn thư mục ảnh** (hoặc **Chọn nhiều ảnh**, hoặc kéo thả thư mục vào trang). File không phải .jpg/.png
   (ví dụ ảnh HEIC của iPhone) được bỏ qua và báo số lượng.
2. Chọn chế độ đọc:
   - **Claude AI + Tesseract kiểm tra chéo (khuyên dùng)**: Claude đọc ảnh, Tesseract đọc độc lập; nếu số tài khoản
     hoặc tên không khớp, dòng được đánh dấu **Cần kiểm tra**.
   - **Chỉ Claude AI**: nhanh hơn.
   - **Chỉ Tesseract**: chạy offline, miễn phí, nhưng hay nhầm số (3↔5, 6↔8) nên mọi dòng đều phải kiểm tra.
3. Bấm **Bắt đầu đọc**. Bấm vào ảnh nhỏ để phóng to, sửa trực tiếp ô bị sai, bấm **Đã kiểm tra** khi đã xem lại.
   Thư mục nhiều ảnh: khi Claude quá tải hoặc mạng chập chờn, app tự thử lại; bấm **Dừng** rồi **Bắt đầu đọc**
   để đọc tiếp phần còn lại. Đừng đóng tab khi đang đọc (kết quả chỉ nằm trong trình duyệt).
4. Bấm **Xuất Excel** (kèm ảnh trong ô) hoặc **Sao chép bảng** để dán vào Excel.

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
| `APP_PASSWORD` | (trống) | Mật khẩu truy cập; nên đặt khi đưa lên Internet |
| `GEMINI_API_KEY` | — | API key Gemini (tuỳ chọn) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model Gemini mặc định |

Ảnh chỉ được gửi tới API Claude để đọc, không lưu trên máy chủ.

## Kiểm thử

```bash
npm test           # kiểm thử tách tên file / phân tích văn bản OCR
npm run typecheck
```
