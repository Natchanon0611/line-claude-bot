const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const entry = path.join(__dirname, '..', 'index.js');
const appRequire = createRequire(entry);
const original = Buffer.from('original fixture').toString('base64');
const preview = Buffer.from('preview fixture').toString('base64');
const po = { po_id: 'PO123', output_file: 'PO123.pdf', image_b64: original, preview_b64: preview };

// Execute the actual app and routes with no credentials, network, disk writes or timers.
function harness({ signed = [po], target = 'Ctest', failPush = false } = {}) {
  const pushes = [];
  const files = new Map();
  const axios = {
    async get(url) {
      if (url.endsWith('/quota')) return { data: { type: 'limited', value: 300 } };
      if (url.endsWith('/quota/consumption')) return { data: { totalUsage: 0 } };
      if (url.endsWith('/credit-status')) return { data: {} };
      throw new Error(`Unexpected GET: ${url}`);
    },
    async post(url, body) {
      if (url === 'https://api.line.me/v2/bot/message/push') {
        pushes.push(JSON.parse(JSON.stringify(body)));
        if (failPush) throw Object.assign(new Error('monthly limit'), { response: { status: 429 } });
        return { data: {} };
      }
      if (url === 'https://local.invalid/sign-po') return { data: { status: 'success', signed } };
      throw new Error(`Unexpected POST: ${url}`);
    },
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'axios') return axios;
      if (name === 'fs') return {
        mkdirSync() {}, writeFileSync(file, bytes) { files.set(file, bytes); },
        existsSync(file) { return files.has(file); }, readFileSync(file) { return files.get(file); },
      };
      return appRequire(name);
    },
    module: { exports: {} }, __dirname: path.dirname(entry), Buffer,
    console: { log() {}, warn() {}, error() {} },
    setTimeout() { return 1; },
    setInterval() { throw new Error('Unexpected background service'); },
    process: { env: {
      PO_SECRET: 'test-secret', LINE_CHANNEL_SECRET: 'test-channel-secret', LINE_TOKEN: 'test-token',
      LINE_NOTIFY_TARGET: target, PO_LOCAL_URL: 'https://local.invalid', RENDER_URL: 'https://bot.invalid',
    }, exit() { throw new Error('Unexpected exit'); } },
  });
  vm.runInContext(fs.readFileSync(entry, 'utf8'), context, { filename: entry });
  return {
    pushes, files,
    sign: vm.runInContext('processPOSignResult', context),
    async route(url, body) {
      const layer = context.module.exports.app._router.stack.find((x) => x.route?.path === url);
      assert.ok(layer, `Missing route ${url}`);
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
      await layer.route.stack[0].handle({ body: { secret: 'test-secret', ...body } }, response);
      return response;
    },
  };
}

function assertBundle(h, expectedText, expectedPreview = preview) {
  assert.equal(h.pushes.length, 1, 'one LINE request for text and image');
  const payload = h.pushes[0];
  assert.equal(payload.to, 'Ctest');
  assert.deepEqual(payload.messages.map((m) => m.type), ['text', 'image']);
  assert.match(payload.messages[0].text, expectedText);
  const image = payload.messages[1];
  assert.match(image.originalContentUrl, /^https:\/\/bot\.invalid\/po-image\/[^/]+$/);
  assert.equal(image.previewImageUrl, image.originalContentUrl + '/preview');
  const id = image.originalContentUrl.split('/').pop();
  const stored = [...h.files.entries()];
  assert.ok(stored.some(([file, data]) => file.endsWith(`${id}.original.jpg`) && data.equals(Buffer.from(original, 'base64'))));
  assert.ok(stored.some(([file, data]) => file.endsWith(`${id}.preview.jpg`) && data.equals(Buffer.from(expectedPreview, 'base64'))));
}

