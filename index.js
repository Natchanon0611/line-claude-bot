const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { processWebhookBatch } = require("./webhook_batch");
const app = express();

app.use(express.json({ limit: "20mb" }));

// ─────────────────────────────────────────────
//  CONFIG (ตั้งใน Render Environment Variables)
// ─────────────────────────────────────────────
const LINE_TOKEN  = process.env.LINE_TOKEN;
const PO_LOCAL_URL = process.env.PO_LOCAL_URL || "https://yearling-harvest-abreast.ngrok-free.dev";
const PO_SECRET   = process.env.PO_SECRET;
const RENDER_URL  = process.env.RENDER_URL || "https://line-claude-bot-y1jo.onrender.com";
let cachedBotUserId = process.env.LINE_BOT_USER_ID || "";

if (!PO_SECRET) {
  console.error("ERROR: PO_SECRET environment variable is required.");
  process.exit(1);
}

// ─── SLIP COLLECTOR — กลุ่ม LINE ที่จะดึงสลิปโอนเงินมาเก็บ ───
const SLIP_GROUP_ID = process.env.SLIP_GROUP_ID || "";
const AMPOHM_GROUP_ID = process.env.AMPOHM_GROUP_ID || process.env.APPOM_GROUP_ID || "Cc4af6846c391128bb8500b4f2c1e7860";
const DOWNLOADABLE_LINE_TYPES = new Set(["image", "file", "video", "audio"]);
const LINE_DOC_MAX_BYTES = Number(process.env.LINE_DOC_MAX_BYTES || 50 * 1024 * 1024);
const DAILY_SUMMARY_SEND_EMPTY = String(process.env.DAILY_SUMMARY_SEND_EMPTY || "").toLowerCase() === "true";

function isLineGroupId(id) {
  return typeof id === "string" && id.startsWith("C");
}

function getLineAttachmentGroups() {
  return [
    { company: "fes", label: "FES", groupId: SLIP_GROUP_ID, includeMailDocs: true },
    { company: "ampohm", label: "AmpOhm", groupId: AMPOHM_GROUP_ID, includeMailDocs: false },
  ].filter((group) => isLineGroupId(group.groupId));
}

function getLineAttachmentGroup(groupId) {
  return getLineAttachmentGroups().find((group) => group.groupId === groupId) || null;
}

// Push เฉพาะ target ที่ตั้งค่าไว้เท่านั้น ไม่จำแชตล่าสุดเป็น fallback
function getNotifyTarget() {
  const configuredTargets = [process.env.LINE_NOTIFY_TARGET, process.env.SLIP_GROUP_ID];
  const groupTarget = configuredTargets.find(isLineGroupId);
  if (!groupTarget && configuredTargets.some(Boolean)) {
    console.warn("[LINE] notify target ignored because it is not a groupId");
  }
  return groupTarget || null;
}

// เก็บรูป PO สำหรับให้ LINE ดึงผ่าน public URL
const imageStore = new Map();
const IMAGE_CACHE_DIR = process.env.PO_IMAGE_CACHE_DIR || path.join(__dirname, "logs", "po_images");
const DEFAULT_IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const configuredImageCacheTtl = Number(process.env.PO_IMAGE_CACHE_TTL_MS || DEFAULT_IMAGE_CACHE_TTL_MS);
const IMAGE_CACHE_TTL_MS = Number.isFinite(configuredImageCacheTtl) ? configuredImageCacheTtl : DEFAULT_IMAGE_CACHE_TTL_MS;
const IMAGE_CACHE_MAX_AGE_SECONDS = Math.max(3600, Math.floor(IMAGE_CACHE_TTL_MS / 1000));
const PUBLIC_RENDER_URL = String(RENDER_URL).replace(/\/+$/, "");

function writeImageCacheFile(id, kind, imageB64) {
  if (!imageB64) return;
  fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGE_CACHE_DIR, `${id}.${kind}.jpg`), Buffer.from(imageB64, "base64"));
}

function readImageCacheFile(id, kind) {
  const cachedPath = path.join(IMAGE_CACHE_DIR, `${id}.${kind}.jpg`);
  return fs.existsSync(cachedPath) ? fs.readFileSync(cachedPath) : null;
}

function removeImageCacheFiles(id) {
  fs.rm(path.join(IMAGE_CACHE_DIR, `${id}.original.jpg`), { force: true }, () => {});
  fs.rm(path.join(IMAGE_CACHE_DIR, `${id}.preview.jpg`), { force: true }, () => {});
  fs.rm(path.join(IMAGE_CACHE_DIR, `${id}.jpg`), { force: true }, () => {});
}

function scheduleImageCacheRemoval(id, remainingMs = IMAGE_CACHE_TTL_MS) {
  if (remainingMs <= 0) return;
  const delayMs = Math.min(remainingMs, MAX_TIMEOUT_MS);
  setTimeout(() => {
    const nextRemainingMs = remainingMs - delayMs;
    if (nextRemainingMs > 0) {
      scheduleImageCacheRemoval(id, nextRemainingMs);
      return;
    }
    imageStore.delete(id);
    removeImageCacheFiles(id);
  }, delayMs);
}

function storePoImage(imageB64, previewB64 = "") {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  imageStore.set(id, { original: imageB64, preview: previewB64 || imageB64 });
  try {
    writeImageCacheFile(id, "original", imageB64);
    writeImageCacheFile(id, "preview", previewB64 || imageB64);
  } catch (err) {
    console.warn(`[PO-IMAGE] disk cache write failed: ${err.message}`);
  }
  scheduleImageCacheRemoval(id);
  return id;
}

function poImageUrls(id) {
  return {
    original: `${PUBLIC_RENDER_URL}/po-image/${id}`,
    preview: `${PUBLIC_RENDER_URL}/po-image/${id}/preview`,
  };
}

// เก็บ PO ที่รอยืนยันลายเซ็น
const pendingConfirmations = new Map();

// เก็บรายการ PO ที่รอให้ user เลือก
let pendingSignList = null;

const PO_CODE_PATTERNS = [
  /(?<![A-Z0-9])PO[._\-\s]?\d+/i,
  /(?<![A-Z0-9])POUA\d+/i,
  /(?<![A-Z0-9])FPT\d+/i,
  /(?<![A-Z0-9])FFT\d+/i,
];
const SIGN_REQUEST_TIMEOUT_MS = Number(process.env.SIGN_REQUEST_TIMEOUT_MS || 600000);
const AUTO_SIGN_MAX_ATTEMPTS = Math.max(1, Number(process.env.AUTO_SIGN_MAX_ATTEMPTS || 8));
const AUTO_SIGN_BUSY_RETRY_MS = Math.max(5000, Number(process.env.AUTO_SIGN_BUSY_RETRY_MS || 45000));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPOFileName(filename = "") {
  return String(filename).toLowerCase().endsWith(".pdf") &&
         PO_CODE_PATTERNS.some((pattern) => pattern.test(filename));
}

