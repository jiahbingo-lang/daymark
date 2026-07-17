const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createAiService, ERROR_CODES } = require('../src/ai-service');

const SECRET_KEY = 'sk-test-never-print-this-secret';
const NOW = new Date('2026-07-15T20:00:00.000Z');

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      return Buffer.from(`ciphertext:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8');
    },
    decryptString(value) {
      const encoded = Buffer.from(value).toString('utf8').replace(/^ciphertext:/, '');
      return Buffer.from(encoded, 'base64').toString('utf8');
    },
  };
}

function localFetch(urlValue, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
    }, (response) => {
      const chunks = [];
      let resolveBody;
      let rejectBody;
      const body = new Promise((resolveBodyPromise, rejectBodyPromise) => {
        resolveBody = resolveBodyPromise;
        rejectBody = rejectBodyPromise;
      });
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
      response.on('aborted', () => rejectBody(new Error('response aborted')));
      response.on('error', rejectBody);
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        headers: { get: (name) => response.headers[String(name).toLowerCase()] || null },
        text: async () => body,
      });
    });
    request.on('error', reject);

    const onAbort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      request.destroy(error);
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    request.end(options.body || undefined);
  });
}

async function mockServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'daymark-ai-test-'));
  const settingsPath = path.join(directory, 'daymark-data', 'ai-settings.json');
  const service = createAiService({
    settingsPath,
    safeStorage: fakeSafeStorage(),
    fetch: localFetch,
    env: {},
    now: () => NOW,
    endpoint: options.endpoint || 'http://127.0.0.1:43210/v1',
    allowInsecureLoopback: true,
    timeoutMs: options.timeoutMs || 2_000,
    ...options,
  });
  return {
    directory,
    settingsPath,
    service,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

function reportSource() {
  return {
    schemaVersion: 1,
    mode: 'quarter',
    period: { startDate: '2026-04-01', endDate: '2026-06-30', throughDate: '2026-06-30' },
    metrics: { activeDays: 2, planned: 2, completed: 2, completionRate: 100 },
    achievements: [{
      date: '2026-06-30',
      title: '完成生产验证',
      completionNote: '测试全部通过',
      sourceUrl: 'https://private.invalid/secret',
      reminderAt: '2026-06-30T01:00:00.000Z',
    }],
    dailyNotes: [{ date: '2026-06-30', note: '仅在明确勾选后发送' }],
    events: [{ before: { title: 'raw secret' }, after: { title: 'raw secret 2' } }],
    dataIntegrity: { complete: true, status: 'complete' },
  };
}

test('settings use a separate atomic 0600 file, expose no secret, and clear ciphertext', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);

  assert.deepEqual(await context.service.getSettings(), {
    provider: 'openai',
    endpoint: 'http://127.0.0.1:43210/v1',
    model: 'gpt-5.6-terra',
    includeCompletionNotes: true,
    includeDailyNotes: false,
    hasStoredKey: false,
    hasApiKey: false,
    keySource: 'none',
    canStoreKey: true,
  });

  const saved = await context.service.saveSettings({
    apiKey: SECRET_KEY,
    model: 'gpt-5.6-terra',
    includeCompletionNotes: false,
    includeDailyNotes: true,
  });
  assert.equal(saved.hasStoredKey, true);
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.keySource, 'stored');
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'apiKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'encryptedApiKey'), false);

  const disk = await fs.readFile(context.settingsPath, 'utf8');
  assert.doesNotMatch(disk, new RegExp(SECRET_KEY));
  assert.match(disk, /"encryptedApiKey"/);
  assert.equal((await fs.stat(context.settingsPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(context.settingsPath))).mode & 0o777, 0o700);
  assert.equal((await fs.readdir(path.dirname(context.settingsPath))).some((name) => name.includes('.tmp-')), false);

  const cleared = await context.service.clearKey();
  assert.equal(cleared.hasStoredKey, false);
  assert.equal(cleared.hasApiKey, false);
  assert.doesNotMatch(await fs.readFile(context.settingsPath, 'utf8'), /encryptedApiKey/);
});

test('Responses request has bounded shape and strips excluded or sensitive fields', async (t) => {
  let observed;
  let transportOptions;
  const server = await mockServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '# Q2 工作总结\n\n全部完成。' }] }],
      usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150, private_detail: 'omit' },
    }));
  });
  t.after(server.close);
  const context = await fixture({
    endpoint: server.endpoint,
    fetch: (url, options) => {
      transportOptions = options;
      return localFetch(url, options);
    },
  });
  t.after(context.cleanup);
  await context.service.saveSettings({ apiKey: SECRET_KEY });

  const result = await context.service.generateReport('window-1', { sourceData: reportSource() });
  assert.equal(result.text, '# Q2 工作总结\n\n全部完成。');
  assert.equal(result.model, 'gpt-5.6-terra');
  assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 30, total_tokens: 150 });
  assert.equal(observed.url, '/v1/responses');
  assert.equal(observed.method, 'POST');
  assert.equal(observed.authorization, `Bearer ${SECRET_KEY}`);
  assert.equal(observed.contentType, 'application/json');
  assert.equal(transportOptions.redirect, 'error');
  assert.equal(transportOptions.credentials, 'omit');
  assert.equal(transportOptions.cache, 'no-store');
  assert.equal(observed.body.model, 'gpt-5.6-terra');
  assert.equal(observed.body.store, false);
  assert.equal(observed.body.max_output_tokens, 2200);
  assert.match(observed.body.instructions, /JSON.*数据/);

  const sent = JSON.parse(observed.body.input);
  assert.equal(Object.prototype.hasOwnProperty.call(sent, 'dailyNotes'), false);
  assert.equal(sent.achievements[0].completionNote, '测试全部通过');
  const serialized = JSON.stringify(sent);
  assert.doesNotMatch(serialized, /private\.invalid|reminderAt|raw secret|"events"|"before"|"after"/);
});

test('per-request privacy options defensively remove completion notes and can include daily notes', async (t) => {
  let sent;
  const server = await mockServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    sent = JSON.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')).input);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      output_text: '已生成',
      output: [{ content: [{ type: 'output_text', text: '已生成' }] }],
    }));
  });
  t.after(server.close);
  const context = await fixture({ endpoint: server.endpoint });
  t.after(context.cleanup);
  await context.service.saveSettings({ apiKey: SECRET_KEY });

  const result = await context.service.generateReport(7, {
    sourceData: reportSource(),
    includeCompletionNotes: false,
    includeDailyNotes: true,
    maxOutputTokens: 512,
  });
  assert.equal(result.text, '已生成');
  assert.equal(Object.prototype.hasOwnProperty.call(sent.achievements[0], 'completionNote'), false);
  assert.deepEqual(sent.dailyNotes, [{ date: '2026-06-30', note: '仅在明确勾选后发送' }]);
});

test('authentication errors are actionable and never echo key or provider body', async (t) => {
  const server = await mockServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `invalid ${SECRET_KEY}` } }));
  });
  t.after(server.close);
  const context = await fixture({ endpoint: server.endpoint });
  t.after(context.cleanup);
  await context.service.saveSettings({ apiKey: SECRET_KEY });

  await assert.rejects(
    context.service.generateReport('window-auth', { sourceData: reportSource() }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.AUTH);
      assert.equal(error.status, 401);
      assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(SECRET_KEY));
      assert.doesNotMatch(error.message, /invalid/);
      return true;
    },
  );
});

test('timeout and explicit cancellation abort requests with distinct strict codes', async (t) => {
  const server = await mockServer((_request, _response) => {
    // Intentionally leave the response open until the client aborts.
  });
  t.after(server.close);

  const timed = await fixture({ endpoint: server.endpoint, timeoutMs: 40 });
  t.after(timed.cleanup);
  await timed.service.saveSettings({ apiKey: SECRET_KEY });
  await assert.rejects(
    timed.service.generateReport('window-timeout', { sourceData: reportSource() }),
    (error) => error.code === ERROR_CODES.TIMEOUT && error.retryable === true,
  );

  const canceled = await fixture({ endpoint: server.endpoint, timeoutMs: 2_000 });
  t.after(canceled.cleanup);
  await canceled.service.saveSettings({ apiKey: SECRET_KEY });
  const pending = canceled.service.generateReport('window-cancel', { sourceData: reportSource() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(canceled.service.cancel('window-cancel'), true);
  await assert.rejects(pending, (error) => error.code === ERROR_CODES.CANCELED && error.retryable === false);
  assert.equal(canceled.service.cancel('window-cancel'), false);
});

test('timeout remains a timeout after response headers arrive but the body stalls', async (t) => {
  const server = await mockServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
    const timer = setTimeout(() => response.end(JSON.stringify({ output_text: 'too late' })), 1_000);
    timer.unref();
  });
  t.after(server.close);
  const context = await fixture({ endpoint: server.endpoint, timeoutMs: 40 });
  t.after(context.cleanup);
  await context.service.saveSettings({ apiKey: SECRET_KEY });

  await assert.rejects(
    context.service.generateReport('window-slow-body', { sourceData: reportSource() }),
    (error) => error.code === ERROR_CODES.TIMEOUT && error.retryable === true,
  );
});

test('one owner gets one active request and a different owner remains independent', async (t) => {
  const server = await mockServer((_request, _response) => {
    // Requests remain pending so the busy guard can be observed.
  });
  t.after(server.close);
  const context = await fixture({ endpoint: server.endpoint, timeoutMs: 2_000 });
  t.after(context.cleanup);
  await context.service.saveSettings({ apiKey: SECRET_KEY });

  const first = context.service.generateReport('same-window', { sourceData: reportSource() });
  await assert.rejects(
    context.service.generateReport('same-window', { sourceData: reportSource() }),
    (error) => error.code === ERROR_CODES.BUSY,
  );
  const secondOwner = context.service.generateReport('other-window', { sourceData: reportSource() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.service.cancelAll(), 2);
  await assert.rejects(first, (error) => error.code === ERROR_CODES.CANCELED);
  await assert.rejects(secondOwner, (error) => error.code === ERROR_CODES.CANCELED);
});

test('safe storage failure never writes plaintext and environment key remains an explicit fallback', async (t) => {
  const unavailable = await fixture({ safeStorage: fakeSafeStorage(false) });
  t.after(unavailable.cleanup);
  await assert.rejects(
    unavailable.service.saveSettings({ apiKey: SECRET_KEY }),
    (error) => error.code === ERROR_CODES.STORAGE_UNAVAILABLE,
  );
  await assert.rejects(fs.readFile(unavailable.settingsPath, 'utf8'), { code: 'ENOENT' });

  let authorization;
  const server = await mockServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ output_text: '环境变量密钥可用' }));
  });
  t.after(server.close);
  const fromEnv = await fixture({
    endpoint: server.endpoint,
    safeStorage: fakeSafeStorage(false),
    env: { OPENAI_API_KEY: SECRET_KEY },
  });
  t.after(fromEnv.cleanup);
  const publicSettings = await fromEnv.service.getSettings();
  assert.equal(publicSettings.keySource, 'environment');
  assert.equal(publicSettings.hasApiKey, true);
  assert.equal(publicSettings.canStoreKey, false);
  assert.equal((await fromEnv.service.generateReport('env-window', { sourceData: reportSource() })).text, '环境变量密钥可用');
  assert.equal(authorization, `Bearer ${SECRET_KEY}`);
});

test('an unreadable stored ciphertext is reported as unavailable without deleting it', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await context.service.saveSettings({ apiKey: SECRET_KEY });
  const before = await fs.readFile(context.settingsPath, 'utf8');

  const reopened = createAiService({
    settingsPath: context.settingsPath,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: () => { throw new Error('different keychain identity'); },
    },
    fetch: localFetch,
    env: {},
  });
  const settings = await reopened.getSettings();
  assert.equal(settings.hasStoredKey, true);
  assert.equal(settings.hasApiKey, false);
  assert.equal(settings.keySource, 'none');
  assert.equal(await fs.readFile(context.settingsPath, 'utf8'), before);
});

test('endpoint, model, token range, and unknown fields fail closed', async (t) => {
  assert.throws(() => createAiService({
    settingsPath: path.join(os.tmpdir(), 'ai-settings.json'),
    safeStorage: fakeSafeStorage(),
    fetch: localFetch,
    endpoint: 'http://api.openai.com/v1',
  }), (error) => error.code === ERROR_CODES.CONFIG);

  const context = await fixture();
  t.after(context.cleanup);
  await assert.rejects(
    context.service.generateReport('window-without-key', { sourceData: reportSource() }),
    (error) => error.code === ERROR_CODES.KEY_MISSING,
  );
  await assert.rejects(
    context.service.saveSettings({ apiKey: SECRET_KEY, endpoint: 'https://evil.invalid/v1' }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID,
  );
  await context.service.saveSettings({ apiKey: SECRET_KEY });
  await assert.rejects(
    context.service.generateReport('window', { sourceData: reportSource(), model: '../bad model' }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID,
  );
  await assert.rejects(
    context.service.generateReport('window', { sourceData: reportSource(), maxOutputTokens: 9000 }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID,
  );
});
