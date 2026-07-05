const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json({ limit: "20mb" }));

// ─────────────────────────────────────────────
//  CONFIG (ตั้งใน Render Environment Variables)
// ─────────────────────────────────────────────
const LINE_TOKEN  = process.env.LINE_TOKEN;
const PO_LOCAL_URL = process.env.PO_LOCAL_URL || "https://yearling-harvest-abreast.ngrok-free.dev";
const PO_SECRET   = process.env.PO_SECRET;
const RENDER_URL  = "https://line-claude-bot-y1jo.onrender.com";

if (!PO_SECRET) {
  console.error("ERROR: PO_SECRET environment variable is required.");
  process.exit(1);
}

// ─── SLIP COLLECTOR — กลุ่ม LINE ที่จะดึงสลิปโอนเงินมาเก็บ ───
const SLIP_GROUP_ID = process.env.SLIP_GROUP_ID || "";

// Push เฉพาะ target ที่ตั้งค่าไว้เท่านั้น ไม่จำแชตล่าสุดเป็น fallback
function getNotifyTarget() {
  return process.env.LINE_NOTIFY_TARGET || process.env.SLIP_GROUP_ID || null;
}

// เก็บรูปชั่วคราว (หมดอายุใน 1 ชั่วโมง)
const imageStore = new Map();

// เก็บ PO ที่รอยืนยันลายเซ็น
const pendingConfirmations = new Map();

// เก็บรายการ PO ที่รอให้ user เลือก
let pendingSignList = null;

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

