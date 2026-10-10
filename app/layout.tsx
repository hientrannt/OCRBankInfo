import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OCR Thông tin ngân hàng",
  description: "Đọc ảnh chụp thông tin người nhận và xuất ra Excel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