test('new PO sends text and distinct original/preview images together', async () => {
  const h = harness();
  await h.route('/notify-new-po', { filename: 'PO123.pdf', ...po });
  assertBundle(h, /มี PO ใหม่.*\n.*PO123.pdf/);
});

test('manual signing result sends one bundle', async () => {
  const h = harness();
  await h.sign({ status: 'success', signed: [po] }, 'tester', 'Ctest');
  assertBundle(h, /เซ็น PO เสร็จแล้ว/);
});

test('confirmation request keeps instructions and image in one bundle', async () => {
  const h = harness();
  await h.sign({ status: 'success', signed: [{ ...po, needs_confirmation: true }] }, 'tester', 'Ctest');
  assertBundle(h, /ยืนยัน.*ส่งเมล[\s\S]*ยกเลิก/);
});

test('auto-sign result sends one bundle', async () => {
  const h = harness();
  const response = await h.route('/auto-sign-po', { filename: 'PO123.pdf' });
  assert.equal(response.body.status, 'accepted');
  assertBundle(h, /เซ็น PO เสร็จแล้ว/);
});

test('missing preview falls back to the original image', async () => {
  const h = harness();
  await h.route('/notify-new-po', { filename: 'PO123.pdf', image_b64: original });
  assertBundle(h, /PO123.pdf/, original);
});

test('all PO paths still send text when no image is available', async () => {
  const item = { po_id: 'PO123', output_file: 'PO123.pdf' };
  for (const route of ['/notify-new-po', '/auto-sign-po', 'manual', 'confirmation']) {
    const h = harness({ signed: [item] });
    if (route.startsWith('/')) await h.route(route, { filename: 'PO123.pdf' });
    else await h.sign({ status: 'success', signed: [{ ...item, needs_confirmation: route === 'confirmation' }] }, 'tester', 'Ctest');
    assert.equal(h.pushes.length, 1, route);
    assert.deepEqual(h.pushes[0].messages.map((m) => m.type), ['text'], route);
    assert.equal(h.files.size, 0, route);
  }
});

test('multiple POs remain paired individually and in order', async () => {
  const h = harness();
  await h.sign({ status: 'success', signed: [po, { ...po, po_id: 'PO456' }] }, 'tester', 'Ctest');
  assert.equal(h.pushes.length, 2);
  assert.match(h.pushes[0].messages[0].text, /PO123/);
  assert.match(h.pushes[1].messages[0].text, /PO456/);
  assert.ok(h.pushes.every((p) => p.messages.length === 2));
  assert.notEqual(h.pushes[0].messages[1].originalContentUrl, h.pushes[1].messages[1].originalContentUrl);
});

test('a rejected bundle does not trigger a second image-only or text-only send', async () => {
  for (const route of ['/notify-new-po', '/auto-sign-po', 'manual', 'confirmation']) {
    const h = harness({ failPush: true });
    if (route.startsWith('/')) await h.route(route, { filename: 'PO123.pdf', ...po });
    else await h.sign({ status: 'success', signed: [{ ...po, needs_confirmation: route === 'confirmation' }] }, 'tester', 'Ctest');
    assert.equal(h.pushes.length, 1, route);
    assert.equal(h.pushes[0].messages.length, 2, route);
  }
});

test('non-group recipients remain blocked', async () => {
  const h = harness({ target: 'Utest' });
  await h.sign({ status: 'success', signed: [po] }, 'tester', 'Utest');
  await h.route('/notify-new-po', { filename: 'PO123.pdf', ...po });
  assert.equal(h.pushes.length, 0);
  assert.equal(h.files.size, 0);
});

test('unauthorized callbacks do not send or sign', async () => {
  const h = harness();
  for (const route of ['/notify-new-po', '/auto-sign-po']) {
    const response = await h.route(route, { secret: 'incorrect', filename: 'PO123.pdf', ...po });
    assert.equal(response.statusCode, 401);
  }
  assert.equal(h.pushes.length, 0);
});
