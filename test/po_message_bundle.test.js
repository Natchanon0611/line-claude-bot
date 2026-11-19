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
function harness({ signed = [po], result, target = 'Ctest', failPush = false, confirmResult = {} } = {}) {
  const pushes = [];
  const calls = [];
  const files = new Map();
  const axios = {
    async get(url) {
      if (url.endsWith('/quota')) return { data: { type: 'limited', value: 300 } };
      if (url.endsWith('/quota/consumption')) return { data: { totalUsage: 0 } };
      if (url.endsWith('/credit-status')) return { data: {} };
      throw new Error(`Unexpected GET: ${url}`);
    },
    async post(url, body, options) {
      calls.push({ url, body, options });
      if (url === 'https://api.line.me/v2/bot/message/push') {
        pushes.push(JSON.parse(JSON.stringify(body)));
        if (typeof failPush === 'function') { const error = failPush(pushes.length); if (error) throw error; }
        else if (failPush) throw Object.assign(new Error('monthly limit'), { response: { status: 429 } });
        return { data: {} };
      }
      if (url === 'https://local.invalid/sign-po') return { data: result || { status: 'success', signed } };
      if (url === 'https://local.invalid/confirm-sign') return { data: confirmResult };
      if (url === 'https://local.invalid/cancel-sign') return { data: { status: 'cancelled' } };
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
      AUTO_SIGN_MAX_ATTEMPTS: '1', RENDER_GIT_COMMIT: 'test-revision',
    }, exit() { throw new Error('Unexpected exit'); } },
  });
  vm.runInContext(fs.readFileSync(entry, 'utf8'), context, { filename: entry });
  return {
    pushes, files, calls,
    sign: vm.runInContext('processPOSignResult', context),
    confirm: vm.runInContext('handleConfirmCancel', context),
    clearImageMemory: () => vm.runInContext('imageStore.clear()', context),
    async route(url, body, extra = {}) {
      const layer = context.module.exports.app._router.stack.find((x) => x.route?.path === url);
      assert.ok(layer, `Missing route ${url}`);
      const response = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; },
        set(key, value) { this.headers[key] = value; return this; },
        setHeader(key, value) { this.headers[key] = value; return this; } };
      await layer.route.stack[0].handle({ body: { secret: 'test-secret', ...body }, headers: { 'x-po-secret': 'test-secret' }, ...extra }, response);
      return response;
    },
  };
}

function assertBundle(h, expectedText, expectedPreview = preview, expectedOriginal = original) {
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
  assert.ok(stored.some(([file, data]) => file.endsWith(`${id}.original.jpg`) && data.equals(Buffer.from(expectedOriginal, 'base64'))));
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
  assertBundle(h, /ยืนยันตำแหน่งลายเซ็น[\s\S]*ยกเลิก[\s\S]*อนุมัติผ่านโฟลเดอร์ A2-2/);
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
  for (const route of ['/notify-new-po', '/auto-sign-po', '/po-sign-result']) {
    const response = await h.route(route, { secret: 'incorrect', filename: 'PO123.pdf', ...po });
    assert.equal(response.statusCode, 401);
  }
  assert.equal(h.pushes.length, 0);
  assert.equal(h.calls.length, 0);
});

test('completed local callback sends details and image without invoking the signer', async () => {
  const h = harness();
  const response = await h.route('/po-sign-result', { result: { status: 'success', signed: [{ ...po,
    output_file: 'W-PO123.pdf', matched_quotation: 'QT123.pdf', matched_confidence: 'high',
    quotation_moved: true, nas_ok: true, nas_path: 'NAS/W-PO123.pdf', print_status: 'deferred_until_mail_sent',
  }] } });
  assert.equal(response.body.protocol, 'po-sign-result-v1');
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.sent, 1);
  assertBundle(h, /QT123.pdf[\s\S]*ความมั่นใจ: high[\s\S]*รอตรวจ[\s\S]*ระบบ Auto-Sign[\s\S]*NAS: คัดลอกแล้ว[\s\S]*รอส่งอีเมลสำเร็จ/);
  assert.ok(h.calls.every(c => !c.url.startsWith('https://local.invalid/')));
});

test('all sign entry points use identical result formatting', async () => {
  for (const result of [
    { status: 'success', signed: [po] },
    { status: 'partial_failed', signed: [po], failed: [{ file: 'bad.pdf', error: 'signature not found', manual_file: 'Manual/bad.pdf' }] },
    { status: 'failed', failed: [{ file: 'bad.pdf', error: 'OCR error', move_error: 'file locked' }] },
    { status: 'held', failed: [{ file: 'old.pdf', error: 'already_signed_or_sent' }] },
    { status: 'busy' }, { status: 'no_files' }, { status: 'ignored' },
    { status: 'error', message: 'signer unavailable' },
    { status: 'success', dry_run: true, signed: [po] },
  ]) {
    const rendered = [];
    for (const entryPoint of ['manual', '/auto-sign-po', '/po-sign-result']) {
      const h = harness({ result });
      if (entryPoint === 'manual') await h.sign(result, 'ระบบ Auto-Sign', 'Ctest');
      else await h.route(entryPoint, { filename: 'PO123.pdf', result });
      rendered.push(h.pushes.map(p => p.messages.map(m => m.type === 'text' ? m.text : m.type)));
    }
    assert.deepEqual(rendered[1], rendered[0], result.status);
    assert.deepEqual(rendered[2], rendered[0], result.status);
  }
});

