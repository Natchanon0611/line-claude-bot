const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json({ limit: "20mb" }));

// ─────────────────────────────────────────────
//  CONFIG (ตั้งใน Render Environment Variables)
// ─────────────────────────────────────────────
const LINE_TOKEN  = process.env.LINE_TOKEN;
const PO_LOCAL_URL = process.env.PO_LOCAL_URL || "https://yearling-harvest-abreast.ngrok-free.dev";
const PO_SECRET   = process.env.PO_SECRET    || "fes-po-secret-2026";
const RENDER_URL  = "https://line-claude-bot-y1jo.onrender.com";

// เก็บ source ID ล่าสุดสำหรับ push notification
let lastLineSource = process.env.LINE_NOTIFY_TARGET || null;

// เก็บรูปชั่วคราว (หมดอายุใน 1 ชั่วโมง)
const imageStore = new Map();

// เก็บ PO ที่รอยืนยันลายเซ็น
const pendingConfirmations = new Map(); // po_id → {email, po_id, signed_file, pending_file, date}

// เก็บรายการ PO ที่รอให้ user เลือก
let pendingSignList = null; // { files: [...], senderName }

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
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to, messages: [{ type: "text", text: String(text).substring(0, 2000) }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function linePushImage(to, imageUrl, altText) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
      messages: [{
        type: "image",
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl
      }]
    },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function lineBroadcast(text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/broadcast",
    { messages: [{ type: "text", text: String(text).substring(0, 2000) }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function lineBroadcastImage(imageUrl) {
  await axios.post(
    "https://api.line.me/v2/bot/message/broadcast",
    { messages: [{ type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
  );
}

// ─────────────────────────────────────────────
//  Process Sign Result (shared logic)
// ─────────────────────────────────────────────
async function processPOSignResult(data, senderName) {
  if (data.status === "busy") {
    await lineBroadcast(`⚠️ กำลังลงลายเซ็นอยู่แล้วครับ\n👤 สั่งโดย: ${senderName}\nรอให้เสร็จก่อนแล้วค่อยสั่งใหม่`);
    return;
  }
  if (data.status === "no_files") {
    await lineBroadcast("✅ ไม่มี PO ที่รอลงลายเซ็นในขณะนี้ครับ");
    return;
  }
  if (data.status !== "success" || !data.signed?.length) {
    await lineBroadcast("⚠️ " + (data.message || "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ"));
  }

  const now = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });

  for (const item of (data.signed || [])) {
    if (item.needs_confirmation) {
      pendingConfirmations.set(item.po_id, {
        email: item.email, po_id: item.po_id,
        signed_file: item.signed_file, pending_file: item.pending_file, date: item.date,
      });
      await lineBroadcast(
        `⚠️ Claude หาตำแหน่งลายเซ็นไม่เจอ\n━━━━━━━━━━━━━━━\n` +
        `📄 PO: ${item.po_id}\n👤 สั่งโดย: ${senderName}\n━━━━━━━━━━━━━━━\n` +
        `ตรวจสอบรูปด้านล่าง แล้วตอบ:\n✅ "ยืนยัน" — ส่งเมล + ปริ้น\n❌ "ยกเลิก" — ลบและส่ง PO ใหม่`
      );
      if (item.image_b64) {
        const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        imageStore.set(id, item.image_b64);
        setTimeout(() => imageStore.delete(id), 60 * 60 * 1000);
        await lineBroadcastImage(`${RENDER_URL}/po-image/${id}`);
      }
      continue;
    }

    const emailBody = `Dear Sir/Madam,\n\nPlease find the confirmed Purchase Order attached.\n\nPO No.: ${item.po_id}\nDate: ${item.date}\n\nBest regards,\nFES Group`;
    const quotationLine = item.matched_quotation ? `📋 ใบเสนอราคา: ${item.matched_quotation}\n` : "";
    const nasLine   = item.nas_ok    ? "📂 NAS: คัดลอกแล้ว ✓\n"
                    : item.nas_error ? `📂 NAS: ล้มเหลว ✗ (${item.nas_error})\n` : "";
    const printLine = item.print_ok    ? "🖨️  ปริ้น: สั่งแล้ว ✓\n"
                    : item.print_error ? `🖨️  ปริ้น: ล้มเหลว ✗ (${item.print_error})\n` : "";

    await lineBroadcast(
      `✅ เซ็น PO เสร็จแล้ว\n━━━━━━━━━━━━━━━\n` +
      `📄 PO: ${item.po_id}\n` + quotationLine +
      `📅 เวลา: ${now}\n👤 สั่งโดย: ${senderName}\n` +
      `✉️  ส่งอีเมลไปที่: ${item.email}\n` +
      `📧 อีเมล: ${item.email_sent ? "ส่งสำเร็จ ✓" : "ส่งไม่สำเร็จ ✗"}\n` +
      nasLine + printLine + `━━━━━━━━━━━━━━━\nข้อความที่ส่ง:\n${emailBody}`
    );

    if (item.image_b64) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      imageStore.set(id, item.image_b64);
      setTimeout(() => imageStore.delete(id), 60 * 60 * 1000);
      await lineBroadcastImage(`${RENDER_URL}/po-image/${id}`);
    }
  }

  for (const item of (data.failed || [])) {
    await lineBroadcast(
      `❌ เซ็น PO ไม่สำเร็จ\n━━━━━━━━━━━━━━━\n` +
      `📄 ไฟล์: ${item.file}\n⚠️ สาเหตุ: ${item.error}\n━━━━━━━━━━━━━━━`
    );
  }
}

// ─────────────────────────────────────────────
//  PO Sign Command Handler
// ─────────────────────────────────────────────
const SIGN_COMMANDS = ["sign po", "เซ็น po", "sign", "ลงลายเซ็น", "confirm po", "เซ็น"];

async function handlePOSign(event) {
  const text = (event.message?.text || "").trim().toLowerCase();
  if (!SIGN_COMMANDS.some(cmd => text.includes(cmd))) return false;

  const userId     = event.source.userId;
  const groupId    = event.source.groupId || null;
  const notifyId   = groupId || userId;

  // ดึงชื่อผู้สั่ง
  let senderName = "ไม่ทราบชื่อ";
  try {
    const profile = await axios.get(
      `https://api.line.me/v2/bot/profile/${userId}`,
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
    );
    senderName = profile.data.displayName || senderName;
  } catch (e) {
    console.error("Get profile error:", e.message);
  }

  // ── ดึงรายการ PO ก่อน ──
  let poFiles = [];
  try {
    const listRes = await axios.post(`${PO_LOCAL_URL}/list-po`, {},
      { headers: { "X-PO-Secret": PO_SECRET, "Content-Type": "application/json",
                   "ngrok-skip-browser-warning": "true" }, timeout: 15000 });
    poFiles = listRes.data.files || [];
  } catch (e) {
    await lineBroadcast(`❌ เชื่อมต่อเครื่องไม่ได้\n👤 สั่งโดย: ${senderName}\nตรวจสอบว่า Flask และ ngrok รันอยู่`);
    return true;
  }

  if (poFiles.length === 0) {
    await lineReply(event.replyToken, "✅ ไม่มี PO ที่รอลงลายเซ็นในขณะนี้ครับ");
    return true;
  }

  // ถ้ามีไฟล์เดียว → เซ็นเลย / ถ้ามีหลายไฟล์ → ให้ user เลือก
  if (poFiles.length > 1) {
    pendingSignList = { files: poFiles, senderName };
    const fileList = poFiles.map((f, i) => `${i + 1}. ${f}`).join("\n");
    await lineReply(event.replyToken,
      `📋 PO ที่รอลงลายเซ็น ${poFiles.length} ไฟล์\n━━━━━━━━━━━━━━━\n${fileList}\n━━━━━━━━━━━━━━━\nตอบเลขที่ต้องการเซ็น เช่น "1 3"\nหรือตอบ "ทั้งหมด"`
    );
    return true;
  }

  // ไฟล์เดียว → เซ็นเลย
  await lineReply(event.replyToken, "⏳ กำลังลงลายเซ็น PO อยู่ครับ รอสักครู่...");
  await lineBroadcast(`⏳ กำลังลงลายเซ็น PO\n👤 สั่งโดย: ${senderName}`);

  try {
    const res = await axios.post(
      `${PO_LOCAL_URL}/sign-po`,
      { requested_by: userId, selected_files: poFiles },
      {
        headers: {
          "X-PO-Secret": PO_SECRET,
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true"
        },
        timeout: 120000
      }
    );

    const data = res.data;

    await processPOSignResult(data, senderName);

  } catch (err) {
    console.error("PO Sign error:", err.message);
    await lineBroadcast(
      `❌ เชื่อมต่อเครื่องไม่ได้\n` +
      `━━━━━━━━━━━━━━━\n` +
      `👤 สั่งโดย: ${senderName}\n` +
      `⚠️ ตรวจสอบว่า Flask server และ ngrok รันอยู่\n` +
      `━━━━━━━━━━━━━━━`
    );
  }

  return true;
}

// ─────────────────────────────────────────────
//  PO Selection Handler (เลือกไฟล์ที่จะเซ็น)
// ─────────────────────────────────────────────
async function handlePOSelection(event) {
  if (!pendingSignList) return false;

  const text  = (event.message?.text || "").trim();
  const lower = text.toLowerCase();

  // ตรวจว่าเป็นตัวเลข หรือ "ทั้งหมด"
  const isAll     = lower === "ทั้งหมด" || lower === "all";
  const numTokens = text.split(/[\s,]+/).map(n => parseInt(n)).filter(n => !isNaN(n));
  if (!isAll && numTokens.length === 0) return false;

  const { files, senderName } = pendingSignList;
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

  await lineReply(event.replyToken, `⏳ กำลังลงลายเซ็น ${selectedFiles.length} ไฟล์ รอสักครู่...`);
  await lineBroadcast(`⏳ กำลังลงลายเซ็น PO ${selectedFiles.length} ไฟล์\n👤 สั่งโดย: ${senderName}\n${selectedFiles.map((f,i)=>`${i+1}. ${f}`).join("\n")}`);

  try {
    const res = await axios.post(
      `${PO_LOCAL_URL}/sign-po`,
      { requested_by: event.source.userId, selected_files: selectedFiles },
      { headers: { "X-PO-Secret": PO_SECRET, "Content-Type": "application/json",
                   "ngrok-skip-browser-warning": "true" }, timeout: 120000 }
    );
    // ส่งผลลัพธ์ผ่าน handlePOSign logic เดิม
    // (จำลอง event เพื่อ reuse)
    const data = res.data;
    if (data.status === "busy") {
      await lineBroadcast(`⚠️ กำลังลงลายเซ็นอยู่แล้วครับ\n👤 สั่งโดย: ${senderName}`);
    } else {
      // ส่งต่อให้ handlePOSign จัดการผลลัพธ์
      await processPOSignResult(data, senderName);
    }
  } catch (err) {
    await lineBroadcast(`❌ เชื่อมต่อเครื่องไม่ได้\n👤 สั่งโดย: ${senderName}\nตรวจสอบว่า Flask และ ngrok รันอยู่`);
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

  // ใช้รายการแรกที่รออยู่
  const [po_id, pending] = pendingConfirmations.entries().next().value;
  pendingConfirmations.delete(po_id);

  const endpoint = isConfirm ? "/confirm-sign" : "/cancel-sign";
  const headers  = { "X-PO-Secret": PO_SECRET, "Content-Type": "application/json",
                     "ngrok-skip-browser-warning": "true" };

  try {
    const res = await axios.post(`${PO_LOCAL_URL}${endpoint}`, pending,
      { headers, timeout: 60000 });

    if (isConfirm) {
      const d = res.data;
      await lineBroadcast(
        `✅ ยืนยันลายเซ็น PO แล้ว\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📄 PO: ${po_id}\n` +
        `📧 อีเมล: ${d.email_sent ? "ส่งสำเร็จ ✓" : "ส่งไม่สำเร็จ ✗"}\n` +
        `🖨️  ปริ้น: ${d.print_ok ? "สั่งแล้ว ✓" : "ล้มเหลว ✗"}\n` +
        `━━━━━━━━━━━━━━━`
      );
    } else {
      await lineBroadcast(
        `❌ ยกเลิกลายเซ็น PO แล้ว\n` +
        `📄 PO: ${po_id}\n` +
        `🔄 ไฟล์ต้นฉบับถูกคืนแล้ว — ส่ง PO ใหม่แล้วเซ็นใหม่ได้เลยครับ`
      );
    }
  } catch (err) {
    await lineBroadcast(`❌ ${isConfirm ? "ยืนยัน" : "ยกเลิก"}ไม่สำเร็จ: ${err.message}`);
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
//  Routes
// ─────────────────────────────────────────────
app.get("/", (req, res) => res.send("Bot is running"));
app.get("/webhook", (req, res) => res.send("Webhook endpoint is alive"));

// Deduplication — ป้องกัน LINE retry ส่ง webhook ซ้ำ
const processedMsgIds = new Set();

// LINE Webhook
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  const event  = events[0];

  console.log("EVENT =", JSON.stringify(req.body));

  if (!event || event.type !== "message" || event.message.type !== "text") {
    return res.sendStatus(200);
  }

  // ตรวจ duplicate message ID
  const msgId = event.message.id;
  if (processedMsgIds.has(msgId)) {
    console.log(`Duplicate message ignored: ${msgId}`);
    return res.sendStatus(200);
  }
  processedMsgIds.add(msgId);
  setTimeout(() => processedMsgIds.delete(msgId), 5 * 60 * 1000); // ลบหลัง 5 นาที

  // บันทึก source ID สำหรับ push notification
  lastLineSource = event.source.groupId || event.source.userId;

  res.sendStatus(200);

  const confirmed = await handleConfirmCancel(event);
  if (confirmed) return;

  const selected = await handlePOSelection(event);
  if (selected) return;

  const handled = await handlePOSign(event);
  if (handled) return;

  const printed = await handlePOPrint(event);
  if (printed) return;

  // ── ส่งให้ Claude ตอบ ──
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
    const replyTarget = lastLineSource || event.source.groupId || event.source.userId;
    await linePush(replyTarget, reply.substring(0, 1000));
  } catch (error) {
    console.error("Claude ERROR =", error.response?.data || error.message);
  }
});

// รับแจ้งเตือน PO ใหม่จาก Windows watcher
app.post("/notify-new-po", async (req, res) => {
  const { filename, image_b64, secret } = req.body;
  if (secret !== PO_SECRET) return res.status(401).json({ error: "Unauthorized" });

  console.log(`📨 PO ใหม่: ${filename}`);

  try {
    await lineBroadcast(`📨 มี PO ใหม่เข้ามาครับ\n📄 ${filename}`);

    if (image_b64) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      imageStore.set(id, image_b64);
      setTimeout(() => imageStore.delete(id), 60 * 60 * 1000);
      const imageUrl = `${RENDER_URL}/po-image/${id}`;
      await lineBroadcastImage(imageUrl);
    }

    res.json({ status: "ok" });
  } catch (err) {
    console.error("notify-new-po error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve รูปภาพชั่วคราว
app.get("/po-image/:id", (req, res) => {
  const data = imageStore.get(req.params.id);
  if (!data) return res.status(404).send("Not found or expired");
  const buf = Buffer.from(data, "base64");
  res.set("Content-Type", "image/jpeg");
  res.send(buf);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);

  // Self-ping ทุก 14 นาที เพื่อไม่ให้ Render free tier นอนหลับ
  setInterval(() => {
    axios.get(`${RENDER_URL}/`).catch(() => {});
    console.log("Self-ping to stay awake");
  }, 14 * 60 * 1000);
});
