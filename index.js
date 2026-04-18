const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

// ─────────────────────────────────────────────
//  CONFIG (ตั้งใน Render Environment Variables)
// ─────────────────────────────────────────────
const LINE_TOKEN    = process.env.LINE_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PO_LOCAL_URL  = process.env.PO_LOCAL_URL || "https://yearling-harvest-abreast.ngrok-free.dev";
const PO_SECRET     = process.env.PO_SECRET    || "fes-po-secret-2026";

// ─────────────────────────────────────────────
//  Helper: ส่ง reply กลับ LINE
// ─────────────────────────────────────────────
async function lineReply(replyToken, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages: [{ type: "text", text: String(text).substring(0, 2000) }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function linePush(userId, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: userId, messages: [{ type: "text", text: String(text).substring(0, 2000) }] },
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

  const userId = event.source.userId;

  // ตอบรับทันที
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

app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  const event  = events[0];

  console.log("EVENT =", JSON.stringify(req.body));

  if (!event || event.type !== "message" || event.message.type !== "text") {
    return res.sendStatus(200);
  }

  res.sendStatus(200); // ตอบ LINE ก่อนเสมอ

  // ── ตรวจสอบว่าเป็นคำสั่ง sign PO ก่อน ──
  const handled = await handlePOSign(event);
  if (handled) return;

  // ── ถ้าไม่ใช่ → ส่งให้ Claude ตอบ ──
  try {
    const userMsg = event.message.text;
    const claude  = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{ role: "user", content: userMsg }]
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
    await linePush(event.source.userId, reply.substring(0, 1000));

  } catch (error) {
    console.error("Claude ERROR =", error.response?.data || error.message);
    await linePush(event.source.userId, "เกิดข้อผิดพลาด: " + (error.response?.data?.error?.message || error.message));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
