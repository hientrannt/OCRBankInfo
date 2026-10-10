/** Đọc file ảnh thành canvas, có thể phóng to / chuyển xám để OCR tốt hơn */
async function toCanvas(file: File, maxSide: number, minSide = 0, grayscale = false) {
  const bitmap = await createImageBitmap(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  let scale = 1;
  if (longest > maxSide) scale = maxSide / longest;
  else if (minSide && longest < minSide) scale = minSide / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  if (grayscale) ctx.filter = "grayscale(1) contrast(1.3)";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/** Ảnh base64 (không có tiền tố data:) để gửi lên Claude, tối đa 1568px cạnh dài */
export async function fileToBase64ForApi(file: File): Promise<{ image: string; mediaType: string }> {
  const canvas = await toCanvas(file, 1568);
  const mediaType = "image/png";
  const dataUrl = canvas.toDataURL(mediaType);
  // PNG lớn thì chuyển sang JPEG chất lượng cao: Vercel giới hạn body request 4.5MB
  if (dataUrl.length > 3_000_000) {
    for (const q of [0.95, 0.9, 0.85]) {
      const jpeg = canvas.toDataURL("image/jpeg", q);
      if (jpeg.length < 3_000_000 || q === 0.85) return { image: jpeg.split(",")[1], mediaType: "image/jpeg" };
    }
  }
  return { image: dataUrl.split(",")[1], mediaType };
}

/** Canvas đã tiền xử lý cho Tesseract (phóng to ảnh nhỏ, chuyển xám) */
export function fileToCanvasForTesseract(file: File) {
  return toCanvas(file, 3000, 2000, true);
}
