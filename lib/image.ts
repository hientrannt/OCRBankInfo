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
  // PNG quá lớn thì chuyển sang JPEG chất lượng cao
  if (dataUrl.length > 4_500_000) {
    return { image: canvas.toDataURL("image/jpeg", 0.95).split(",")[1], mediaType: "image/jpeg" };
  }
  return { image: dataUrl.split(",")[1], mediaType };
}

/** Canvas đã tiền xử lý cho Tesseract (phóng to ảnh nhỏ, chuyển xám) */
export function fileToCanvasForTesseract(file: File) {
  return toCanvas(file, 3000, 2000, true);
}
