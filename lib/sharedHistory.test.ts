import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBackend, getThumb, removeRecords, upsertRecords, type IncomingRecord } from "./sharedHistory.ts";

const rec = (fileName: string, extra: Partial<IncomingRecord> = {}): IncomingRecord => ({
  fileName,
  customerCode: "0573/00028",
  businessName: "HKD",
  bank: "AGRIBANK",
  account: "4705235387979",
  name: "A",
  status: "ok",
  note: "",
  engine: "Gemini",
  size: 1,
  readAt: 1,
  ...extra,
});

function backend() {
  const dir = mkdtempSync(path.join(tmpdir(), "ocr-hist-"));
  process.env.OCR_HISTORY_DIR = dir;
  return { b: getBackend()!, dir };
}

test("ghi lô có ảnh, đọc ảnh theo tên file, ghi đè giữ ảnh cũ khi không gửi ảnh", async () => {
  const { b } = backend();
  const jpg = Buffer.from("fake-jpeg").toString("base64");
  await upsertRecords(b, [rec("a.png", { thumb: jpg }), rec("b.png")]);
  let { records } = await b.readIndex();
  assert.equal(records.length, 2);
  assert.equal((await getThumb(b, "a.png"))?.toString(), "fake-jpeg");
  assert.equal(await getThumb(b, "b.png"), null);

  await upsertRecords(b, [rec("a.png", { account: "999" })]);
  ({ records } = await b.readIndex());
  assert.equal(records.find((r) => r.fileName === "a.png")!.account, "999");
  assert.equal((await getThumb(b, "a.png"))?.toString(), "fake-jpeg", "giữ ảnh cũ");
});

test("ghi song song nhiều lô không mất dữ liệu (xử lý xung đột)", async () => {
  const { b } = backend();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => upsertRecords(b, [rec(`f${i}.png`, { thumb: Buffer.from(`t${i}`).toString("base64") })])),
  );
  const { records } = await b.readIndex();
  assert.equal(records.length, 12);
  assert.equal((await getThumb(b, "f7.png"))?.toString(), "t7");
});

test("xóa bản ghi thì dọn luôn lô ảnh không còn dùng; dữ liệu bẩn bị cắt/bỏ", async () => {
  const { b, dir } = backend();
  await upsertRecords(b, [rec("x.png", { thumb: "AAAA" })]);
  await upsertRecords(b, [rec("x.png", { thumb: "BBBB" })]); // lô cũ bị bỏ
  assert.equal(readdirSync(path.join(dir, "thumbs")).length, 1);
  await removeRecords(b, ["x.png"]);
  assert.equal(readdirSync(path.join(dir, "thumbs")).length, 0);
  assert.equal(await upsertRecords(b, [{ fileName: "" } as IncomingRecord, rec("y.png", { status: "hack" as "ok" })]), 1);
  assert.equal((await b.readIndex()).records[0].status, "review");
});