async function linePushImage(to, imageUrl) {
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
  if (data.status !== "success" || !data.signed?.length) {
    await send("⚠️ " + (data.message || "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ"));
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
      await send(
        `⚠️ Claude หาตำแหน่งลายเซ็นไม่เจอ\n━━━━━━━━━━━━━━━\n` +
        `📄 PO: ${item.po_id}\n👤 สั่งโดย: ${senderName}\n━━━━━━━━━━━━━━━\n` +
        `ตรวจสอบรูปด้านล่าง แล้วตอบ:\n✅ "ยืนยัน" — ส่งเมล + ปริ้น\n❌ "ยกเลิก" — ลบและส่ง PO ใหม่`
      );
      if (item.image_b64) {
        const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        imageStore.set(id, item.image_b64);
        setTimeout(() => imageStore.delete(id), 60 * 60 * 1000);
        try { await linePushImage(notifyId, `${RENDER_URL}/po-image/${id}`); }
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

    const nasLine   = item.nas_ok
                        ? `📂 NAS: คัดลอกแล้ว ✓\n${item.nas_path ? `   ${item.nas_path}\n` : ""}`
                        : item.nas_error ? `📂 NAS: ล้มเหลว ✗ (${item.nas_error})\n` : "";
    const printLine = item.print_ok    ? "🖨️  ปริ้น: สั่งแล้ว ✓\n"
                    : item.print_error ? `🖨️  ปริ้น: ล้มเหลว ✗ (${item.print_error})\n` : "";
    const fileLine  = item.output_file ? `📄 ไฟล์: ${item.output_file}\n` : "";

    await send(
      `✅ เซ็น PO เสร็จแล้ว\n━━━━━━━━━━━━━━━\n` +
      `📄 PO: ${item.po_id}\n` + quotationLine + fileLine +
      `📅 เวลา: ${now}\n👤 สั่งโดย: ${senderName}\n` +
      nasLine + printLine + `━━━━━━━━━━━━━━━`
    );

    if (item.image_b64) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      imageStore.set(id, item.image_b64);
      setTimeout(() => imageStore.delete(id), 60 * 60 * 1000);
      try { await linePushImage(notifyId, `${RENDER_URL}/po-image/${id}`); }
      catch (e) { console.error("[SEND] linePushImage failed:", e.response?.status, e.message); }
    }
  }

  for (const item of (data.failed || [])) {
    await send(
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
    poFiles = listRes.data.files || [];
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
    pendingSignList = { files: poFiles, senderName };
    const fileList = poFiles.map((f, i) => `${i + 1}. ${f}`).join("\n");
    await lineReply(event.replyToken,
      `📋 PO ที่รอลงลายเซ็น ${poFiles.length} ไฟล์\n━━━━━━━━━━━━━━━\n${fileList}\n━━━━━━━━━━━━━━━\nตอบเลขที่ต้องการเซ็น เช่น "1 3"\nหรือตอบ "ทั้งหมด"`
    );
    return true;
  }

  await lineReply(event.replyToken, `⏳ กำลังลงลายเซ็น PO\n👤 สั่งโดย: ${senderName}\nรอสักครู่...`);

  try {
    console.log(`[SIGN] POST ${PO_LOCAL_URL}/sign-po (1 file)`);
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

  const selNotifyId2 = event.source.groupId || event.source.userId;
  await lineReply(event.replyToken, `⏳ กำลังลงลายเซ็น ${selectedFiles.length} ไฟล์ รอสักครู่...`);
  await linePush(selNotifyId2, `⏳ กำลังลงลายเซ็น PO ${selectedFiles.length} ไฟล์\n👤 สั่งโดย: ${senderName}\n${selectedFiles.map((f,i)=>`${i+1}. ${f}`).join("\n")}`).catch(()=>{});

  try {
    console.log(`[SIGN-SEL] POST ${PO_LOCAL_URL}/sign-po (${selectedFiles.length} files)`);
    const res = await axios.post(
      `${PO_LOCAL_URL}/sign-po`,
      { requested_by: event.source.userId, selected_files: selectedFiles },
      { headers: { "X-PO-Secret": PO_SECRET, "Content-Type": "application/json",
                   "ngrok-skip-browser-warning": "true" }, timeout: 120000 }
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
async function handleSlipImage(event) {
  if (event.type !== "message" || event.message?.type !== "image") return false;
  if (!SLIP_GROUP_ID || event.source?.groupId !== SLIP_GROUP_ID) return false;

  const messageId = event.message.id;
  const userId    = event.source.userId || "unknown";
  const timestamp = event.timestamp || Date.now();

  console.log(`📥 รับสลิปจากกลุ่ม: ${messageId} (user: ${userId})`);

  try {
    const imgRes = await axios.get(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: { Authorization: `Bearer ${LINE_TOKEN}` },
        responseType: "arraybuffer",
        timeout: 30000,
      }
    );

    const imgBuffer = Buffer.from(imgRes.data);
    const imgB64    = imgBuffer.toString("base64");
    console.log(`  size: ${(imgBuffer.length / 1024).toFixed(1)} KB`);

    let slipData = { date: "", sender: "", recipient: "", amount: "", ref: "" };
    try {
      const ocrPrompt =
        'อ่านสลิปโอนเงินไทยนี้แล้วตอบเป็น JSON เท่านั้น (ไม่มี markdown, ไม่มีคำอธิบาย):\n' +
        '{\n' +
        '  "date": "YYYY-MM-DD",\n' +
        '  "sender": "ชื่อผู้โอน/บัญชีต้นทาง",\n' +
        '  "recipient": "ชื่อผู้รับ/บัญชีปลายทาง",\n' +
        '  "amount": "ยอดเงิน เป็นตัวเลขเท่านั้น",\n' +
        '  "ref": "เลข reference ถ้ามี ไม่มีให้ใส่ \\"\\""\n' +
        '}\n' +
        'กฎวันที่ (สำคัญมาก อ่านให้ตรงเป๊ะ):\n' +
        '- อ่านวันที่/เดือน/ปี ตามที่ปรากฏบนสลิปเท่านั้น ห้ามเดา ห้ามใช้วันที่วันนี้\n' +
        '- เดือนไทยย่อ: ม.ค.=01, ก.พ.=02, มี.ค.=03, เม.ย.=04, พ.ค.=05, มิ.ย.=06, ก.ค.=07, ส.ค.=08, ก.ย.=09, ต.ค.=10, พ.ย.=11, ธ.ค.=12\n' +
        '- ถ้าปีเป็น พ.ศ. (เช่น 2569) ให้ลบ 543 เป็น ค.ศ. (2026) ก่อนใส่ในรูปแบบ YYYY-MM-DD\n' +
        'กฎชื่อ: ถอดชื่อผู้โอน/ผู้รับตามตัวอักษรที่เห็นจริง ถ้าเป็นบริษัทให้คงคำว่า "บจก./บริษัท" ไว้\n' +
        'ห้ามใส่ markdown code block ตอบเฉพาะ JSON';

      const claudeRes = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-haiku-4-5",
          max_tokens: 500,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgB64 } },
              { type: "text",  text: ocrPrompt }
            ]
          }]
        },
        {
          headers: {
            "x-api-key": process.env.CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
          },
          timeout: 30000,
        }
      );

      let rawText = claudeRes.data.content[0].text.trim();
      rawText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      slipData = JSON.parse(rawText);
      console.log(`  OCR: ${JSON.stringify(slipData)}`);
    } catch (e) {
      console.error("  OCR failed:", e.message);
    }

    let savedFilename = null;
    try {
      savedFilename = await uploadSlipToFlask({ imgBuffer, userId, timestamp, messageId, slipData });
      console.log(`  ✓ บันทึกแล้ว: ${savedFilename}`);
    } catch (saveErr) {
      console.error("  ⚠️ save-slip failed:", saveErr.response?.data || saveErr.message);
      // เก็บเข้าคิว retry — เก็บแค่ messageId + slipData (ไม่เก็บ imgBuffer เพื่อประหยัด memory)
      // ตอน retry จะดาวน์โหลดรูปจาก LINE ใหม่ (รูปอยู่บน LINE 14 วัน)
      pendingSlips.set(messageId, {
        userId, timestamp, slipData,
        addedAt: Date.now(),
        retries: 0,
      });
      console.log(`  📋 เพิ่มเข้าคิว retry (รวม ${pendingSlips.size} รายการ)`);
    }

    // ── ไม่ push per-slip แล้ว (ประหยัด LINE quota) ──
    // ใช้ sendDailySummary() ตอน 18:00 รายงานรวบยอดแทน

  } catch (err) {
    console.error("handleSlipImage error:", err.message);
  }

  return true;
}