test('partial failure reports each outcome once, including manual-review destination', async () => {
  const h = harness();
  const r = await h.route('/po-sign-result', { result: { status: 'partial_failed', signed: [po],
    failed: [{ file: 'bad.pdf', error: 'no signature', manual_file: 'Manual/bad.pdf', image_b64: original }] } });
  assert.equal(r.body.sent, 2);
  assert.equal(h.pushes.length, 2);
  assert.match(h.pushes[1].messages[0].text, /เซ็น PO ไม่สำเร็จ[\s\S]*Manual\/bad.pdf/);
  assert.deepEqual(h.pushes[1].messages.map(m => m.type), ['text', 'image']);
});

test('missing full image uses preview; missing both is explicitly reported', async () => {
  const h = harness();
  await h.route('/po-sign-result', { result: { status: 'success', signed: [{ ...po, image_b64: '' }] } });
  assertBundle(h, /เซ็น PO เสร็จแล้ว/, preview, preview);
  const empty = harness();
  await empty.route('/po-sign-result', { result: { status: 'success', signed: [{ po_id: 'PO123' }] } });
  assert.equal(empty.pushes[0].messages.length, 1);
  assert.match(empty.pushes[0].messages[0].text, /ภาพตัวอย่าง: ไม่พร้อมใช้งาน/);
});

test('image URLs serve original and preview bytes, including disk cache fallback', async () => {
  const h = harness();
  await h.route('/po-sign-result', { result: { status: 'success', signed: [po] } });
  const id = h.pushes[0].messages[1].originalContentUrl.split('/').pop();
  for (const diskOnly of [false, true]) {
    if (diskOnly) h.clearImageMemory();
    for (const [route, expected] of [['/po-image/:id', original], ['/po-image/:id/preview', preview]]) {
      const response = await h.route(route, {}, { params: { id } });
      assert.ok(response.body.equals(Buffer.from(expected, 'base64')));
      assert.equal(response.headers['Content-Type'], 'image/jpeg');
    }
  }
});

test('long errors cannot hide time, NAS status or missing image notice', async () => {
  const h = harness();
  await h.route('/po-sign-result', { result: { status: 'success', signed: [{
    po_id: 'PO123', output_file: 'W-' + 'f'.repeat(1000), matched_quotation: 'q'.repeat(1000),
    matched_confidence: 'high', factory: 'factory'.repeat(100), quotation_move_error: 'locked'.repeat(1000),
    nas_error: 'unavailable'.repeat(1000), print_error: 'printer'.repeat(1000),
  }] } });
  const text = h.pushes[0].messages[0].text;
  assert.ok(text.length < 2000);
  for (const marker of ['เวลา:', 'สั่งโดย:', 'NAS: ล้มเหลว', 'ปริ้น: ล้มเหลว', 'ภาพตัวอย่าง: ไม่พร้อมใช้งาน']) assert.ok(text.includes(marker), marker);
});

test('dry run never claims awaiting approval, NAS copy or print', async () => {
  const h = harness();
  await h.route('/po-sign-result', { result: { status: 'success', dry_run: true, signed: [po] } });
  const text = h.pushes[0].messages[0].text;
  assert.match(text, /โหมดทดสอบ: ไม่ส่งเมล ไม่ปริ้น ไม่ย้าย NAS/);
  assert.doesNotMatch(text, /รอตรวจ|คัดลอกแล้ว|ปริ้น: สั่งแล้ว/);
});

test('callback detects blocked/failed delivery and does not retry or claim success', async () => {
  for (const options of [{ failPush: true }, { target: '' }, { target: 'Utest' }]) {
    const h = harness(options);
    const response = await h.route('/po-sign-result', { result: { status: 'success', signed: [po] } });
    assert.equal(response.body.status, options.failPush ? 'line_push_failed' : 'no_target');
    assert.equal(h.pushes.length, options.failPush ? 1 : 0);
    assert.ok(h.calls.every(c => !c.url.endsWith('/sign-po')));
  }
});

test('capabilities is authenticated and read-only; invalid results are rejected', async () => {
  const h = harness();
  const response = await h.route('/po-sign-result-capabilities');
  assert.equal(response.body.protocol, 'po-sign-result-v1');
  assert.equal(response.body.revision, 'test-revision');
  assert.equal((await h.route('/po-sign-result-capabilities', {}, { headers: {} })).statusCode, 401);
  for (const result of [undefined, [], {}, { status: 'bogus' }, { status: 'success', signed: [null] }, { status: 'failed', failed: {} }]) {
    assert.equal((await h.route('/po-sign-result', { result })).statusCode, 400);
  }
  assert.equal(h.calls.length, 0);
});