// ─────────────────────────────────────────────
//  LINE Helpers
// ─────────────────────────────────────────────
async function lineReply(replyToken, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages: [{ type: "text", text: String(text).substring(0, 2000) }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function linePush(to, text) {
  if (!isLineGroupId(to)) {
    console.warn(`[LINE] blocked push to non-group target: ${to || "EMPTY"}`);
    return { skipped: true, reason: "non_group_target" };
  }
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to, messages: [{ type: "text", text: String(text).substring(0, 2000) }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function linePushImage(to, imageUrl, previewImageUrl = imageUrl) {
  if (!isLineGroupId(to)) {
    console.warn(`[LINE] blocked image push to non-group target: ${to || "EMPTY"}`);
    return { skipped: true, reason: "non_group_target" };
  }
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
      messages: [{
        type: "image",
        originalContentUrl: imageUrl,
        previewImageUrl
      }]
    },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function linePushPoImage(to, item) {
  if (!item?.image_b64) return;
  const id = storePoImage(item.image_b64, item.preview_b64);
  const urls = poImageUrls(id);
  await linePushImage(to, urls.original, urls.preview);
}

async function linePushFlex(to, altText, contents) {
  if (!isLineGroupId(to)) {
    console.warn(`[LINE] blocked flex push to non-group target: ${to || "EMPTY"}`);
    return { skipped: true, reason: "non_group_target" };
  }
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
      messages: [{
        type: "flex",
        altText: String(altText || "สรุปรายวัน").substring(0, 400),
        contents,
      }],
    },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  try {
    const res = await axios.get(
      "https://api.line.me/v2/bot/info",
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` }, timeout: 10000 }
    );
    cachedBotUserId = res.data?.userId || "";
  } catch (err) {
    console.warn("[LINE] cannot fetch bot info for self-message guard:", err.response?.status || err.message);
  }
  return cachedBotUserId;
}

async function isFromThisBot(event) {
  const senderId = event.source?.userId || "";
  if (!senderId) return false;
  const botUserId = await getBotUserId();
  return !!botUserId && senderId === botUserId;
}

async function lineBroadcast(text) {
  console.warn("[LINE] blocked broadcast; notifications are group-only");
  return { skipped: true, reason: "broadcast_disabled" };
}

async function lineBroadcastImage(imageUrl) {
  console.warn("[LINE] blocked image broadcast; notifications are group-only");
  return { skipped: true, reason: "broadcast_disabled" };
}

// ─────────────────────────────────────────────
//  Process Sign Result (shared logic)
// ─────────────────────────────────────────────
async function processPOSignResult(data, senderName, notifyId) {
  const send = async (text) => {
    try { await linePush(notifyId, text); } catch (e) {
      console.error("[SEND] linePush failed:", e.response?.status, e.message);
    }
  };

  if (data.status === "busy") {
    await send(`⚠️ กำลังลงลายเซ็นอยู่แล้วครับ\n👤 สั่งโดย: ${senderName}\nรอให้เสร็จก่อนแล้วค่อยสั่งใหม่`);
    return;
  }
  if (data.status === "no_files") {
    await send("✅ ไม่มี PO ที่รอลงลายเซ็นในขณะนี้ครับ");
    return;
  }
  if (data.status === "ignored") {
    return;
  }
  if ((data.status !== "success" || !data.signed?.length) && !(data.failed || []).length) {
    await send("⚠️ " + (data.message || "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ"));
  }

  const now = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
  const modeLine = data.dry_run ? "โหมดทดสอบ: ไม่ปริ้น ไม่ย้าย NAS ไม่ลบต้นฉบับ\n" : "";

  for (const item of (data.signed || [])) {
    if (item.needs_confirmation) {
      pendingConfirmations.set(item.po_id, {
        email: item.email, po_id: item.po_id,
        signed_file: item.signed_file, pending_file: item.pending_file, date: item.date,
      });
      await send(
        `⚠️ Claude หาตำแหน่งลายเซ็นไม่เจอ\n━━━━━━━━━━━━━━━\n` +
        `📄 PO: ${item.po_id}\n👤 สั่งโดย: ${senderName}\n━━━━━━━━━━━━━━━\n` +
        `ตรวจสอบรูปด้านล่าง แล้วตอบ:\n✅ "ยืนยัน" — ส่งเมล + ปริ้น\n❌ "ยกเลิก" — ลบและส่ง PO ใหม่`
      );
      if (item.image_b64) {
        try { await linePushPoImage(notifyId, item); }
        catch (e) { console.error("[SEND] linePushImage failed:", e.response?.status, e.message); }
      }
      continue;
    }

    let quotationLine = "";
    if (item.matched_quotation) {
      const confEmoji = item.matched_confidence === "high"   ? "🟢"
                      : item.matched_confidence === "medium" ? "🟡"
                      : item.matched_confidence === "low"    ? "🔴" : "⚪";
      quotationLine = `📋 ใบเสนอราคา: ${item.matched_quotation}\n   ${confEmoji} ความมั่นใจ: ${item.matched_confidence || "?"}\n`;
    } else {
      quotationLine = `📋 ใบเสนอราคา: ไม่พบที่ตรงกันใน NAS ⚠️\n`;
    }
    const quotationMoveLine = item.quotation_moved
                        ? `📁 ย้ายใบเสนอราคาเข้า V2-2 แล้ว ✓\n`
                        : item.quotation_move_error ? `📁 ย้ายใบเสนอราคาเข้า V2-2 ไม่สำเร็จ ✗ (${item.quotation_move_error})\n` : "";
    const factoryLine = item.factory ? `🏭 โรงงาน: ${item.factory}\n` : "";

    const nasLine   = item.nas_ok
                        ? `📂 NAS: คัดลอกแล้ว ✓\n${item.nas_path ? `   ${item.nas_path}\n` : ""}`
                        : item.nas_error ? `📂 NAS: ล้มเหลว ✗ (${item.nas_error})\n` : "";
    const printLine = item.print_ok    ? "🖨️  ปริ้น: สั่งแล้ว ✓\n"
                    : item.print_error ? `🖨️  ปริ้น: ล้มเหลว ✗ (${item.print_error})\n` : "";
    const fileLine  = item.output_file ? `📄 ไฟล์: ${item.output_file}\n` : "";
    const waitingLine = item.output_file?.startsWith("W-")
                    ? "⏳ สถานะ: รอตรวจ ก่อนส่งเมลยืนยัน\n" : "";

    await send(
      `✅ เซ็น PO เสร็จแล้ว\n━━━━━━━━━━━━━━━\n` +
      modeLine +
      `📄 PO: ${item.po_id}\n` + quotationLine + factoryLine + quotationMoveLine + fileLine + waitingLine +
      `📅 เวลา: ${now}\n👤 สั่งโดย: ${senderName}\n` +
      nasLine + printLine + `━━━━━━━━━━━━━━━`
    );

    if (item.image_b64) {
      try { await linePushPoImage(notifyId, item); }
      catch (e) { console.error("[SEND] linePushImage failed:", e.response?.status, e.message); }
    }
  }

  for (const item of (data.failed || [])) {
    const manualLine = item.manual_file ? `📁 ย้ายไปตรวจมือ: ${item.manual_file}\n` : "";
    await send(
      `❌ เซ็น PO ไม่สำเร็จ\n━━━━━━━━━━━━━━━\n` +
      modeLine +
      `📄 ไฟล์: ${item.file}\n⚠️ สาเหตุ: ${item.error}\n` +
      manualLine +
      `━━━━━━━━━━━━━━━`
    );
  }
}

// ─────────────────────────────────────────────
//  PO Sign Command Handler
// ─────────────────────────────────────────────
const SIGN_COMMANDS = ["sign po", "เซ็น po", "sign", "ลงลายเซ็น", "confirm po", "เซ็น"];

function isDryRunSignCommand(text = "") {
  const lower = String(text).trim().toLowerCase();
  return lower.includes("dry run") ||
         lower.includes("dry-run") ||
         lower.includes("test sign") ||
         lower.includes("test po") ||
         lower.includes("ทดสอบเซ็น");
}

function isSignCommand(text = "") {
  const lower = String(text).trim().toLowerCase();
  if (!lower) return false;
  if (isDryRunSignCommand(lower)) return true;
  if (/^(sign|sign po|confirm po)$/i.test(lower)) return true;
  if (/\b(sign po|confirm po)\b/i.test(lower)) return true;
  return SIGN_COMMANDS
    .filter((cmd) => cmd !== "sign")
    .some((cmd) => lower.includes(cmd));
}

async function handlePOSign(event) {
  const text = (event.message?.text || "").trim().toLowerCase();
  if (!isSignCommand(text)) return false;
  const dryRun = isDryRunSignCommand(text);

  const userId     = event.source.userId;
  const groupId    = event.source.groupId || null;
  const notifyId   = groupId || userId;
  const modePrefix = dryRun ? "[DRY-RUN] " : "";

  console.log(`[SIGN] command="${text}" from userId=${userId} groupId=${groupId || "-"}`);

  let senderName = "ไม่ทราบชื่อ";
  try {
    const profile = await axios.get(
      `https://api.line.me/v2/bot/profile/${userId}`,
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
    );
    senderName = profile.data.displayName || senderName;
  } catch (e) {
    console.error("[SIGN] Get profile error:", e.message);
  }

  let poFiles = [];
  try {
    console.log(`[SIGN] POST ${PO_LOCAL_URL}/list-po`);
    const listRes = await axios.post(`${PO_LOCAL_URL}/list-po`, {},
      { headers: { "X-PO-Secret": PO_SECRET, "Content-Type": "application/json",
                   "ngrok-skip-browser-warning": "true" }, timeout: 15000 });
    poFiles = (listRes.data.files || []).filter(isPOFileName);
    console.log(`[SIGN] got ${poFiles.length} files: ${JSON.stringify(poFiles)}`);
  } catch (e) {
    console.error(`[SIGN] list-po FAILED: ${e.message} (code=${e.code} status=${e.response?.status})`);
    await linePush(notifyId, `❌ เชื่อมต่อเครื่องไม่ได้\n👤 สั่งโดย: ${senderName}\nตรวจสอบว่า Flask และ ngrok รันอยู่\n[${e.message}]`).catch((err)=>console.error("[SIGN] push error notify failed:", err.message));
    return true;
  }

  if (poFiles.length === 0) {
    await lineReply(event.replyToken, "✅ ไม่มี PO ที่รอลงลายเซ็นในขณะนี้ครับ");
    return true;
  }

  if (poFiles.length > 1) {
    pendingSignList = {
      files: poFiles,
      senderName,
      dryRun,
      sourceId: event.source.groupId || event.source.userId,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    const fileList = poFiles.map((f, i) => `${i + 1}. ${f}`).join("\n");
    await lineReply(event.replyToken,
      `${modePrefix}📋 PO ที่รอลงลายเซ็น ${poFiles.length} ไฟล์\n━━━━━━━━━━━━━━━\n${fileList}\n━━━━━━━━━━━━━━━\nตอบเลขที่ต้องการเซ็น เช่น "1 3"\nหรือตอบ "ทั้งหมด"`
    );
    return true;
  }

  await lineReply(event.replyToken, `${modePrefix}⏳ กำลังลงลายเซ็น PO\n👤 สั่งโดย: ${senderName}\nรอสักครู่...`);

  try {
    console.log(`[SIGN] POST ${PO_LOCAL_URL}/sign-po (1 file)`);
    const res = await axios.post(
      `${PO_LOCAL_URL}/sign-po`,
      { requested_by: userId, selected_files: poFiles, dry_run: dryRun },
      {
        headers: {
          "X-PO-Secret": PO_SECRET,
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true"
        },
        timeout: SIGN_REQUEST_TIMEOUT_MS
      }
    );

    const data = res.data;
    console.log(`[SIGN] sign-po response: status=${data.status} signed=${data.signed?.length || 0} failed=${data.failed?.length || 0}`);

    await processPOSignResult(data, senderName, notifyId);

  } catch (err) {
    console.error(`[SIGN] sign-po FAILED: ${err.message} (code=${err.code} status=${err.response?.status})`);
    try {
      await linePush(notifyId,
        `❌ เชื่อมต่อเครื่องไม่ได้\n` +
        `━━━━━━━━━━━━━━━\n` +
        `👤 สั่งโดย: ${senderName}\n` +
        `⚠️ ตรวจสอบว่า Flask server และ ngrok รันอยู่\n` +
        `[${err.message}]\n` +
        `━━━━━━━━━━━━━━━`
      );
    } catch (e) { console.error("[SIGN] error notify push failed:", e.message); }
  }

  return true;
}

// ─────────────────────────────────────────────
//  PO Selection Handler
// ─────────────────────────────────────────────
async function handlePOSelection(event) {
  if (!pendingSignList) return false;

  const text  = (event.message?.text || "").trim();
  const lower = text.toLowerCase();
  const sourceId = event.source.groupId || event.source.userId;

  if (pendingSignList.expiresAt && Date.now() > pendingSignList.expiresAt) {
    pendingSignList = null;
    return false;
  }

  if (pendingSignList.sourceId && pendingSignList.sourceId !== sourceId) {
    return false;
  }

  const isAll     = lower === "ทั้งหมด" || lower === "all";
  const numTokens = text.split(/[\s,]+/).map(n => parseInt(n)).filter(n => !isNaN(n));
  if (!isAll && numTokens.length === 0) return false;

  const { files, senderName, dryRun } = pendingSignList;
  let selectedFiles;

  if (isAll) {
    selectedFiles = files;
  } else {
    selectedFiles = numTokens
      .filter(n => n >= 1 && n <= files.length)
      .map(n => files[n - 1]);
  }

  if (selectedFiles.length === 0) {
    await lineReply(event.replyToken, "⚠️ ไม่พบหมายเลขที่เลือก กรุณาลองใหม่ครับ");
    return true;
  }

  pendingSignList = null;

  const selNotifyId2 = event.source.groupId || event.source.userId;
  const modePrefix = dryRun ? "[DRY-RUN] " : "";
  await lineReply(event.replyToken, `${modePrefix}⏳ กำลังลงลายเซ็น ${selectedFiles.length} ไฟล์ รอสักครู่...`);
  await linePush(selNotifyId2, `${modePrefix}⏳ กำลังลงลายเซ็น PO ${selectedFiles.length} ไฟล์\n👤 สั่งโดย: ${senderName}\n${selectedFiles.map((f,i)=>`${i+1}. ${f}`).join("\n")}`).catch(()=>{});

  try {
    console.log(`[SIGN-SEL] POST ${PO_LOCAL_URL}/sign-po (${selectedFiles.length} files)`);
    const res = await axios.post(
      `${PO_LOCAL_URL}/sign-po`,
      { requested_by: event.source.userId, selected_files: selectedFiles, dry_run: !!dryRun },
      { headers: { "X-PO-Secret": PO_SECRET, "Content-Type": "application/json",
                   "ngrok-skip-browser-warning": "true" }, timeout: SIGN_REQUEST_TIMEOUT_MS }
    );
    const data = res.data;
    console.log(`[SIGN-SEL] response status=${data.status} signed=${data.signed?.length || 0}`);
    const selNotifyId = event.source.groupId || event.source.userId;
    if (data.status === "busy") {
      await linePush(selNotifyId, `⚠️ กำลังลงลายเซ็นอยู่แล้วครับ\n👤 สั่งโดย: ${senderName}`).catch(()=>{});
    } else {
      await processPOSignResult(data, senderName, selNotifyId);
    }
  } catch (err) {
    console.error(`[SIGN-SEL] FAILED: ${err.message} (code=${err.code})`);
    const selNotifyId = event.source.groupId || event.source.userId;
    try {
      await linePush(selNotifyId, `❌ เชื่อมต่อเครื่องไม่ได้\n👤 สั่งโดย: ${senderName}\nตรวจสอบว่า Flask และ ngrok รันอยู่\n[${err.message}]`);
    } catch (e) { console.error("[SIGN-SEL] push error:", e.message); }
  }
  return true;
}

// ─────────────────────────────────────────────
//  Confirm / Cancel Signature Handler
// ─────────────────────────────────────────────
async function handleConfirmCancel(event) {
  const text = (event.message?.text || "").trim();
  const lower = text.toLowerCase();

  const isConfirm = lower === "ยืนยัน" || lower === "confirm";
  const isCancel  = lower === "ยกเลิก"  || lower === "cancel";
  if (!isConfirm && !isCancel) return false;

  if (pendingConfirmations.size === 0) {
    await lineReply(event.replyToken, "ไม่มี PO ที่รอยืนยันในขณะนี้ครับ");
    return true;
  }

  const [po_id, pending] = pendingConfirmations.entries().next().value;
  pendingConfirmations.delete(po_id);

  const endpoint = isConfirm ? "/confirm-sign" : "/cancel-sign";
  const headers  = { "X-PO-Secret": PO_SECRET, "Content-Type": "application/json",
                     "ngrok-skip-browser-warning": "true" };

  try {
    const res = await axios.post(`${PO_LOCAL_URL}${endpoint}`, pending,
      { headers, timeout: 60000 });

    const ccNotifyId = event.source.groupId || event.source.userId;
    if (isConfirm) {
      const d = res.data;
      await linePush(ccNotifyId,
        `✅ ยืนยันลายเซ็น PO แล้ว\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📄 PO: ${po_id}\n` +
        `📧 อีเมล: ${d.email_sent ? "ส่งสำเร็จ ✓" : "ส่งไม่สำเร็จ ✗"}\n` +
        `🖨️  ปริ้น: ${d.print_ok ? "สั่งแล้ว ✓" : "ล้มเหลว ✗"}\n` +
        `━━━━━━━━━━━━━━━`
      ).catch(()=>{});
    } else {
      await linePush(ccNotifyId,
        `❌ ยกเลิกลายเซ็น PO แล้ว\n` +
        `📄 PO: ${po_id}\n` +
        `🔄 ไฟล์ต้นฉบับถูกคืนแล้ว — ส่ง PO ใหม่แล้วเซ็นใหม่ได้เลยครับ`
      ).catch(()=>{});
    }
  } catch (err) {
    const ccNotifyId = event.source.groupId || event.source.userId;
    await linePush(ccNotifyId, `❌ ${isConfirm ? "ยืนยัน" : "ยกเลิก"}ไม่สำเร็จ: ${err.message}`).catch(()=>{});
  }
  return true;
}

// ─────────────────────────────────────────────
//  Print PO Command Handler
// ─────────────────────────────────────────────
const PRINT_COMMANDS = ["print po", "ปริ้น po", "ปริ้น", "print"];

async function handlePOPrint(event) {
  const text = (event.message?.text || "").trim().toLowerCase();
  if (!PRINT_COMMANDS.some(cmd => text.includes(cmd))) return false;

  const userId = event.source.groupId || event.source.userId;
  await lineReply(event.replyToken, "🖨️ กำลังสั่งปริ้น PO ล่าสุด รอสักครู่...");

  try {
    const res = await axios.post(
      `${PO_LOCAL_URL}/print-po`,
      {},
      {
        headers: {
          "X-PO-Secret": PO_SECRET,
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true"
        },
        timeout: 30000
      }
    );

    const data = res.data;
    if (data.status === "ok") {
      await linePush(userId, `✅ สั่งปริ้นแล้วครับ\n📄 ${data.printed}`);
    } else if (data.status === "no_files") {
      await linePush(userId, "⚠️ ไม่มีไฟล์ใน PO_Signed ครับ");
    } else {
      await linePush(userId, "❌ ปริ้นไม่สำเร็จ: " + (data.error || "unknown"));
    }
  } catch (err) {
    console.error("Print PO error:", err.message);
    await linePush(userId, "❌ เชื่อมต่อเครื่องไม่ได้ครับ\nตรวจสอบว่า Flask server และ ngrok รันอยู่");
  }

  return true;
}

// ─────────────────────────────────────────────
//  Slip Image Handler
// ─────────────────────────────────────────────
async function handleLineAttachment(event) {
  if (event.type !== "message" || !DOWNLOADABLE_LINE_TYPES.has(event.message?.type)) return false;
  const lineGroup = getLineAttachmentGroup(event.source?.groupId);
  if (!lineGroup) return false;

  const messageId = event.message.id;
  const userId    = event.source.userId || "unknown";
  const timestamp = event.timestamp || Date.now();
  const messageType = event.message.type;
  const originalFilename = event.message.fileName || "";
  console.log(`[LINE-INBOX] company=${lineGroup.company} message=${messageId} type=${messageType} user=${userId}`);

  console.log(`📥 รับไฟล์จากกลุ่ม LINE: ${messageId} type=${messageType} user=${userId}`);

  try {
    const { buffer, contentType } = await downloadLineContent(messageId);
    console.log(`  size: ${(buffer.length / 1024).toFixed(1)} KB content_type=${contentType || "-"}`);

    let savedFilename = null;
    try {
      savedFilename = await uploadLineDocumentToFlask({
        fileBuffer: buffer,
        userId,
        timestamp,
        messageId,
        messageType,
        originalFilename,
        contentType,
        company: lineGroup.company,
        groupId: lineGroup.groupId,
      });
      console.log(`  ✓ บันทึกแล้ว: ${savedFilename}`);
    } catch (saveErr) {
      console.error("  ⚠️ save-line-document failed:", saveErr.response?.data || saveErr.message);
      pendingLineDocuments.set(messageId, {
        userId,
        timestamp,
        messageType,
        originalFilename,
        company: lineGroup.company,
        groupId: lineGroup.groupId,
        addedAt: Date.now(),
        retries: 0,
      });
      console.log(`  📋 เพิ่มเข้าคิว retry (รวม ${pendingLineDocuments.size} รายการ)`);
    }

    // ไม่ push ต่อไฟล์ เพื่อประหยัด LINE quota; ใช้สรุปรายวันแทน

  } catch (err) {
    console.error("handleLineAttachment error:", err.message);
  }

  return true;
}

// ─────────────────────────────────────────────
//  Slip Upload Helper + Auto-Retry Queue
// ─────────────────────────────────────────────

// คิวสำหรับไฟล์ LINE ที่ save ไม่สำเร็จ (เช่น Flask down / ngrok down)
// key = messageId, value = {userId, timestamp, messageType, originalFilename, addedAt, retries}
const pendingLineDocuments = new Map();

const RETRY_INTERVAL_MS  = 5 * 60 * 1000;  // retry ทุก 5 นาที
const RETRY_MAX_AGE_HOURS = 12;             // ลบจากคิวถ้าค้างเกิน 12 ชั่วโมง (กัน leak)

/**
 * ดาวน์โหลด content จาก LINE Content API
 */
async function downloadLineContent(messageId) {
  const res = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` },
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: LINE_DOC_MAX_BYTES,
      maxBodyLength: LINE_DOC_MAX_BYTES,
    }
  );
  return {
    buffer: Buffer.from(res.data),
    contentType: res.headers?.["content-type"] || "",
  };
}

/**
 * อัพโหลดไฟล์ดิบจาก LINE ไป Flask
 */
async function uploadLineDocumentToFlask({
  fileBuffer,
  userId,
  timestamp,
  messageId,
  messageType,
  originalFilename,
  contentType,
  company,
  groupId,
}) {
  if (!fileBuffer) {
    const downloaded = await downloadLineContent(messageId);
    fileBuffer = downloaded.buffer;
    contentType = contentType || downloaded.contentType;
  }

  const qs = new URLSearchParams({
    user_id:        userId || "RECOVERY",
    timestamp:      String(timestamp || Date.now()),
    message_id:     messageId,
    message_type:   messageType || "file",
    original_filename: originalFilename || "",
    content_type:   contentType || "",
    company:        company || "",
    group_id:       groupId || "",
  }).toString();

  const saveRes = await axios.post(
    `${PO_LOCAL_URL}/save-line-document?${qs}`,
    fileBuffer,
    {
      headers: {
        "X-PO-Secret": PO_SECRET,
        "Content-Type": "application/octet-stream",
        "ngrok-skip-browser-warning": "true",
      },
      timeout: 30000,
      maxBodyLength: LINE_DOC_MAX_BYTES,
    }
  );

  return saveRes.data?.filename || null;
}

/**
 * ลองส่งสลิปในคิวอีกครั้ง — รันทุก 5 นาที
 */
async function retryPendingSlips() {
  if (pendingLineDocuments.size === 0) return;

  console.log(`🔄 retry pending LINE files: ${pendingLineDocuments.size} รายการ`);

  const cutoff = Date.now() - RETRY_MAX_AGE_HOURS * 60 * 60 * 1000;

  for (const [messageId, info] of pendingLineDocuments.entries()) {
    // ลบรายการที่ค้างนานเกินไป (รูปบน LINE หมดอายุ 14 วัน แต่เกินบางขนาดก็เลิกลอง)
    if (info.addedAt < cutoff) {
      console.log(`  ⏰ ลบจากคิว (เก่าเกิน ${RETRY_MAX_AGE_HOURS}h): ${messageId}`);
      pendingLineDocuments.delete(messageId);
      continue;
    }

    try {
      const filename = await uploadLineDocumentToFlask({
        fileBuffer: null,  // จะดาวน์โหลดใหม่
        userId:    info.userId,
        timestamp: info.timestamp,
        messageId,
        messageType: info.messageType,
        originalFilename: info.originalFilename,
        company: info.company,
        groupId: info.groupId,
        contentType: "",
      });
      console.log(`  ✓ retry สำเร็จ: ${filename} (${messageId})`);
      pendingLineDocuments.delete(messageId);
    } catch (err) {
      info.retries++;
      console.log(`  ✗ retry ครั้งที่ ${info.retries} ล้มเหลว: ${messageId} — ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────
//  Daily Summary v3 — mail documents + money slips
//  ยิงตอน 18:00 Asia/Bangkok ครอบช่วง 18:01 เมื่อวาน → 18:00 วันนี้ (24h เต็ม)
//  ใช้ /mail-doc-stats + /slip-stats ของ Flask แล้วส่งเข้า SLIP_GROUP_ID เป็น Flex ตารางเดียว
// ─────────────────────────────────────────────

function getYesterdayBkk(todayYmd) {
  // todayYmd = "YYYY-MM-DD" → คืน YYYY-MM-DD ของเมื่อวาน (ใช้ UTC math ไม่ติด timezone)
  const [y, m, d] = todayYmd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

async function fetchDailyStat(endpoint, today, lineGroup = null) {
  try {
    const qs = new URLSearchParams({ period_end_date: today });
    if (lineGroup?.company) qs.set("company", lineGroup.company);
    if (lineGroup?.groupId) qs.set("group_id", lineGroup.groupId);
    const res = await axios.get(
      `${PO_LOCAL_URL}/${endpoint}?${qs.toString()}`,
      {
        headers: { "X-PO-Secret": PO_SECRET, "ngrok-skip-browser-warning": "true" },
        timeout: 15000,
      }
    );
    return { ok: true, count: res.data?.count ?? 0, rows: res.data?.rows || [] };
  } catch (err) {
    return { ok: false, count: 0, rows: [], error: err.message };
  }
}

function shortText(value, maxLen = 38) {
  const text = String(value || "-").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

const THAI_MONTHS_SHORT = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

function formatThaiDate(ymd) {
  const [y, m, d] = String(ymd || "").split("-").map(Number);
  if (!y || !m || !d) return String(ymd || "-");
  return `${d} ${THAI_MONTHS_SHORT[m - 1]} ${y + 543}`;
}

function flexText(text, options = {}) {
  return {
    type: "text",
    text: String(text ?? "-"),
    wrap: options.wrap ?? true,
    ...options,
  };
}

function buildDailySummaryFlex(mailDocStat, lineDocStat, today, yesterday) {
  const docsOk = !!mailDocStat.ok;
  const rows = docsOk && Array.isArray(mailDocStat.rows) ? mailDocStat.rows : [];
  const countText = docsOk ? `ดาวน์โหลดทั้งหมด ${mailDocStat.count} ไฟล์` : `ตรวจเอกสารไม่ได้ (${mailDocStat.error})`;
  const lineDocText = lineDocStat.ok ? `LINE inbox ${lineDocStat.count} ไฟล์` : `LINE inbox ตรวจไม่ได้`;

  const bodyContents = [
    {
      type: "box",
      layout: "horizontal",
      contents: [
        flexText("#", { size: "xs", weight: "bold", flex: 1, color: "#555555", wrap: false }),
        flexText("หน่วยงาน", { size: "xs", weight: "bold", flex: 4, color: "#555555" }),
        flexText("ไฟล์", { size: "xs", weight: "bold", flex: 6, color: "#555555" }),
      ],
    },
    { type: "separator", margin: "xs" },
  ];

  if (!docsOk) {
    bodyContents.push({
      type: "box",
      layout: "horizontal",
      margin: "sm",
      contents: [
        flexText("!", { size: "xs", flex: 1, color: "#B00020", wrap: false }),
        flexText("ระบบ", { size: "xs", flex: 4, color: "#B00020" }),
        flexText(mailDocStat.error || "ตรวจไม่ได้", { size: "xs", flex: 6, color: "#B00020" }),
      ],
    });
  } else if (rows.length === 0) {
    bodyContents.push({
      type: "box",
      layout: "horizontal",
      margin: "sm",
      contents: [
        flexText("-", { size: "xs", flex: 1, color: "#888888", wrap: false }),
        flexText("-", { size: "xs", flex: 4, color: "#888888" }),
        flexText("ไม่มีไฟล์เอกสารใหม่", { size: "xs", flex: 6, color: "#888888" }),
      ],
    });
  } else {
    for (const [idx, row] of rows.slice(0, 10).entries()) {
      bodyContents.push({
        type: "box",
        layout: "horizontal",
        margin: "sm",
        contents: [
          flexText(String(idx + 1), { size: "xs", flex: 1, color: "#555555", wrap: false }),
          flexText(shortText(row.entity, 34), { size: "xs", flex: 4 }),
          flexText(shortText(row.filename, 64), { size: "xs", flex: 6 }),
        ],
      });
    }
    if (mailDocStat.count > rows.length) {
      bodyContents.push({ type: "separator", margin: "sm" });
      bodyContents.push(flexText(`... และอีก ${mailDocStat.count - rows.length} ไฟล์`, {
        size: "xs",
        color: "#888888",
        align: "center",
        margin: "sm",
      }));
    }
  }

  return {
    type: "bubble",
    size: "giga",
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "lg",
      backgroundColor: "#F5F5F5",
      contents: [
        flexText("📥 สรุปการดาวน์โหลดเอกสาร", {
          weight: "bold",
          size: "md",
          color: "#1F1F1F",
        }),
        flexText(`📅 ${formatThaiDate(today)}`, {
          size: "sm",
          color: "#888888",
          margin: "sm",
        }),
        flexText(countText, {
          size: "sm",
          weight: "bold",
          color: "#0066CC",
          margin: "sm",
        }),
        flexText(`${yesterday} 18:01 → ${today} 18:00 • ${lineDocText}`, {
          size: "xxs",
          color: "#888888",
          margin: "xs",
        }),
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "md",
      contents: bodyContents,
    },
  };
}

function dailySummaryTotalCount(mailDocStat, lineDocStat) {
  const mailCount = mailDocStat.ok ? Number(mailDocStat.count || 0) : 0;
  const lineCount = lineDocStat.ok ? Number(lineDocStat.count || 0) : 0;
  return mailCount + lineCount;
}

async function sendDailySummary() {
  const lineGroups = getLineAttachmentGroups();
  if (lineGroups.length === 0) return;

  // วันที่วันนี้ตามเวลา BKK (สำหรับ period_end_date)
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  const yesterday = getYesterdayBkk(today);

  for (const lineGroup of lineGroups) {
  try {
    let [lineDocStat, mailDocStat] = await Promise.all([
      fetchDailyStat("line-inbox-stats", today, lineGroup),
      lineGroup.includeMailDocs ? fetchDailyStat("mail-doc-stats", today, lineGroup) : Promise.resolve({ ok: true, count: 0, rows: [] }),
    ]);
    if (!lineGroup.includeMailDocs && lineDocStat.ok) {
      mailDocStat = {
        ...lineDocStat,
        rows: (lineDocStat.rows || []).map((row) => ({ entity: lineGroup.label, ...row })),
      };
    }

    if (!lineDocStat.ok && !mailDocStat.ok) {
      console.error(
        `Daily summary skipped (period_end ${today}): ` +
        `mail_docs=${mailDocStat.error || "ERR"} line_inbox=${lineDocStat.error || "ERR"}`
      );
      continue;
    }

    const totalCount = dailySummaryTotalCount(mailDocStat, lineDocStat);
    if (!DAILY_SUMMARY_SEND_EMPTY && totalCount === 0) {
      console.log(`Daily summary skipped company=${lineGroup.company} (period_end ${today}): no loaded documents`);
      continue;
    }

    await linePushFlex(
      lineGroup.groupId,
      `สรุปดาวน์โหลด ${totalCount} ไฟล์ ประจำวันที่ ${formatThaiDate(today)}`,
      buildDailySummaryFlex(mailDocStat, lineDocStat, today, yesterday)
    );
    console.log(
      `✓ ส่งสรุปรายวัน (period_end ${today}): ` +
      `mail_docs=${mailDocStat.ok ? mailDocStat.count : "ERR"} ` +
      `line_inbox=${lineDocStat.ok ? lineDocStat.count : "ERR"}`
    );
  } catch (err) {
    console.error(`Daily summary error company=${lineGroup.company}:`, err.message);
  }
  }
}

function msUntilNext1800Bangkok() {
  const now    = new Date();
  const bkkStr = now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" });
  const bkkNow = new Date(bkkStr);
  const target = new Date(bkkNow);
  target.setHours(18, 0, 0, 0);
  if (target <= bkkNow) target.setDate(target.getDate() + 1);
  return target.getTime() - bkkNow.getTime();
}

function scheduleDailySummary() {
  const delay = msUntilNext1800Bangkok();
  console.log(`⏰ ตั้งเวลาสรุปรายวันอีก ${Math.round(delay / 60000)} นาที`);
  setTimeout(async () => {
    await sendDailySummary();
    setInterval(sendDailySummary, 24 * 60 * 60 * 1000); // ทุก 24 ชั่วโมง
  }, delay);
}

// ─────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────
app.get("/", (req, res) => res.send("Bot is running"));
app.get("/webhook", (req, res) => res.send("Webhook endpoint is alive"));

const processedMsgIds = new Set();

async function processWebhookEvent(event) {
  if (!event || event.type !== "message") return;

  if (!isLineGroupId(event.source?.groupId)) {
    console.log(`[LINE] ignored non-group message from source=${event.source?.userId || event.source?.roomId || "unknown"}`);
    return;
  }

  const msgId = event.message.id;
  if (processedMsgIds.has(msgId)) {
    console.log(`Duplicate message ignored: ${msgId}`);
    return;
  }
  processedMsgIds.add(msgId);
  setTimeout(() => processedMsgIds.delete(msgId), 5 * 60 * 1000);

  if (await isFromThisBot(event).catch((e) => {
    console.warn("[LINE] self-message guard failed:", e.message);
    return false;
  })) {
    console.log(`[LINE] ignored self-sent bot message: ${msgId}`);
    return;
  }

  if (DOWNLOADABLE_LINE_TYPES.has(event.message.type)) {
    await handleLineAttachment(event).catch(e => console.error("LineAttachment error:", e.message));
    return;
  }

  if (event.message.type !== "text") return;

  const messageText = (event.message.text || "").trim().toLowerCase();
  if (messageText === "group id" || messageText === "groupid" || messageText === "source id") {
    const sourceId = event.source.groupId || event.source.userId || "unknown";
    const sourceType = event.source.groupId ? "group" : "user";
    await linePush(sourceId, `LINE ${sourceType} ID:\n${sourceId}`);
    return;
  }

  // กลุ่มรับสลิป: บอทไม่ตอบข้อความผู้ใช้ — เก็บสลิป + สรุปรายวันอย่างเดียว
  if (getLineAttachmentGroup(event.source?.groupId)) return;

  const confirmed = await handleConfirmCancel(event);
  if (confirmed) return;

  const selected = await handlePOSelection(event);
  if (selected) return;

  const handled = await handlePOSign(event);
  if (handled) return;

  const printed = await handlePOPrint(event);
  if (printed) return;

  try {
    const claude = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{ role: "user", content: event.message.text }]
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );
    const reply = claude.data.content[0].text || "No response";
    const replyTarget = event.source.groupId || event.source.userId;
    await linePush(replyTarget, reply.substring(0, 1000));
  } catch (error) {
    console.error("Claude ERROR =", error.response?.data || error.message);
  }
}

async function processWebhookEvents(events, eventHandler = processWebhookEvent) {
  return processWebhookBatch(events, eventHandler, console);
}

app.post("/webhook", (req, res) => {
  const events = req.body?.events || [];
  console.log("EVENT =", JSON.stringify(req.body));

  // LINE expects a quick acknowledgement; process every event in the batch afterwards.
  res.sendStatus(200);
  void processWebhookEvents(events);
});

app.post("/notify-new-po", async (req, res) => {
  const { filename, image_b64, secret } = req.body;
  if (secret !== PO_SECRET) return res.status(401).json({ error: "Unauthorized" });

  console.log(`📨 PO ใหม่: ${filename}`);

  try {
    const target = getNotifyTarget();
    console.log(`[NOTIFY] target=${target || "NONE"} notify_env=${process.env.LINE_NOTIFY_TARGET || "unset"} slip_group=${process.env.SLIP_GROUP_ID || "unset"}`);

    if (target) {
      try {
        await linePush(target, `📨 มี PO ใหม่เข้ามาครับ\n📄 ${filename}`);
        console.log(`[NOTIFY] text push OK to ${target}`);
      } catch (e) {
        console.error(`[NOTIFY] text push FAILED: ${e.response?.status} ${e.message}`);
      }
      if (image_b64) {
        const id = storePoImage(image_b64, req.body.preview_b64);
        const imageUrl = poImageUrls(id);
        try {
          await linePushImage(target, imageUrl.original, imageUrl.preview);
          console.log(`[NOTIFY] image push OK`);
        } catch (e) {
          console.error(`[NOTIFY] image push FAILED: ${e.response?.status} ${e.message}`);
        }
      }
    } else {
      console.warn("[NOTIFY] no target — set LINE_NOTIFY_TARGET or SLIP_GROUP_ID env var");
    }
    res.json({ status: "ok", target: target || null });
  } catch (err) {
    console.error("notify-new-po error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  [NEW WORKFLOW] Auto-sign endpoint
//  รับ trigger จาก po_watcher → call Flask /sign-po → push LINE ผลลัพธ์
// ─────────────────────────────────────────────
app.post("/auto-sign-po", async (req, res) => {
  const { filename, secret } = req.body;
  if (secret !== PO_SECRET) return res.status(401).json({ error: "Unauthorized" });

  console.log(`[AUTO-SIGN] received: ${filename}`);
  if (!isPOFileName(filename)) {
    console.log(`[AUTO-SIGN] ignored non-PO file: ${filename}`);
    return res.json({ status: "ignored", reason: "not_po_file", filename });
  }

  // ตอบ po_watcher กลับเลย — sign ใช้เวลานาน, ทำ async
  res.json({ status: "accepted", filename });

  const senderName = "ระบบ Auto-Sign";

  // [TARGET MODE] Send only to configured LINE_NOTIFY_TARGET/SLIP_GROUP_ID.
  const notifyTarget = getNotifyTarget();

  const bsend = async (text) => {
    if (!notifyTarget) {
      console.warn("[AUTO-SIGN] no notify target - set LINE_NOTIFY_TARGET or SLIP_GROUP_ID to a groupId");
      return;
    }
    try {
      await linePush(notifyTarget, text);
      console.log(`[AUTO-SIGN] push OK to ${notifyTarget} (${String(text).substring(0,30)}...)`);
    } catch (e) {
      console.error(`[AUTO-SIGN] push FAILED: ${e.response?.status} ${e.message}`);
    }
  };
  const bsendImage = async (imageUrl, previewImageUrl = imageUrl) => {
    if (!notifyTarget) {
      console.warn("[AUTO-SIGN] no notify target for image - set LINE_NOTIFY_TARGET or SLIP_GROUP_ID to a groupId");
      return;
    }
    try {
      await linePushImage(notifyTarget, imageUrl, previewImageUrl);
      console.log(`[AUTO-SIGN] push image OK to ${notifyTarget}`);
    } catch (e) {
      console.error(`[AUTO-SIGN] push image FAILED: ${e.response?.status} ${e.message}`);
    }
  };

  try {
    let data = null;
    for (let attempt = 1; attempt <= AUTO_SIGN_MAX_ATTEMPTS; attempt++) {
      console.log(`[AUTO-SIGN] POST ${PO_LOCAL_URL}/sign-po (1 file, attempt ${attempt}/${AUTO_SIGN_MAX_ATTEMPTS})`);
      const signRes = await axios.post(
        `${PO_LOCAL_URL}/sign-po`,
        { requested_by: "auto-watcher", selected_files: [filename] },
        {
          headers: {
            "X-PO-Secret": PO_SECRET,
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true"
          },
          timeout: SIGN_REQUEST_TIMEOUT_MS
        }
      );

      data = signRes.data;
      if (data.status !== "busy") break;
      if (attempt < AUTO_SIGN_MAX_ATTEMPTS) {
        console.log(`[AUTO-SIGN] local signer busy; retry in ${AUTO_SIGN_BUSY_RETRY_MS / 1000}s`);
        await sleep(AUTO_SIGN_BUSY_RETRY_MS);
      }
    }

    console.log(`[AUTO-SIGN] response: status=${data.status} signed=${data.signed?.length || 0} failed=${data.failed?.length || 0}`);

    if (data.status === "busy") {
      await bsend(`⚠️ Auto-sign ยังชนงานเซ็นที่กำลังรันอยู่หลัง retry แล้ว\n━━━━━━━━━━━━━━━\n📄 ไฟล์: ${filename}\n👤 สั่งโดย: ${senderName}\nระบบ watcher จะลองส่งใหม่ถ้าไฟล์ยังค้างอยู่`);
      return;
    }
    if (data.status === "no_files") {
      await bsend(`✅ ไม่มี PO ที่รอลงลายเซ็นในขณะนี้ครับ`);
      return;
    }
    if (data.status === "ignored") {
      return;
    }
    if (data.status !== "success" && !(data.failed || []).length) {
      await bsend(`⚠️ Auto-sign มีข้อผิดพลาด\n━━━━━━━━━━━━━━━\n📄 ไฟล์: ${filename}\n⚠️ ${data.message || "ไม่ทราบสาเหตุ"}\n━━━━━━━━━━━━━━━`);
      return;
    }

    const now = new Date().toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });

    for (const item of (data.signed || [])) {
      let quotationLine = "";
      if (item.matched_quotation) {
        const confEmoji = item.matched_confidence === "high"   ? "🟢"
                        : item.matched_confidence === "medium" ? "🟡"
                        : item.matched_confidence === "low"    ? "🔴" : "⚪";
        quotationLine = `📋 ใบเสนอราคา: ${item.matched_quotation}\n   ${confEmoji} ความมั่นใจ: ${item.matched_confidence || "?"}\n`;
      } else {
        quotationLine = `📋 ใบเสนอราคา: ไม่พบที่ตรงกันใน NAS ⚠️\n`;
      }
      const quotationMoveLine = item.quotation_moved
                          ? `📁 ย้ายใบเสนอราคาเข้า V2-2 แล้ว ✓\n`
                          : item.quotation_move_error ? `📁 ย้ายใบเสนอราคาเข้า V2-2 ไม่สำเร็จ ✗ (${item.quotation_move_error})\n` : "";
      const factoryLine = item.factory ? `🏭 โรงงาน: ${item.factory}\n` : "";

      const nasLine   = item.nas_ok
                          ? `📂 NAS: คัดลอกแล้ว ✓\n${item.nas_path ? `   ${item.nas_path}\n` : ""}`
                          : item.nas_error ? `📂 NAS: ล้มเหลว ✗ (${item.nas_error})\n` : "";
      const printLine = item.print_ok    ? "🖨️  ปริ้น: สั่งแล้ว ✓\n"
                      : item.print_error ? `🖨️  ปริ้น: ล้มเหลว ✗ (${item.print_error})\n` : "";
      const fileLine  = item.output_file ? `📄 ไฟล์: ${item.output_file}\n` : "";
      const waitingLine = item.output_file?.startsWith("W-")
                      ? "⏳ สถานะ: รอตรวจ ก่อนส่งเมลยืนยัน\n" : "";

      await bsend(
        `✅ เซ็น PO เสร็จแล้ว\n━━━━━━━━━━━━━━━\n` +
        `📄 PO: ${item.po_id}\n` + quotationLine + factoryLine + quotationMoveLine + fileLine + waitingLine +
        `📅 เวลา: ${now}\n👤 สั่งโดย: ${senderName}\n` +
        nasLine + printLine + `━━━━━━━━━━━━━━━`
      );

      if (item.image_b64) {
        const id = storePoImage(item.image_b64, item.preview_b64);
        const urls = poImageUrls(id);
        await bsendImage(urls.original, urls.preview);
      }
    }

    for (const item of (data.failed || [])) {
      await bsend(
        `❌ เซ็น PO ไม่สำเร็จ\n━━━━━━━━━━━━━━━\n` +
        `📄 ไฟล์: ${item.file}\n⚠️ สาเหตุ: ${item.error}\n━━━━━━━━━━━━━━━`
      );
    }
  } catch (err) {
    console.error(`[AUTO-SIGN] FAILED: ${err.message} (code=${err.code} status=${err.response?.status})`);
    await bsend(
      `❌ Auto-sign ล้มเหลว\n━━━━━━━━━━━━━━━\n📄 ไฟล์: ${filename}\n⚠️ ${err.message}\n━━━━━━━━━━━━━━━`
    );
  }
});

app.post("/po-mail-result", async (req, res) => {
  const { secret, text } = req.body || {};
  if (secret !== PO_SECRET) return res.status(401).json({ error: "Unauthorized" });

  const notifyTarget = getNotifyTarget();
  if (!notifyTarget) {
    console.warn("[PO-MAIL] no notify target - set LINE_NOTIFY_TARGET or SLIP_GROUP_ID");
    return res.json({ status: "no_target" });
  }

  try {
    await linePush(notifyTarget, String(text || "สรุปส่งเมล PO ว่าง").substring(0, 2000));
    console.log("[PO-MAIL] result pushed");
    return res.json({ status: "ok" });
  } catch (err) {
    const lineStatus = err.response?.status || 0;
    const lineBody = err.response?.data || null;
    console.error("[PO-MAIL] push failed:", lineStatus, err.message, lineBody);
    return res.json({
      status: "line_push_failed",
      line_status: lineStatus,
      reason: lineStatus === 429 ? "line_quota_or_rate_limit" : "line_push_error",
      message: err.message,
    });
  }
});

function sendCachedPoImage(req, res, kind) {
  const id = req.params.id;
  const entry = imageStore.get(id);
  const imageB64 = entry && (entry[kind] || entry.original || entry);
  let buf = imageB64 ? Buffer.from(imageB64, "base64") : null;
  if (!buf) {
    buf = readImageCacheFile(id, kind) ||
          readImageCacheFile(id, "original") ||
          (kind === "original" ? readImageCacheFile(id, "preview") : null);
  }
  if (!buf) return res.status(404).send("Not found or expired");
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", `public, max-age=${IMAGE_CACHE_MAX_AGE_SECONDS}, immutable`);
  res.set("Content-Length", String(buf.length));
  res.set("X-Content-Type-Options", "nosniff");
  res.send(buf);
}

app.get("/po-image/:id/preview", (req, res) => {
  sendCachedPoImage(req, res, "preview");
});

app.get("/po-image/:id", (req, res) => {
  sendCachedPoImage(req, res, "original");
});

// ─────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
function startServer() {
  return app.listen(PORT, () => {
    console.log("Server running on port " + PORT);

    // Self-ping ทุก 14 นาที กัน Render free tier นอนหลับ
    setInterval(() => {
      axios.get(`${RENDER_URL}/`).catch(() => {});
      console.log("Self-ping to stay awake");
    }, 14 * 60 * 1000);

    // Auto-retry ไฟล์ LINE ที่ค้างในคิว ทุก 5 นาที
    setInterval(retryPendingSlips, RETRY_INTERVAL_MS);
    console.log(`🔁 ตั้ง auto-retry pending LINE files ทุก ${RETRY_INTERVAL_MS / 60000} นาที`);

    // ยิงสรุปเอกสารจากเมล + สลิปประจำวัน 18:00 BKK (ครอบ 18:01 เมื่อวาน → 18:00 วันนี้)
    scheduleDailySummary();
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, processWebhookEvent, processWebhookEvents, startServer };
