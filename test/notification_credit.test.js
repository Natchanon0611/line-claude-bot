const test = require("node:test");
const assert = require("node:assert/strict");
const { createCreditDecorator, creditLines } = require("../notification_credit");

const credit = { budget_usd: "20", total_estimated_usd: "0.03", remaining_estimated_usd: "19.97",
  job_estimated_usd: "0.015", estimate_complete: true };
function mockHttp({ type = "limited", value = 500, totalUsage = 123, fail = false } = {}) {
  const calls = [];
  return { calls, async get(url, config) {
    calls.push({ url, config });
    if (fail) throw new Error("offline");
    if (url.endsWith("/quota/consumption")) return { data: { totalUsage } };
    if (url.endsWith("/quota")) return { data: { type, value } };
    if (url.endsWith("/credit-status")) return { data: credit };
    throw new Error("Unexpected URL");
  } };
}
const make = (http) => createCreditDecorator({ http, lineToken: "test-only", secret: "local-test", localUrl: "http://local.test" });
const bubble = () => ({ type: "bubble", body: { type: "box", layout: "vertical", contents: [] } });
async function dailyFooter(http, summary) {
  const result = await make(http).flex(bubble(), summary);
  return result.footer.contents[0].text;
}

test("routine text stays unchanged and never fetches Claude or LINE balances", async () => {
  const http = mockHttp();
  const text = await make(http).text("✅ เซ็น PO เสร็จแล้ว", credit);
  assert.equal(text, "✅ เซ็น PO เสร็จแล้ว");
  assert.equal(http.calls.length, 0);
});

test("daily footer includes cumulative Claude credit and monthly LINE balance", async () => {
  const http = mockHttp();
  const summary = { ...credit };
  const text = await dailyFooter(http, summary);
  assert.equal(text, "💳 Claude (ระบบนับ): ใช้สะสม ≈$0.03 | เหลือ ≈$19.97\n💬 LINE เดือนนี้: เหลือ ≈377/500 (ก่อนส่ง)");
  assert.doesNotMatch(text, /งานนี้|ตั้งต้น/);
  assert.equal(http.calls.length, 2); // read-only quota endpoints, no extra push
  assert.ok(http.calls.every(c => c.config.timeout <= 3000));
});

test("long routine notifications use the full 2000 characters without a footer", async () => {
  const text = await make(mockHttp()).text("PO ".repeat(2000), credit);
  assert.equal(text, "PO ".repeat(2000).slice(0, 2000));
});

test("daily quota errors do not suppress the summary or invent remaining credit", async () => {
  const text = await dailyFooter(mockHttp({ fail: true }));
  assert.match(text, /Claude: ตรวจสอบยอดไม่ได้/);
  assert.match(text, /LINE คงเหลือ: ตรวจสอบไม่ได้/);
  assert.doesNotMatch(text, /เหลือ ≈0/);
});

test("no configured target limit is not shown as an infinite balance", async () => {
  const text = await dailyFooter(mockHttp({ type: "none" }), credit);
  assert.match(text, /ไม่ได้ตั้งเพดานโควตา/);
  assert.doesNotMatch(text, /Infinity|unlimited/);
});

test("over-quota values clamp remaining to zero and malformed values are unavailable", async () => {
  const exhausted = await dailyFooter(mockHttp({ totalUsage: 600 }), credit);
  assert.match(exhausted, /เหลือ ≈0\/500/);
  const invalid = await dailyFooter(mockHttp({ totalUsage: null }), credit);
  assert.match(invalid, /LINE คงเหลือ: ตรวจสอบไม่ได้/);
});

test("unknown model cost does not claim a complete remaining Claude balance", () => {
  const lines = creditLines({ ...credit, estimate_complete: false }, null).join("\n");
  assert.match(lines, /Claude \(ระบบนับ\): ใช้สะสม ≈\$0.03 \| เหลือ ไม่ทราบ/);
});

test("credit-exhausted alert retains its existing summary without duplicates", async () => {
  const text = await make(mockHttp()).text("🚨 เครดิต Claude API หมด\nใช้สะสมที่ระบบนับ: 1", credit);
  assert.equal(text, "🚨 เครดิต Claude API หมด\nใช้สะสมที่ระบบนับ: 1");
});

test("daily summary gets a footer in the existing bubble without mutating input", async () => {
  const bubble = { type: "bubble", body: { type: "box", layout: "vertical", contents: [] } };
  const result = await make(mockHttp()).flex(bubble, credit);
  assert.equal(bubble.footer, undefined);
  assert.match(result.footer.contents[0].text, /LINE เดือนนี้/);
  assert.equal(result.type, "bubble");
});

