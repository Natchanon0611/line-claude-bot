"use strict";

// Keep headroom for the existing credit footer under LINE's 30 KB / 50 KB limits.
const MAX_BUBBLE_BYTES = 26000;
const MAX_CAROUSEL_BYTES = 46000;
const ROWS_PER_PAGE = 8;
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const text = (value, options = {}) => ({ type: "text", text: String(value || "-"), wrap: true, ...options });
const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function formatThaiDate(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return y && m && d ? d + " " + months[m - 1] + " " + (y + 543) : String(ymd);
}
function dailySummaryTotalCount(mail, line) {
  return (mail.ok ? Number(mail.count || 0) : 0) + (line.ok ? Number(line.count || 0) : 0);
}
function buildDailySummaryMessages(mail, line, today, yesterday, group = {}) {
  const rows = [];
  const warnings = [];
  for (const [stat, label] of [[mail, "อีเมล"], [line, "LINE"]]) {
    if (!stat.ok) {
      warnings.push(label + ": ตรวจรายการไม่ได้ชั่วคราว");
      continue;
    }
    const sourceRows = Array.isArray(stat.rows) ? stat.rows : [];
    rows.push(...sourceRows.map(row => ({ ...row, source: label })));
    if (Number(stat.count || 0) !== sourceRows.length) {
      warnings.push(label + ": ได้รายชื่อ " + sourceRows.length + " จาก " + stat.count + " ไฟล์ — ข้อมูลยังไม่ครบ");
    }
  }
  const total = dailySummaryTotalCount(mail, line);
  const company = group.label || "FES";
  const types = { image: "รูปภาพ/สลิป", file: "ไฟล์", video: "วิดีโอ", audio: "เสียง" };
  function bubble(pageRows, offset, pageNo, pageCount) {
    const body = warnings.map(message => text(message, { size: "xs", color: "#B00020", margin: "sm" }));
    if (!pageRows.length && !warnings.length) {
      body.push(text("ไม่มีไฟล์ใหม่ในช่วงเวลานี้", { size: "sm", color: "#888888" }));
    }
    pageRows.forEach((row, idx) => {
      const detail = row.source === "อีเมล" ? row.entity || "-" : types[row.message_type] || "ไฟล์";
      if (idx) body.push({ type: "separator", margin: "sm" });
      body.push({
        type: "box", layout: "vertical", margin: "sm", contents: [
          text((offset + idx + 1) + ". " + row.source + " • " + detail, { size: "xs", color: "#666666" }),
          text(row.filename, { size: "sm", color: "#1F1F1F", margin: "xs" }),
        ],
      });
    });
    return {
      type: "bubble", size: "giga",
      header: { type: "box", layout: "vertical", paddingAll: "lg", backgroundColor: "#F5F5F5", contents: [
        text("📥 สรุปไฟล์ที่ดาวน์โหลด • " + company, { weight: "bold", size: "md" }),
        text("📅 " + formatThaiDate(today) + " • หน้า " + pageNo + "/" + pageCount, { size: "sm", color: "#888888", margin: "sm" }),
        text("ทั้งหมด " + total + " ไฟล์" + (warnings.length ? " (ข้อมูลบางส่วนตรวจไม่ได้/ไม่ครบ)" : ""), { size: "sm", weight: "bold", color: "#0066CC", margin: "sm" }),
        text("อีเมล " + (mail.ok ? mail.count : "?") + " • LINE " + (line.ok ? line.count : "?"), { size: "xs", color: "#666666", margin: "xs" }),
        text(yesterday + " 18:01 → " + today + " 18:00", { size: "xxs", color: "#888888", margin: "xs" }),
      ] },
      body: { type: "box", layout: "vertical", paddingAll: "md", contents: body },
    };
  }

  const pages = [];
  let pageRows = [], offset = 0;
  for (const row of rows) {
    const candidate = [...pageRows, row];
    // Upper-bound page digits while partitioning; final numbering cannot be larger.
    if (pageRows.length && (candidate.length > ROWS_PER_PAGE || bytes(bubble(candidate, offset, rows.length, rows.length)) > MAX_BUBBLE_BYTES)) {
      pages.push({ rows: pageRows, offset });
      offset += pageRows.length;
      pageRows = [];
    }
    pageRows.push(row);
    if (bytes(bubble(pageRows, offset, rows.length, rows.length)) > MAX_BUBBLE_BYTES) {
      throw new Error("Daily summary row exceeds LINE bubble size");
    }
  }
  if (pageRows.length || !pages.length) pages.push({ rows: pageRows, offset });
  const bubbles = pages.map((page, index) => bubble(page.rows, page.offset, index + 1, pages.length));
  const messages = [];
  let carousel = [];
  const flush = () => {
    if (!carousel.length) return;
    messages.push({
      type: "flex",
      altText: "สรุปไฟล์ที่ดาวน์โหลด " + total + " ไฟล์ • " + formatThaiDate(today) + " • " + company,
      contents: carousel.length === 1 ? carousel[0] : { type: "carousel", contents: carousel },
    });
    carousel = [];
  };
  for (const item of bubbles) {
    if (carousel.length && (carousel.length === 12 || bytes({ type: "carousel", contents: [...carousel, item] }) > MAX_CAROUSEL_BYTES)) flush();
    carousel.push(item);
  }
  flush();
  return messages;
}

module.exports = { buildDailySummaryMessages, dailySummaryTotalCount };
