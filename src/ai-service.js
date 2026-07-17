const fs = require('node:fs/promises');
const path = require('node:path');
const { buildReportInstructions } = require('./ai-report');

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.6-terra';
const DEFAULT_MAX_OUTPUT_TOKENS = 2200;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REPORT_TEXT_LENGTH = 200_000;
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 8192;

const ERROR_CODES = Object.freeze({
  KEY_MISSING: 'AI_KEY_MISSING',
  BUSY: 'AI_BUSY',
  TIMEOUT: 'AI_TIMEOUT',
  CANCELED: 'AI_CANCELED',
  AUTH: 'AI_AUTH',
  RATE_LIMIT: 'AI_RATE_LIMIT',
  API: 'AI_API_ERROR',
  NETWORK: 'AI_NETWORK',
  RESPONSE_INVALID: 'AI_RESPONSE_INVALID',
  CONFIG: 'AI_CONFIG_ERROR',
  STORAGE_UNAVAILABLE: 'AI_STORAGE_UNAVAILABLE',
  INPUT_INVALID: 'AI_INPUT_INVALID',
});

class AiServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiServiceError';
    this.code = code;
    if (Number.isInteger(details.status)) this.status = details.status;
    this.retryable = Boolean(details.retryable);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(Number.isInteger(this.status) ? { status: this.status } : {}),
      retryable: this.retryable,
    };
  }
}

function serviceError(code, message, details) {
  return new AiServiceError(code, message, details);
}

function defaultSettings(defaultModel) {
  return {
    version: 1,
    provider: 'openai',
    model: defaultModel,
    includeCompletionNotes: true,
    includeDailyNotes: false,
  };
}

function validateModel(value) {
  if (typeof value !== 'string') {
    throw serviceError(ERROR_CODES.INPUT_INVALID, '模型 ID 必须是文本。');
  }
  const model = value.trim();
  if (model.length < 1 || model.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) {
    throw serviceError(ERROR_CODES.INPUT_INVALID, '模型 ID 格式无效，请使用 1 到 120 个字母、数字、点、下划线、冒号或连字符。');
  }
  return model;
}

function validateApiKey(value) {
  if (typeof value !== 'string') {
    throw serviceError(ERROR_CODES.INPUT_INVALID, 'API Key 必须是文本。');
  }
  const key = value.trim();
  if (key.length < 8 || key.length > 512 || /[\u0000-\u0020\u007f]/.test(key)) {
    throw serviceError(ERROR_CODES.INPUT_INVALID, 'API Key 格式无效，请重新复制完整密钥。');
  }
  return key;
}

function validateBooleanOption(payload, key, fallback) {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) return fallback;
  if (typeof payload[key] !== 'boolean') {
    throw serviceError(ERROR_CODES.INPUT_INVALID, `${key} 必须是布尔值。`);
  }
  return payload[key];
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function validateEndpoint(value, allowInsecureLoopback) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_ENDPOINT));
  } catch (_error) {
    throw serviceError(ERROR_CODES.CONFIG, 'OpenAI API 地址配置无效。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw serviceError(ERROR_CODES.CONFIG, 'OpenAI API 地址不能包含凭据、查询参数或片段。');
  }

  const official = url.protocol === 'https:'
    && url.hostname === 'api.openai.com'
    && (!url.port || url.port === '443');
  const testLoopback = Boolean(allowInsecureLoopback)
    && url.protocol === 'http:'
    && isLoopbackHostname(url.hostname);
  if (!official && !testLoopback) {
    throw serviceError(
      ERROR_CODES.CONFIG,
      '生产环境只允许通过 HTTPS 连接 api.openai.com；HTTP 仅可在显式测试模式下连接本机回环地址。',
    );
  }

  const pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  if (official && pathname !== '/v1') {
    throw serviceError(ERROR_CODES.CONFIG, 'OpenAI API 地址必须使用 /v1 路径。');
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, '');
}