test("does not reuse monthly quotas between daily summaries", async () => {
  const http = mockHttp();
  const decorator = make(http);
  await decorator.flex(bubble(), credit);
  await decorator.flex(bubble(), credit);
  assert.equal(http.calls.length, 4);
});

test("mail and Auto PO stay plain while the scheduled daily summary includes balances", async () => {
  // Execute the real route code with in-memory Express/HTTP adapters.
  // No dependency installation, server, LINE request or Claude request.
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const routes = new Map();
  const app = { use() {}, get(route, handler) { routes.set(route, handler); }, post(route, ...handlers) { routes.set(route, handlers.at(-1)); } };
  const express = () => app;
  express.json = () => () => {};
  express.raw = () => () => {};
  const calls = [];
  const http = mockHttp();
  const getBalance = http.get.bind(http);
  http.get = async (url, config) => {
    if (url.includes("/line-inbox-stats?")) return { data: { count: 2, rows: [] } };
    if (url.includes("/mail-doc-stats?")) return { data: { count: 1, rows: [{ entity: "FFT", filename: "PO123.pdf" }] } };
    return getBalance(url, config);
  };
  http.post = async (url, body) => {
    if (url.endsWith("/sign-po")) return { data: {
      status: "success", signed: [{ input_file: "PO123.pdf", po_id: "PO123", credit }], failed: [],
    } };
    if (!url.endsWith("/message/push")) throw new Error("Unexpected request");
    calls.push(body);
    return { data: {} };
  };
  const indexPath = path.join(__dirname, "..", "index.js");
  const sandbox = {
    require(name) {
      if (name === "axios") return http;
      if (name === "express") return express;
      return require(name.startsWith(".") ? path.resolve(path.dirname(indexPath), name) : name);
    },
    module: { exports: {} }, __dirname: path.dirname(indexPath),
    process: { env: { PO_SECRET: "test-secret", LINE_CHANNEL_SECRET: "test-channel-secret", LINE_NOTIFY_TARGET: "Ctest-group",
      SLIP_GROUP_ID: "Ctest-group", AMPOHM_GROUP_ID: "disabled" } },
    console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, setInterval, clearTimeout,
    URLSearchParams,
  };
  vm.runInNewContext(fs.readFileSync(indexPath, "utf8"), sandbox, { filename: indexPath });
  async function post(route, body) {
    const res = { code: 200, body: null, status(code) { this.code = code; return this; },
      json(value) { this.body = value; return this; } };
    await routes.get(route)({ body }, res);
    return res;
  }
  const unauthorized = await post("/po-mail-result", { secret: "wrong", text: "must not send" });
  assert.equal(unauthorized.code, 401);
  assert.equal(calls.length, 0);
  const mail = await post("/po-mail-result", { secret: "test-secret", text: "Existing mail result", credit });
  assert.equal(mail.body.status, "ok");
  await post("/auto-sign-po", { secret: "test-secret", filename: "PO123.pdf" });
  assert.equal(calls.length, 2);
  for (const body of calls) {
    assert.equal(body.messages.length, 1);
    assert.doesNotMatch(body.messages[0].text, /Claude|LINE เดือนนี้|ตั้งต้น|งานนี้/);
  }
  assert.equal(http.calls.length, 0);
  assert.equal(calls[0].messages[0].text, "Existing mail result");
  assert.match(calls[1].messages[0].text, /เซ็น PO เสร็จแล้ว/);
  await sandbox.sendDailySummary();
  assert.equal(calls.length, 3);
  const daily = calls[2].messages;
  assert.equal(daily.length, 1);
  assert.equal(daily[0].type, "flex");
  assert.match(daily[0].altText, /สรุปดาวน์โหลด 3 ไฟล์/);
  assert.match(JSON.stringify(daily[0].contents), /PO123.pdf/);
  assert.match(daily[0].contents.footer.contents[0].text, /Claude \(ระบบนับ\): ใช้สะสม/);
  assert.match(daily[0].contents.footer.contents[0].text, /เหลือ ≈377\/500/);
  assert.equal(daily[0].contents.footer.contents[0].text.split("\n").length, 2);
  const diagnostic = routes.get("/notification-credit-status");
  const res = { code: 200, body: null, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
  await diagnostic({ headers: {} }, res);
  assert.equal(res.code, 401);
  res.code = 200;
  await diagnostic({ headers: { "x-po-secret": "test-secret" } }, res);
  assert.equal(res.body.line.used, 123);
  assert.equal(calls.length, 3); // checking the balance sends no messages
});
