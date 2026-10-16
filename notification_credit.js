// Credits decorate existing notifications; this module never sends messages.
const LINE_API = "https://api.line.me/v2/bot/message";

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function usd(value) {
  const n = numberOrNull(value);
  return n === null ? "ไม่ทราบ" : `≈$${n.toFixed(6)}`;
}

function creditLines(credit, quota, { includeClaude = true } = {}) {
  const lines = [];
  if (includeClaude) {
    if (credit && typeof credit === "object") {
      if (Object.hasOwn(credit, "job_estimated_usd")) {
        lines.push(`💳 Claude งานนี้: ${usd(credit.job_estimated_usd)}`);
      }
      lines.push(`Claude ใช้สะสมที่นับ: ${usd(credit.total_estimated_usd)}`);
      const budget = numberOrNull(credit.budget_usd);
      const remaining = credit.estimate_complete === false ? null : credit.remaining_estimated_usd;
      lines.push(`Claude เหลือโดยประมาณ: ${usd(remaining)}` +
        (budget === null ? "" : ` (ตั้งต้น $${budget.toFixed(2)})`));
      lines.push("เฉพาะที่ระบบนับ ไม่ใช่ยอดบัญชีจริง");
    } else {
      lines.push("💳 Claude: ตรวจสอบยอดไม่ได้ชั่วคราว");
    }
  }
  if (quota && numberOrNull(quota.used) !== null) {
    const used = quota.used.toLocaleString("en-US");
    if (quota.type === "limited") {
      const limit = quota.limit.toLocaleString("en-US");
      const remaining = Math.max(0, quota.limit - quota.used).toLocaleString("en-US");
      lines.push(`💬 LINE เดือนนี้: ใช้ ≈${used} | เหลือ ≈${remaining}/${limit} ข้อความ`);
    } else {
      lines.push(`💬 LINE เดือนนี้: ใช้ ≈${used} ข้อความ | ไม่ได้ตั้งเพดานโควตา`);
    }
    lines.push("ยอด LINE ก่อนส่งจาก API อาจอัปเดตช้า");
  } else {
    lines.push("💬 LINE คงเหลือ: ตรวจสอบไม่ได้ชั่วคราว");
  }
  return lines;
}

function appendCreditText(text, lines, maxLength = 2000) {
  const footer = "\n━━━━━━━━━━━━━━━\n" + lines.join("\n");
  const body = String(text || "");
  const available = Math.max(0, maxLength - footer.length);
  // Reserve space for the footer rather than truncating it off long PO alerts.
  return (body.length > available ? body.slice(0, available - 1) + "…" : body) + footer;
}

function createCreditDecorator({ http, lineToken, localUrl, secret }) {
  let pendingQuota = null;
  async function fetchQuota() {
    // Coalesce simultaneous notifications only; never reuse a stale monthly
    // count after a send or display a made-up per-group charge.
    if (pendingQuota) return pendingQuota;
    pendingQuota = (async () => {
      try {
        const config = { headers: { Authorization: `Bearer ${lineToken}` }, timeout: 2500 };
        const [limitResponse, usageResponse] = await Promise.all([
          http.get(`${LINE_API}/quota`, config),
          http.get(`${LINE_API}/quota/consumption`, config),
        ]);
        const type = limitResponse.data?.type;
        const used = numberOrNull(usageResponse.data?.totalUsage);
        const limit = numberOrNull(limitResponse.data?.value);
        if (used === null || !["limited", "none"].includes(type) || (type === "limited" && limit === null)) return null;
        return { type, used, limit };
      } catch {
        // Quota failures must not prevent the original business notification.
        return null;
      }
    })();
    try { return await pendingQuota; }
    finally { pendingQuota = null; }
  }
  async function fetchCredit() {
    try {
      const response = await http.get(`${localUrl}/credit-status`, {
        headers: { "X-PO-Secret": secret, "ngrok-skip-browser-warning": "true" },
        timeout: 2500,
      });
      return response.data && typeof response.data === "object" ? response.data : null;
    } catch { return null; }
  }
  async function snapshot(credit) {
    const [summary, quota] = await Promise.all([
      credit && typeof credit === "object" ? credit : fetchCredit(), fetchQuota(),
    ]);
    return { claude: summary, line: quota };
  }
  async function lines(credit, options) {
    const status = await snapshot(credit);
    return creditLines(status.claude, status.line, options);
  }
  return {
    snapshot,
    async text(text, credit) {
      // The exhausted-credit alert already has its own more specific summary.
      const includeClaude = !String(text).startsWith("🚨 เครดิต Claude API หมด");
      return appendCreditText(text, await lines(credit, { includeClaude }));
    },
    async flex(contents, credit) {
      const copy = JSON.parse(JSON.stringify(contents));
      const bubble = copy.type === "carousel" ? copy.contents.at(-1) : copy;
      const footer = await lines(credit);
      if (bubble?.type === "bubble") {
        const section = bubble.footer || { type: "box", layout: "vertical", contents: [] };
        section.contents.push({ type: "text", text: footer.join("\n"), size: "xxs", wrap: true, margin: "md", color: "#666666" });
        bubble.footer = section;
      }
      return copy;
    },
  };
}

module.exports = { createCreditDecorator, creditLines, appendCreditText };
