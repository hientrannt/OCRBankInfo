import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getBackend,
  getThumb,
  removeRecords,
  setCleanupRunner,
  strongEtag,
  upsertRecords,
  type IncomingRecord,
} from "./sharedHistory.ts";

// Việc dọn ảnh cũ chạy sau khi trả lời: gom lại để test chờ xong rồi mới kiểm tra
const cleanups: Promise<unknown>[] = [];
setCleanupRunner((t) => void cleanups.push(t));
const cleanupsDone = () => Promise.all(cleanups.splice(0));

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
  await cleanupsDone();
  assert.equal(readdirSync(path.join(dir, "thumbs")).length, 1);
  await removeRecords(b, ["x.png"]);
  await cleanupsDone();
  assert.equal(readdirSync(path.join(dir, "thumbs")).length, 0);
  assert.equal(await upsertRecords(b, [{ fileName: "" } as IncomingRecord, rec("y.png", { status: "hack" as "ok" })]), 1);
  assert.equal((await b.readIndex()).records[0].status, "review");
});

test("tài liệu dùng chung (HSKH) không bị xóa khi xóa toàn bộ lịch sử", async () => {
  const { b } = backend();
  await b.putDoc("hskh.json", '{"count":1}');
  await upsertRecords(b, [rec("z.png", { thumb: "AAAA" })]);
  await b.clearAll();
  assert.equal((await b.readIndex()).records.length, 0);
  assert.equal(await b.getDoc("hskh.json"), '{"count":1}');
  assert.equal(await b.getDoc("khong-co.json"), null);
});

test("ETag yếu W/\"...\" (bản đọc bị nén trên Vercel) được đổi về ETag gốc để ghi có điều kiện", () => {
  assert.equal(strongEtag('W/"1ab2"'), '"1ab2"');
  assert.equal(strongEtag('"1ab2"'), '"1ab2"');
  assert.equal(strongEtag(""), null);
  assert.equal(strongEtag(undefined), null);
});
