const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { buildDailySummaryMessages } = require("../daily_summary");
const empty = { ok: true, count: 0, rows: [] };
const stat = rows => ({ ok: true, count: rows.length, rows });
const dates = ["2026-11-18", "2026-11-17"];
function bubbles(messages) {
  return messages.flatMap(m => m.contents.type === "carousel" ? m.contents.contents : [m.contents]);
}
function filenames(messages) {
  return bubbles(messages).flatMap(b => b.body.contents.filter(c => c.type === "box").map(c => c.contents[1].text));
}
function fixtures(n, prefix = "slip") {
  return Array.from({ length: n }, (_, i) => ({ filename: prefix + "-" + i + "-สลิปโอนเงิน.jpg", message_type: "image" }));
}
test("all email and LINE filenames appear once including over ten images and full long names", () => {
  const mail = [{ entity: "ลูกค้า", filename: "ใบสั่งซื้อ".repeat(18) + ".pdf" }, ...fixtures(12, "mail")];
  const line = fixtures(23);
  const messages = buildDailySummaryMessages(stat(mail), stat(line), ...dates, { label: "FES" });
  assert.deepEqual(filenames(messages), [...mail, ...line].map(r => r.filename));
  assert.match(JSON.stringify(messages), /อีเมล/);
  assert.match(JSON.stringify(messages), /รูปภาพ\/สลิป/);
  assert.match(messages[0].altText, /36 ไฟล์/);
  assert.equal(bubbles(messages).length, 5);
});
test("large Thai file lists fit LINE limits without truncation", () => {
  const rows = fixtures(1300).map(r => ({ ...r, filename: r.filename + "ก".repeat(230) }));
  const messages = buildDailySummaryMessages(empty, stat(rows), ...dates);
  assert.deepEqual(filenames(messages), rows.map(r => r.filename));
  assert.ok(messages.length > 5);
  for (const message of messages) {
    assert.ok(Buffer.byteLength(JSON.stringify(message.contents)) < 46000);
    if (message.contents.type === "carousel") assert.ok(message.contents.contents.length <= 12);
  }
  for (const b of bubbles(messages)) assert.ok(Buffer.byteLength(JSON.stringify(b)) < 26000);
});
test("failed or incomplete stats are visible, not reported as an empty successful list", () => {
  const messages = buildDailySummaryMessages({ ok: false }, { ok: true, count: 3, rows: fixtures(1) }, ...dates);
  assert.match(JSON.stringify(messages), /อีเมล: ตรวจรายการไม่ได้/);
  assert.match(JSON.stringify(messages), /ได้รายชื่อ 1 จาก 3/);
  assert.deepEqual(filenames(messages), fixtures(1).map(r => r.filename));
});
test("empty day has a readable page", () => {
  assert.match(JSON.stringify(buildDailySummaryMessages(empty, empty, ...dates)), /ไม่มีไฟล์ใหม่/);
});
function harness({ mail = empty, line = stat(fixtures(1)), sendEmpty = false, failLine = false, failPush = false } = {}) {
  const entry = path.join(__dirname, "..", "index.js");
  const appRequire = createRequire(entry);
  const pushes = [], gets = [], logs = [];
  let decorations = 0;
  const http = {
    async get(url) {
      gets.push(url);
      assert.doesNotMatch(url, /ampohm|Camp/);
      if (url.includes("/line-inbox-stats?")) { if (failLine) throw new Error("unavailable"); return { data: line }; }
      if (url.includes("/mail-doc-stats?")) return { data: mail };
      throw new Error("Unexpected GET " + url);
    },
    async post(url, body) {
      assert.equal(url, "https://api.line.me/v2/bot/message/push");
      assert.equal(body.to, "Cfes");
      assert.ok(body.messages.length <= 5);
      pushes.push(JSON.parse(JSON.stringify(body)));
      if (failPush) throw new Error("LINE unavailable");
      return { data: {} };
    },
  };
  const context = vm.createContext({
    require(name) {
      if (name === "axios") return http;
      if (name === "./notification_credit") return { createCreditDecorator: () => ({
        async flex(contents) { decorations++; return contents; },
      }) };
      return appRequire(name);
    },
    module: { exports: {} }, __dirname: path.dirname(entry), Buffer, URLSearchParams,
    console: { log(...args) { logs.push(args.join(" ")); }, warn() {}, error() {} },
    setTimeout() { throw new Error("Unexpected timer"); }, setInterval() { throw new Error("Unexpected service"); },
    process: { env: {
      PO_SECRET: "test", LINE_CHANNEL_SECRET: "test", LINE_TOKEN: "test",
      SLIP_GROUP_ID: "Cfes", AMPOHM_GROUP_ID: "Camp", DAILY_SUMMARY_SEND_EMPTY: String(sendEmpty),
    }, exit() { throw new Error("Unexpected exit"); } },
  });
  vm.runInContext(fs.readFileSync(entry, "utf8"), context, { filename: entry });
  return { pushes, gets, logs, decorations: () => decorations, run: () => vm.runInContext("sendDailySummary()", context),
    groups: () => vm.runInContext("getLineAttachmentGroups()", context) };
}
test("daily summary sends all FES files; AmpOhm stays available for intake but has no summary calls", async () => {
  const rows = fixtures(1300);
  const h = harness({ line: stat(rows) });
  await h.run();
  assert.ok(h.groups().some(g => g.company === "ampohm"));
  assert.equal(h.gets.length, 2);
  assert.ok(h.pushes.length > 1);
  assert.deepEqual(filenames(h.pushes.flatMap(p => p.messages)), rows.map(r => r.filename));
  assert.equal(h.decorations(), 1);
});
test("empty FES day skips unless explicitly enabled; never sends AmpOhm", async () => {
  const h = harness({ line: empty });
  await h.run();
  assert.equal(h.pushes.length, 0);
  const enabled = harness({ line: empty, sendEmpty: true });
  await enabled.run();
  assert.equal(enabled.pushes.length, 1);
});
test("partial source failure still sends available files with warning", async () => {
  const h = harness({ mail: stat([{ filename: "invoice.pdf" }]), failLine: true });
  await h.run();
  assert.deepEqual(filenames(h.pushes[0].messages), ["invoice.pdf"]);
  assert.match(JSON.stringify(h.pushes), /LINE: ตรวจรายการไม่ได้/);
});
test("failed push does not log a successful summary", async () => {
  const h = harness({ failPush: true });
  await h.run();
  assert.equal(h.pushes.length, 1);
  assert.ok(!h.logs.some(log => log.includes("✓")));
});
