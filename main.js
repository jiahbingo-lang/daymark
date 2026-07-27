const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  globalShortcut,
  dialog,
  Notification,
  safeStorage,
  net,
  protocol,
} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createTodoStore } = require('./src/store');
const { dateInTimeZone } = require('./src/domain');
const { createAiService, ERROR_CODES } = require('./src/ai-service');
const { buildReportSourceData, buildReportInstructions } = require('./src/ai-report');
const { evaluateEndOfDayReminder, notificationCopy } = require('./src/end-of-day');

const isMac = process.platform === 'darwin';
const isSmokeTest = process.argv.includes('--smoke-test');
const DAYMARK_TIME_ZONE = 'Asia/Shanghai';
const GLOBAL_CAPTURE_SHORTCUT = 'CommandOrControl+Shift+Space';
const APP_SCHEME = 'daymark';
const APP_HOST = 'app';
const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/src/index.html`;
const APP_ASSETS = new Map([
  ['/src/index.html', 'text/html; charset=utf-8'],
  ['/src/styles.css', 'text/css; charset=utf-8'],
  ['/src/domain.js', 'text/javascript; charset=utf-8'],
  ['/src/china-calendar.js', 'text/javascript; charset=utf-8'],
  ['/src/planning.js', 'text/javascript; charset=utf-8'],
  ['/src/execution.js', 'text/javascript; charset=utf-8'],
  ['/src/daily-planning.js', 'text/javascript; charset=utf-8'],
  ['/src/reporting.js', 'text/javascript; charset=utf-8'],
  ['/src/calendar.js', 'text/javascript; charset=utf-8'],
  ['/src/ai-report.js', 'text/javascript; charset=utf-8'],
  ['/src/renderer.js', 'text/javascript; charset=utf-8'],
]);

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
    },
  },
]);

// Chromium's encrypted-cookie initialization can wait for an interactive
// macOS Keychain prompt during headless release verification. Keep production
// on the real Keychain while making the disposable smoke-test profile fully
// non-interactive.
if (isSmokeTest && isMac) app.commandLine.appendSwitch('use-mock-keychain');

if (process.env.DAYMARK_TEST_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.DAYMARK_TEST_USER_DATA));
} else if (isSmokeTest) {
  app.setPath('userData', path.join(os.tmpdir(), `daymark-smoke-${process.pid}`));
}

let mainWindow;
let todoStore;
let aiService;
let reminderTimer;
let aiGenerationLocked = false;
const activeAiRequests = new Map();

const AI_ERROR_MESSAGES = Object.freeze({
  [ERROR_CODES.KEY_MISSING]: '请先配置 OpenAI API 密钥。',
  [ERROR_CODES.BUSY]: '已有一个总结正在生成，请稍候或先取消。',
  [ERROR_CODES.TIMEOUT]: '模型响应超时，请稍后重试。',
  [ERROR_CODES.CANCELED]: '已取消本次生成。',
  [ERROR_CODES.AUTH]: 'OpenAI API 密钥无效或无权使用当前模型。',
  [ERROR_CODES.RATE_LIMIT]: 'OpenAI API 请求过于频繁或额度不足，请稍后重试。',
  [ERROR_CODES.API]: 'OpenAI API 暂时无法完成请求。',
  [ERROR_CODES.NETWORK]: '无法连接 OpenAI API，请检查网络后重试。',
  [ERROR_CODES.RESPONSE_INVALID]: '模型返回了无法读取的内容，请重试。',
  [ERROR_CODES.CONFIG]: 'AI 服务配置无效。',
  [ERROR_CODES.STORAGE_UNAVAILABLE]: '当前系统无法安全保存 API 密钥，可改用 OPENAI_API_KEY 环境变量。',
  [ERROR_CODES.INPUT_INVALID]: '总结范围或参数无效。',
});

function isTrustedFrame(event) {
  if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
}

function protocolResponse(body, status, contentType) {
  return new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });
}

function installAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET') {
      return protocolResponse('Method not allowed', 405, 'text/plain; charset=utf-8');
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return protocolResponse('Bad request', 400, 'text/plain; charset=utf-8');
    }

    if (url.host !== APP_HOST || !APP_ASSETS.has(url.pathname)) {
      return protocolResponse('Not found', 404, 'text/plain; charset=utf-8');
    }

    try {
      const body = await fs.readFile(path.join(__dirname, url.pathname.slice(1)));
      return protocolResponse(body, 200, APP_ASSETS.get(url.pathname));
    } catch {
      return protocolResponse('Not found', 404, 'text/plain; charset=utf-8');
    }
  });
}

function assertTrusted(event) {
  if (!isTrustedFrame(event)) throw new Error('Untrusted Daymark request');
}

function assertNoPayload(payload, channel) {
  if (payload !== undefined) throw new TypeError(`${channel} does not accept a payload`);
}

function assertExactObject(payload, allowedKeys, channel) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError(`${channel} payload must be an object`);
  }
  const unexpected = Object.keys(payload).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length) throw new TypeError(`${channel} received unsupported fields`);
}

function validatedModel(value) {
  if (typeof value !== 'string') throw new TypeError('model must be a string');
  const model = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(model)) throw new TypeError('model is invalid');
  return model;
}

function validatedRequestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new TypeError('requestId is invalid');
  }
  return value;
}

function localToday() {
  return dateInTimeZone(new Date(), DAYMARK_TIME_ZONE);
}

function validateAiSettings(payload) {
  assertExactObject(
    payload,
    ['model', 'includeDailyNotes', 'includeCompletionNotes'],
    'ai:save-settings',
  );
  const settings = {};
  if (payload.model !== undefined) settings.model = validatedModel(payload.model);
  if (payload.includeDailyNotes !== undefined) {
    if (typeof payload.includeDailyNotes !== 'boolean') throw new TypeError('includeDailyNotes must be a boolean');
    settings.includeDailyNotes = payload.includeDailyNotes;
  }
  if (payload.includeCompletionNotes !== undefined) {
    if (typeof payload.includeCompletionNotes !== 'boolean') throw new TypeError('includeCompletionNotes must be a boolean');
    settings.includeCompletionNotes = payload.includeCompletionNotes;
  }
  if (!Object.keys(settings).length) throw new TypeError('ai:save-settings payload is empty');
  return settings;
}

function validateAiKey(payload) {
  assertExactObject(payload, ['apiKey'], 'ai:set-key');
  if (typeof payload.apiKey !== 'string') throw new TypeError('apiKey must be a string');
  const apiKey = payload.apiKey.trim();
  if (apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey)) throw new TypeError('apiKey is invalid');
  return apiKey;
}

function validateAiReportOptions(payload) {
  assertExactObject(
    payload,
    ['mode', 'year', 'month', 'quarter', 'includeDailyNotes', 'includeCompletionNotes', 'requestId'],
    'ai:generate-report',
  );
  if (!['month', 'quarter', 'year'].includes(payload.mode)) throw new TypeError('mode is invalid');
  if (!Number.isInteger(payload.year) || payload.year < 1000 || payload.year > 9999) {
    throw new TypeError('year is invalid');
  }
  const options = {
    mode: payload.mode,
    year: payload.year,
    includeDailyNotes: payload.includeDailyNotes ?? false,
    includeCompletionNotes: payload.includeCompletionNotes ?? true,
    requestId: validatedRequestId(payload.requestId),
  };
  if (typeof options.includeDailyNotes !== 'boolean' || typeof options.includeCompletionNotes !== 'boolean') {
    throw new TypeError('report inclusion options must be booleans');
  }
  if (payload.mode === 'month') {
    if (!Number.isInteger(payload.month) || payload.month < 1 || payload.month > 12 || payload.quarter !== undefined) {
      throw new TypeError('month report range is invalid');
    }
    options.month = payload.month;
  } else if (payload.mode === 'quarter') {
    if (!Number.isInteger(payload.quarter) || payload.quarter < 1 || payload.quarter > 4 || payload.month !== undefined) {
      throw new TypeError('quarter report range is invalid');
    }
    options.quarter = payload.quarter;
  } else if (payload.month !== undefined || payload.quarter !== undefined) {
    throw new TypeError('year report does not accept month or quarter');
  }
  return options;
}

function aiReportRangeLabel(options) {
  if (options.mode === 'month') return `${options.year}年${options.month}月`;
  if (options.mode === 'quarter') return `${options.year}年第${options.quarter}季度`;
  return `${options.year}年`;
}

async function confirmAiReportTransfer(options) {
  const included = [
    '任务标题、工作领域、日期、优先级、预计用时和完成统计',
    ...(options.includeDailyNotes ? ['每日备注'] : []),
    ...(options.includeCompletionNotes ? ['完成说明'] : []),
  ];
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '确认发送工作数据',
    message: `将 ${aiReportRangeLabel(options)} 的工作数据发送到 api.openai.com 生成总结。`,
    detail: [
      `包含：${included.join('、')}。`,
      '不包含：提醒时间、来源链接、删除任务、操作历史、API 密钥。',
      '只有选择“发送并生成”后才会发起网络请求。',
    ].join('\n'),
    buttons: ['发送并生成', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

function publicAiError(error) {
  const code = Object.hasOwn(AI_ERROR_MESSAGES, error?.code) ? error.code : ERROR_CODES.API;
  const wrapped = new Error(`[${code}] ${AI_ERROR_MESSAGES[code]}`);
  wrapped.code = code;
  return wrapped;
}

function validateAiInput(operation) {
  try {
    return operation();
  } catch (error) {
    error.code = ERROR_CODES.INPUT_INVALID;
    throw publicAiError(error);
  }
}

function cancelAllAiRequests() {
  if (!aiService) return;
  for (const [requestId, request] of activeAiRequests) {
    request.canceled = true;
    cancelAiRequest(requestId, request);
  }
  aiService.cancelAll();
}

function cancelAiRequest(requestId, request, attempt = 0) {
  if (!aiService || activeAiRequests.get(requestId) !== request || !request.canceled) return;
  if (aiService.cancel(request.ownerId) || attempt >= 40) return;
  const retry = setTimeout(() => cancelAiRequest(requestId, request, attempt + 1), 25);
  retry.unref?.();
}

function showAndFocusNewTask() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('app:focus-new-task');
}

function showAndFocusDailyShutdown() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('app:open-daily-shutdown');
}

async function smokeAudit() {
  const result = await mainWindow.webContents.executeJavaScript(`
    (async () => {
      const waitFor = async (predicate, label, timeout = 10000) => {
        const started = Date.now();
        while (!predicate()) {
          if (Date.now() - started > timeout) {
            throw new Error('Timed out waiting for ' + label + ' · ' + JSON.stringify({
              ...debug(),
              saveStatus: document.querySelector('#save-status')?.textContent,
              toast: document.querySelector('#toast-message')?.textContent,
            }));
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      };
      const debug = () => JSON.parse(document.querySelector('#app-debug-state')?.textContent || '{}');

      await waitFor(() => document.body.dataset.appReady === 'true' && document.querySelector('#task-input'), 'renderer');
      const aiSettings = await window.daymark.getAiSettings();
      const dateShortcutSpacing = parseFloat(
        getComputedStyle(document.querySelector('.date-shortcuts')).marginTop,
      ) >= 12;
      document.querySelector('[data-view="today"]').click();
      const endOfDayEnabled = document.querySelector('#end-of-day-enabled');
      const endOfDayTime = document.querySelector('#end-of-day-time');
      const endOfDayDefaultVisible = endOfDayEnabled?.checked === true && endOfDayTime?.value === '17:30';
      endOfDayTime.value = '18:15';
      endOfDayTime.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => debug().totalEvents >= 1, 'end-of-day reminder setting');
      const endOfDayStore = await window.daymark.load();
      const endOfDaySettingSynced = endOfDayDefaultVisible
        && endOfDayStore.meta.endOfDayReminderEnabled === true
        && endOfDayStore.meta.endOfDayReminderTime === '18:15';

      document.querySelector('[data-view="upcoming"]').click();
      const futureInput = document.querySelector('#task-input');
      futureInput.value = 'Smoke 明日归属验证';
      document.querySelector('#add-form').requestSubmit();
      await waitFor(() => debug().view === 'upcoming' && debug().visibleTaskCount === 1, 'future task creation');
      const futureStore = await window.daymark.load();
      const futureTask = futureStore.tasks.find((task) => task.title === 'Smoke 明日归属验证');
      const creationEvent = futureStore.events.find((event) => event.taskId === futureTask?.id);
      const creationDate = creationEvent?.reportingDate;
      const futureDate = futureTask?.plannedDate;
      const futureYear = Number(creationDate?.slice(0, 4));
      const futureQuarter = Math.floor((Number(creationDate?.slice(5, 7)) - 1) / 3) + 1;
      const creationDetail = window.DaymarkCalendar.buildDateDetail(futureStore, creationDate);
      const futureDetail = window.DaymarkCalendar.buildDateDetail(futureStore, futureDate);
      const creationReport = window.DaymarkReporting.buildPeriodReport(futureStore, {
        year: futureYear,
        quarter: futureQuarter,
        today: creationDate,
      });
      const reminderInput = document.querySelector('#detail-reminder');
      const rangeEndDate = (() => {
        const value = new Date(futureDate + 'T00:00:00.000Z');
        value.setUTCDate(value.getUTCDate() + 4);
        return value.toISOString().slice(0, 10);
      })();
      const dueInput = document.querySelector('#detail-due');
      dueInput.value = rangeEndDate;
      dueInput.dispatchEvent(new Event('change', { bubbles: true }));
      const estimateInput = document.querySelector('#detail-estimate');
      estimateInput.value = '120';
      estimateInput.dispatchEvent(new Event('change', { bubbles: true }));
      reminderInput.value = futureDate + 'T09:30';
      reminderInput.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => debug().totalEvents >= 5, 'range planning and China-time reminder');
      const reminderStore = await window.daymark.load();
      const reminderTask = reminderStore.tasks.find((task) => task.id === futureTask?.id);
      const rangeSchedule = window.DaymarkPlanning.buildSchedule(reminderStore);
      const rangeBlocks = rangeSchedule.byTask[futureTask?.id] || [];
      const rangeEndDetail = window.DaymarkCalendar.buildDateDetail(reminderStore, rangeEndDate);
      const rangePlanningSynced = reminderTask?.dueDate === rangeEndDate
        && reminderTask?.estimateMinutes === 120
        && rangeBlocks.length === 5
        && rangeBlocks.reduce((sum, block) => sum + (Number(block.scheduledMinutes) || 0), 0) === 120
        && rangeEndDetail.range.some((task) => task.id === futureTask?.id);
      const chinaTimeSynced = reminderStore.meta.timeZone === 'Asia/Shanghai'
        && creationEvent?.timeZone === 'Asia/Shanghai'
        && creationDate === window.TodoDomain.dateInTimeZone(new Date(creationEvent?.occurredAt), 'Asia/Shanghai')
        && reminderTask?.reminderAt === new Date(futureDate + 'T09:30:00+08:00').toISOString()
        && reminderInput.value === futureDate + 'T09:30'
        && document.querySelector('#date-label')?.textContent.includes('中国时间');

      document.querySelector('[data-view="review"]').click();
      await waitFor(() => document.querySelector('[data-calendar-date="' + creationDate + '"]'), 'future attribution calendar');
      document.querySelector('[data-calendar-date="' + creationDate + '"]').click();
      await waitFor(() => !document.querySelector('#day-detail-tasks')?.textContent.includes('Smoke 明日归属验证'), 'creation date detail');
      document.querySelector('[data-calendar-date="' + futureDate + '"]').click();
      await waitFor(() => document.querySelector('#day-detail-tasks')?.textContent.includes('Smoke 明日归属验证'), 'planned date detail');
      const futureAttributionSynced = creationDetail.planned.length === 0
        && futureDetail.planned.some((task) => task.id === futureTask?.id)
        && creationReport.totals.activeDays === 0
        && creationReport.totals.planned === 0;
      const currentCalendarMonth = futureDate.slice(0, 7);
      const nextCalendarMonth = (() => {
        const value = new Date(currentCalendarMonth + '-01T00:00:00.000Z');
        value.setUTCMonth(value.getUTCMonth() + 1);
        return value.toISOString().slice(0, 7);
      })();
      const monthInput = document.querySelector('#record-month');
      monthInput.value = nextCalendarMonth;
      monthInput.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => monthInput.value === nextCalendarMonth, 'future calendar navigation');
      document.querySelector('#previous-month').click();
      await waitFor(() => monthInput.value === currentCalendarMonth, 'return from future calendar');
      const futureCalendarNavigation = true;

      document.querySelector('[data-view="upcoming"]').click();
      await waitFor(() => debug().view === 'upcoming' && debug().visibleTaskCount === 1, 'future task before Inbox');
      document.querySelector('.task-row').click();
      document.querySelector('[data-planned-shortcut="clear"]').click();
      await waitFor(
        () => debug().visibleTaskCount === 0 && debug().totalEvents >= 3,
        'move future task to Inbox',
      );
      const inboxStore = await window.daymark.load();
      const inboxTask = inboxStore.tasks.find((task) => task.id === futureTask?.id);
      const inboxDateDetail = window.DaymarkCalendar.buildDateDetail(inboxStore, futureDate);
      document.querySelector('[data-view="review"]').click();
      await waitFor(() => document.querySelector('[data-calendar-date="' + futureDate + '"]'), 'Inbox withdrawal calendar');
      document.querySelector('[data-calendar-date="' + futureDate + '"]').click();
      await waitFor(
        () => !document.querySelector('#day-detail-tasks')?.textContent.includes('Smoke 明日归属验证'),
        'Inbox withdrawal review detail',
      );
      const inboxWithdrawalSynced = inboxTask?.plannedDate === null
        && inboxDateDetail.planned.every((task) => task.id !== futureTask?.id);

      document.querySelector('[data-view="today"]').click();
      const reopenInput = document.querySelector('#task-input');
      reopenInput.value = 'Smoke 恢复待办验证';
      document.querySelector('#add-form').requestSubmit();
      await waitFor(() => debug().view === 'today' && debug().visibleTaskCount === 1 && debug().totalEvents >= 3, 'reopen task creation');
      document.querySelector('.task-row [data-action="toggle"]').click();
      await waitFor(() => debug().visibleTaskCount === 0 && debug().totalEvents >= 4, 'temporary completion');
      document.querySelector('[data-view="completed"]').click();
      await waitFor(() => debug().view === 'completed' && debug().visibleTaskCount === 1, 'temporary completed view');
      document.querySelector('.task-row [data-action="toggle"]').click();
      await waitFor(() => debug().visibleTaskCount === 0 && debug().totalEvents >= 5, 'restore Todo');
      document.querySelector('[data-view="today"]').click();
      await waitFor(() => debug().visibleTaskCount === 1, 'restored Todo view');
      const reopenedStore = await window.daymark.load();
      const reopenedTask = reopenedStore.tasks.find((task) => task.title === 'Smoke 恢复待办验证');
      const reopenedDate = reopenedTask?.plannedDate;
      const reopenedDetail = window.DaymarkCalendar.buildDateDetail(reopenedStore, reopenedDate);
      const reopenedReport = window.DaymarkReporting.buildPeriodReport(reopenedStore, {
        year: Number(reopenedDate?.slice(0, 4)),
        quarter: Math.floor((Number(reopenedDate?.slice(5, 7)) - 1) / 3) + 1,
        today: reopenedDate,
      });
      const reopenedAiSource = window.DaymarkAiReport.buildReportSourceData(reopenedStore, {
        mode: 'quarter',
        year: Number(reopenedDate?.slice(0, 4)),
        quarter: Math.floor((Number(reopenedDate?.slice(5, 7)) - 1) / 3) + 1,
        today: reopenedDate,
      });
      document.querySelector('[data-view="review"]').click();
      await waitFor(() => document.querySelector('[data-calendar-date="' + reopenedDate + '"]'), 'reopened calendar');
      document.querySelector('[data-calendar-date="' + reopenedDate + '"]').click();
      await waitFor(
        () => [...document.querySelectorAll('.day-detail-task.is-open')]
          .some((row) => row.textContent.includes('Smoke 恢复待办验证')),
        'reopened review detail',
      );
      const reopenSynced = reopenedTask?.status === 'active'
        && reopenedDetail.completed.length === 0
        && reopenedDetail.planned.some((task) => task.id === reopenedTask?.id)
        && reopenedReport.totals.completed === 0
        && reopenedAiSource.metrics.completed === 0
        && reopenedAiSource.achievements.length === 0;
      document.querySelector('[data-view="today"]').click();
      await waitFor(() => debug().visibleTaskCount === 1, 'reopened cleanup view');
      document.querySelector('.task-row [data-action="delete"]').click();
      await waitFor(() => debug().visibleTaskCount === 0 && debug().totalEvents >= 6, 'reopened cleanup');

      document.querySelector('[data-view="today"]').click();
      const input = document.querySelector('#task-input');
      input.value = 'Smoke 季度报告验证';
      document.querySelector('#add-form').requestSubmit();
      await waitFor(() => debug().visibleTaskCount === 1 && debug().totalEvents >= 7, 'task creation');

      const estimate = document.querySelector('#detail-estimate');
      estimate.value = '60';
      estimate.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => document.querySelector('.task-row')?.textContent.includes('60 分钟'), 'estimate update');

      const area = document.querySelector('#detail-area');
      area.value = '交付验证';
      area.dispatchEvent(new Event('blur'));
      await waitFor(() => document.querySelector('.task-row')?.textContent.includes('交付验证'), 'area update');

      document.querySelector('#detail-top3').click();
      await waitFor(() => document.querySelector('.task-row .top3-pill')?.textContent.includes('Top 3'), 'Top 3 update');
      document.querySelector('#detail-flagged').click();
      await waitFor(
        () => document.querySelector('.task-row .flagged-pill')?.textContent.includes('旗标')
          && document.querySelector('.task-row .flag-action')?.classList.contains('is-flagged'),
        'ordinary flag update',
      );
      document.querySelector('.task-row .flag-action').click();
      await waitFor(
        () => !document.querySelector('.task-row .flagged-pill')
          && !document.querySelector('.task-row .flag-action')?.classList.contains('is-flagged')
          && debug().totalEvents >= 12,
        'list flag removal',
      );
      document.querySelector('.task-row .flag-action').click();
      await waitFor(
        () => document.querySelector('.task-row .flagged-pill')?.textContent.includes('旗标')
          && document.querySelector('.task-row .flag-action')?.classList.contains('is-flagged')
          && debug().totalEvents >= 13,
        'list flag restore',
      );

      document.querySelector('.task-row [data-action="toggle"]').click();
      await waitFor(() => debug().visibleTaskCount === 0 && debug().totalEvents >= 14, 'task completion');

      document.querySelector('[data-view="completed"]').click();
      await waitFor(() => debug().view === 'completed' && debug().visibleTaskCount === 1, 'completed view');
      document.querySelector('.task-row').click();
      const completedEstimate = document.querySelector('#detail-estimate');
      completedEstimate.value = '90';
      completedEstimate.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => document.querySelector('.task-row')?.textContent.includes('90 分钟'), 'completed estimate sync');

      const beforeDeleteStore = await window.daymark.load();
      const beforeDeleteTask = beforeDeleteStore.tasks.find((task) => task.title === 'Smoke 季度报告验证');
      const reviewDate = beforeDeleteTask?.plannedDate;
      const reviewYear = Number(reviewDate?.slice(0, 4));
      const reviewQuarter = Math.floor((Number(reviewDate?.slice(5, 7)) - 1) / 3) + 1;
      const beforeDeleteDetail = window.DaymarkCalendar.buildDateDetail(beforeDeleteStore, reviewDate);
      const beforeDeleteReport = window.DaymarkReporting.buildPeriodReport(beforeDeleteStore, {
        year: reviewYear,
        quarter: reviewQuarter,
        today: reviewDate,
      });
      const durationSynced = beforeDeleteDetail.summary.completedMinutes === 90
        && beforeDeleteReport.totals.completedMinutes === 90;

      const completedTop3Visible = document.querySelector('.task-row .top3-pill')?.textContent.includes('Top 3');
      const completedFlagVisible = document.querySelector('.task-row .flagged-pill')?.textContent.includes('旗标');
      document.querySelector('[data-view="review"]').click();
      await waitFor(() => document.querySelector('[data-calendar-date="' + reviewDate + '"]'), 'Top 3 review calendar');
      document.querySelector('[data-calendar-date="' + reviewDate + '"]').click();
      await waitFor(
        () => [...document.querySelectorAll('.day-detail-top3')].some((badge) => badge.textContent.includes('Top 3')),
        'Top 3 review badge',
      );
      const reviewTop3Visible = [...document.querySelectorAll('.day-detail-task.is-top3')]
        .some((row) => row.textContent.includes('Smoke 季度报告验证'));
      const top3MarkersVisible = completedTop3Visible && reviewTop3Visible;
      const reviewFlagVisible = [...document.querySelectorAll('.day-detail-task.is-flagged')]
        .some((row) => row.textContent.includes('Smoke 季度报告验证'));
      const flagMarkersVisible = completedFlagVisible && reviewFlagVisible;
      document.querySelector('[data-view="completed"]').click();
      await waitFor(() => debug().view === 'completed' && debug().visibleTaskCount === 1, 'completed cleanup view');

      document.querySelector('.task-row [data-action="delete"]').click();
      await waitFor(() => debug().visibleTaskCount === 0 && debug().totalEvents >= 16, 'completed deletion');

      document.querySelector('[data-view="today"]').click();
      const ritualInput = document.querySelector('#task-input');
      ritualInput.value = 'Smoke 每日规划收尾验证';
      document.querySelector('#add-form').requestSubmit();
      await waitFor(
        () => debug().view === 'today'
          && [...document.querySelectorAll('.task-row')].some((row) => row.textContent.includes('Smoke 每日规划收尾验证')),
        'daily ritual task creation',
      );
      document.querySelector('#plan-today').click();
      await waitFor(() => document.querySelector('#daily-plan-dialog')?.open, 'morning planner dialog');
      const ritualCandidate = [...document.querySelectorAll('.ritual-candidate')]
        .find((row) => row.textContent.includes('Smoke 每日规划收尾验证'));
      const ritualTop3 = ritualCandidate?.querySelector('.plan-top3');
      if (!ritualCandidate || !ritualTop3) throw new Error('Daily planner did not surface the ritual task');
      if (!ritualTop3.checked) ritualTop3.click();
      document.querySelector('#daily-plan-form').requestSubmit();
      await waitFor(() => !document.querySelector('#daily-plan-dialog')?.open, 'morning plan confirmation');
      await waitFor(
        () => [...document.querySelectorAll('.task-row')]
          .some((row) => row.textContent.includes('Smoke 每日规划收尾验证') && row.querySelector('.top3-pill') && row.querySelector('.today-reason-pill')),
        'morning plan markers',
      );
      document.querySelector('#shutdown-today').click();
      await waitFor(() => document.querySelector('#daily-shutdown-dialog')?.open, 'shutdown dialog');
      const shutdownRow = [...document.querySelectorAll('.shutdown-task')]
        .find((row) => row.textContent.includes('Smoke 每日规划收尾验证'));
      const shutdownAction = shutdownRow?.querySelector('.shutdown-action-select');
      if (!shutdownRow || !shutdownAction) throw new Error('Shutdown did not surface the ritual task');
      shutdownAction.value = 'tomorrow';
      shutdownAction.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#shutdown-note').value = 'Smoke 今日成果';
      document.querySelector('#shutdown-tomorrow-focus').value = 'Smoke 明日重点';
      document.querySelector('#daily-shutdown-form').requestSubmit();
      await waitFor(() => !document.querySelector('#daily-shutdown-dialog')?.open, 'shutdown confirmation');
      const ritualStore = await window.daymark.load();
      const ritualDate = window.TodoDomain.dateInTimeZone(new Date(), 'Asia/Shanghai');
      const ritualTask = ritualStore.tasks.find((task) => task.title === 'Smoke 每日规划收尾验证');
      const ritualPlan = ritualStore.meta.dailyPlans?.[ritualDate];
      const dailyRitualSynced = Boolean(
        ritualTask?.plannedDate === window.DaymarkDailyPlanning.addDays(ritualDate, 1)
        && ritualTask?.top3Date === null
        && ritualPlan?.planningStartedAt
        && ritualPlan?.planningCompletedAt
        && ritualPlan?.shutdownCompletedAt
        && ritualPlan?.shutdownNote === 'Smoke 今日成果'
        && ritualPlan?.tomorrowFocus === 'Smoke 明日重点',
      );
      document.querySelector('[data-view="upcoming"]').click();
      await waitFor(
        () => [...document.querySelectorAll('.task-row')].some((row) => row.textContent.includes('Smoke 每日规划收尾验证')),
        'ritual task moved to tomorrow',
      );
      [...document.querySelectorAll('.task-row')]
        .find((row) => row.textContent.includes('Smoke 每日规划收尾验证'))
        ?.querySelector('[data-action="delete"]')?.click();
      await waitFor(
        () => ![...document.querySelectorAll('.task-row')].some((row) => row.textContent.includes('Smoke 每日规划收尾验证')),
        'ritual task cleanup',
      );

      document.querySelector('[data-view="review"]').click();
      await waitFor(() => document.querySelector('[data-review-mode="quarter"]'), 'review workspace');
      document.querySelector('[data-review-mode="quarter"]').click();
      const reportTitle = () => (
        document.querySelector('#report-title')?.textContent
        || document.querySelector('#report-document h2')?.textContent
        || document.querySelector('#report-output h2')?.textContent
        || ''
      );
      const completedMetric = () => (
        document.querySelector('[data-metric="completed"] strong')?.textContent
        || document.querySelector('[data-metric="completed"]')?.textContent
        || document.querySelectorAll('#report-metrics strong')[2]?.textContent
        || document.querySelectorAll('#report-metrics strong')[1]?.textContent
        || ''
      );
      await waitFor(
        () => debug().view === 'review' && debug().reviewMode === 'quarter' && reportTitle().includes('季度工作总结'),
        'quarter report',
      );
      const afterDeleteStore = await window.daymark.load();
      const afterDeleteDetail = window.DaymarkCalendar.buildDateDetail(afterDeleteStore, reviewDate);
      const afterDeleteReport = window.DaymarkReporting.buildPeriodReport(afterDeleteStore, {
        year: reviewYear,
        quarter: reviewQuarter,
        today: reviewDate,
      });
      const deletionSynced = afterDeleteDetail.completed.length === 0
        && afterDeleteDetail.planned.length === 0
        && afterDeleteReport.totals.completed === 0
        && afterDeleteReport.totals.planned === 0;
      return {
        ready: true,
        title: document.title,
        state: debug(),
        reportTitle: reportTitle(),
        completedMetric: completedMetric(),
        calendarCells: document.querySelectorAll('[data-calendar-date]').length,
        aiModel: aiSettings?.model || '',
        aiSecretExposed: Object.hasOwn(aiSettings || {}, 'apiKey'),
        chinaTimeSynced,
        endOfDaySettingSynced,
        dateShortcutSpacing,
        top3MarkersVisible,
        flagMarkersVisible,
        futureAttributionSynced,
        rangePlanningSynced,
        futureCalendarNavigation,
        inboxWithdrawalSynced,
        reopenSynced,
        durationSynced,
        deletionSynced,
        dailyRitualSynced,
      };
    })()
  `, true);
  const persisted = await todoStore.getSnapshot();
  const smokeTask = persisted.tasks.find((task) => task.title === 'Smoke 季度报告验证');
  const futureTask = persisted.tasks.find((task) => task.title === 'Smoke 明日归属验证');
  if (
    !result.ready ||
    result.title !== 'Daymark' ||
    result.state.version !== 3 ||
    result.state.reviewMode !== 'quarter' ||
    !result.reportTitle.includes('季度工作总结') ||
    /\b[1-9]\d*\b/.test(result.completedMetric) ||
    result.calendarCells !== 42 ||
    !result.aiModel ||
    result.aiSecretExposed ||
    !result.chinaTimeSynced ||
    !result.endOfDaySettingSynced ||
    !result.dateShortcutSpacing ||
    !result.top3MarkersVisible ||
    !result.flagMarkersVisible ||
    !result.futureAttributionSynced ||
    !result.rangePlanningSynced ||
    !result.futureCalendarNavigation ||
    !result.inboxWithdrawalSynced ||
    !result.reopenSynced ||
    !result.durationSynced ||
    !result.deletionSynced ||
    !result.dailyRitualSynced ||
    !smokeTask ||
    smokeTask.status !== 'completed' ||
    !smokeTask.deletedAt ||
    smokeTask.estimateMinutes !== 90 ||
    smokeTask.top3Date !== smokeTask.plannedDate ||
    smokeTask.flagged !== true ||
    smokeTask.area !== '交付验证' ||
    !futureTask ||
    futureTask.status !== 'active' ||
    futureTask.plannedDate !== null ||
    persisted.meta.timeZone !== 'Asia/Shanghai' ||
    persisted.meta.endOfDayReminderEnabled !== true ||
    persisted.meta.endOfDayReminderTime !== '18:15' ||
    persisted.events.length < 16
  ) {
    throw new Error(`Unexpected smoke state: ${JSON.stringify(result)}`);
  }
  console.log(`DAYMARK_SMOKE_OK ${JSON.stringify({ ...result.state, reportTitle: result.reportTitle, persistedEvents: persisted.events.length })}`);
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 790,
    minWidth: 860,
    minHeight: 620,
    title: 'Daymark',
    backgroundColor: '#f5f3ed',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadURL(APP_ENTRY_URL);
  mainWindow.on('closed', () => {
    cancelAllAiRequests();
    mainWindow = null;
  });

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        await smokeAudit();
        setTimeout(() => app.quit(), 100);
      } catch (error) {
        console.error('DAYMARK_SMOKE_FAILED', error);
        process.exitCode = 1;
        setTimeout(() => app.quit(), 100);
      }
    });
  }
  return mainWindow;
}

function safeReportName(value) {
  const base = String(value || 'Daymark-工作总结.md')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

async function writeAtomic(target, content) {
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tasksToCsv(tasks) {
  const columns = [
    'id', 'title', 'status', 'plannedDate', 'dueDate', 'priority', 'top3Date', 'flagged', 'estimateMinutes', 'area',
    'completionNote', 'repeatRule', 'reminderAt', 'createdAt', 'completedAt', 'deletedAt', 'notes',
  ];
  const rows = tasks.map((task) => columns.map((key) => {
    const value = key === 'repeatRule' && typeof task[key] === 'object' ? JSON.stringify(task[key]) : task[key];
    return csvCell(value);
  }).join(','));
  return `\uFEFF${columns.join(',')}\n${rows.join('\n')}\n`;
}

async function exportData(format = 'json') {
  const store = await todoStore.getSnapshot();
  const json = format === 'json';
  const result = await dialog.showSaveDialog(mainWindow || undefined, {
    title: json ? '导出 Daymark 完整备份' : '导出任务 CSV',
    defaultPath: json ? 'Daymark-backup.json' : 'Daymark-tasks.csv',
    filters: json
      ? [{ name: 'JSON', extensions: ['json'] }]
      : [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const content = json ? `${JSON.stringify(store, null, 2)}\n` : tasksToCsv(store.tasks);
  await writeAtomic(result.filePath, content);
  return { ok: true, path: result.filePath };
}

function installMenu() {
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建任务', accelerator: 'CmdOrCtrl+N', click: showAndFocusNewTask },
        { label: '全局快速记录', accelerator: GLOBAL_CAPTURE_SHORTCUT, click: showAndFocusNewTask },
        { type: 'separator' },
        { label: '导出完整备份…', click: () => exportData('json').catch(console.error) },
        { label: '导出任务 CSV…', click: () => exportData('csv').catch(console.error) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: '查找任务', accelerator: 'CmdOrCtrl+F', click: () => mainWindow?.webContents.send('app:focus-search') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' }] : [{ role: 'close' }])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installIpc() {
  ipcMain.handle('store:load', async (event) => {
    assertTrusted(event);
    return todoStore.load();
  });
  ipcMain.handle('store:command', async (event, command) => {
    assertTrusted(event);
    try {
      return await todoStore.execute(command);
    } catch (error) {
      console.error('Daymark command failed in main process:', error);
      throw error;
    }
  });
  ipcMain.handle('store:persist-archives', async (event, dailyArchives) => {
    assertTrusted(event);
    return todoStore.persistArchives(dailyArchives);
  });
  ipcMain.handle('reports:save-markdown', async (event, payload) => {
    assertTrusted(event);
    const content = String(payload?.content || '');
    if (!content || content.length > 5_000_000) throw new Error('报告内容为空或过大');
    const suggestedName = safeReportName(payload?.suggestedName);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存工作总结',
      defaultPath: suggestedName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await writeAtomic(result.filePath, content);
    return { ok: true, path: result.filePath };
  });
  ipcMain.handle('store:export', async (event, format) => {
    assertTrusted(event);
    return exportData(format === 'csv' ? 'csv' : 'json');
  });
  ipcMain.handle('ai:get-settings', async (event, payload) => {
    assertTrusted(event);
    validateAiInput(() => assertNoPayload(payload, 'ai:get-settings'));
    try {
      return await aiService.getSettings();
    } catch (error) {
      throw publicAiError(error);
    }
  });
  ipcMain.handle('ai:save-settings', async (event, payload) => {
    assertTrusted(event);
    const settings = validateAiInput(() => validateAiSettings(payload));
    try {
      await aiService.saveSettings(settings);
      return await aiService.getSettings();
    } catch (error) {
      throw publicAiError(error);
    }
  });
  ipcMain.handle('ai:set-key', async (event, payload) => {
    assertTrusted(event);
    const apiKey = validateAiInput(() => validateAiKey(payload));
    try {
      await aiService.saveSettings({ apiKey });
      return await aiService.getSettings();
    } catch (error) {
      throw publicAiError(error);
    }
  });
  ipcMain.handle('ai:clear-key', async (event, payload) => {
    assertTrusted(event);
    validateAiInput(() => assertNoPayload(payload, 'ai:clear-key'));
    try {
      await aiService.clearKey();
      return await aiService.getSettings();
    } catch (error) {
      throw publicAiError(error);
    }
  });
  ipcMain.handle('ai:generate-report', async (event, payload) => {
    assertTrusted(event);
    const options = validateAiInput(() => validateAiReportOptions(payload));
    if (aiGenerationLocked || activeAiRequests.size > 0 || activeAiRequests.has(options.requestId)) {
      throw publicAiError({ code: ERROR_CODES.BUSY });
    }
    aiGenerationLocked = true;
    const ownerId = `window-${event.sender.id}-${randomUUID()}`;
    const activeRequest = { ownerId, senderId: event.sender.id, canceled: false };
    activeAiRequests.set(options.requestId, activeRequest);
    try {
      let settings;
      try {
        settings = await aiService.getSettings();
      } catch (error) {
        throw publicAiError(error);
      }
      if (!settings.hasApiKey) {
        throw publicAiError({
          code: settings.hasStoredKey ? ERROR_CODES.STORAGE_UNAVAILABLE : ERROR_CODES.KEY_MISSING,
        });
      }
      if (activeRequest.canceled) return { canceled: true };
      if (!(await confirmAiReportTransfer(options))) return { canceled: true };
      if (activeRequest.canceled) return { canceled: true };

      let sourceData;
      try {
        const store = await todoStore.getSnapshot();
        sourceData = buildReportSourceData(store, {
          mode: options.mode,
          year: options.year,
          month: options.month,
          quarter: options.quarter,
          today: localToday(),
        });
      } catch (error) {
        error.code = ERROR_CODES.INPUT_INVALID;
        throw publicAiError(error);
      }
      if (!options.includeDailyNotes) delete sourceData.dailyNotes;
      if (!options.includeCompletionNotes) {
        sourceData.achievements = sourceData.achievements.map((achievement) => {
          const { completionNote: _excluded, ...safeAchievement } = achievement;
          return safeAchievement;
        });
      }
      if (activeRequest.canceled) return { canceled: true };

      try {
        return await aiService.generateReport(ownerId, {
          sourceData,
          instructions: buildReportInstructions(),
          includeDailyNotes: options.includeDailyNotes,
          includeCompletionNotes: options.includeCompletionNotes,
        });
      } catch (error) {
        throw publicAiError(error);
      }
    } finally {
      activeAiRequests.delete(options.requestId);
      aiGenerationLocked = false;
    }
  });
  ipcMain.handle('ai:cancel', async (event, payload) => {
    assertTrusted(event);
    const requestId = validateAiInput(() => {
      assertExactObject(payload, ['requestId'], 'ai:cancel');
      return validatedRequestId(payload.requestId);
    });
    const request = activeAiRequests.get(requestId);
    if (!request || request.senderId !== event.sender.id) return { canceled: false };
    request.canceled = true;
    cancelAiRequest(requestId, request);
    return { canceled: true };
  });
}

async function deliverDueReminders() {
  if (!Notification.isSupported()) return;
  const store = await todoStore.load();
  const now = new Date();
  const due = store.tasks.filter((task) => {
    if (task.deletedAt || task.status === 'completed' || !task.reminderAt) return false;
    const reminder = new Date(task.reminderAt);
    if (Number.isNaN(reminder.getTime()) || reminder > now) return false;
    if (!task.reminderFiredAt) return true;
    return new Date(task.reminderFiredAt) < reminder;
  });
  for (const task of due) {
    new Notification({ title: task.title, body: task.area ? `${task.area} · Daymark 提醒` : 'Daymark 提醒' }).show();
    await todoStore.execute({
      type: 'markReminderFired',
      eventId: `reminder-${task.id}-${task.reminderAt}`,
      taskId: task.id,
      occurredAt: now.toISOString(),
    });
  }
}

async function deliverEndOfDayReminder() {
  if (!Notification.isSupported()) return;
  const store = await todoStore.load();
  const now = new Date();
  const evaluation = evaluateEndOfDayReminder(store, now, { timeZone: DAYMARK_TIME_ZONE });
  if (!evaluation.due) return;
  const copy = notificationCopy(evaluation);
  const notification = new Notification({ title: copy.title, body: copy.body });
  notification.on('click', showAndFocusDailyShutdown);
  notification.show();
  await todoStore.execute({
    type: 'markEndOfDayReminderFired',
    eventId: `end-of-day-reminder-${evaluation.date}`,
    occurredAt: now.toISOString(),
    payload: { date: evaluation.date },
  });
}

async function deliverScheduledReminders() {
  await deliverDueReminders();
  await deliverEndOfDayReminder();
}

function startReminderScheduler() {
  clearInterval(reminderTimer);
  deliverScheduledReminders().catch((error) => console.error('Unable to deliver reminder:', error));
  reminderTimer = setInterval(() => {
    deliverScheduledReminders().catch((error) => console.error('Unable to deliver reminder:', error));
  }, 30_000);
}

app.setName('Daymark');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showAndFocusNewTask);
  app.whenReady().then(() => {
    installAppProtocol();
    const dataDirectory = path.join(app.getPath('userData'), 'daymark-data');
    todoStore = createTodoStore(path.join(dataDirectory, 'todos.json'), {
      timeZone: DAYMARK_TIME_ZONE,
      forceTimeZone: true,
    });
    aiService = createAiService({
      settingsPath: path.join(dataDirectory, 'ai-settings.json'),
      // Packaged smoke tests use disposable data and never exercise API-key
      // storage. Avoid letting a macOS Keychain prompt block headless release
      // verification; production continues to use Electron safeStorage.
      safeStorage: isSmokeTest ? { isEncryptionAvailable: () => false } : safeStorage,
      fetch: (...args) => net.fetch(...args),
    });
    installIpc();
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    installMenu();
    createWindow();
    const registered = globalShortcut.register(GLOBAL_CAPTURE_SHORTCUT, showAndFocusNewTask);
    if (!registered) console.warn(`Unable to register global shortcut: ${GLOBAL_CAPTURE_SHORTCUT}`);
    startReminderScheduler();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showAndFocusNewTask();
    });
  });
}

app.on('window-all-closed', () => {
  if (!isMac || isSmokeTest) app.quit();
});

app.on('will-quit', () => {
  cancelAllAiRequests();
  clearInterval(reminderTimer);
  globalShortcut.unregisterAll();
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault();
  });
});
