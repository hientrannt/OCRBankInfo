/** Mở file ảnh; báo lỗi tiếng Việt khi file hỏng hoặc không phải ảnh thật */
async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error("File ảnh bị hỏng hoặc sai định dạng, không mở được");
  }
}

/** Đọc file ảnh thành canvas, có thể phóng to / chuyển xám để OCR tốt hơn */
async function toCanvas(file: File, maxSide: number, minSide = 0, grayscale = false) {
  const bitmap = await decode(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  let scale = 1;
  if (longest > maxSide) scale = maxSide / longest;
  else if (minSide && longest < minSide) scale = minSide / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  if (grayscale) ctx.filter = "grayscale(1)";
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

/**
 * Ảnh nhỏ (JPEG) để chèn vào ô Excel: thu vừa khung boxW x boxH (px hiển thị),
 * vẽ ở độ phân giải gấp đôi cho rõ chữ khi phóng to.
 */
export async function fileToThumbnail(
  file: File,
  boxW: number,
  boxH: number,
): Promise<{ base64: string; width: number; height: number }> {
  const bitmap = await decode(file);
  const scale = Math.min(boxW / bitmap.width, boxH / bitmap.height, 1);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(bitmap.width, width * 2);
  canvas.height = Math.min(bitmap.height, height * 2);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { base64: canvas.toDataURL("image/jpeg", 0.85).split(",")[1], width, height };
}
