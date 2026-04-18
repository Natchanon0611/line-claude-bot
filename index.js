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

// เก็บรูปชั่วคราว (หมดอายุใน 10 นาที)
const imageStore = new Map();

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
//  PO Sign Command Handler
// ─────────────────────────────────────────────
const SIGN_COMMANDS = ["sign po", "เซ็น po", "sign", "ลงลายเซ็น", "confirm po", "เซ็น"];

async function handlePOSign(event) {
  const text = (event.message?.text || "").trim().toLowerCase();
  if (!SIGN_COMMANDS.some(cmd => text.includes(cmd))) return false;

  const userId = event.source.groupId || event.source.userId;

  await lineReply(event.replyToken, "⏳ กำลังลงลายเซ็น PO อยู่ครับ รอสักครู่...");

  try {
    const res = await axios.post(
      `${PO_LOCAL_URL}/sign-po`,
      { requested_by: userId },
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

    if (data.status === "no_files") {
      await linePush(userId, "✅ ไม่มี PO ที่รอลงลายเซ็นในขณะนี้ครับ");

    } else if (data.status === "success" && data.signed?.length > 0) {
      const list = data.signed.map((f, i) => `${i + 1}. ${f.po_id}`).join("\n");
      await linePush(userId, `✅ ลงลายเซ็น PO เสร็จแล้ว ${data.signed.length} ไฟล์\n\n${list}\n\n📅 วันที่: ${data.date}\n📂 บันทึกใน PO_Signed แล้วครับ`);

      // ส่งรูป PO ที่เซ็นแล้วทีละไฟล์
      for (const item of data.signed) {
        if (item.image_b64) {
          const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
          imageStore.set(id, item.image_b64);
          setTimeout(() => imageStore.delete(id), 10 * 60 * 1000);
          const imageUrl = `${RENDER_URL}/po-image/${id}`;
          await linePushImage(userId, imageUrl, item.po_id);
        }
      }

    } else {
      await linePush(userId, "⚠️ " + (data.message || "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ"));
    }

  } catch (err) {
    console.error("PO Sign error:", err.message);
    await linePush(userId, "❌ เชื่อมต่อเครื่องไม่ได้ครับ\nตรวจสอบว่า Flask server และ ngrok รันอยู่");
  }

  return true;
}

// ─────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────
app.get("/", (req, res) => res.send("Bot is running"));
app.get("/webhook", (req, res) => res.send("Webhook endpoint is alive"));

// LINE Webhook
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  const event  = events[0];

  console.log("EVENT =", JSON.stringify(req.body));

  if (!event || event.type !== "message" || event.message.type !== "text") {
    return res.sendStatus(200);
  }

  // บันทึก source ID สำหรับ push notification
  lastLineSource = event.source.groupId || event.source.userId;

  res.sendStatus(200);

  const handled = await handlePOSign(event);
  if (handled) return;

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
    await linePush(lastLineSource, reply.substring(0, 1000));
  } catch (error) {
    console.error("Claude ERROR =", error.response?.data || error.message);
  }
});

// รับแจ้งเตือน PO ใหม่จาก Windows watcher
app.post("/notify-new-po", async (req, res) => {
  const { filename, image_b64, secret } = req.body;
  if (secret !== PO_SECRET) return res.status(401).json({ error: "Unauthorized" });

  console.log(`📨 PO ใหม่: ${filename}`);

  if (!lastLineSource) {
    return res.json({ status: "ok", note: "no LINE target yet" });
  }

  try {
    await lineBroadcast(`📨 มี PO ใหม่เข้ามาครับ\n📄 ${filename}`);

    if (image_b64) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      imageStore.set(id, image_b64);
      setTimeout(() => imageStore.delete(id), 10 * 60 * 1000);
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
app.listen(PORT, () => console.log("Server running on port " + PORT));
