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

test("appends job credit and remaining monthly messages in the SAME text", async () => {
  const http = mockHttp();
  const text = await make(http).text("✅ เซ็น PO เสร็จแล้ว", credit);
  assert.match(text, /^✅ เซ็น PO เสร็จแล้ว/);
  assert.match(text, /งานนี้: ≈\$0.015000/);
  assert.match(text, /≈\$19.970000/);
  assert.match(text, /เหลือ ≈377\/500 ข้อความ/);
  assert.equal(http.calls.length, 2); // read-only quota endpoints, no extra push
  assert.ok(http.calls.every(c => c.config.timeout <= 3000));
});

test("long notifications reserve footer space within 2000 characters", async () => {
  const text = await make(mockHttp()).text("PO ".repeat(2000), credit);
  assert.equal(text.length, 2000);
  assert.match(text, /LINE เดือนนี้/);
  assert.ok(text.endsWith("อาจอัปเดตช้า"));
});

test("quota errors do not suppress existing message or invent remaining credit", async () => {
  const text = await make(mockHttp({ fail: true })).text("Original alert");
  assert.ok(text.startsWith("Original alert"));
  assert.match(text, /Claude: ตรวจสอบยอดไม่ได้/);
  assert.match(text, /LINE คงเหลือ: ตรวจสอบไม่ได้/);
  assert.doesNotMatch(text, /เหลือ ≈0/);
});

test("no configured target limit is not shown as an infinite balance", async () => {
  const text = await make(mockHttp({ type: "none" })).text("alert", credit);
  assert.match(text, /ไม่ได้ตั้งเพดานโควตา/);
  assert.doesNotMatch(text, /Infinity|unlimited/);
});

test("over-quota values clamp remaining to zero and malformed values are unavailable", async () => {
  const exhausted = await make(mockHttp({ totalUsage: 600 })).text("alert", credit);
  assert.match(exhausted, /เหลือ ≈0\/500/);
  const invalid = await make(mockHttp({ totalUsage: null })).text("alert", credit);
  assert.match(invalid, /LINE คงเหลือ: ตรวจสอบไม่ได้/);
});

test("unknown model cost does not claim a complete remaining Claude balance", () => {
  const lines = creditLines({ ...credit, estimate_complete: false }, null).join("\n");
  assert.match(lines, /Claude เหลือโดยประมาณ: ไม่ทราบ/);
});

test("credit-exhausted alert retains its existing summary without duplicates", async () => {
  const text = await make(mockHttp()).text("🚨 เครดิต Claude API หมด\nใช้สะสมที่ระบบนับ: 1", credit);
  assert.doesNotMatch(text, /Claude ใช้สะสมที่นับ/);
  assert.match(text, /LINE เดือนนี้/);
});

test("daily summary gets a footer in the existing bubble without mutating input", async () => {
  const bubble = { type: "bubble", body: { type: "box", layout: "vertical", contents: [] } };
  const result = await make(mockHttp()).flex(bubble, credit);
  assert.equal(bubble.footer, undefined);
  assert.match(result.footer.contents[0].text, /LINE เดือนนี้/);
  assert.equal(result.type, "bubble");
});

test("does not reuse monthly quotas after a notification", async () => {
  const http = mockHttp();
  const decorator = make(http);
  await decorator.text("one", credit);
  await decorator.text("two", credit);
  assert.equal(http.calls.length, 4);
});

test("existing mail route and Auto PO each send exactly one decorated text", async () => {
  // Execute the real route code with in-memory Express/HTTP adapters.
  // No dependency installation, server, LINE request or Claude request.
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const routes = new Map();
  const app = { use() {}, get(route, handler) { routes.set(route, handler); }, post(route, handler) { routes.set(route, handler); } };
  const express = () => app;
  express.json = () => () => {};
  const calls = [];
  const http = mockHttp();
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
    process: { env: { PO_SECRET: "test-secret", LINE_NOTIFY_TARGET: "Ctest-group" } },
    console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, setInterval, clearTimeout,
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
    assert.match(body.messages[0].text, /งานนี้: ≈\$0.015000/);
    assert.match(body.messages[0].text, /เหลือ ≈377\/500/);
  }
  assert.match(calls[1].messages[0].text, /เซ็น PO เสร็จแล้ว/);
  const diagnostic = routes.get("/notification-credit-status");
  const res = { code: 200, body: null, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
  await diagnostic({ headers: {} }, res);
  assert.equal(res.code, 401);
  res.code = 200;
  await diagnostic({ headers: { "x-po-secret": "test-secret" } }, res);
  assert.equal(res.body.line.used, 123);
  assert.equal(calls.length, 2); // checking the balance sends no messages
});