// ─────────────────────────────────────────────
//  Slip Upload Helper + Auto-Retry Queue
// ─────────────────────────────────────────────

// คิวสำหรับสลิปที่ save ไม่สำเร็จ (เช่น Flask down / ngrok down)
// key = messageId, value = {userId, timestamp, slipData, addedAt, retries}
const pendingSlips = new Map();

const RETRY_INTERVAL_MS  = 5 * 60 * 1000;  // retry ทุก 5 นาที
const RETRY_MAX_AGE_HOURS = 12;             // ลบจากคิวถ้าค้างเกิน 12 ชั่วโมง (กัน leak)

/**
 * อัพโหลดสลิปไป Flask
 * ถ้า imgBuffer ไม่มี (กรณี retry) จะดาวน์โหลดจาก LINE Content API ใหม่
 */
async function uploadSlipToFlask({ imgBuffer, userId, timestamp, messageId, slipData }) {
  // ถ้าไม่มี buffer → ดาวน์โหลดจาก LINE ใหม่ (กรณี retry)
  if (!imgBuffer) {
    const imgRes = await axios.get(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: { Authorization: `Bearer ${LINE_TOKEN}` },
        responseType: "arraybuffer",
        timeout: 30000,
      }
    );
    imgBuffer = Buffer.from(imgRes.data);
  }

  const qs = new URLSearchParams({
    user_id:        userId || "RECOVERY",
    timestamp:      String(timestamp || Date.now()),
    message_id:     messageId,
    slip_date:      slipData?.date      || "",
    slip_sender:    slipData?.sender    || "",
    slip_recipient: slipData?.recipient || "",
    slip_amount:    String(slipData?.amount || ""),
    slip_ref:       slipData?.ref       || "",
  }).toString();

  const saveRes = await axios.post(
    `${PO_LOCAL_URL}/save-slip?${qs}`,
    imgBuffer,
    {
      headers: {
        "X-PO-Secret": PO_SECRET,
        "Content-Type": "application/octet-stream",
        "ngrok-skip-browser-warning": "true",
      },
      timeout: 30000,
      maxBodyLength: 20 * 1024 * 1024,
    }
  );

  return saveRes.data?.filename || null;
}

/**
 * ลองส่งสลิปในคิวอีกครั้ง — รันทุก 5 นาที
 */
