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
function fixtures(n, prefix = "document") {
  return Array.from({ length: n }, (_, i) => ({ filename: prefix + "-" + i + "-เอกสาร.pdf", message_type: "file" }));
}
const imageFixtures = n => Array.from({ length: n }, (_, i) => ({ filename: "line-slip-" + i + ".jpg", message_type: "image" }));
test("email attachments and other LINE filenames appear once with full long names", () => {
  const mail = [{ entity: "ลูกค้า", filename: "ใบสั่งซื้อ".repeat(18) + ".pdf" }, ...imageFixtures(12)];
  const line = fixtures(23);
  const messages = buildDailySummaryMessages(stat(mail), stat(line), ...dates, { label: "FES" });
  assert.deepEqual(filenames(messages), [...mail, ...line].map(r => r.filename));
  assert.match(JSON.stringify(messages), /อีเมล/);
  assert.doesNotMatch(JSON.stringify(messages), /รูปภาพ\/สลิป LINE/);
  assert.match(messages[0].altText, /36 ไฟล์/);
  assert.equal(bubbles(messages).length, 5);
});
test("LINE images/slips use a count without filename rows or extra pages", () => {
  const images = imageFixtures(1300);
  const lineFiles = [{ filename: "invoice.pdf", message_type: "file" },
    { filename: "photo-attachment.jpg", message_type: "file" },
    { filename: "unknown.jpg" }, { filename: "video.mp4", message_type: "video" },
    { filename: "audio.m4a", message_type: "audio" }];
  const mail = [{ filename: "Desktop.zip", entity: "ลีสซิ่งกสิกรไทย" }];
  const messages = buildDailySummaryMessages(stat(mail), stat([...images, ...lineFiles]), ...dates);
  assert.deepEqual(filenames(messages), [...mail, ...lineFiles].map(row => row.filename));
  assert.equal(bubbles(messages).length, 1);
  assert.match(JSON.stringify(messages), /รูปภาพ\/สลิป LINE 1300 ไฟล์/);
  assert.match(JSON.stringify(messages), /อีเมล 1 • LINE 1305/);
  assert.doesNotMatch(JSON.stringify(messages), /line-slip-|ข้อมูลยังไม่ครบ/);
  assert.match(messages[0].altText, /1306 ไฟล์/);
  const numbers = bubbles(messages)[0].body.contents.filter(c => c.type === "box").map(c => c.contents[0].text.split(".")[0]);
  assert.deepEqual(numbers, ["1", "2", "3", "4", "5", "6"]);

  const onlyImages = buildDailySummaryMessages(empty, stat(images), ...dates);
  assert.deepEqual(filenames(onlyImages), []);
  assert.match(JSON.stringify(onlyImages), /รูปภาพ\/สลิป LINE 1300 ไฟล์/);
  assert.doesNotMatch(JSON.stringify(onlyImages), /ไม่มีไฟล์ใหม่/);
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
  const messages = buildDailySummaryMessages({ ok: false }, { ok: true, count: 3, rows: imageFixtures(1) }, ...dates);
  assert.match(JSON.stringify(messages), /อีเมล: ตรวจรายการไม่ได้/);
  assert.match(JSON.stringify(messages), /ได้รายชื่อ 1 จาก 3/);
  assert.deepEqual(filenames(messages), []);
  assert.match(JSON.stringify(messages), /รูปภาพ\/สลิป LINE 1 ไฟล์/);
});
test("empty day has a readable page", () => {
  assert.match(JSON.stringify(buildDailySummaryMessages(empty, empty, ...dates)), /ไม่มีไฟล์ใหม่/);
});
function harness({ mail = empty, line = stat(fixtures(1)), sendEmpty = false, failMail = false, failLine = false, failPush = false } = {}) {
  const entry = path.join(__dirname, "..", "index.js");
  const appRequire = createRequire(entry);
  const pushes = [], gets = [], logs = [];
  let decorations = 0;
  const http = {
    async get(url) {
      gets.push(url);
      assert.doesNotMatch(url, /ampohm|Camp/);
      if (url.includes("/line-inbox-stats?")) { if (failLine) throw new Error("unavailable"); return { data: line }; }
      if (url.includes("/mail-doc-stats?")) { if (failMail) throw new Error("mail unavailable"); return { data: mail }; }
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
test("daily summary paginates other FES files; AmpOhm stays available for intake but has no summary calls", async () => {
  const rows = fixtures(1300);
  const mail = [{ entity: "Test supplier", filename: "invoice.pdf" }];
  const h = harness({ mail: stat(mail), line: stat(rows) });
  await h.run();
  assert.ok(h.groups().some(g => g.company === "ampohm"));
  assert.equal(h.gets.length, 2);
  assert.ok(h.pushes.length > 1);
  assert.deepEqual(filenames(h.pushes.flatMap(p => p.messages)), [...mail, ...rows].map(r => r.filename));
  assert.equal(h.decorations(), 1);
});
test("LINE-only and empty days stay quiet even if SEND_EMPTY is enabled", async () => {
  for (const line of [empty, stat(fixtures(5)), stat(imageFixtures(5))]) {
    for (const sendEmpty of [false, true]) {
      const h = harness({ line, sendEmpty });
      await h.run();
      assert.equal(h.pushes.length, 0);
      assert.equal(h.decorations(), 0);
      assert.ok(h.logs.some(log => log.includes("no confirmed mail downloads")));
    }
  }
});
test("one downloaded mail file triggers a summary without any LINE files", async () => {
  const h = harness({ mail: stat([{ filename: "invoice.pdf" }]), line: empty });
  await h.run();
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(filenames(h.pushes[0].messages), ["invoice.pdf"]);
  assert.equal(h.decorations(), 1);
});
test("one email file plus five LINE slips lists only the email and keeps all six in totals", async () => {
  const mail = [{ filename: "Desktop.zip" }];
  const line = imageFixtures(5);
  const h = harness({ mail: stat(mail), line: stat(line) });
  await h.run();
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(filenames(h.pushes[0].messages), ["Desktop.zip"]);
  assert.match(h.pushes[0].messages[0].altText, /6 ไฟล์/);
  assert.match(JSON.stringify(h.pushes), /รูปภาพ\/สลิป LINE 5 ไฟล์/);
  assert.doesNotMatch(JSON.stringify(h.pushes), /line-slip-/);
  assert.equal(h.decorations(), 1);
});
test("mail lookup failure never triggers a LINE-only or empty summary", async () => {
  for (const failLine of [false, true]) {
    const h = harness({ failMail: true, failLine, sendEmpty: true });
    await h.run();
    assert.equal(h.pushes.length, 0);
    assert.equal(h.decorations(), 0);
  }
});
test("invalid mail counts are not interpreted as downloaded files", async () => {
  for (const count of [-1, 0.5, "1", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness({ mail: { ok: true, count, rows: [] } });
    await h.run();
    assert.equal(h.pushes.length, 0);
    assert.equal(h.decorations(), 0);
  }
});
test("partial source failure still sends available files with warning", async () => {
  const h = harness({ mail: stat([{ filename: "invoice.pdf" }]), failLine: true });
  await h.run();
  assert.deepEqual(filenames(h.pushes[0].messages), ["invoice.pdf"]);
  assert.match(JSON.stringify(h.pushes), /LINE: ตรวจรายการไม่ได้/);
});
test("failed push does not log a successful summary", async () => {
  const h = harness({ mail: stat([{ filename: "invoice.pdf" }]), failPush: true });
  await h.run();
  assert.equal(h.pushes.length, 1);
  assert.ok(!h.logs.some(log => log.includes("✓")));
});