test('legacy confirmation and cancel describe actual deferred workflow', async () => {
  for (const action of ['ยืนยัน', 'ยกเลิก']) {
    const h = harness({ confirmResult: { email_sent: false, print_ok: false, print_status: 'deferred_until_mail_sent' } });
    await h.sign({ status: 'success', signed: [{ ...po, needs_confirmation: true }] }, 'tester', 'Ctest');
    await h.confirm({ message: { text: action }, source: { groupId: 'Ctest' } });
    const text = h.pushes[1].messages[0].text;
    if (action === 'ยืนยัน') {
      assert.match(text, /รออนุมัติผ่านโฟลเดอร์ A2-2[\s\S]*รอส่งอีเมลสำเร็จ/);
      assert.doesNotMatch(text, /ล้มเหลว|ส่งไม่สำเร็จ/);
    } else assert.match(text, /ยกเลิก[\s\S]*ไฟล์ต้นฉบับถูกคืน/);
  }
});

test('mail results remain a separate text-only message', async () => {
  const h = harness();
  await h.route('/po-mail-result', { text: '📧 สรุปส่งเมลยืนยัน PO\n✅ ส่งสำเร็จ 1 ไฟล์' });
  assert.deepEqual(h.pushes[0].messages.map(m => m.type), ['text']);
  assert.match(h.pushes[0].messages[0].text, /สรุปส่งเมลยืนยัน PO/);
});

test('quotation failures and review candidates are not reported as missing files', async () => {
  for (const status of ['error', 'review_required']) {
    const h = harness();
    await h.sign({ status: 'success', signed: [{ ...po,
      quotation_match_status: status,
      quotation_match_reason: 'revision / รายการ / ยอดเงินต้องตรวจยืนยัน',
      quotation_candidates: ['FFT26089Rev.2.pdf'],
    }] }, 'tester', 'Ctest');
    const text = h.pushes[0].messages[0].text;
    assert.doesNotMatch(text, /ไม่พบที่ตรงกัน/);
    assert.match(text, status === 'error' ? /ระบบจับคู่ผิดพลาด/ : /รอตรวจยืนยัน[\s\S]*FFT26089Rev.2.pdf/);
    assert.equal(h.pushes.length, 1);
  }
});


test('durable relay retries identical content and treats LINE accepted retry as delivered', async () => {
  const h = harness({ failPush: count => count === 2
    ? Object.assign(new Error('accepted retry'), { response: { status: 409, headers: {'x-line-accepted-request-id': 'first'} } }) : null });
  const notification = {id:'123e4567-e89b-42d3-a456-426614174000',created_at:1800000000,target:'Ctest'};
  const body = {result:{status:'success',signed:[{...po,signed_pages:[2],page_images:[{...po,page:2}]}]},notification};
  assert.equal((await h.route('/po-sign-result',body)).body.status,'ok');
  assert.equal((await h.route('/po-sign-result',body)).body.status,'ok');
  assert.deepEqual(h.pushes[0],h.pushes[1]);
  const requests=h.calls.filter(x=>x.url.endsWith('/message/push'));
  assert.equal(requests[0].options.headers['X-Line-Retry-Key'],requests[1].options.headers['X-Line-Retry-Key']);
  assert.match(requests[0].options.headers['X-Line-Retry-Key'],/^[a-f0-9-]{36}$/);
  assert.match(h.pushes[0].messages[0].text,/หน้าที่เซ็น: 2/);
});

test('all signed pages are included within LINE five-message limit', async () => {
  const h=harness();
  const images=Array.from({length:7},(_,i)=>({...po,page:i+1}));
  await h.route('/po-sign-result',{result:{status:'success',signed:[{...po,page_images:images,signed_pages:[1,2,3,4,5,6,7]}]},
    notification:{id:'123e4567-e89b-42d3-a456-426614174001',created_at:1800000000,target:'Ctest'}});
  assert.equal(h.pushes.length,2);
  assert.equal(h.pushes.flatMap(x=>x.messages).filter(x=>x.type==='image').length,7);
  assert.ok(h.pushes.every(x=>x.messages.length<=5));
  const keys=h.calls.filter(x=>x.url.endsWith('/message/push')).map(x=>x.options.headers['X-Line-Retry-Key']);
  assert.notEqual(keys[0],keys[1]);
});

test('changing a durable notification target requires review and never pushes', async () => {
  const h=harness();
  const result=await h.route('/po-sign-result',{result:{status:'success',signed:[po]},
    notification:{id:'123e4567-e89b-42d3-a456-426614174000',created_at:1800000000,target:'Cother'}});
  assert.equal(result.statusCode,409);assert.equal(h.pushes.length,0);
});

test('409 without accepted-request evidence is not counted as delivered', async () => {
  const h=harness({failPush:()=>Object.assign(new Error('unrelated conflict'),{response:{status:409,headers:{}}})});
  const result=await h.route('/po-sign-result',{result:{status:'success',signed:[po]},
    notification:{id:'123e4567-e89b-42d3-a456-426614174000',created_at:1800000000,target:'Ctest'}});
  assert.equal(result.body.status,'line_push_failed');
});