async function retryPendingSlips() {
  if (pendingSlips.size === 0) return;

  console.log(`🔄 retry pending slips: ${pendingSlips.size} รายการ`);

  const cutoff = Date.now() - RETRY_MAX_AGE_HOURS * 60 * 60 * 1000;

  for (const [messageId, info] of pendingSlips.entries()) {
    // ลบรายการที่ค้างนานเกินไป (รูปบน LINE หมดอายุ 14 วัน แต่เกินบางขนาดก็เลิกลอง)
    if (info.addedAt < cutoff) {
      console.log(`  ⏰ ลบจากคิว (เก่าเกิน ${RETRY_MAX_AGE_HOURS}h): ${messageId}`);
      pendingSlips.delete(messageId);
      continue;
    }

    try {
      const filename = await uploadSlipToFlask({
        imgBuffer: null,  // จะดาวน์โหลดใหม่
        userId:    info.userId,
        timestamp: info.timestamp,
        messageId,
        slipData:  info.slipData,
      });
      console.log(`  ✓ retry สำเร็จ: ${filename} (${messageId})`);
      pendingSlips.delete(messageId);
    } catch (err) {
      info.retries++;
      console.log(`  ✗ retry ครั้งที่ ${info.retries} ล้มเหลว: ${messageId} — ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────
//  Daily Summary v3 — mail documents + money slips
//  ยิงตอน 18:00 Asia/Bangkok ครอบช่วง 18:01 เมื่อวาน → 18:00 วันนี้ (24h เต็ม)
//  ใช้ /mail-doc-stats + /slip-stats ของ Flask แล้วส่งเข้า SLIP_GROUP_ID เป็นข้อความเดียว
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

async function fetchDailyStat(endpoint, today) {
  try {
    const res = await axios.get(
      `${PO_LOCAL_URL}/${endpoint}?period_end_date=${today}`,
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

function formatDailyStat(stat, unit) {
  if (stat.ok) return `${stat.count} ${unit}`;
  return `ตรวจไม่ได้ (${stat.error})`;
}

function shortText(value, maxLen = 38) {
  const text = String(value || "-").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function formatMailDocSummary(stat) {
  if (!stat.ok) return `📄 เอกสารจากเมล: ตรวจไม่ได้ (${stat.error})`;
  let text = `📄 เอกสารจากเมล: ${stat.count} ไฟล์`;
  const rows = Array.isArray(stat.rows) ? stat.rows : [];
  for (const [idx, row] of rows.slice(0, 5).entries()) {
    text += `\n${idx + 1}. ${shortText(row.entity, 24)} — ${shortText(row.filename, 46)}`;
  }
  if (stat.count > 5) text += `\n...และอีก ${stat.count - 5} ไฟล์`;
  return text;
}

async function sendDailySummary() {
  if (!SLIP_GROUP_ID) return;

  // วันที่วันนี้ตามเวลา BKK (สำหรับ period_end_date)
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  const yesterday = getYesterdayBkk(today);

  try {
    const [slipStat, mailDocStat] = await Promise.all([
      fetchDailyStat("slip-stats", today),
      fetchDailyStat("mail-doc-stats", today),
    ]);

    if (!slipStat.ok && !mailDocStat.ok) {
      console.error(
        `Daily summary skipped (period_end ${today}): ` +
        `mail_docs=${mailDocStat.error || "ERR"} slips=${slipStat.error || "ERR"}`
      );
      return;
    }

    await linePush(
      SLIP_GROUP_ID,
      `📊 สรุปประจำวัน\n` +
      `🕕 ${yesterday} 18:01 → ${today} 18:00\n` +
      `${formatMailDocSummary(mailDocStat)}\n` +
      `🧾 สลิปโอนเงิน: ${formatDailyStat(slipStat, "รูป")}`
    );
    console.log(
      `✓ ส่งสรุปรายวัน (period_end ${today}): ` +
      `mail_docs=${mailDocStat.ok ? mailDocStat.count : "ERR"} ` +
      `slips=${slipStat.ok ? slipStat.count : "ERR"}`
    );
  } catch (err) {
    console.error("Daily summary error:", err.message);
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

app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  const event  = events[0];

  console.log("EVENT =", JSON.stringify(req.body));

  if (!event || event.type !== "message") {
    return res.sendStatus(200);
  }

  const msgId = event.message.id;
  if (processedMsgIds.has(msgId)) {
    console.log(`Duplicate message ignored: ${msgId}`);
    return res.sendStatus(200);
  }
  processedMsgIds.add(msgId);
  setTimeout(() => processedMsgIds.delete(msgId), 5 * 60 * 1000);

  res.sendStatus(200);

  if (event.message.type === "image") {
    await handleSlipImage(event).catch(e => console.error("SlipImage error:", e.message));
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
  if (SLIP_GROUP_ID && event.source?.groupId === SLIP_GROUP_ID) return;

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
        const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        imageStore.set(id, image_b64);
        setTimeout(() => imageStore.delete(id), 60 * 60 * 1000);
        const imageUrl = `${RENDER_URL}/po-image/${id}`;
        try {
          await linePushImage(target, imageUrl);
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
  const bsendImage = async (imageUrl) => {
    if (!notifyTarget) {
      console.warn("[AUTO-SIGN] no notify target for image - set LINE_NOTIFY_TARGET or SLIP_GROUP_ID to a groupId");
      return;
    }
    try {
      await linePushImage(notifyTarget, imageUrl);
      console.log(`[AUTO-SIGN] push image OK to ${notifyTarget}`);
    } catch (e) {
      console.error(`[AUTO-SIGN] push image FAILED: ${e.response?.status} ${e.message}`);
    }
  };

  try {
    console.log(`[AUTO-SIGN] POST ${PO_LOCAL_URL}/sign-po (1 file)`);
    const signRes = await axios.post(
      `${PO_LOCAL_URL}/sign-po`,
      { requested_by: "auto-watcher", selected_files: [filename] },
      {
        headers: {
          "X-PO-Secret": PO_SECRET,
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true"
        },
        timeout: 180000
      }
    );

    const data = signRes.data;
    console.log(`[AUTO-SIGN] response: status=${data.status} signed=${data.signed?.length || 0} failed=${data.failed?.length || 0}`);

    if (data.status === "busy") {
      await bsend(`⚠️ กำลังลงลายเซ็นอยู่แล้วครับ\n👤 สั่งโดย: ${senderName}`);
      return;
    }
    if (data.status === "no_files") {
      await bsend(`✅ ไม่มี PO ที่รอลงลายเซ็นในขณะนี้ครับ`);
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

      const nasLine   = item.nas_ok
                          ? `📂 NAS: คัดลอกแล้ว ✓\n${item.nas_path ? `   ${item.nas_path}\n` : ""}`
                          : item.nas_error ? `📂 NAS: ล้มเหลว ✗ (${item.nas_error})\n` : "";
      const printLine = item.print_ok    ? "🖨️  ปริ้น: สั่งแล้ว ✓\n"
                      : item.print_error ? `🖨️  ปริ้น: ล้มเหลว ✗ (${item.print_error})\n` : "";
      const fileLine  = item.output_file ? `📄 ไฟล์: ${item.output_file}\n` : "";

      await bsend(
        `✅ เซ็น PO เสร็จแล้ว\n━━━━━━━━━━━━━━━\n` +
        `📄 PO: ${item.po_id}\n` + quotationLine + fileLine +
        `📅 เวลา: ${now}\n👤 สั่งโดย: ${senderName}\n` +
        nasLine + printLine + `━━━━━━━━━━━━━━━`
      );

      if (item.image_b64) {
        const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        imageStore.set(id, item.image_b64);
        setTimeout(() => imageStore.delete(id), 60 * 60 * 1000);
        await bsendImage(`${RENDER_URL}/po-image/${id}`);
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

app.get("/po-image/:id", (req, res) => {
  const data = imageStore.get(req.params.id);
  if (!data) return res.status(404).send("Not found or expired");
  const buf = Buffer.from(data, "base64");
  res.set("Content-Type", "image/jpeg");
  res.send(buf);
});

// ─────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);

  // Self-ping ทุก 14 นาที กัน Render free tier นอนหลับ
  setInterval(() => {
    axios.get(`${RENDER_URL}/`).catch(() => {});
    console.log("Self-ping to stay awake");
  }, 14 * 60 * 1000);

  // Auto-retry สลิปที่ค้างในคิว ทุก 5 นาที
  setInterval(retryPendingSlips, RETRY_INTERVAL_MS);
  console.log(`🔁 ตั้ง auto-retry pending slips ทุก ${RETRY_INTERVAL_MS / 60000} นาที`);

  // ยิงสรุปเอกสารจากเมล + สลิปประจำวัน 18:00 BKK (ครอบ 18:01 เมื่อวาน → 18:00 วันนี้)
  scheduleDailySummary();
});