function makeAbortController() {
  if (typeof globalThis.AbortController === 'function') return new globalThis.AbortController();

  const listeners = new Set();
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener, options = {}) {
      if (type !== 'abort' || typeof listener !== 'function') return;
      const entry = { listener, once: Boolean(options && options.once) };
      listeners.add(entry);
      if (signal.aborted) {
        listener.call(signal, { type: 'abort', target: signal });
        if (entry.once) listeners.delete(entry);
      }
    },
    removeEventListener(type, listener) {
      if (type !== 'abort') return;
      for (const entry of listeners) {
        if (entry.listener === listener) listeners.delete(entry);
      }
    },
  };
  return {
    signal,
    abort(reason) {
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason;
      for (const entry of [...listeners]) {
        try {
          entry.listener.call(signal, { type: 'abort', target: signal });
        } catch (_error) {
          // Abort listeners are external fetch implementation details.
        }
        if (entry.once) listeners.delete(entry);
      }
    },
  };
}

function safeNow(now) {
  let value;
  try {
    value = now();
  } catch (_error) {
    throw serviceError(ERROR_CODES.CONFIG, '无法读取当前时间，AI 设置未保存。');
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw serviceError(ERROR_CODES.CONFIG, '当前时间无效，AI 设置未保存。');
  }
  return date.toISOString();
}

function sanitizeSourceData(sourceData, preferences) {
  if (!sourceData || typeof sourceData !== 'object' || Array.isArray(sourceData)) {
    throw serviceError(ERROR_CODES.INPUT_INVALID, '工作总结数据必须是对象。');
  }

  const forbiddenKeys = new Set([
    'tasks',
    'events',
    'before',
    'after',
    'reminderAt',
    'reminderFiredAt',
    'sourceUrl',
    'notes',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ]);
  const seen = new WeakSet();
  let nodes = 0;

  function visit(value, depth, key) {
    nodes += 1;
    if (nodes > 100_000 || depth > 32) {
      throw serviceError(ERROR_CODES.INPUT_INVALID, '工作总结数据结构过大或嵌套过深。');
    }
    if (forbiddenKeys.has(key)) return undefined;
    if (key === 'dailyNotes' && !preferences.includeDailyNotes) return undefined;
    if (key === 'completionNote' && !preferences.includeCompletionNotes) return undefined;

    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
      return undefined;
    }
    if (typeof value !== 'object') return undefined;
    if (seen.has(value)) throw serviceError(ERROR_CODES.INPUT_INVALID, '工作总结数据不能包含循环引用。');
    seen.add(value);

    let result;
    if (Array.isArray(value)) {
      result = value.map((item) => visit(item, depth + 1, '')).filter((item) => item !== undefined);
    } else {
      result = {};
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedKey === '__proto__' || nestedKey === 'prototype' || nestedKey === 'constructor') continue;
        const clean = visit(nestedValue, depth + 1, nestedKey);
        if (clean !== undefined) result[nestedKey] = clean;
      }
    }
    seen.delete(value);
    return result;
  }

  const clean = visit(sourceData, 0, '');
  let serialized;
  try {
    serialized = JSON.stringify(clean);
  } catch (_error) {
    throw serviceError(ERROR_CODES.INPUT_INVALID, '工作总结数据无法安全序列化。');
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_SOURCE_BYTES) {
    throw serviceError(ERROR_CODES.INPUT_INVALID, '工作总结数据为空或超过 2 MB 限制。');
  }
  return serialized;
}

function extractReportText(payload) {
  const direct = typeof payload?.output_text === 'string' ? payload.output_text.trim() : '';
  if (direct) {
    if (direct.length > MAX_REPORT_TEXT_LENGTH) {
      throw serviceError(ERROR_CODES.RESPONSE_INVALID, 'OpenAI 返回的总结为空或过大，请重试。', { retryable: true });
    }
    return direct;
  }

  const candidates = [];
  if (Array.isArray(payload?.output)) {
    payload.output.forEach((item) => {
      if (!Array.isArray(item?.content)) return;
      item.content.forEach((content) => {
        if (content?.type === 'output_text' && typeof content.text === 'string') candidates.push(content.text);
      });
    });
  }
  const text = candidates.join('\n').trim();
  if (!text || text.length > MAX_REPORT_TEXT_LENGTH) {
    throw serviceError(ERROR_CODES.RESPONSE_INVALID, 'OpenAI 返回的总结为空或过大，请重试。', { retryable: true });
  }
  return text;
}

function sanitizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  }
  return Object.keys(result).length ? result : null;
}

async function readResponsePayload(response) {
  try {
    if (typeof response.text === 'function') {
      const content = await response.text();
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error('response-size');
      }
      return JSON.parse(content);
    }
    if (typeof response.json === 'function') return await response.json();
  } catch (_error) {
    throw serviceError(ERROR_CODES.RESPONSE_INVALID, 'OpenAI 返回了无法解析的响应，请重试。', { retryable: true });
  }
  throw serviceError(ERROR_CODES.RESPONSE_INVALID, 'OpenAI 返回了无法解析的响应，请重试。', { retryable: true });
}

function createAiService(options = {}) {
  if (typeof options.settingsPath !== 'string' || !path.isAbsolute(options.settingsPath)) {
    throw serviceError(ERROR_CODES.CONFIG, 'AI 设置文件必须使用绝对路径。');
  }
  const settingsPath = options.settingsPath;
  const safeStorage = options.safeStorage;
  const fetchImpl = options.fetch || globalThis.fetch;
  const env = options.env || process.env;
  const now = options.now || (() => new Date());
  const defaultModel = validateModel(options.defaultModel || DEFAULT_MODEL);
  const endpoint = validateEndpoint(options.endpoint || DEFAULT_ENDPOINT, options.allowInsecureLoopback);
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) {
    throw serviceError(ERROR_CODES.CONFIG, 'AI 请求超时必须在 10 到 120000 毫秒之间。');
  }

  const activeRequests = new Map();
  let settingsQueue = Promise.resolve();

  function enqueueSettings(operation) {
    const result = settingsQueue.catch(() => {}).then(operation);
    settingsQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function encryptionAvailable() {
    try {
      return Boolean(safeStorage
        && typeof safeStorage.isEncryptionAvailable === 'function'
        && safeStorage.isEncryptionAvailable());
    } catch (_error) {
      return false;
    }
  }

  function validateStoredSettings(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || raw.provider !== 'openai') {
      throw serviceError(ERROR_CODES.CONFIG, 'AI 设置文件已损坏，请清除密钥后重新配置。');
    }
    let model;
    try {
      model = validateModel(raw.model);
    } catch (_error) {
      throw serviceError(ERROR_CODES.CONFIG, 'AI 设置中的模型 ID 无效，请清除密钥后重新配置。');
    }
    if (raw.encryptedApiKey !== undefined
      && (typeof raw.encryptedApiKey !== 'string'
        || raw.encryptedApiKey.length < 4
        || raw.encryptedApiKey.length > 32_768
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.encryptedApiKey))) {
      throw serviceError(ERROR_CODES.CONFIG, 'AI 密钥密文已损坏，请清除密钥后重新配置。');
    }
    return {
      version: 1,
      provider: 'openai',
      model,
      includeCompletionNotes: typeof raw.includeCompletionNotes === 'boolean' ? raw.includeCompletionNotes : true,
      includeDailyNotes: typeof raw.includeDailyNotes === 'boolean' ? raw.includeDailyNotes : false,
      ...(raw.encryptedApiKey ? { encryptedApiKey: raw.encryptedApiKey } : {}),
      ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
    };
  }

  async function readSettings(options = {}) {
    try {
      const stat = await fs.stat(settingsPath);
      if (stat.size > MAX_SETTINGS_BYTES) throw new Error('settings-size');
      const raw = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      return validateStoredSettings(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') return defaultSettings(defaultModel);
      if (options.allowCorrupt) return defaultSettings(defaultModel);
      if (error instanceof AiServiceError) throw error;
      throw serviceError(ERROR_CODES.CONFIG, 'AI 设置文件无法读取，请清除密钥后重新配置。');
    }
  }

  async function writeSettings(settings) {
    const temporary = `${settingsPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const content = `${JSON.stringify(settings, null, 2)}\n`;
    try {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
      await fs.chmod(path.dirname(settingsPath), 0o700);
      await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, settingsPath);
      await fs.chmod(settingsPath, 0o600);
    } catch (_error) {
      try {
        await fs.unlink(temporary);
      } catch (_cleanupError) {
        // Best-effort cleanup; the original fixed error is safer to expose.
      }
      throw serviceError(ERROR_CODES.CONFIG, '无法安全保存 AI 设置，请检查应用数据目录权限。');
    }
  }

  function environmentKey() {
    const candidate = typeof env?.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
    if (!candidate) return null;
    try {
      return validateApiKey(candidate);
    } catch (_error) {
      return null;
    }
  }

  function publicSettings(settings) {
    const hasStoredKey = Boolean(settings.encryptedApiKey);
    const canStoreKey = encryptionAvailable();
    const hasEnvironmentKey = Boolean(environmentKey());
    let storedKeyUsable = false;
    if (hasStoredKey && canStoreKey) {
      try {
        storedKeyUsable = Boolean(decryptStoredKey(settings));
      } catch (_error) {
        storedKeyUsable = false;
      }
    }
    const keySource = storedKeyUsable
      ? 'stored'
      : (hasEnvironmentKey ? 'environment' : 'none');
    return {
      provider: 'openai',
      endpoint,
      model: settings.model,
      includeCompletionNotes: settings.includeCompletionNotes,
      includeDailyNotes: settings.includeDailyNotes,
      hasStoredKey,
      hasApiKey: keySource !== 'none',
      keySource,
      canStoreKey,
    };
  }

  async function getSettings() {
    return publicSettings(await readSettings());
  }

  async function saveSettings(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw serviceError(ERROR_CODES.INPUT_INVALID, 'AI 设置必须是对象。');
    }
    const allowed = new Set(['apiKey', 'model', 'includeCompletionNotes', 'includeDailyNotes']);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      throw serviceError(ERROR_CODES.INPUT_INVALID, 'AI 设置包含不支持的字段。');
    }

    return enqueueSettings(async () => {
      const replacingKey = Object.prototype.hasOwnProperty.call(payload, 'apiKey');
      const current = await readSettings({ allowCorrupt: replacingKey });
      const next = {
        version: 1,
        provider: 'openai',
        model: Object.prototype.hasOwnProperty.call(payload, 'model')
          ? validateModel(payload.model)
          : current.model,
        includeCompletionNotes: validateBooleanOption(
          payload,
          'includeCompletionNotes',
          current.includeCompletionNotes,
        ),
        includeDailyNotes: validateBooleanOption(payload, 'includeDailyNotes', current.includeDailyNotes),
        ...(current.encryptedApiKey ? { encryptedApiKey: current.encryptedApiKey } : {}),
        updatedAt: safeNow(now),
      };

      if (Object.prototype.hasOwnProperty.call(payload, 'apiKey')) {
        const key = validateApiKey(payload.apiKey);
        if (!encryptionAvailable()
          || typeof safeStorage.encryptString !== 'function'
          || typeof safeStorage.decryptString !== 'function') {
          throw serviceError(
            ERROR_CODES.STORAGE_UNAVAILABLE,
            '系统安全存储当前不可用，Daymark 不会以明文保存密钥。可改用 OPENAI_API_KEY 环境变量。',
          );
        }
        let encrypted;
        try {
          encrypted = safeStorage.encryptString(key);
        } catch (_error) {
          throw serviceError(ERROR_CODES.STORAGE_UNAVAILABLE, '系统安全存储未能加密密钥，密钥没有被保存。');
        }
        if (!Buffer.isBuffer(encrypted)) encrypted = Buffer.from(encrypted || []);
        if (!encrypted.length || encrypted.length > 24_576) {
          throw serviceError(ERROR_CODES.STORAGE_UNAVAILABLE, '系统安全存储返回了无效密文，密钥没有被保存。');
        }
        next.encryptedApiKey = encrypted.toString('base64');
      }

      await writeSettings(next);
      return publicSettings(next);
    });
  }

  async function clearKey() {
    return enqueueSettings(async () => {
      const current = await readSettings({ allowCorrupt: true });
      const next = {
        version: 1,
        provider: 'openai',
        model: current.model,
        includeCompletionNotes: current.includeCompletionNotes,
        includeDailyNotes: current.includeDailyNotes,
        updatedAt: safeNow(now),
      };
      await writeSettings(next);
      return publicSettings(next);
    });
  }

  function decryptStoredKey(settings) {
    if (!settings.encryptedApiKey) return null;
    if (!encryptionAvailable() || typeof safeStorage.decryptString !== 'function') return null;
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64'));
      return validateApiKey(decrypted);
    } catch (_error) {
      throw serviceError(
        ERROR_CODES.STORAGE_UNAVAILABLE,
        '无法从系统安全存储读取 API Key，请重新保存密钥或使用 OPENAI_API_KEY。',
      );
    }
  }

  function resolveKey(settings) {
    const stored = decryptStoredKey(settings);
    if (stored) return stored;
    const fromEnvironment = environmentKey();
    if (fromEnvironment) return fromEnvironment;
    if (settings.encryptedApiKey) {
      throw serviceError(
        ERROR_CODES.STORAGE_UNAVAILABLE,
        '系统安全存储当前不可用，无法读取已保存的 API Key。可改用 OPENAI_API_KEY。',
      );
    }
    throw serviceError(
      ERROR_CODES.KEY_MISSING,
      '尚未配置 OpenAI API Key。请在 AI 总结设置中保存密钥，或为 Daymark 设置 OPENAI_API_KEY。',
    );
  }

  function validateOwner(ownerId) {
    if ((typeof ownerId !== 'string' && typeof ownerId !== 'number')
      || String(ownerId).length < 1
      || String(ownerId).length > 200) {
      throw serviceError(ERROR_CODES.INPUT_INVALID, 'AI 请求缺少有效的窗口标识。');
    }
    return ownerId;
  }

  function normalizeInstructions(value) {
    if (value === undefined) return buildReportInstructions();
    if (typeof value !== 'string' || value.trim().length < 1 || value.length > 20_000) {
      throw serviceError(ERROR_CODES.INPUT_INVALID, 'AI 总结指令为空或过长。');
    }
    return value.trim();
  }

  function normalizeOutputTokens(value) {
    if (value === undefined) return DEFAULT_MAX_OUTPUT_TOKENS;
    if (!Number.isInteger(value) || value < MIN_OUTPUT_TOKENS || value > MAX_OUTPUT_TOKENS) {
      throw serviceError(
        ERROR_CODES.INPUT_INVALID,
        `maxOutputTokens 必须是 ${MIN_OUTPUT_TOKENS} 到 ${MAX_OUTPUT_TOKENS} 之间的整数。`,
      );
    }
    return value;
  }

  function statusError(status) {
    if (status === 401 || status === 403) {
      return serviceError(
        ERROR_CODES.AUTH,
        'OpenAI 拒绝了凭据。请检查 API Key，以及当前账号是否有权使用所选模型。',
        { status },
      );
    }
    if (status === 429) {
      return serviceError(
        ERROR_CODES.RATE_LIMIT,
        'OpenAI 当前限流或额度不足，请稍后重试并检查 API 用量。',
        { status, retryable: true },
      );
    }
    if (status === 408 || status === 504) {
      return serviceError(ERROR_CODES.TIMEOUT, 'OpenAI 请求超时，请稍后重试。', { status, retryable: true });
    }
    if (status === 400 || status === 404 || status === 422) {
      return serviceError(
        ERROR_CODES.API,
        'OpenAI 未接受本次请求。请检查模型 ID、模型权限和报告数据后重试。',
        { status },
      );
    }
    return serviceError(
      ERROR_CODES.API,
      `OpenAI 服务暂时不可用（HTTP ${Number.isInteger(status) ? status : '未知'}），请稍后重试。`,
      { status, retryable: Number.isInteger(status) && status >= 500 },
    );
  }

  async function generateReport(ownerId, payload = {}) {
    const owner = validateOwner(ownerId);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw serviceError(ERROR_CODES.INPUT_INVALID, 'AI 请求必须是对象。');
    }
    const allowed = new Set([
      'sourceData',
      'instructions',
      'model',
      'maxOutputTokens',
      'includeCompletionNotes',
      'includeDailyNotes',
    ]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      throw serviceError(ERROR_CODES.INPUT_INVALID, 'AI 请求包含不支持的字段。');
    }
    if (activeRequests.has(owner)) {
      throw serviceError(ERROR_CODES.BUSY, '该窗口已有 AI 总结正在生成，可先取消后再试。');
    }
    if (typeof fetchImpl !== 'function') {
      throw serviceError(ERROR_CODES.CONFIG, '当前运行环境不支持安全的网络请求。');
    }

    const controller = makeAbortController();
    const active = { controller, canceled: false, timedOut: false, timeout: null };
    // Reserve the owner before the first await so simultaneous calls cannot
    // pass the busy check together.
    activeRequests.set(owner, active);

    try {
      const settings = await readSettings();
      if (active.canceled) throw serviceError(ERROR_CODES.CANCELED, 'AI 总结生成已取消。');
      const key = resolveKey(settings);
      const model = payload.model === undefined ? settings.model : validateModel(payload.model);
      const preferences = {
        includeCompletionNotes: validateBooleanOption(
          payload,
          'includeCompletionNotes',
          settings.includeCompletionNotes,
        ),
        includeDailyNotes: validateBooleanOption(payload, 'includeDailyNotes', settings.includeDailyNotes),
      };
      const requestBody = {
        model,
        instructions: normalizeInstructions(payload.instructions),
        input: sanitizeSourceData(payload.sourceData, preferences),
        max_output_tokens: normalizeOutputTokens(payload.maxOutputTokens),
        store: false,
      };

      active.timeout = setTimeout(() => {
        active.timedOut = true;
        controller.abort();
      }, timeoutMs);

      let response;
      try {
        response = await fetchImpl(`${endpoint}/responses`, {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch (_error) {
        if (active.canceled) {
          throw serviceError(ERROR_CODES.CANCELED, 'AI 总结生成已取消。');
        }
        if (active.timedOut) {
          throw serviceError(ERROR_CODES.TIMEOUT, 'OpenAI 请求超时，请稍后重试。', { retryable: true });
        }
        throw serviceError(ERROR_CODES.NETWORK, '无法连接 OpenAI，请检查网络后重试。', { retryable: true });
      }

      if (active.canceled) throw serviceError(ERROR_CODES.CANCELED, 'AI 总结生成已取消。');
      if (active.timedOut) {
        throw serviceError(ERROR_CODES.TIMEOUT, 'OpenAI 请求超时，请稍后重试。', { retryable: true });
      }
      if (!response || !Number.isInteger(response.status)) {
        throw serviceError(ERROR_CODES.RESPONSE_INVALID, 'OpenAI 返回了无效响应，请重试。', { retryable: true });
      }
      if (!(response.ok === true || (response.status >= 200 && response.status < 300))) {
        throw statusError(response.status);
      }

      let responsePayload;
      try {
        responsePayload = await readResponsePayload(response);
      } catch (error) {
        if (active.canceled) throw serviceError(ERROR_CODES.CANCELED, 'AI 总结生成已取消。');
        if (active.timedOut) {
          throw serviceError(ERROR_CODES.TIMEOUT, 'OpenAI 请求超时，请稍后重试。', { retryable: true });
        }
        throw error;
      }
      if (active.canceled) throw serviceError(ERROR_CODES.CANCELED, 'AI 总结生成已取消。');
      if (active.timedOut) {
        throw serviceError(ERROR_CODES.TIMEOUT, 'OpenAI 请求超时，请稍后重试。', { retryable: true });
      }
      return {
        text: extractReportText(responsePayload),
        model,
        usage: sanitizeUsage(responsePayload?.usage),
      };
    } finally {
      if (active.timeout) clearTimeout(active.timeout);
      if (activeRequests.get(owner) === active) activeRequests.delete(owner);
    }
  }

  function cancel(ownerId) {
    let owner;
    try {
      owner = validateOwner(ownerId);
    } catch (_error) {
      return false;
    }
    const active = activeRequests.get(owner);
    if (!active) return false;
    active.canceled = true;
    active.controller.abort();
    return true;
  }

  function cancelAll() {
    let count = 0;
    for (const active of activeRequests.values()) {
      active.canceled = true;
      active.controller.abort();
      count += 1;
    }
    return count;
  }

  return {
    getSettings,
    saveSettings,
    clearKey,
    generateReport,
    cancel,
    cancelAll,
  };
}

module.exports = {
  AiServiceError,
  ERROR_CODES,
  createAiService,
};
