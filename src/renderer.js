const {
  STORE_VERSION,
  localDate,
  dateInTimeZone,
  sanitizeStore,
  applyCommand,
  visibleTasks,
  counts,
  inverseTaskPatch,
  nextRecurringDate,
  focusSessionEnd,
} = window.TodoDomain;

const Reporting = window.DaymarkReporting;
const Calendar = window.DaymarkCalendar;
const Planning = window.DaymarkPlanning;
const Worklog = window.DaymarkWorklog;
const DailyPlanning = window.DaymarkDailyPlanning;
const AiReport = window.DaymarkAiReport;
const Focus = window.DaymarkFocus;
const DAYMARK_TIME_ZONE = 'Asia/Shanghai';
const WORKLOG_START_HOUR = 0;
const WORKLOG_END_HOUR = 24;
const WORKLOG_PIXELS_PER_MINUTE = 1.1;
const WORKLOG_MIN_BLOCK_HEIGHT = 22;
const WORKLOG_DEFAULT_SCROLL_MINUTE = 480;

function commandId(prefix = 'event') {
  if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

let previewStore;
let previewAiSettings = {
  model: 'gpt-5.6-terra',
  hasKey: false,
  keySource: 'none',
  includeDailyNotes: false,
  includeCompletionNotes: true,
};
const browserPreviewBridge = {
  async load() {
    try {
      const raw = JSON.parse(localStorage.getItem('daymark-preview') || '{"version":1,"tasks":[]}');
      previewStore = sanitizeStore({ ...raw, meta: { ...(raw.meta || {}), timeZone: DAYMARK_TIME_ZONE } });
    } catch {
      previewStore = sanitizeStore({ version: 1, tasks: [] }, { timeZone: DAYMARK_TIME_ZONE });
    }
    previewStore = { ...previewStore, meta: { ...previewStore.meta, timeZone: DAYMARK_TIME_ZONE } };
    return previewStore;
  },
  async command(command) {
    previewStore = applyCommand(previewStore || sanitizeStore({ version: 1, tasks: [] }, { timeZone: DAYMARK_TIME_ZONE }), command);
    localStorage.setItem('daymark-preview', JSON.stringify(previewStore));
    return previewStore;
  },
  async persistArchives(dailyArchives) {
    previewStore = sanitizeStore({ ...previewStore, dailyArchives });
    localStorage.setItem('daymark-preview', JSON.stringify(previewStore));
    return previewStore;
  },
  async saveMarkdown({ suggestedName, content }) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = suggestedName;
    link.click();
    URL.revokeObjectURL(link.href);
    return { ok: true, path: suggestedName };
  },
  onFocusNewTask: () => () => {},
  onFocusSearch: () => () => {},
  onOpenDailyShutdown: () => () => {},
  onOpenFocus: () => () => {},
  async notifyFocusCompleted() {
    // A browser preview has no system notification channel to reach.
    return { notified: false };
  },
  async getAiSettings() {
    return { ...previewAiSettings };
  },
  async saveAiSettings(settings) {
    previewAiSettings = { ...previewAiSettings, ...settings };
    return { ...previewAiSettings };
  },
  async setAiKey(apiKey) {
    previewAiSettings.hasKey = Boolean(String(apiKey || '').trim());
    previewAiSettings.keySource = previewAiSettings.hasKey ? 'preview' : 'none';
    return { ...previewAiSettings };
  },
  async clearAiKey() {
    previewAiSettings.hasKey = false;
    previewAiSettings.keySource = 'none';
    return { ...previewAiSettings };
  },
  async generateAiReport() {
    return {
      model: previewAiSettings.model,
      text: '# AI 预览草稿\n\n浏览器预览不会连接外部服务。安装桌面应用并配置 API Key 后，可基于所选工作记录生成 AI 总结。',
    };
  },
  async cancelAiReport() {
    return { canceled: true };
  },
};

const previewEnabled = new URLSearchParams(window.location.search).get('preview') === '1';
const unavailableBridge = {
  async load() { throw new Error('安全桥接未加载，应用已进入只读保护'); },
  async command() { throw new Error('安全桥接未加载，禁止写入'); },
  async persistArchives() { throw new Error('安全桥接未加载，禁止写入'); },
  async saveMarkdown() { throw new Error('安全桥接未加载，禁止导出'); },
  onFocusNewTask: () => () => {},
  onFocusSearch: () => () => {},
  onOpenDailyShutdown: () => () => {},
  onOpenFocus: () => () => {},
  async notifyFocusCompleted() { return { notified: false }; },
};
const bridgeUnavailable = !window.daymark && !previewEnabled;
const bridge = window.daymark || (previewEnabled ? browserPreviewBridge : unavailableBridge);

const VIEW_COPY = {
  inbox: {
    title: '收件箱',
    listLabel: '待安排',
    hint: '先收集，再决定什么时候做',
    emptyTitle: '收件箱已经清空',
    emptyCopy: '想到的新任务会先放在这里。',
  },
  today: {
    title: '今天',
    listLabel: '今日承诺',
    hint: '选择真正做得完的今天',
    emptyTitle: '今天留白',
    emptyCopy: '从收件箱挑选任务，或者给自己留一点空间。',
  },
  upcoming: {
    title: '即将安排',
    listLabel: '之后的计划',
    hint: '按计划日期排列',
    emptyTitle: '还没有未来计划',
    emptyCopy: '为任务设置计划日期后会出现在这里。',
  },
  all: {
    title: '全部待办',
    listLabel: '所有待处理',
    hint: '包括收件箱和已安排任务',
    emptyTitle: '还没有任务',
    emptyCopy: '在上方输入第一件要做的事。',
  },
  completed: {
    title: '已完成',
    listLabel: '完成记录',
    hint: '成果会进入工作回顾',
    emptyTitle: '还没有完成任何任务',
    emptyCopy: '完成任务后，可以在这里查看。',
  },
  worklog: {
    title: '处理记录',
    listLabel: '',
    hint: '',
    emptyTitle: '',
    emptyCopy: '',
  },
  calendar: {
    title: '待办日历',
    listLabel: '',
    hint: '',
    emptyTitle: '',
    emptyCopy: '',
  },
  review: {
    title: '工作回顾',
    listLabel: '',
    hint: '',
    emptyTitle: '',
    emptyCopy: '',
  },
  focus: {
    title: '专注',
    listLabel: '',
    hint: '',
    emptyTitle: '',
    emptyCopy: '',
  },
};

const PRIORITY_LABELS = {
  low: '低优先级',
  medium: '中优先级',
  high: '高优先级',
};

const state = {
  store: null,
  view: 'inbox',
  reviewMode: 'month',
  query: '',
  selectedId: null,
  quickDate: null,
  calendarDate: null,
  reviewMonth: null,
  calendarMonth: null,
  reviewSelectedDate: null,
  worklogMode: 'day',
  worklogDate: null,
  lastTimedTaskId: null,
  calendarMode: 'week',
  todoCalendarDate: null,
  history: [],
  report: null,
  reportMarkdown: '',
  reportTitle: '',
  reportPeriodKey: '',
  reportSource: null,
  aiSettings: {
    model: 'gpt-5.6-terra',
    hasKey: false,
    keySource: 'none',
    includeDailyNotes: false,
    includeCompletionNotes: true,
  },
  aiRequestId: null,
  aiReportText: '',
  focusMinutes: null,
  focusOutcome: null,
  focusStartTaskId: null,
  focusStartMinutes: null,
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  shell: $('.app-shell'),
  addForm: $('#add-form'),
  taskInput: $('#task-input'),
  searchBox: $('#search-box'),
  searchInput: $('#search-input'),
  dateLabel: $('#date-label'),
  viewTitle: $('#view-title'),
  viewSummary: $('#view-summary'),
  listLabel: $('#list-label'),
  toolbarHint: $('#toolbar-hint'),
  taskWorkspace: $('#task-workspace'),
  taskList: $('#task-list'),
  emptyState: $('#empty-state'),
  emptyTitle: $('#empty-title'),
  emptyCopy: $('#empty-copy'),
  emptyAction: $('#empty-action'),
  todayCapacity: $('#today-capacity'),
  capacitySummary: $('#capacity-summary'),
  capacityFill: $('#capacity-fill'),
  capacitySelect: $('#capacity-select'),
  endOfDayEnabled: $('#end-of-day-enabled'),
  endOfDayTime: $('#end-of-day-time'),
  dailyRitualBar: $('#daily-ritual-bar'),
  dailyRitualStatus: $('#daily-ritual-status'),
  dailyRitualDetail: $('#daily-ritual-detail'),
  planToday: $('#plan-today'),
  shutdownToday: $('#shutdown-today'),
  dailyNote: $('#daily-note'),
  dailyNoteInput: $('#daily-note-input'),
  worklogWorkspace: $('#worklog-workspace'),
  worklogDate: $('#worklog-date'),
  worklogPrevious: $('#worklog-previous'),
  worklogNext: $('#worklog-next'),
  worklogToday: $('#worklog-today'),
  worklogRange: $('#worklog-range'),
  worklogSummary: $('#worklog-summary'),
  worklogCalendar: $('#worklog-calendar'),
  worklogScroll: $('#worklog-scroll'),
  worklogRollup: $('#worklog-rollup'),
  todoCalendarWorkspace: $('#todo-calendar-workspace'),
  todoCalendarRange: $('#todo-calendar-range'),
  todoCalendarPrevious: $('#todo-calendar-previous'),
  todoCalendarNext: $('#todo-calendar-next'),
  todoCalendarToday: $('#todo-calendar-today'),
  todoCalendarBody: $('#todo-calendar-body'),
  todoCalendarSummary: $('#todo-calendar-summary'),
  runStrip: $('#run-strip'),
  runTaskTitle: $('#run-task-title'),
  runElapsed: $('#run-elapsed'),
  runSegments: $('#run-segments'),
  runPause: $('#run-pause'),
  runComplete: $('#run-complete'),
  reviewWorkspace: $('#review-workspace'),
  reviewDashboard: $('#review-dashboard'),
  dailyReviewPane: $('#daily-review-pane'),
  reportReviewPane: $('#report-review-pane'),
  recordMonth: $('#record-month'),
  recordRangeNote: $('#record-range-note'),
  dailyRecordList: $('#daily-record-list'),
  reportYear: $('#report-year'),
  quarterControl: $('#quarter-control'),
  reportQuarter: $('#report-quarter'),
  copyReport: $('#copy-report'),
  saveReport: $('#save-report'),
  reportMetrics: $('#report-metrics'),
  reportTrend: $('#report-trend'),
  reportDocument: $('#report-document'),
  reviewPeriodTitle: $('#review-period-title'),
  yearControl: $('#year-control'),
  calendarGrid: $('#calendar-grid'),
  holidaySourceNote: $('#holiday-source-note'),
  previousMonth: $('#previous-month'),
  nextMonth: $('#next-month'),
  dayDetail: $('#day-detail'),
  dayDetailDate: $('#day-detail-date'),
  dayDetailHoliday: $('#day-detail-holiday'),
  dayDetailScore: $('#day-detail-score'),
  dayDetailNote: $('#day-detail-note'),
  dayDetailTasks: $('#day-detail-tasks'),
  aiReportRange: $('#ai-report-range'),
  aiModel: $('#ai-model'),
  aiApiKey: $('#ai-api-key'),
  aiKeyStatus: $('#ai-key-status'),
  saveAiKey: $('#save-ai-key'),
  clearAiKey: $('#clear-ai-key'),
  includeDailyNotes: $('#include-daily-notes'),
  includeCompletionNotes: $('#include-completion-notes'),
  generateAiReport: $('#generate-ai-report'),
  cancelAiReport: $('#cancel-ai-report'),
  aiActionNote: $('#ai-action-note'),
  reportKind: $('#report-kind'),
  reportTitle: $('#report-title'),
  reportOutput: $('#report-output'),
  reportStatus: $('#report-status'),
  detailsPanel: $('#details-panel'),
  detailsEmpty: $('#details-empty'),
  detailsForm: $('#details-form'),
  detailCompleted: $('#detail-completed'),
  completeLabel: $('#complete-label'),
  detailTitle: $('#detail-title'),
  detailPlanned: $('#detail-planned'),
  detailDue: $('#detail-due'),
  schedulePreview: $('#schedule-preview'),
  detailEstimate: $('#detail-estimate'),
  detailArea: $('#detail-area'),
  areaSuggestions: $('#area-suggestions'),
  detailTop3: $('#detail-top3'),
  detailFlagged: $('#detail-flagged'),
  detailRepeat: $('#detail-repeat'),
  detailReminder: $('#detail-reminder'),
  detailSource: $('#detail-source'),
  detailNotes: $('#detail-notes'),
  detailCompletionNote: $('#detail-completion-note'),
  completionNoteField: $('#completion-note-field'),
  notesCount: $('#notes-count'),
  deleteTask: $('#delete-task'),
  closeDetails: $('#close-details'),
  saveStatus: $('#save-status'),
  statusDot: $('.status-dot'),
  toast: $('#toast'),
  toastMessage: $('#toast-message'),
  undoButton: $('#undo-button'),
  dailyPlanDialog: $('#daily-plan-dialog'),
  dailyPlanForm: $('#daily-plan-form'),
  dailyPlanCandidates: $('#daily-plan-candidates'),
  dailyPlanSummary: $('#daily-plan-summary'),
  dailyPlanEmpty: $('#daily-plan-empty'),
  confirmDailyPlan: $('#confirm-daily-plan'),
  dailyShutdownDialog: $('#daily-shutdown-dialog'),
  dailyShutdownForm: $('#daily-shutdown-form'),
  dailyShutdownTasks: $('#daily-shutdown-tasks'),
  dailyShutdownSummary: $('#daily-shutdown-summary'),
  dailyShutdownEmpty: $('#daily-shutdown-empty'),
  shutdownNote: $('#shutdown-note'),
  shutdownBlockerNote: $('#shutdown-blocker-note'),
  shutdownTomorrowFocus: $('#shutdown-tomorrow-focus'),
  confirmDailyShutdown: $('#confirm-daily-shutdown'),
  manualTimeDialog: $('#manual-time-dialog'),
  manualTimeForm: $('#manual-time-form'),
  manualTimeTaskId: $('#manual-time-task-id'),
  manualTimeTaskTitle: $('#manual-time-task-title'),
  manualTimeDate: $('#manual-time-date'),
  manualTimeMinutes: $('#manual-time-minutes'),
  manualTimeNote: $('#manual-time-note'),
  saveManualTime: $('#save-manual-time'),
  debugState: $('#app-debug-state'),
  focusNavCount: $('#focus-nav-count'),
  focusChip: $('#focus-chip'),
  focusChipTime: $('#focus-chip-time'),
  focusWorkspace: $('#focus-workspace'),
  focusPanel: $('#focus-panel'),
  focusRingProgress: $('#focus-ring-progress'),
  focusTree: $('.focus-tree'),
  focusClock: $('#focus-clock'),
  focusStateLine: $('#focus-state-line'),
  focusPhaseIdle: $('#focus-phase-idle'),
  focusPhaseRunning: $('#focus-phase-running'),
  focusPhaseDone: $('#focus-phase-done'),
  focusPhaseWithered: $('#focus-phase-withered'),
  focusDurationChips: $('#focus-duration-chips'),
  focusTaskSelect: $('#focus-task-select'),
  focusStart: $('#focus-start'),
  focusStartDialog: $('#focus-start-dialog'),
  focusStartChips: $('#focus-start-chips'),
  focusStartTaskTitle: $('#focus-start-task-title'),
  focusStartHint: $('#focus-start-hint'),
  focusStartConfirm: $('#focus-start-confirm'),
  focusPause: $('#focus-pause'),
  focusGiveup: $('#focus-giveup'),
  focusConfirm: $('#focus-confirm'),
  focusConfirmYes: $('#focus-confirm-yes'),
  focusConfirmNo: $('#focus-confirm-no'),
  focusAgain: $('#focus-again'),
  focusRest: $('#focus-rest'),
  focusRetry: $('#focus-retry'),
  focusTodayMinutes: $('#focus-today-minutes'),
  focusTodaySub: $('#focus-today-sub'),
  focusGoalFill: $('#focus-goal-fill'),
  focusGoalCaption: $('#focus-goal-caption'),
  focusGrove: $('#focus-grove'),
  focusBars: $('#focus-bars'),
  focusBarLabels: $('#focus-bar-labels'),
  focusWeekTotal: $('#focus-week-total'),
  focusStrictMode: $('#focus-strict-mode'),
  focusNotification: $('#focus-notification'),
  focusGoalSelect: $('#focus-goal-select'),
};

let commandChain = Promise.resolve();
let toastTimer;
let noteTimer;
let dateCheckTimer;
let focusTicker;
let pendingDailyNote = null;
let runTicker = null;
let draggedCalendarTask = null;
const fieldTimers = new Map();
const pendingTaskActions = new Set();
const detailsOverlayQuery = window.matchMedia('(max-width: 1030px)');

function activeTasks() {
  return state.store?.tasks || [];
}

function focusSessions() {
  return state.store?.focusSessions || [];
}

function focusSettings() {
  return state.store?.meta?.focusSettings || {
    defaultMinutes: 25, strictMode: true, completionNotification: true, dailyGoalMinutes: 120,
  };
}

function runningFocusSession() {
  return Focus.runningSession(focusSessions());
}

function selectedTask() {
  return activeTasks().find((task) => task.id === state.selectedId && !task.deletedAt) || null;
}

function todayDate() {
  return dateInTimeZone(new Date(), state.store?.meta?.timeZone || DAYMARK_TIME_ZONE);
}

function addDays(value, amount) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function tomorrowDate() {
  return addDays(todayDate(), 1);
}

function toInputDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DAYMARK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function fromInputDateTime(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function coerceStore(result) {
  const candidate = result?.store || result?.data?.store || result?.data || result;
  return sanitizeStore(candidate);
}

function setSaveState(kind) {
  elements.statusDot.classList.toggle('is-saving', kind === 'saving');
  elements.statusDot.classList.toggle('is-error', kind === 'error');
  elements.saveStatus.textContent =
    kind === 'saving' ? '正在保存本地历史…' : kind === 'error' ? '保存失败，历史尚未写入' : '本地历史已保存';
}

function showToast(message, canUndo = false) {
  clearTimeout(toastTimer);
  elements.toastMessage.textContent = message;
  elements.undoButton.hidden = !canUndo || state.history.length === 0;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 8000);
}

function errorMessage(error) {
  const text = String(error?.message || error || '未知错误');
  if (text.includes('Only three Top 3')) return '一天最多只能标记 3 个 Top 3 任务';
  if (text.includes('Due date cannot be earlier')) return '最后期限不能早于计划日期';
  if (text.includes('Schedule block conflicts')) return '这个时段已有锁定任务，请换一个时间';
  if (text.includes('Schedule block must stay')) return '手动安排必须位于任务的计划日期和最后期限之间';
  // Covers both timers: a strict-mode pomodoro cannot be paused, so telling the
  // user to pause would be advice they cannot follow.
  if (text.includes('focus session is already running')) return '已有专注正在进行，先结束它再开始新的';
  if (text.includes('Unsupported store version')) return '数据来自更新版本，为避免覆盖已切换到只读保护';
  return text;
}

function runAction(action) {
  Promise.resolve(action).catch(() => {});
}

function pushUndo(commands, message) {
  const safeCommands = Array.isArray(commands) ? commands : [commands];
  state.history.push({ commands: safeCommands, message });
  if (state.history.length > 40) state.history.shift();
}

function dispatch(command, options = {}) {
  const request = {
    ...command,
    eventId: command.eventId || commandId(command.type),
    occurredAt: command.occurredAt || new Date().toISOString(),
    timeZone: state.store?.meta?.timeZone,
  };
  setSaveState('saving');
  commandChain = commandChain
    .catch(() => {})
    .then(() => bridge.command(request))
    .then((result) => {
      state.store = coerceStore(result);
      if (options.selectedId !== undefined) state.selectedId = options.selectedId;
      setSaveState('saved');
      render();
      if (options.undo) pushUndo(options.undo, options.undoMessage || '已撤销');
      if (options.message) showToast(options.message, Boolean(options.undo));
      return state.store;
    })
    .catch((error) => {
      console.error('Daymark command failed:', error);
      const validationError = /Only three Top 3|Due date cannot be earlier/.test(String(error?.message || error));
      setSaveState(validationError ? 'saved' : 'error');
      render();
      showToast(errorMessage(error), false);
      throw error;
    });
  return commandChain;
}

async function undo() {
  const entry = state.history.pop();
  if (!entry) return;
  try {
    for (const command of entry.commands) {
      await dispatch(command, { selectedId: command.taskId || state.selectedId });
    }
    showToast(entry.message || '已撤销上一步操作', false);
  } catch {
    state.history.push(entry);
  }
}

function createSvg(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach(({ tag = 'path', attrs }) => {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([name, value]) => child.setAttribute(name, value));
    svg.appendChild(child);
  });
  return svg;
}

function calendarIcon() {
  return createSvg([
    { tag: 'rect', attrs: { x: '4', y: '5', width: '16', height: '15', rx: '3' } },
    { attrs: { d: 'M8 3v4M16 3v4M4 10h16' } },
  ]);
}

function noteIcon() {
  return createSvg([{ attrs: { d: 'M6 4h12v16H6zM9 9h6M9 13h6' } }]);
}

function checkIcon() {
  return createSvg([{ attrs: { d: 'm7 12.5 3.2 3.2L17.5 8' } }]);
}

function trashIcon() {
  return createSvg([{ attrs: { d: 'M6 7h12M9 7V4h6v3M8 10v9M12 10v9M16 10v9M7 7l1 14h8l1-14' } }]);
}

function formatHeaderDate() {
  return `${new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'long', timeZone: DAYMARK_TIME_ZONE,
  })
    .format(new Date())
    .replace('星期', ' · 星期')} · 中国时间`;
}

function formatShortDate(value) {
  if (!value) return '';
  if (value === todayDate()) return '今天';
  if (value === tomorrowDate()) return '明天';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatCompletedGroupDate(value, today) {
  if (!value) return '日期未记录';
  const relative = value === today ? '今天' : value === addDays(today, -1) ? '昨天' : '';
  const includeYear = value.slice(0, 4) !== today.slice(0, 4);
  const formatted = new Intl.DateTimeFormat('zh-CN', {
    ...(includeYear ? { year: 'numeric' } : {}),
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
  return relative ? `${relative} · ${formatted}` : formatted;
}

function formatCompletionTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: state.store?.meta?.timeZone || DAYMARK_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function appendMeta(meta, text, className = '') {
  const item = document.createElement('span');
  item.className = `meta-pill ${className}`.trim();
  item.textContent = text;
  meta.appendChild(item);
  return item;
}

function renderSidebar() {
  const taskCounts = counts(activeTasks(), todayDate());
  document.querySelectorAll('[data-count]').forEach((element) => {
    element.textContent = String(taskCounts[element.dataset.count] || 0);
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

function renderHeader() {
  const copy = VIEW_COPY[state.view];
  const specialView = ['review', 'worklog', 'calendar', 'focus'].includes(state.view);
  const count = specialView ? 0 : visibleTasks(activeTasks(), state.view, '', todayDate()).length;
  elements.dateLabel.textContent = formatHeaderDate();
  elements.viewTitle.textContent = copy.title;
  elements.searchBox.hidden = specialView;
  if (state.view === 'focus') {
    const summary = Focus.dailyFocusSummary(focusSessions(), todayDate());
    elements.viewSummary.textContent = summary.completedCount || summary.abandonedCount
      ? `今日已专注 ${summary.minutes} 分钟 · 种下 ${summary.completedCount} 棵树`
      : '选一段时间，专心种一棵树';
  } else if (state.view === 'review') {
    elements.viewSummary.textContent = '每日记录自动沉淀，报告默认在本机生成';
  } else if (state.view === 'worklog') {
    const summary = Worklog.dailySummary(state.store, state.worklogDate || todayDate(), { now: new Date() });
    elements.viewSummary.textContent = summary.segmentCount
      ? `处理 ${summary.taskCount} 个任务 · 累计 ${humanMinutes(summary.minutes)}`
      : '开始处理任务后，这里会记录每一段时间';
  } else if (state.view === 'calendar') {
    elements.viewSummary.textContent = state.calendarMode === 'week'
      ? '这一周每天要做什么'
      : '整月的待办分布';
  } else if (state.view === 'completed') {
    elements.viewSummary.textContent = `${count} 件已完成`;
  } else if (state.view === 'inbox') {
    elements.viewSummary.textContent = `${count} 件待安排`;
  } else {
    elements.viewSummary.textContent = `${count} 件待处理`;
  }
  elements.listLabel.textContent = state.query ? '搜索结果' : copy.listLabel;
  elements.toolbarHint.textContent = copy.hint;
}

function buildTaskRow(task, options = {}) {
  const showTop3 = Boolean(task.top3Date && task.top3Date === task.plannedDate);
  const top3Label = task.top3Date === todayDate()
    ? '★ 今日 Top 3'
    : `★ ${formatShortDate(task.top3Date)} Top 3`;
  const row = document.createElement('article');
  row.className = 'task-row';
  row.classList.toggle('is-selected', task.id === state.selectedId);
  row.classList.toggle('is-completed', task.status === 'completed');
  row.classList.toggle('is-top3', showTop3);
  row.classList.toggle('is-flagged', Boolean(task.flagged));
  row.dataset.taskId = task.id;
  row.setAttribute('role', 'listitem');
  row.setAttribute('tabindex', task.id === state.selectedId ? '0' : '-1');
  row.setAttribute('aria-label', `${task.title}${showTop3 ? `，${top3Label.slice(2)}` : ''}${task.flagged ? '，已加旗标' : ''}`);

  const checkbox = document.createElement('button');
  checkbox.type = 'button';
  checkbox.className = 'check-button';
  checkbox.dataset.action = 'toggle';
  checkbox.setAttribute('aria-label', task.status === 'completed' ? '恢复任务' : '完成任务');
  checkbox.setAttribute('aria-pressed', String(task.status === 'completed'));
  checkbox.appendChild(checkIcon());

  const main = document.createElement('div');
  main.className = 'task-main';
  const title = document.createElement('span');
  title.className = 'task-title';
  if (showTop3) {
    const star = document.createElement('span');
    star.className = 'top3-star';
    star.textContent = '★';
    title.append(star, ' ');
  }
  title.append(task.title);
  main.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'task-meta';
  if (options.completionTime) appendMeta(meta, `${options.completionTime} 完成`, 'completion-time-pill');
  if (options.todayReason) {
    const reason = appendMeta(meta, options.todayReason, 'today-reason-pill');
    reason.classList.toggle('is-overdue', options.todayReason.includes('逾期') || options.todayReason.includes('延续'));
  }
  if (showTop3) appendMeta(meta, top3Label, 'top3-pill');
  if (task.flagged) appendMeta(meta, '⚑ 旗标', 'flagged-pill');
  if (task.plannedDate) appendMeta(meta, `计划 ${formatShortDate(task.plannedDate)}`, 'planned-pill');
  if (task.dueDate) {
    const deadline = appendMeta(meta, `截止 ${formatShortDate(task.dueDate)}`, 'deadline-pill');
    deadline.classList.toggle('is-overdue', task.status === 'active' && task.dueDate < todayDate());
  }
  if (task.estimateMinutes) appendMeta(meta, `${task.estimateMinutes} 分钟`, 'estimate-pill');
  const actualMinutes = Worklog.actualMinutesForTask(state.store, task.id, { now: new Date() });
  const segmentCount = actualMinutes ? Worklog.entriesForTask(state.store, task.id).length : 0;
  if (actualMinutes) {
    appendMeta(meta, `实际 ${humanMinutes(actualMinutes)} · ${segmentCount} 段`, 'actual-pill');
  }
  if (runningEntry()?.taskId === task.id) appendMeta(meta, '处理中', 'running-pill');
  if (task.area) appendMeta(meta, task.area, 'area-pill');
  if (task.priority !== 'none') appendMeta(meta, PRIORITY_LABELS[task.priority], `priority-${task.priority}`);
  if (task.repeatRule) appendMeta(meta, '重复', 'repeat-pill');
  if (task.reminderAt) appendMeta(meta, '有提醒', 'reminder-pill');
  if (task.notes.trim()) {
    const notes = appendMeta(meta, '有备注', 'notes-pill');
    notes.prepend(noteIcon());
  }
  if (!meta.childNodes.length) appendMeta(meta, '尚未安排');
  main.appendChild(meta);

  const priorityMark = document.createElement('span');
  priorityMark.className = `row-priority priority-dot ${task.priority}`;
  priorityMark.setAttribute('aria-hidden', 'true');

  const flag = document.createElement('button');
  flag.type = 'button';
  flag.className = `flag-action${task.flagged ? ' is-flagged' : ''}`;
  flag.dataset.action = 'flag';
  flag.setAttribute('aria-label', task.flagged ? `移除“${task.title}”的旗标` : `为“${task.title}”添加旗标`);
  flag.setAttribute('aria-pressed', String(Boolean(task.flagged)));
  flag.textContent = task.flagged ? '⚑' : '⚐';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'row-action';
  remove.dataset.action = 'delete';
  remove.setAttribute('aria-label', `删除“${task.title}”`);
  remove.appendChild(trashIcon());

  row.append(checkbox, main);
  if (state.view === 'today' && task.status === 'active') {
    row.classList.add('has-row-actions');
    const timing = runningEntry()?.taskId === task.id;
    const timer = document.createElement('button');
    timer.type = 'button';
    timer.className = `timer-action${timing ? ' is-running' : ''}`;
    timer.dataset.action = timing ? 'pause' : 'start';
    timer.setAttribute('aria-label', timing ? `暂停“${task.title}”的计时` : `开始处理“${task.title}”`);
    timer.appendChild(timing
      ? createSvg([{ tag: 'rect', attrs: { x: '7', y: '5', width: '3.5', height: '14', rx: '1' } },
                   { tag: 'rect', attrs: { x: '13.5', y: '5', width: '3.5', height: '14', rx: '1' } }])
      : createSvg([{ attrs: { d: 'M8 5.5v13l11-6.5z' } }]));
    timer.append(timing ? '暂停' : actualMinutes ? '继续' : '开始');
    row.appendChild(timer);

    if (!runningFocusSession()) {
      const focusGo = document.createElement('button');
      focusGo.type = 'button';
      focusGo.className = 'focus-go-action';
      focusGo.dataset.action = 'focus';
      focusGo.setAttribute('aria-label', `为“${task.title}”开始专注`);
      focusGo.appendChild(createSvg([
        { attrs: { d: 'M12 21v-6' } },
        { attrs: { d: 'M12 15c-3.5 0-6-2.4-6-5.5C6 6.4 8.5 3 12 3s6 3.4 6 6.5c0 3.1-2.5 5.5-6 5.5z' } },
      ]));
      focusGo.append('专注');
      row.appendChild(focusGo);
    }
  }
  row.append(flag, priorityMark, remove);
  return row;
}

function renderEmpty(tasks) {
  const empty = tasks.length === 0;
  elements.emptyState.hidden = !empty;
  if (!empty) return;
  if (state.query) {
    elements.emptyTitle.textContent = `没有找到“${state.query}”`;
    elements.emptyCopy.textContent = '试试其他关键词，或清除搜索。';
    elements.emptyAction.textContent = '清除搜索';
    return;
  }
  const copy = VIEW_COPY[state.view];
  elements.emptyTitle.textContent = copy.emptyTitle;
  elements.emptyCopy.textContent = copy.emptyCopy;
  const hasInboxTasks = visibleTasks(activeTasks(), 'inbox', '', todayDate()).length > 0;
  if (state.view === 'completed') elements.emptyAction.textContent = '查看全部待办';
  else if (state.view === 'today' && hasInboxTasks) elements.emptyAction.textContent = '查看收件箱';
  else elements.emptyAction.textContent = '添加任务';
}

function renderTaskList() {
  const tasks = visibleTasks(activeTasks(), state.view, state.query, todayDate());
  const fragment = document.createDocumentFragment();
  const today = todayDate();
  const schedule = state.view === 'today' ? Planning.buildSchedule(state.store) : null;
  const blocksToday = Object.fromEntries((schedule?.byDate?.[today] || []).map((block) => [block.taskId, block]));
  if (state.view === 'today' && !state.query) {
    const groups = DailyPlanning.groupTodayTasks(tasks, today, blocksToday);
    [
      ['top3', '今日 Top3'],
      ['planned', '今天的安排'],
      ['overdue', '逾期与延续'],
      ['other', '其他可做事项'],
    ].forEach(([key, label]) => {
      if (!groups[key].length) return;
      const section = document.createElement('section');
      section.className = `today-task-group today-task-group-${key}`;
      const heading = document.createElement('h2');
      heading.className = 'today-task-group-heading';
      heading.append(label, makeElement('span', '', String(groups[key].length)));
      section.appendChild(heading);
      groups[key].forEach((task) => section.appendChild(buildTaskRow(task, {
        todayReason: DailyPlanning.todayReason(task, today, blocksToday[task.id]),
      })));
      fragment.appendChild(section);
    });
  } else if (state.view === 'completed') {
    const groups = DailyPlanning.groupCompletedTasks(tasks, state.store?.meta?.timeZone || DAYMARK_TIME_ZONE);
    groups.forEach((group) => {
      const section = document.createElement('section');
      section.className = 'completed-date-group';
      section.dataset.completionDate = group.date || 'unknown';
      const heading = document.createElement('h2');
      heading.className = 'completed-date-group-heading';
      heading.append(
        makeElement('span', 'completed-date-label', formatCompletedGroupDate(group.date, today)),
        makeElement('span', 'completed-date-count', String(group.tasks.length)),
      );
      section.appendChild(heading);
      group.tasks.forEach((task) => section.appendChild(buildTaskRow(task, {
        completionTime: formatCompletionTime(task.completedAt),
      })));
      fragment.appendChild(section);
    });
  } else {
    tasks.forEach((task) => fragment.appendChild(buildTaskRow(task)));
  }
  elements.taskList.replaceChildren(fragment);
  renderEmpty(tasks);

  const isToday = state.view === 'today';
  elements.todayCapacity.hidden = !isToday;
  elements.dailyRitualBar.hidden = !isToday;
  elements.dailyNote.hidden = !isToday;
  if (isToday) {
    const today = todayDate();
    const surfaced = visibleTasks(activeTasks(), 'today', '', today);
    const planned = Planning.currentReviewForDate(state.store, today, { today }).planned;
    const used = planned.reduce((total, task) => total + (Number(task.scheduledMinutes) || 0), 0);
    const unestimated = planned.filter((task) => task.scheduleNeedsEstimate).length;
    const plannedIds = new Set(planned.map((task) => task.id));
    const urgentExtras = surfaced.filter((task) => !plannedIds.has(task.id)).length;
    const capacity = Number(state.store?.meta?.dailyCapacityMinutes) || 0;
    const percent = capacity ? Math.round((used / capacity) * 100) : used ? 100 : 0;
    const extras = [
      unestimated ? `${unestimated} 项未估时` : '',
      urgentExtras ? `另有 ${urgentExtras} 项逾期/到期` : '',
    ].filter(Boolean);
    elements.capacitySummary.textContent = `${percent > 100 ? '已超载 · ' : ''}已安排 ${used} / ${capacity} 分钟${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
    elements.capacityFill.style.width = `${Math.min(100, percent)}%`;
    elements.todayCapacity.classList.toggle('is-overloaded', used > capacity);
    elements.capacitySelect.value = String(capacity);
    elements.endOfDayEnabled.checked = state.store?.meta?.endOfDayReminderEnabled !== false;
    elements.endOfDayTime.value = state.store?.meta?.endOfDayReminderTime || '17:30';
    elements.endOfDayTime.disabled = !elements.endOfDayEnabled.checked;
    elements.dailyNoteInput.value = state.store?.meta?.dailyNotes?.[todayDate()] || '';
    const dailyPlan = DailyPlanning.dailyPlanForDate(state.store, today);
    const pending = DailyPlanning.pendingShutdownTasks(state.store, today);
    if (dailyPlan?.shutdownCompletedAt) {
      elements.dailyRitualStatus.textContent = '今天已经完成收尾';
      elements.dailyRitualDetail.textContent = `${pending.length} 项仍保留原计划，今天不会再次提醒。`;
      elements.planToday.textContent = '调整计划';
      elements.shutdownToday.textContent = '查看收尾';
    } else if (dailyPlan?.planningCompletedAt) {
      elements.dailyRitualStatus.textContent = '今日计划已确认';
      elements.dailyRitualDetail.textContent = `${surfaced.length} 项待处理 · ${pending.length} 项需要下班前确认去向。`;
      elements.planToday.textContent = '调整计划';
      elements.shutdownToday.textContent = '下班收尾';
    } else {
      elements.dailyRitualStatus.textContent = '今天尚未规划';
      elements.dailyRitualDetail.textContent = `${DailyPlanning.dailyPlanningCandidates(state.store, today).length} 项候选，先选出真正做得完的工作。`;
      elements.planToday.textContent = '规划今天';
      elements.shutdownToday.textContent = '下班收尾';
    }
  }
}

function planningRowMeta(item, today) {
  const task = item.task;
  const details = [item.categoryLabel];
  if (task.plannedDate) details.push(`计划 ${formatShortDate(task.plannedDate)}`);
  if (task.dueDate) details.push(`截止 ${formatShortDate(task.dueDate)}`);
  if (task.estimateMinutes) details.push(`${task.estimateMinutes} 分钟`);
  if (task.area) details.push(task.area);
  if (task.dueDate && task.dueDate < today) details.push('到期日已过，不能直接设为 Top3');
  return details.join(' · ');
}

function updateDailyPlanSummary() {
  const rows = [...elements.dailyPlanCandidates.querySelectorAll('.ritual-candidate')];
  const selectedRows = rows.filter((row) => row.querySelector('.plan-include')?.checked);
  const top3Count = rows.filter((row) => row.querySelector('.plan-top3')?.checked).length;
  const minutes = selectedRows.reduce((total, row) => {
    const task = activeTasks().find((item) => item.id === row.dataset.taskId);
    return total + (Number(task?.estimateMinutes) || 0);
  }, 0);
  const capacity = Number(state.store?.meta?.dailyCapacityMinutes) || 0;
  const overloaded = capacity > 0 && minutes > capacity;
  elements.dailyPlanSummary.textContent = `${selectedRows.length} 项进入今日承诺 · ${minutes} / ${capacity} 分钟 · Top3 ${top3Count}/3${overloaded ? ' · 已超出容量' : ''}`;
  elements.dailyPlanSummary.classList.toggle('is-overloaded', overloaded);
}

function renderDailyPlanDialog() {
  const today = todayDate();
  const candidates = DailyPlanning.dailyPlanningCandidates(state.store, today);
  const fragment = document.createDocumentFragment();
  candidates.forEach((item) => {
    const task = item.task;
    const row = makeElement('div', 'ritual-candidate');
    row.dataset.taskId = task.id;

    const include = document.createElement('input');
    include.type = 'checkbox';
    include.className = 'plan-include';
    include.checked = item.selected;
    include.setAttribute('aria-label', `将“${task.title}”加入今日承诺`);

    const copy = makeElement('div', 'ritual-task-copy');
    copy.append(makeElement('strong', '', task.title), makeElement('small', '', planningRowMeta(item, today)));
    const defer = makeElement('div', 'ritual-defer');
    defer.hidden = item.selected;
    const deferSelect = document.createElement('select');
    deferSelect.className = 'plan-defer-select';
    deferSelect.setAttribute('aria-label', `设置“${task.title}”不进入今天时的去向`);
    [
      ['tomorrow', '移到明天'],
      ['date', '移到指定日期'],
      ['inbox', '撤销安排并移回收件箱'],
      ['keep', '保留原安排'],
    ].forEach(([value, label]) => deferSelect.appendChild(new Option(label, value)));
    const deferDate = document.createElement('input');
    deferDate.type = 'date';
    deferDate.className = 'plan-defer-date';
    deferDate.min = tomorrowDate();
    deferDate.value = tomorrowDate();
    deferDate.hidden = true;
    defer.append(deferSelect, deferDate);
    copy.appendChild(defer);

    const top3Label = makeElement('label', 'ritual-top3');
    const top3 = document.createElement('input');
    top3.type = 'checkbox';
    top3.className = 'plan-top3';
    top3.checked = task.top3Date === today;
    top3.disabled = Boolean(task.dueDate && task.dueDate < today);
    if (top3.checked) include.checked = true;
    top3Label.append(top3, document.createTextNode('★ Top3'));
    row.append(include, copy, top3Label);
    row.dataset.wasSelected = String(item.selected);
    fragment.appendChild(row);
  });
  elements.dailyPlanCandidates.replaceChildren(fragment);
  elements.dailyPlanEmpty.hidden = candidates.length > 0;
  updateDailyPlanSummary();
}

async function openDailyPlan() {
  const today = todayDate();
  const plan = DailyPlanning.dailyPlanForDate(state.store, today);
  if (!plan?.planningStartedAt) {
    await dispatch({
      type: 'startDailyPlan',
      eventId: `daily-plan-start-${today}`,
      payload: { date: today },
    });
  }
  renderDailyPlanDialog();
  if (!elements.dailyPlanDialog.open) elements.dailyPlanDialog.showModal();
}

function shutdownTaskMeta(task, today) {
  const details = [];
  if (task.top3Date === today) details.push('★ 今日 Top3');
  if (task.plannedDate) details.push(`计划 ${formatShortDate(task.plannedDate)}`);
  if (task.dueDate) details.push(`截止 ${formatShortDate(task.dueDate)}`);
  if (task.estimateMinutes) details.push(`${task.estimateMinutes} 分钟`);
  return details.join(' · ') || '今天需要确认去向';
}

function updateDailyShutdownSummary() {
  const plan = DailyPlanning.dailyPlanForDate(state.store, todayDate());
  const rows = [...elements.dailyShutdownTasks.querySelectorAll('.shutdown-task')];
  if (plan?.shutdownCompletedAt) {
    elements.dailyShutdownSummary.textContent = `今日收尾已完成；当前仍有 ${rows.length} 项保留在原计划中。以下内容仅供查看。`;
    return;
  }
  const handled = rows.filter((row) => ['complete', 'tomorrow', 'date', 'inbox']
    .includes(row.querySelector('.shutdown-action-select')?.value)).length;
  const blocked = rows.filter((row) => row.querySelector('.shutdown-action-select')?.value === 'blocked').length;
  const remaining = rows.length - handled;
  elements.dailyShutdownSummary.textContent = rows.length
    ? `${rows.length} 项未完成 · 确认后处理 ${handled} 项 · 保留 ${remaining} 项${blocked ? `（其中阻塞 ${blocked} 项）` : ''}。截止日早于新日期时会同步顺延。`
    : '今天没有仍需处理的事项，可以补充成果后完成收尾。';
}

function renderDailyShutdownDialog() {
  const today = todayDate();
  const tasks = DailyPlanning.pendingShutdownTasks(state.store, today);
  const plan = DailyPlanning.dailyPlanForDate(state.store, today);
  const readOnly = Boolean(plan?.shutdownCompletedAt);
  const fragment = document.createDocumentFragment();
  tasks.forEach((task) => {
    const row = makeElement('div', 'shutdown-task');
    row.dataset.taskId = task.id;
    const copy = makeElement('div', 'shutdown-task-copy');
    copy.append(makeElement('strong', '', task.title), makeElement('small', '', shutdownTaskMeta(task, today)));
    const action = makeElement('div', 'shutdown-action');
    const select = document.createElement('select');
    select.className = 'shutdown-action-select';
    select.setAttribute('aria-label', `设置“${task.title}”的去向`);
    [
      ['keep', '保持原计划'],
      ['complete', '标记完成'],
      ['tomorrow', '移到明天'],
      ['date', '移到指定日期'],
      ['inbox', '撤销安排并移回收件箱'],
      ['blocked', '记录为阻塞'],
    ].forEach(([value, label]) => select.appendChild(new Option(label, value)));
    select.disabled = readOnly;
    const customDate = document.createElement('input');
    customDate.type = 'date';
    customDate.className = 'shutdown-date-input';
    customDate.min = tomorrowDate();
    customDate.value = tomorrowDate();
    customDate.hidden = true;
    action.append(select, customDate);
    row.append(copy, action);
    fragment.appendChild(row);
  });
  elements.dailyShutdownTasks.replaceChildren(fragment);
  elements.dailyShutdownEmpty.hidden = tasks.length > 0;
  updateDailyShutdownSummary();
  elements.shutdownNote.value = plan?.shutdownNote || '';
  elements.shutdownBlockerNote.value = plan?.blockerNote || '';
  elements.shutdownTomorrowFocus.value = plan?.tomorrowFocus || '';
  [elements.shutdownNote, elements.shutdownBlockerNote, elements.shutdownTomorrowFocus]
    .forEach((field) => { field.readOnly = readOnly; });
  elements.confirmDailyShutdown.dataset.readonly = String(readOnly);
  elements.confirmDailyShutdown.textContent = readOnly ? '关闭' : '完成今日收尾';
}

function openDailyShutdown() {
  renderDailyShutdownDialog();
  if (!elements.dailyShutdownDialog.open) elements.dailyShutdownDialog.showModal();
}

async function confirmDailyPlan() {
  const today = todayDate();
  const rows = [...elements.dailyPlanCandidates.querySelectorAll('.ritual-candidate')];
  const top3Rows = rows.filter((row) => row.querySelector('.plan-top3')?.checked);
  if (top3Rows.length > 3) {
    showToast('一天最多只能选择 3 个 Top3', false);
    return false;
  }
  const invalidDateRow = rows.find((row) => {
    const include = row.querySelector('.plan-include')?.checked;
    const disposition = row.querySelector('.plan-defer-select')?.value;
    if (include || disposition !== 'date') return false;
    const target = row.querySelector('.plan-defer-date')?.value;
    return !target || target <= today;
  });
  if (invalidDateRow) {
    showToast('指定日期必须晚于今天', false);
    invalidDateRow.querySelector('.plan-defer-date')?.focus();
    return false;
  }
  const currentTop3 = activeTasks().filter((task) => task.top3Date === today);
  const desiredTop3 = new Set(top3Rows.map((row) => row.dataset.taskId));
  for (const task of currentTop3) {
    if (!desiredTop3.has(task.id)) await patchTask(task.id, { top3Date: null });
  }
  for (const row of rows) {
    const include = row.querySelector('.plan-include')?.checked;
    const wantsTop3 = row.querySelector('.plan-top3')?.checked;
    const task = activeTasks().find((item) => item.id === row.dataset.taskId && !item.deletedAt);
    if (!task) continue;
    if (!include && !wantsTop3) {
      if (row.dataset.wasSelected !== 'true') continue;
      const disposition = row.querySelector('.plan-defer-select')?.value || 'keep';
      if (disposition === 'tomorrow' || disposition === 'date') {
        const target = disposition === 'tomorrow' ? tomorrowDate() : row.querySelector('.plan-defer-date')?.value;
        if (!target || target <= today) {
          showToast('指定日期必须晚于今天', false);
          return false;
        }
        await patchTask(task.id, {
          plannedDate: target,
          ...(task.dueDate && task.dueDate < target ? { dueDate: target } : {}),
        });
      } else if (disposition === 'inbox') {
        await patchTask(task.id, { plannedDate: null, dueDate: null, top3Date: null });
      } else if (task.top3Date === today) await patchTask(task.id, { top3Date: null });
      continue;
    }
    const canMoveToToday = !task.dueDate || task.dueDate >= today;
    const patch = {};
    if (canMoveToToday && task.plannedDate !== today) patch.plannedDate = today;
    if (wantsTop3 && canMoveToToday) patch.top3Date = today;
    if (Object.keys(patch).length) await patchTask(task.id, patch);
  }
  await dispatch({
    type: 'completeDailyPlan',
    eventId: `daily-plan-complete-${today}`,
    payload: { date: today },
  });
  elements.dailyPlanDialog.close();
  showToast('今日计划已确认', state.history.length > 0);
  return true;
}

async function confirmDailyShutdown() {
  const today = todayDate();
  if (DailyPlanning.shutdownComplete(state.store, today)) {
    elements.dailyShutdownDialog.close();
    return true;
  }
  const blockedTaskIds = [];
  const rows = [...elements.dailyShutdownTasks.querySelectorAll('.shutdown-task')];
  const invalidDateRow = rows.find((row) => {
    if (row.querySelector('.shutdown-action-select')?.value !== 'date') return false;
    const target = row.querySelector('.shutdown-date-input')?.value;
    return !target || target <= today;
  });
  if (invalidDateRow) {
    showToast('指定日期必须晚于今天', false);
    invalidDateRow.querySelector('.shutdown-date-input')?.focus();
    return false;
  }
  for (const row of rows) {
    const action = row.querySelector('.shutdown-action-select')?.value || 'keep';
    const task = activeTasks().find((item) => item.id === row.dataset.taskId && !item.deletedAt);
    if (!task || task.status === 'completed') continue;
    if (action === 'complete') await toggleTaskById(task.id);
    else if (action === 'tomorrow' || action === 'date') {
      const target = action === 'tomorrow' ? tomorrowDate() : row.querySelector('.shutdown-date-input')?.value;
      if (!target || target <= today) {
        showToast('指定日期必须晚于今天', false);
        return false;
      }
      await patchTask(task.id, {
        plannedDate: target,
        ...(task.dueDate && task.dueDate < target ? { dueDate: target } : {}),
      });
    } else if (action === 'inbox') {
      await patchTask(task.id, { plannedDate: null, dueDate: null, top3Date: null });
    } else if (action === 'blocked') blockedTaskIds.push(task.id);
  }
  await dispatch({
    type: 'completeDailyShutdown',
    eventId: `daily-shutdown-complete-${today}`,
    payload: {
      date: today,
      shutdownNote: elements.shutdownNote.value,
      blockerNote: elements.shutdownBlockerNote.value,
      tomorrowFocus: elements.shutdownTomorrowFocus.value,
      blockedTaskIds,
    },
  });
  elements.dailyShutdownDialog.close();
  showToast('今日收尾已完成，今天不再提醒', state.history.length > 0);
  return true;
}

function renderAreaSuggestions() {
  const areas = [...new Set(activeTasks().map((task) => task.area?.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const fragment = document.createDocumentFragment();
  areas.forEach((area) => {
    const option = document.createElement('option');
    option.value = area;
    fragment.appendChild(option);
  });
  elements.areaSuggestions.replaceChildren(fragment);
}

function renderDetails() {
  const task = state.view === 'review' || state.view === 'focus' ? null : selectedTask();
  const isolateBackground = Boolean(task && detailsOverlayQuery.matches);
  document.querySelector('.sidebar').inert = isolateBackground;
  document.querySelector('.main-content').inert = isolateBackground;
  elements.detailsEmpty.hidden = Boolean(task);
  elements.detailsForm.hidden = !task;
  elements.detailsPanel.classList.toggle('is-open', Boolean(task));
  if (!task) return;

  elements.detailCompleted.checked = task.status === 'completed';
  elements.completeLabel.textContent = task.status === 'completed' ? '恢复为待处理' : '标记为已完成';
  elements.detailTitle.value = task.title;
  elements.detailPlanned.value = task.plannedDate || '';
  elements.detailDue.value = task.dueDate || '';
  elements.detailEstimate.value = task.estimateMinutes ? String(task.estimateMinutes) : '';
  elements.detailArea.value = task.area || '';
  elements.detailTop3.checked = Boolean(task.top3Date && task.top3Date === task.plannedDate);
  elements.detailTop3.disabled = !task.plannedDate || task.status === 'completed';
  elements.detailFlagged.checked = Boolean(task.flagged);
  elements.detailRepeat.value = typeof task.repeatRule === 'string' ? task.repeatRule : task.repeatRule?.frequency || 'none';
  elements.detailReminder.value = toInputDateTime(task.reminderAt);
  elements.detailSource.value = task.sourceUrl || '';
  elements.detailNotes.value = task.notes || '';
  elements.notesCount.textContent = `${task.notes.length} / 2000`;
  elements.detailCompletionNote.value = task.completionNote || '';
  elements.completionNoteField.hidden = task.status !== 'completed';
  const priority = elements.detailsForm.querySelector(`input[name="priority"][value="${task.priority}"]`);
  if (priority) priority.checked = true;
  const range = Planning.taskRange(task);
  elements.schedulePreview.hidden = !range;
  if (range) {
    const blocks = Planning.buildSchedule(state.store).byTask[task.id] || [];
    const planningBlocks = blocks.filter((block) => block.isPlanningDay && (block.needsEstimate || block.scheduledMinutes > 0));
    const scheduled = planningBlocks.reduce((total, block) => total + (Number(block.scheduledMinutes) || 0), 0);
    const overflow = blocks.reduce((total, block) => total + (Number(block.overflowMinutes) || 0), 0);
    const rangeCopy = range.multiDay
      ? `${formatShortDate(range.startDate)} 至 ${formatShortDate(range.endDate)} · ${planningBlocks.length} 个计划日`
      : `${formatShortDate(range.startDate)} · 单日安排`;
    const estimateCopy = task.estimateMinutes
      ? ` · 已自动分配 ${scheduled}/${task.estimateMinutes} 分钟`
      : ' · 待补充预计用时';
    elements.schedulePreview.textContent = `${rangeCopy}${estimateCopy}${overflow ? ` · 超出容量 ${overflow} 分钟` : ''}`;
    elements.schedulePreview.classList.toggle('is-overflow', overflow > 0);
  }
  renderAreaSuggestions();
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatRecordDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function reportSelection() {
  const monthValue = state.reviewMonth || todayDate().slice(0, 7);
  const [monthYear, month] = monthValue.split('-').map(Number);
  const selectedYear = Number(elements.reportYear.value || todayDate().slice(0, 4));
  return {
    mode: state.reviewMode,
    year: state.reviewMode === 'month' ? monthYear : selectedYear,
    month: state.reviewMode === 'month' ? month : undefined,
    quarter: state.reviewMode === 'quarter' ? Number(elements.reportQuarter.value || 1) : undefined,
    today: todayDate(),
  };
}

function periodTitle(selection, suffix = '') {
  if (selection.mode === 'month') return `${selection.year} 年 ${selection.month} 月${suffix}`;
  if (selection.mode === 'quarter') return `${selection.year} 年第 ${selection.quarter} 季度${suffix}`;
  return `${selection.year} 年度${suffix}`;
}

function markdownList(items, formatter) {
  if (!items?.length) return '- 暂无记录';
  return items.map((item) => `- ${formatter(item)}`).join('\n');
}

function buildMonthMarkdown(source, title) {
  const rate = Number.isFinite(source.metrics.completionRate) ? `${source.metrics.completionRate}%` : '—';
  const achievements = source.achievements
    .filter((item, index, all) => all.findIndex((candidate) => `${candidate.date}:${candidate.title}` === `${item.date}:${item.title}`) === index)
    .slice(0, 12);
  const focusStats = Focus.rangeFocusStats(focusSessions(), source.period.startDate, source.period.throughDate);
  const focusLines = focusStats.completedCount || focusStats.abandonedCount
    ? [
        '## 专注统计',
        '',
        `- 专注总时长：${focusStats.totalMinutes} 分钟（${focusStats.completedCount} 次完成）`,
        `- 专注天数：${focusStats.activeDays} 天，日均 ${focusStats.dailyAverage} 分钟`,
        focusStats.bestDay ? `- 最佳专注日：${focusStats.bestDay.date}（${focusStats.bestDay.minutes} 分钟）` : '',
        focusStats.abandonedCount ? `- 中断 ${focusStats.abandonedCount} 次（未计入时长）` : '',
        '',
      ].filter(Boolean)
    : [];
  return [
    `# ${title}`,
    '',
    `数据范围：${source.period.startDate} 至 ${source.period.throughDate}`,
    '',
    '## 概览',
    '',
    `- 活跃工作日：${source.metrics.activeDays} 天`,
    `- 计划任务：${source.metrics.planned} 项`,
    `- 完成计划内任务：${source.metrics.completedPlanned} 项`,
    `- 计划完成率：${rate}`,
    `- 实际投入：${source.metrics.actualMinutes || 0} 分钟`,
    '',
    ...focusLines,
    '## 关键成果',
    '',
    markdownList(achievements, (item) => `${item.date} · ${item.completionNote || item.title}${item.area ? `（${item.area}）` : ''}`),
    '',
    '## 工作领域',
    '',
    markdownList(source.areas, (area) => `${area.area}：完成 ${area.completed} 项，计划 ${area.planned} 项，实际投入 ${area.actualMinutes || 0} 分钟`),
    '',
    '## 每日备注',
    '',
    markdownList(source.dailyNotes, (item) => `${item.date}：${item.note}`),
    '',
    source.dataIntegrity.complete ? '' : `> 数据提示：${source.dataIntegrity.message}`,
  ].filter((line, index, all) => line || all[index - 1] !== '').join('\n').trim();
}

function renderPeriodReport() {
  const selection = reportSelection();
  const source = AiReport.buildReportSourceData(state.store, selection);
  state.reportSource = source;
  const title = periodTitle(selection, '工作总结');
  const revision = `${state.store.events?.length || 0}:${state.store.dailyArchives?.length || 0}:${state.store.events?.at(-1)?.occurredAt || ''}`;
  const periodKey = `${selection.mode}:${selection.year}:${selection.month || ''}:${selection.quarter || ''}:${revision}`;

  let report = null;
  let markdown;
  if (selection.mode === 'month') {
    markdown = buildMonthMarkdown(source, title);
  } else {
    report = Reporting.buildPeriodReport(state.store, {
      year: selection.year,
      quarter: selection.mode === 'quarter' ? selection.quarter : null,
      today: selection.today,
    });
    markdown = Reporting.reportToMarkdown(report);
  }
  state.report = report || { title, period: source.period, dataIntegrity: source.dataIntegrity };
  state.reportTitle = report?.title || title;
  state.reportMarkdown = markdown;

  const metricValues = {
    active: String(source.metrics.activeDays),
    completed: `${source.metrics.completedPlanned} / ${source.metrics.planned}`,
    rate: Number.isFinite(source.metrics.completionRate) ? `${source.metrics.completionRate}%` : '—',
  };
  Object.entries(metricValues).forEach(([name, value]) => {
    const target = elements.reportMetrics.querySelector(`[data-metric="${name}"] strong`);
    if (target) target.textContent = value;
  });

  elements.reviewPeriodTitle.textContent = periodTitle(selection);
  elements.recordRangeNote.textContent = `${source.period.startDate} 至 ${source.period.throughDate}${source.dataIntegrity.complete ? '' : ' · 部分历史数据不完整'}`;
  elements.aiReportRange.textContent = `${periodTitle(selection)} · ${source.metrics.activeDays} 个活跃工作日 · 默认在本机生成`;

  if (state.reportPeriodKey !== periodKey) {
    state.reportPeriodKey = periodKey;
    state.aiReportText = '';
    elements.reportOutput.value = markdown;
    elements.reportKind.textContent = '本地工作报告';
    elements.reportStatus.textContent = source.dataIntegrity.complete
      ? '基于本地结构化工作记录生成'
      : `本地报告 · ${source.dataIntegrity.message}`;
  }
  elements.reportTitle.textContent = state.reportTitle;
}

function formatCalendarDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function renderDayDetail() {
  const date = state.reviewSelectedDate;
  if (!date) return;
  const detail = Calendar.buildDateDetail(state.store, date);
  const holiday = Calendar.getChinaHoliday(date);
  const planned = Array.isArray(detail.planned) ? detail.planned : [];
  const ranged = Array.isArray(detail.range) ? detail.range : [];
  const completed = Array.isArray(detail.completed) ? detail.completed : [];
  const completedIds = new Set(completed.map((task) => task.id).filter(Boolean));
  const plannedIds = new Set(planned.map((task) => task.id).filter(Boolean));
  const top3Ids = new Set((Array.isArray(detail.top3) ? detail.top3 : []).map((task) => task.id).filter(Boolean));
  const actualByTask = new Map((Array.isArray(detail.actualTime) ? detail.actualTime : []).map((entry) => [entry.taskId, Number(entry.minutes) || 0]));
  const items = [];
  const seen = new Set();
  [...ranged, ...planned, ...completed].forEach((task) => {
    const key = task.id || `${task.title}:${task.completedAt || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      title: task.completionNote || task.title || '未命名任务',
      done: completedIds.has(task.id) || completed.includes(task),
      planned: plannedIds.has(task.id),
      top3: top3Ids.has(task.id) || task.top3Date === date,
      flagged: Boolean(task.flagged),
      phase: task.schedulePhase || null,
      minutes: Number(task.scheduledMinutes) || 0,
      needsEstimate: Boolean(task.scheduleNeedsEstimate),
      overflowMinutes: Number(task.scheduleOverflowMinutes) || 0,
      actualMinutes: actualByTask.get(task.id) || 0,
    });
  });
  (Array.isArray(detail.actualTime) ? detail.actualTime : []).forEach((entry) => {
    if (!entry?.taskId || seen.has(entry.taskId)) return;
    seen.add(entry.taskId);
    items.push({
      title: entry.title || '未命名任务',
      done: false,
      planned: false,
      top3: false,
      flagged: false,
      phase: null,
      minutes: 0,
      needsEstimate: false,
      overflowMinutes: 0,
      actualMinutes: Number(entry.minutes) || 0,
    });
  });
  const plannedCount = Number(detail.summary?.plannedCount) || planned.length;
  const completedCount = Number(detail.summary?.completedPlannedCount);
  const done = Number.isFinite(completedCount)
    ? completedCount
    : planned.filter((task) => completedIds.has(task.id)).length;

  elements.dayDetailDate.textContent = formatCalendarDate(date);
  elements.dayDetailHoliday.hidden = !holiday;
  elements.dayDetailHoliday.textContent = holiday ? `${holiday.badge} · ${holiday.name}` : '';
  elements.dayDetailHoliday.classList.toggle('is-makeup', holiday?.type === 'makeup');
  // Completed pomodoros already record a time entry, so their minutes are part
  // of 实际 above. Only the tree count is exclusive to focus sessions.
  const focusSummary = Focus.dailyFocusSummary(focusSessions(), date);
  const treeLabel = focusSummary.completedCount || focusSummary.abandonedCount
    ? ` · 种下 ${focusSummary.completedCount} 棵树${focusSummary.abandonedCount ? `（${focusSummary.abandonedCount} 棵枯萎）` : ''}`
    : '';
  elements.dayDetailScore.textContent = `完成 ${completed.length} · 计划 ${plannedCount} · 实际 ${Number(detail.summary?.actualMinutes) || 0} 分钟${treeLabel}`;
  elements.dayDetailNote.textContent = detail.dailyNotes
    || (holiday ? `${holiday.name}${holiday.type === 'makeup' ? '，当天按调休工作日标注。' : '，当天按法定假日标注。'}` : '')
    || (detail.dataIntegrity?.complete === false ? detail.dataIntegrity.message : '当天没有填写每日备注。');

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const row = makeElement('li', `day-detail-task${item.done ? '' : ' is-open'}${item.top3 ? ' is-top3' : ''}${item.flagged ? ' is-flagged' : ''}${!item.planned && !item.done ? ' is-range-only' : ''}`);
    const content = makeElement('span', 'day-detail-task-content');
    if (item.top3) content.appendChild(makeElement('span', 'day-detail-top3', '★ Top 3'));
    if (item.flagged) content.appendChild(makeElement('span', 'day-detail-flagged', '⚑ 旗标'));
    const phaseLabels = { single: '单日', start: '开始', middle: '进行中', deadline: '截止' };
    if (item.phase) content.appendChild(makeElement('span', `day-detail-phase is-${item.phase}`, phaseLabels[item.phase]));
    if (item.minutes) content.appendChild(makeElement('span', 'day-detail-minutes', `${item.minutes} 分钟`));
    else if (item.needsEstimate && item.planned) content.appendChild(makeElement('span', 'day-detail-minutes', '待估时'));
    if (item.overflowMinutes) content.appendChild(makeElement('span', 'day-detail-overflow', `超载 ${item.overflowMinutes} 分钟`));
    if (item.actualMinutes) content.appendChild(makeElement('span', 'day-detail-minutes', `实际 ${item.actualMinutes} 分钟`));
    content.appendChild(makeElement('span', 'day-detail-task-title', item.title));
    row.append(makeElement('span', 'day-detail-task-mark', item.done ? '✓' : '○'), content);
    fragment.appendChild(row);
  });
  if (!items.length) fragment.appendChild(makeElement('li', 'day-detail-empty', '当天没有工作任务。'));
  elements.dayDetailTasks.replaceChildren(fragment);
}

function renderCalendar() {
  const monthValue = state.calendarMonth || todayDate().slice(0, 7);
  const [year, month] = monthValue.split('-').map(Number);
  if (!state.reviewSelectedDate || !state.reviewSelectedDate.startsWith(monthValue)) {
    state.reviewSelectedDate = todayDate().startsWith(monthValue) ? todayDate() : `${monthValue}-01`;
  }
  const calendar = Calendar.buildMonthGrid({ year, month, store: state.store, today: todayDate() });
  const specialDays = calendar.cells.filter((cell) => cell.inCurrentMonth && cell.holiday);
  elements.holidaySourceNote.textContent = calendar.holidaySource
    ? `${calendar.holidaySource.label} · 本月标注 ${specialDays.length} 天休假或调休`
    : '该年份暂无内置官方节假日数据，不做推测标注';
  elements.recordMonth.value = monthValue;
  elements.recordMonth.removeAttribute('max');
  elements.nextMonth.disabled = false;

  const fragment = document.createDocumentFragment();
  calendar.cells.forEach((cell) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-day';
    button.dataset.calendarDate = cell.date;
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-selected', String(cell.date === state.reviewSelectedDate));
    button.tabIndex = cell.date === state.reviewSelectedDate ? 0 : -1;
    button.classList.toggle('is-outside', !cell.inCurrentMonth);
    button.classList.toggle('is-today', cell.isToday);
    button.classList.toggle('is-selected', cell.date === state.reviewSelectedDate);
    button.classList.toggle('is-holiday', cell.holiday?.type === 'holiday');
    button.classList.toggle('is-makeup', cell.holiday?.type === 'makeup');
    button.classList.toggle('has-schedule', cell.rangeCount > 0);
    const labelParts = [formatCalendarDate(cell.date)];
    if (cell.holiday) labelParts.push(cell.holiday.name, cell.holiday.badge === '休' ? '休假' : '调休上班');
    if (cell.rangeCount) labelParts.push(`跨期任务 ${cell.rangeCount} 项`);
    if (cell.metrics.actualMinutes) labelParts.push(`实际投入 ${cell.metrics.actualMinutes} 分钟`);
    labelParts.push(`完成 ${cell.metrics.completedCount}，计划 ${cell.metrics.plannedCount}`);
    button.setAttribute('aria-label', labelParts.join('，'));

    const top = makeElement('span', 'calendar-day-top');
    top.appendChild(makeElement('span', 'day-number', String(cell.day)));
    if (cell.holiday) {
      top.appendChild(makeElement('span', `day-badge${cell.holiday.type === 'makeup' ? ' is-makeup' : ''}`, cell.holiday.badge));
    }
    const tally = makeElement('span', 'day-tally', cell.metrics.plannedCount || cell.metrics.completedCount
      ? `完成 ${cell.metrics.completedCount} · 计划 ${cell.metrics.plannedCount}`
      : cell.metrics.actualMinutes ? `实际投入 ${cell.metrics.actualMinutes} 分钟`
      : cell.rangeCount ? `跨期任务 ${cell.rangeCount} 项` : '无任务记录');
    const progress = makeElement('span', 'day-progress');
    const fill = makeElement('span');
    fill.style.width = `${Math.max(0, Math.min(100, Number(cell.metrics.completionRate) || 0))}%`;
    progress.appendChild(fill);
    button.append(top, tally, progress);
    fragment.appendChild(button);
  });
  elements.calendarGrid.replaceChildren(fragment);
  renderDayDetail();
}

function hasAiKey(settings = state.aiSettings) {
  return Boolean(settings?.hasKey || settings?.hasApiKey);
}

function renderAiSettingsStatus() {
  const settings = state.aiSettings || {};
  const configured = hasAiKey(settings);
  const sourceCopy = settings.keySource === 'environment'
    ? '正在使用 OPENAI_API_KEY 环境变量'
    : settings.keySource === 'preview'
      ? '浏览器预览密钥仅保存在内存中'
      : settings.hasStoredKey && !configured
        ? '本机密钥当前不可用，请移除后重新保存'
      : configured
        ? 'API Key 已保存在本机安全存储'
        : '尚未配置 API Key';
  elements.aiKeyStatus.textContent = sourceCopy;
  elements.clearAiKey.hidden = !settings.hasStoredKey && settings.keySource !== 'preview';
  elements.saveAiKey.disabled = settings.canStoreKey === false;
  elements.generateAiReport.disabled = !configured || Boolean(state.aiRequestId);
  elements.cancelAiReport.hidden = !state.aiRequestId;
  elements.aiActionNote.textContent = settings.canStoreKey === false && !configured
    ? '当前系统安全存储不可用；可通过 OPENAI_API_KEY 环境变量使用 AI。本地报告不受影响。'
    : configured
      ? '点击生成后，只发送上方勾选的结构化内容。'
      : '没有 API Key 也可复制或保存右侧本地总结。';
}

function renderReview() {
  elements.quarterControl.hidden = state.reviewMode !== 'quarter';
  elements.yearControl.hidden = state.reviewMode === 'month';
  if (state.reviewMode === 'quarter') updateQuarterAvailability();
  document.querySelectorAll('[data-review-mode]').forEach((button) => {
    const active = button.dataset.reviewMode === state.reviewMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active) elements.reviewDashboard.setAttribute('aria-labelledby', button.id);
  });
  renderPeriodReport();
  renderCalendar();
  renderAiSettingsStatus();
}

const FOCUS_RING_CIRCUMFERENCE = 628.3;
// Distinct from focusTicker, which drives the stopwatch strip. The two timers
// are mutually exclusive but keep separate handles so neither clears the other.
let focusSessionTicker = null;
let focusCompletionPending = false;

function formatFocusClock(totalSeconds) {
  const safe = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function focusTaskTitle(taskId) {
  if (!taskId) return '';
  return activeTasks().find((task) => task.id === taskId)?.title || '';
}

function selectedFocusMinutes() {
  return state.focusMinutes || focusSettings().defaultMinutes || 25;
}

function setFocusStage(stage) {
  elements.focusTree.querySelectorAll('g[data-stage]').forEach((group) => {
    group.classList.toggle('is-on', group.dataset.stage === stage);
  });
}

function setFocusPhase(phase) {
  elements.focusPhaseIdle.hidden = phase !== 'idle';
  elements.focusPhaseRunning.hidden = phase !== 'running';
  elements.focusPhaseDone.hidden = phase !== 'done';
  elements.focusPhaseWithered.hidden = phase !== 'withered';
  elements.focusClock.classList.toggle('is-withered', phase === 'withered');
}

function setFocusRing(progress, withered = false) {
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  elements.focusRingProgress.style.strokeDashoffset = String(FOCUS_RING_CIRCUMFERENCE * (1 - clamped));
  elements.focusRingProgress.style.stroke = withered ? '#a49a8c' : 'var(--accent)';
}

function renderFocusTaskOptions() {
  const running = runningFocusSession();
  if (running) return;
  const current = elements.focusTaskSelect.value;
  const options = [new Option('自由专注（不关联任务）', '')];
  visibleTasks(activeTasks(), 'today', '', todayDate())
    .filter((task) => task.status === 'active')
    .forEach((task) => options.push(new Option(task.title, task.id)));
  elements.focusTaskSelect.replaceChildren(...options);
  if ([...elements.focusTaskSelect.options].some((option) => option.value === current)) {
    elements.focusTaskSelect.value = current;
  }
}

function renderFocusDurationChips() {
  const minutes = selectedFocusMinutes();
  elements.focusDurationChips.querySelectorAll('button[data-minutes]').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) === minutes));
  });
}

function renderFocusGrove(summary) {
  const fragment = document.createDocumentFragment();
  const finished = summary.sessions.filter((session) => session.status !== 'running');
  if (!finished.length) {
    fragment.appendChild(makeElement('span', 'focus-grove-empty', '今天还没有种下树'));
  } else {
    finished.forEach((session) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 120 140');
      svg.setAttribute('role', 'listitem');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = session.status === 'completed'
        ? `专注 ${session.focusedMinutes} 分钟${focusTaskTitle(session.taskId) ? ` · ${focusTaskTitle(session.taskId)}` : ''}`
        : `中断于 ${session.focusedMinutes} 分钟 · 未计入统计`;
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', session.status === 'completed' ? '#tree-bloom' : '#tree-withered');
      svg.append(title, use);
      fragment.appendChild(svg);
    });
  }
  elements.focusGrove.replaceChildren(fragment);
}

function renderFocusBars() {
  const days = Focus.recentFocusDays(focusSessions(), todayDate(), 7);
  const max = Math.max(1, ...days.map((day) => day.minutes));
  const bars = document.createDocumentFragment();
  const labels = document.createDocumentFragment();
  const weekdayFormat = new Intl.DateTimeFormat('zh-CN', { weekday: 'narrow', timeZone: 'UTC' });
  days.forEach((day, index) => {
    const bar = makeElement('span', index === days.length - 1 ? 'is-today' : '');
    bar.style.height = `${Math.max(3, (day.minutes / max) * 62)}px`;
    bar.title = `${day.date} · ${day.minutes} 分钟`;
    bars.appendChild(bar);
    labels.appendChild(makeElement('span', '', index === days.length - 1
      ? '今'
      : weekdayFormat.format(new Date(`${day.date}T00:00:00Z`))));
  });
  elements.focusBars.replaceChildren(bars);
  elements.focusBarLabels.replaceChildren(labels);
  elements.focusWeekTotal.textContent = String(days.reduce((total, day) => total + day.minutes, 0));
}

function renderFocusPanel() {
  const summary = Focus.dailyFocusSummary(focusSessions(), todayDate());
  const settings = focusSettings();
  elements.focusTodayMinutes.textContent = String(summary.minutes);
  elements.focusTodaySub.textContent = summary.completedCount || summary.abandonedCount
    ? `种下 ${summary.completedCount} 棵 · 枯萎 ${summary.abandonedCount} 棵`
    : '还没有种下树';
  const goal = Number(settings.dailyGoalMinutes) || 0;
  const ratio = goal ? Math.min(1, summary.minutes / goal) : 0;
  elements.focusGoalFill.style.width = `${(ratio * 100).toFixed(1)}%`;
  elements.focusGoalCaption.textContent = `${summary.minutes} / ${goal} 分钟`;
  renderFocusGrove(summary);
  renderFocusBars();
  elements.focusStrictMode.checked = settings.strictMode !== false;
  elements.focusNotification.checked = settings.completionNotification !== false;
  if ([...elements.focusGoalSelect.options].some((option) => option.value === String(goal))) {
    elements.focusGoalSelect.value = String(goal);
  }
}

function renderFocusStage() {
  const running = runningFocusSession();
  if (running) {
    setFocusPhase('running');
    elements.focusPause.hidden = focusSettings().strictMode !== false;
    elements.focusPause.textContent = running.pausedAt ? '继续' : '暂停';
    const linkedTitle = focusTaskTitle(running.taskId);
    elements.focusStateLine.replaceChildren();
    if (running.pausedAt) {
      elements.focusStateLine.append('已暂停 · ');
    }
    if (linkedTitle) {
      elements.focusStateLine.append('专注于 ');
      elements.focusStateLine.appendChild(makeElement('strong', '', linkedTitle));
    } else {
      elements.focusStateLine.append('自由专注');
    }
    if (!running.pausedAt) elements.focusStateLine.append(' · 保持专注，树在生长');
    tickFocus();
    return;
  }

  if (state.focusOutcome?.kind === 'done') {
    setFocusPhase('done');
    setFocusStage('bloom');
    setFocusRing(1);
    elements.focusClock.textContent = '00:00';
    elements.focusStateLine.replaceChildren();
    elements.focusStateLine.appendChild(
      makeElement('strong', '', `专注 ${state.focusOutcome.minutes} 分钟 · 树已种下`),
    );
    if (state.focusOutcome.taskTitle) elements.focusStateLine.append(` · ${state.focusOutcome.taskTitle}`);
    return;
  }

  if (state.focusOutcome?.kind === 'withered') {
    setFocusPhase('withered');
    setFocusStage('withered');
    setFocusRing(state.focusOutcome.progress || 0, true);
    elements.focusClock.textContent = formatFocusClock(state.focusOutcome.remainingSeconds || 0);
    elements.focusStateLine.replaceChildren('树枯萎了 · 中断的 ');
    elements.focusStateLine.appendChild(makeElement('strong', '', `${state.focusOutcome.minutes} 分钟`));
    elements.focusStateLine.append(' 不计入统计');
    return;
  }

  setFocusPhase('idle');
  setFocusStage('seed');
  setFocusRing(0);
  elements.focusClock.textContent = formatFocusClock(selectedFocusMinutes() * 60);
  elements.focusStateLine.textContent = '选好时长，种下一棵树';
  renderFocusDurationChips();
  renderFocusTaskOptions();
}

function renderFocus() {
  const summary = Focus.dailyFocusSummary(focusSessions(), todayDate());
  elements.focusNavCount.textContent = String(summary.completedCount);
  const running = runningFocusSession();
  elements.focusChip.hidden = !running || state.view === 'focus';
  if (state.view !== 'focus') return;
  renderFocusStage();
  renderFocusPanel();
}

function tickFocus() {
  const running = runningFocusSession();
  if (!running) return;
  const now = Date.now();
  const end = focusSessionEnd(running);
  const total = running.plannedMinutes * 60_000;
  const reference = running.pausedAt ? new Date(running.pausedAt).getTime() : now;
  const remainingMs = Math.max(0, end - reference);
  const progress = total ? Math.min(1, 1 - remainingMs / total) : 1;
  const clock = formatFocusClock(remainingMs / 1000);
  elements.focusChipTime.textContent = clock;
  if (state.view === 'focus') {
    elements.focusClock.textContent = clock;
    setFocusRing(progress);
    setFocusStage(Focus.growthStage(progress));
  }
  if (!running.pausedAt && now >= end) completeRunningFocusSession(running);
}

function startFocusTicker() {
  clearInterval(focusSessionTicker);
  focusSessionTicker = setInterval(() => {
    try {
      tickFocus();
    } catch (error) {
      console.error('Focus ticker failed:', error);
    }
  }, 500);
}

function completeRunningFocusSession(session) {
  if (focusCompletionPending) return;
  focusCompletionPending = true;
  const taskTitle = focusTaskTitle(session.taskId);
  // Deterministic event id: the main process delivers the completion
  // notification through the same command, whichever side lands first wins
  // and the other becomes a no-op.
  dispatch({
    type: 'completeFocusSession',
    eventId: `focus-complete-${session.id}`,
    occurredAt: new Date(focusSessionEnd(session)).toISOString(),
    payload: { sessionId: session.id },
  }, { selectedId: state.selectedId })
    .then(() => {
      state.focusOutcome = { kind: 'done', minutes: session.plannedMinutes, taskTitle };
      state.view = 'focus';
      render();
      // The renderer's half-second ticker almost always finishes a session
      // before the main process sweep notices, so the notification has to be
      // asked for here; main de-duplicates if its sweep gets there first.
      return bridge.notifyFocusCompleted(session.id);
    })
    .catch(() => {})
    .finally(() => {
      focusCompletionPending = false;
    });
}

function focusStartDurationOptions() {
  return [...elements.focusStartChips.querySelectorAll('button[data-minutes]')]
    .map((button) => Number(button.dataset.minutes));
}

// An estimate is the closest thing to the user's own answer for how long this
// should take, so it picks the starting chip when the task carries one.
function suggestedFocusMinutes(task) {
  const estimate = Number(task?.estimateMinutes) || 0;
  if (!estimate) return null;
  return focusStartDurationOptions()
    .reduce((best, option) => (
      Math.abs(option - estimate) < Math.abs(best - estimate) ? option : best
    ));
}

function renderFocusStartChips() {
  elements.focusStartChips.querySelectorAll('button[data-minutes]').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) === state.focusStartMinutes));
  });
}

function openFocusStart(taskId) {
  // An already-running session owns the timer; send the user to it rather than
  // offering a second start they cannot have.
  if (runningFocusSession()) {
    state.view = 'focus';
    render();
    return;
  }
  const task = activeTasks().find((item) => item.id === taskId && !item.deletedAt);
  if (!task) return;
  const suggestion = suggestedFocusMinutes(task);
  state.focusStartTaskId = task.id;
  state.focusStartMinutes = suggestion || selectedFocusMinutes();
  elements.focusStartTaskTitle.textContent = task.title;
  elements.focusStartHint.textContent = suggestion
    ? `已按预计用时 ${task.estimateMinutes} 分钟推荐`
    : '';
  renderFocusStartChips();
  if (!elements.focusStartDialog.open) elements.focusStartDialog.showModal();
}

async function startFocusSession(taskId, minutes) {
  if (runningFocusSession()) {
    state.view = 'focus';
    render();
    return;
  }
  const plannedMinutes = Number(minutes) || selectedFocusMinutes();
  state.focusOutcome = null;
  await dispatch({
    type: 'startFocusSession',
    payload: {
      sessionId: commandId('focus'),
      taskId: taskId || elements.focusTaskSelect.value || null,
      plannedMinutes,
    },
  }, { selectedId: state.selectedId });
  state.view = 'focus';
  elements.focusConfirm.hidden = true;
  render();
}

async function abandonRunningFocusSession() {
  const running = runningFocusSession();
  if (!running) return;
  const progress = Math.min(1, (Date.now() - new Date(running.startedAt).getTime()) / (running.plannedMinutes * 60_000));
  const result = await dispatch({
    type: 'abandonFocusSession',
    eventId: `focus-abandon-${running.id}-${Date.now()}`,
    payload: { sessionId: running.id },
  }, { selectedId: state.selectedId });
  const stored = result.focusSessions.find((session) => session.id === running.id);
  state.focusOutcome = {
    kind: 'withered',
    minutes: stored?.focusedMinutes ?? 0,
    progress,
    remainingSeconds: Math.max(0, Math.round((1 - progress) * running.plannedMinutes * 60)),
  };
  elements.focusConfirm.hidden = true;
  render();
}

async function resolveInterruptedFocusSessions() {
  const running = runningFocusSession();
  if (!running) return;
  const resolution = Focus.resolveInterruptedSession(running, new Date(), window.TodoDomain);
  if (!resolution) return;
  const type = resolution.action === 'complete' ? 'completeFocusSession' : 'abandonFocusSession';
  try {
    await dispatch({
      type,
      // Completion shares the main-process event id so the recovery path
      // dedupes against the reminder scheduler instead of racing it.
      eventId: resolution.action === 'complete'
        ? `focus-complete-${running.id}`
        : `focus-recover-${running.id}`,
      occurredAt: resolution.occurredAt,
      payload: { sessionId: running.id },
    }, { selectedId: state.selectedId });
    if (resolution.action === 'complete') {
      showToast(`上次专注的 ${running.plannedMinutes} 分钟已完成，树种下了`, false);
    } else {
      showToast('上次退出时专注尚未结束，那棵树枯萎了', false);
    }
  } catch (error) {
    console.error('Unable to resolve interrupted focus session:', error);
  }
}

function calendarDateLabel(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function elapsedClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = String(Math.floor(value / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const remainder = String(value % 60).padStart(2, '0');
  return `${hours}:${minutes}:${remainder}`;
}

function humanMinutes(value) {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function runningEntry() {
  return Worklog.runningEntry(state.store);
}

function updateRunningClock() {
  const entry = runningEntry();
  if (!entry) return;
  elements.runElapsed.textContent = elapsedClock(Worklog.durationSeconds(entry, new Date()));
  const task = entry.taskId ? activeTasks().find((item) => item.id === entry.taskId) : null;
  const total = entry.taskId
    ? Worklog.actualMinutesForTask(state.store, entry.taskId, { now: new Date() })
    : 0;
  const segments = entry.taskId
    ? Worklog.entriesForTask(state.store, entry.taskId).length
    : 1;
  elements.runSegments.textContent = task
    ? `第 ${segments} 段 · 累计 ${humanMinutes(total)}`
    : '自由计时';
}

function renderRunStrip() {
  const entry = runningEntry();
  clearInterval(runTicker);
  runTicker = null;
  elements.runStrip.hidden = !entry;
  if (!entry) return;
  const task = entry.taskId ? activeTasks().find((item) => item.id === entry.taskId) : null;
  elements.runTaskTitle.textContent = task?.title || (entry.taskId ? '已移除的任务' : '自由计时');
  elements.runComplete.hidden = !task;
  updateRunningClock();
  runTicker = setInterval(updateRunningClock, 1000);
}

function worklogDates() {
  const date = state.worklogDate || todayDate();
  return state.worklogMode === 'week' ? Worklog.weekDates(date) : [date];
}

function renderWorklogSegment(segment, date) {
  // Vertical placement belongs to the caller, which knows what sits above.
  const height = Math.max(WORKLOG_MIN_BLOCK_HEIGHT, segment.minutes * WORKLOG_PIXELS_PER_MINUTE);
  const compact = height < 40;
  const block = makeElement('article', `worklog-segment${segment.running ? ' is-running' : ''}${compact ? ' is-compact' : ''}${segment.taskDeleted ? ' is-orphan' : ''}`);
  block.style.height = `${height}px`;
  block.dataset.taskId = segment.taskId || '';
  block.dataset.entryId = segment.id;
  block.dataset.date = date;
  // Colour comes from the task id so the same task keeps one hue all day and a
  // split run reads as one thing interrupted rather than two unrelated blocks.
  block.style.setProperty('--segment-hue', String(worklogHue(segment.taskId)));
  block.appendChild(makeElement('strong', 'worklog-segment-title', segment.title));
  const range = `${Worklog.formatMinute(segment.startMinute)}–${segment.running ? '进行中' : Worklog.formatMinute(segment.endMinute)}`;
  block.appendChild(makeElement('small', 'worklog-segment-meta', `${range} · ${segment.minutes} 分`));
  block.title = `${segment.title} ${range}（${segment.minutes} 分钟）`;
  block.setAttribute('aria-label', `${segment.title}，${range}，${segment.minutes} 分钟`);
  return block;
}

// A stable hue per task, so colours survive reloads and never depend on order.
function worklogHue(taskId) {
  if (!taskId) return 210;
  let hash = 0;
  for (let index = 0; index < taskId.length; index += 1) {
    hash = (hash * 31 + taskId.charCodeAt(index)) % 360;
  }
  return hash;
}

function renderWorklog() {
  const date = state.worklogDate || todayDate();
  state.worklogDate = date;
  elements.worklogDate.value = date;
  document.querySelectorAll('[data-worklog-mode]').forEach((button) => {
    const active = button.dataset.worklogMode === state.worklogMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });

  const dates = worklogDates();
  const now = new Date();
  const range = Worklog.rangeSummary(state.store, dates, { now });
  const single = dates.length === 1;
  const summary = single ? range.byDate[dates[0]] : null;

  elements.worklogRange.textContent = single
    ? calendarDateLabel(dates[0])
    : `${calendarDateLabel(dates[0])} – ${calendarDateLabel(dates[dates.length - 1])}`;

  const metrics = [
    ['累计处理', humanMinutes(range.minutes), true],
    ['时段', `${range.segmentCount} 段`, false],
  ];
  if (single && summary) {
    metrics.splice(1, 0, ['任务', `${summary.taskCount} 个`, false]);
    if (summary.firstMinute !== null) {
      metrics.push([
        '最早 / 最晚',
        `${Worklog.formatMinute(summary.firstMinute)} – ${Worklog.formatMinute(summary.lastMinute)}`,
        false,
      ]);
      metrics.push(['其间未计时', humanMinutes(summary.idleMinutes), false]);
    }
  } else {
    metrics.push(['有记录的天', `${range.activeDays} / ${dates.length}`, false]);
  }
  elements.worklogSummary.replaceChildren(...metrics.map(([label, value, highlight]) => {
    const chip = makeElement('span', highlight ? 'is-highlight' : '');
    chip.append(`${label} `, makeElement('strong', '', value));
    return chip;
  }));

  const grid = makeElement('div', `worklog-grid${single ? ' is-single' : ''}`);
  const rail = makeElement('div', 'worklog-rail');
  for (let hour = WORKLOG_START_HOUR; hour <= WORKLOG_END_HOUR; hour += 1) {
    const label = makeElement('span', '', `${String(hour).padStart(2, '0')}:00`);
    label.style.top = `${(hour - WORKLOG_START_HOUR) * 60 * WORKLOG_PIXELS_PER_MINUTE}px`;
    rail.appendChild(label);
  }
  grid.appendChild(rail);

  const height = (WORKLOG_END_HOUR - WORKLOG_START_HOUR) * 60 * WORKLOG_PIXELS_PER_MINUTE;
  rail.style.height = `${height}px`;

  dates.forEach((day) => {
    const column = makeElement('section', `worklog-day${day === todayDate() ? ' is-today' : ''}`);
    const heading = makeElement('header', 'worklog-day-header');
    heading.appendChild(makeElement('strong', '', calendarDateLabel(day)));
    const dayMinutes = range.byDate[day]?.minutes || 0;
    heading.appendChild(makeElement('small', '', dayMinutes ? humanMinutes(dayMinutes) : '未记录'));
    const body = makeElement('div', 'worklog-day-body');
    body.style.height = `${height}px`;
    for (let hour = WORKLOG_START_HOUR; hour < WORKLOG_END_HOUR; hour += 1) {
      const line = makeElement('i', 'worklog-hour-line');
      line.style.top = `${(hour - WORKLOG_START_HOUR) * 60 * WORKLOG_PIXELS_PER_MINUTE}px`;
      body.appendChild(line);
    }
    if (day === todayDate()) {
      const marker = makeElement('i', 'worklog-now');
      const minute = nowMinuteOfDay();
      marker.style.top = `${(minute - WORKLOG_START_HOUR * 60) * WORKLOG_PIXELS_PER_MINUTE}px`;
      body.appendChild(marker);
    }
    // Only one timer runs at a time, so segments never really overlap. They can
    // still collide on screen, because a block has a minimum height that is
    // taller than a short segment's true span. Pushing each one below the last
    // keeps back-to-back stretches readable instead of stacked on top of a
    // single blob.
    let floor = 0;
    (range.byDate[day]?.segments || []).forEach((segment) => {
      const block = renderWorklogSegment(segment, day);
      const natural = (segment.startMinute - WORKLOG_START_HOUR * 60) * WORKLOG_PIXELS_PER_MINUTE;
      const top = Math.max(natural, floor);
      block.style.top = `${top}px`;
      floor = top + parseFloat(block.style.height) + 2;
      body.appendChild(block);
    });
    if (!(range.byDate[day]?.segmentCount)) {
      body.appendChild(makeElement('p', 'worklog-day-empty', '这天没有记录'));
    }
    column.append(heading, body);
    grid.appendChild(column);
  });

  // The rail is absolutely positioned against the shared scroll area, so the
  // whole grid scrolls as one and the hours stay aligned with the blocks.
  elements.worklogCalendar.replaceChildren(grid);

  const rollupDates = single ? dates : [];
  const rollup = rollupDates.length
    ? Worklog.taskRollup(state.store, rollupDates[0], { now })
    : [];
  elements.worklogRollup.replaceChildren(...rollup.map((row) => {
    const item = makeElement('div', 'worklog-rollup-row');
    const bar = makeElement('span', 'worklog-rollup-bar');
    bar.style.setProperty('--segment-hue', String(worklogHue(row.taskId)));
    const title = makeElement('div', 'worklog-rollup-title', row.title);
    title.appendChild(makeElement('small', '', row.segments
      .map((segment) => `${Worklog.formatMinute(segment.startMinute)}–${segment.running ? '进行中' : Worklog.formatMinute(segment.endMinute)}`)
      .join('　')));
    item.append(
      bar,
      title,
      makeElement('span', 'worklog-rollup-total', humanMinutes(row.minutes)),
      makeElement('span', 'worklog-rollup-count', `${row.segments.length} 段`),
    );
    return item;
  }));
  elements.worklogRollup.hidden = !rollup.length;

  if (!elements.worklogScroll.dataset.initialized) {
    const earliest = range.segmentCount
      ? Math.min(...dates.flatMap((day) => (range.byDate[day]?.segments || []).map((s) => s.startMinute)))
      : WORKLOG_DEFAULT_SCROLL_MINUTE;
    elements.worklogScroll.scrollTop = Math.max(0, (earliest - WORKLOG_START_HOUR * 60 - 30) * WORKLOG_PIXELS_PER_MINUTE);
    elements.worklogScroll.dataset.initialized = 'true';
  }
}

function nowMinuteOfDay() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: state.store?.meta?.timeZone || DAYMARK_TIME_ZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return (Number(value.hour) % 24) * 60 + Number(value.minute);
}

function openManualTime(taskId, date = todayDate()) {
  const task = activeTasks().find((item) => item.id === taskId && !item.deletedAt);
  if (!task) return;
  elements.manualTimeTaskId.value = task.id;
  elements.manualTimeTaskTitle.textContent = task.title;
  elements.manualTimeDate.value = date;
  elements.manualTimeMinutes.value = '30';
  elements.manualTimeNote.value = '';
  if (!elements.manualTimeDialog.open) elements.manualTimeDialog.showModal();
}

const CALENDAR_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const CALENDAR_PHASE_LABEL = { start: '开始', middle: '进行中', deadline: '截止' };

function todoCalendarAnchor() {
  return state.todoCalendarDate || todayDate();
}

// Every task landing on a date, straight from the scheduler that already knows
// how a dated range spreads across China workdays.
function todoCalendarDay(schedule, date) {
  const tasks = new Map(activeTasks().map((task) => [task.id, task]));
  const blocks = (schedule.byDate[date] || []).map((block) => {
    const task = tasks.get(block.taskId);
    if (!task) return null;
    return {
      task,
      minutes: Number(block.scheduledMinutes) || 0,
      phase: block.phase,
      needsEstimate: Boolean(block.needsEstimate),
      isPlanningDay: block.isPlanningDay !== false,
    };
  }).filter(Boolean);

  // Tasks finished on this date are worth showing: the day is only legible if
  // you can see what got done alongside what is left.
  const completedHere = activeTasks().filter((task) => (
    task.status === 'completed'
    && dateInTimeZone(task.completedAt, state.store?.meta?.timeZone || DAYMARK_TIME_ZONE) === date
    && !blocks.some((block) => block.task.id === task.id)
  )).map((task) => ({
    task, minutes: Number(task.estimateMinutes) || 0, phase: 'single', needsEstimate: false, isPlanningDay: true,
  }));

  return [...blocks, ...completedHere];
}

function todoCalendarCard(entry, date) {
  const task = entry.task;
  const done = task.status === 'completed';
  const priority = task.priority === 'high' ? ' is-high' : task.priority === 'low' ? ' is-low' : '';
  const card = makeElement('button', `calendar-card${priority}${task.top3Date === date ? ' is-top3' : ''}${done ? ' is-done' : ''}`);
  card.type = 'button';
  card.dataset.taskId = task.id;
  card.dataset.date = date;
  card.draggable = !done;
  card.appendChild(makeElement('span', 'calendar-card-title', task.title));

  const meta = makeElement('span', 'calendar-card-meta');
  if (task.top3Date === date) meta.appendChild(makeElement('i', 'calendar-chip is-top3', '★ Top 3'));
  // Phase and "needs an estimate" describe work still ahead, so a finished task
  // shows neither — only that it is done, and how long it was expected to take.
  if (!done && entry.phase && entry.phase !== 'single') {
    meta.appendChild(makeElement('i', 'calendar-chip is-phase', CALENDAR_PHASE_LABEL[entry.phase]));
  }
  if (entry.minutes) meta.appendChild(makeElement('i', 'calendar-chip', `${entry.minutes} 分`));
  else if (!done && entry.needsEstimate) meta.appendChild(makeElement('i', 'calendar-chip is-need', '待估时'));
  if (done) meta.appendChild(makeElement('i', 'calendar-chip', '已完成'));
  if (meta.childNodes.length) card.appendChild(meta);

  card.title = `${task.title}${entry.minutes ? ` · ${entry.minutes} 分钟` : ''}`;
  return card;
}

function renderTodoCalendarWeek(schedule) {
  const anchor = todoCalendarAnchor();
  const dates = Worklog.weekDates(anchor);
  const grid = makeElement('div', 'calendar-week');
  let total = 0;
  let count = 0;

  dates.forEach((date, index) => {
    const entries = todoCalendarDay(schedule, date);
    const used = entries.reduce((sum, entry) => sum + entry.minutes, 0);
    const holiday = Calendar.getChinaHoliday(date);
    const workday = Planning.isChinaWorkday(date);
    total += used;
    count += entries.length;

    const column = makeElement('section', `calendar-day${date === todayDate() ? ' is-today' : ''}${workday ? '' : ' is-rest'}`);
    column.dataset.date = date;

    const head = makeElement('header', 'calendar-day-head');
    const name = makeElement('div', 'calendar-day-name');
    name.append(
      makeElement('b', '', `周${CALENDAR_WEEKDAYS[index]}`),
      makeElement('span', '', String(Number(date.slice(8, 10)))),
    );
    head.appendChild(name);
    if (holiday) {
      head.appendChild(makeElement('span', `calendar-day-badge is-${holiday.type === 'makeup' ? 'makeup' : 'holiday'}`, holiday.name));
    }
    if (used > 0) {
      const capacity = schedule.dailyCapacityMinutes || 480;
      const over = used > capacity;
      const cap = makeElement('div', 'calendar-cap');
      const track = makeElement('div', 'calendar-cap-track');
      const fill = makeElement('div', `calendar-cap-fill${over ? ' is-over' : ''}`);
      fill.style.width = `${Math.min(100, (used / capacity) * 100)}%`;
      track.appendChild(fill);
      cap.append(track, makeElement('span', `calendar-cap-text${over ? ' is-over' : ''}`, `${used} / ${capacity} 分${over ? ' · 超载' : ''}`));
      head.appendChild(cap);
    }
    column.appendChild(head);

    const body = makeElement('div', 'calendar-day-body');
    body.dataset.dropDate = date;
    if (!entries.length) {
      body.appendChild(makeElement('p', 'calendar-day-empty', workday ? '没有安排' : '休息'));
    }
    entries.forEach((entry) => body.appendChild(todoCalendarCard(entry, date)));
    column.appendChild(body);
    grid.appendChild(column);
  });

  elements.todoCalendarRange.textContent = `${formatShortDate(dates[0])} – ${formatShortDate(dates[6])}`;
  elements.todoCalendarSummary.textContent = count
    ? `本周 ${count} 件待办 · 已排 ${humanMinutes(total)}`
    : '本周还没有安排';
  return grid;
}

function renderTodoCalendarMonth(schedule) {
  const anchor = todoCalendarAnchor();
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  const first = `${anchor.slice(0, 7)}-01`;
  const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const gridStart = addDays(first, -offset);

  const wrap = makeElement('div', 'calendar-month-wrap');
  const header = makeElement('div', 'calendar-weekday-row');
  CALENDAR_WEEKDAYS.forEach((day) => header.appendChild(makeElement('span', '', day)));
  const grid = makeElement('div', 'calendar-month');
  let total = 0;
  let count = 0;

  for (let index = 0; index < 42; index += 1) {
    const date = addDays(gridStart, index);
    const inMonth = Number(date.slice(5, 7)) === month && Number(date.slice(0, 4)) === year;
    const entries = todoCalendarDay(schedule, date);
    const used = entries.reduce((sum, entry) => sum + entry.minutes, 0);
    const holiday = Calendar.getChinaHoliday(date);
    const workday = Planning.isChinaWorkday(date);
    if (inMonth) { total += used; count += entries.length; }

    const cell = makeElement('div', `calendar-cell${inMonth ? '' : ' is-outside'}${date === todayDate() ? ' is-today' : ''}${workday ? '' : ' is-rest'}`);
    cell.dataset.dropDate = date;
    const head = makeElement('div', 'calendar-cell-head');
    head.appendChild(makeElement('span', 'calendar-cell-day', String(Number(date.slice(8, 10)))));
    const capacity = schedule.dailyCapacityMinutes || 480;
    const dot = holiday
      ? (holiday.type === 'makeup' ? 'is-makeup' : 'is-holiday')
      : used > capacity ? 'is-over' : '';
    if (dot) head.appendChild(makeElement('i', `calendar-cell-dot ${dot}`));
    cell.appendChild(head);

    entries.slice(0, 3).forEach((entry) => {
      const line = makeElement('button', `calendar-line${entry.task.top3Date === date ? ' is-top3' : ''}${entry.task.status === 'completed' ? ' is-done' : ''}`);
      line.type = 'button';
      line.dataset.taskId = entry.task.id;
      line.dataset.date = date;
      line.draggable = entry.task.status !== 'completed';
      const priority = entry.task.priority === 'high' ? ' is-high' : entry.task.priority === 'low' ? ' is-low' : '';
      line.appendChild(makeElement('i', `calendar-line-bar${priority}`));
      line.appendChild(makeElement('span', '', entry.task.title));
      line.title = entry.task.title + (entry.minutes ? ` · ${entry.minutes} 分钟` : '');
      cell.appendChild(line);
    });
    if (entries.length > 3) {
      cell.appendChild(makeElement('span', 'calendar-more', `+${entries.length - 3} 更多`));
    }
    grid.appendChild(cell);
  }

  wrap.append(header, grid);
  elements.todoCalendarRange.textContent = `${year} 年 ${month} 月`;
  elements.todoCalendarSummary.textContent = count
    ? `本月 ${count} 件待办 · 已排 ${humanMinutes(total)}`
    : '本月还没有安排';
  return wrap;
}

function renderTodoCalendar() {
  state.todoCalendarDate = todoCalendarAnchor();
  document.querySelectorAll('[data-calendar-mode]').forEach((button) => {
    const active = button.dataset.calendarMode === state.calendarMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const schedule = Planning.buildSchedule(state.store, { today: todayDate() });
  elements.todoCalendarBody.replaceChildren(
    state.calendarMode === 'week'
      ? renderTodoCalendarWeek(schedule)
      : renderTodoCalendarMonth(schedule),
  );
}

// Dropping a task on another day moves it there. A task with a deadline keeps
// its span: the whole range shifts, so dragging never silently compresses the
// window someone allowed for the work.
async function moveTaskToDate(taskId, date) {
  const task = activeTasks().find((item) => item.id === taskId && !item.deletedAt);
  if (!task || !date || task.status === 'completed') return;
  const from = task.plannedDate;
  if (from === date) return;

  const patch = { plannedDate: date };
  if (task.dueDate && from) {
    const span = daysBetween(from, task.dueDate);
    patch.dueDate = addDays(date, span);
  } else if (task.dueDate && task.dueDate < date) {
    patch.dueDate = date;
  }

  // Moving a task off its day invalidates a Top 3 marker pinned to that day.
  // The domain clears it either way; saying so keeps the change from looking
  // like the marker was lost by accident.
  const losesTop3 = Boolean(task.top3Date) && task.top3Date !== date;
  const spanNote = patch.dueDate && patch.dueDate !== task.dueDate ? ' · 期限一并顺延' : '';
  await patchTask(taskId, patch, {
    message: `已改期到 ${formatShortDate(date)}${spanNote}${losesTop3 ? ' · Top 3 标记已移除' : ''}`,
  });
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000);
}

function renderDebugState() {
  const visible = ['review', 'worklog', 'calendar', 'focus'].includes(state.view)
    ? []
    : visibleTasks(activeTasks(), state.view, state.query, todayDate());
  const payload = {
    ready: Boolean(state.store),
    version: state.store?.version,
    timeZone: state.store?.meta?.timeZone,
    today: todayDate(),
    previewEnabled,
    bridgeMode: window.daymark ? 'desktop' : previewEnabled ? 'preview' : 'unavailable',
    view: state.view,
    reviewMode: state.reviewMode,
    visibleTaskCount: visible.length,
    totalEvents: state.store?.events?.length || 0,
    archiveCount: state.store?.dailyArchives?.length || 0,
    selectedId: state.selectedId,
    focusSessionCount: focusSessions().length,
    focusRunning: Boolean(runningFocusSession()),
  };
  elements.debugState.textContent = JSON.stringify(payload);
  document.body.dataset.appReady = String(Boolean(state.store));
  document.body.dataset.currentView = state.view;
}

function render() {
  if (!state.store) return;
  const reviewing = state.view === 'review';
  const focusing = state.view === 'focus';
  const logging = state.view === 'worklog';
  const planning = state.view === 'calendar';
  elements.shell.classList.toggle('is-reviewing', reviewing || logging || planning);
  elements.shell.classList.toggle('is-focusing', focusing);
  elements.taskWorkspace.hidden = reviewing || logging || planning || focusing;
  elements.worklogWorkspace.hidden = !logging;
  elements.todoCalendarWorkspace.hidden = !planning;
  elements.reviewWorkspace.hidden = !reviewing;
  elements.focusWorkspace.hidden = !focusing;
  elements.detailsPanel.hidden = focusing;
  elements.focusPanel.hidden = !focusing;
  renderSidebar();
  renderHeader();
  if (reviewing) renderReview();
  else if (logging) renderWorklog();
  else if (planning) renderTodoCalendar();
  else if (!focusing) renderTaskList();
  renderFocus();
  renderRunStrip();
  renderDetails();
  renderDebugState();
}

function plannedForNewTask() {
  if (state.quickDate === 'today' || state.view === 'today') return todayDate();
  if (state.quickDate === 'tomorrow' || state.view === 'upcoming') return tomorrowDate();
  return null;
}

async function addTask(title) {
  const clean = String(title || '').trim();
  if (!clean) return;
  const taskId = commandId('task');
  const plannedDate = plannedForNewTask();
  await dispatch({ type: 'create', taskId, payload: { title: clean, plannedDate } }, {
    selectedId: taskId,
    undo: { type: 'delete', taskId },
    undoMessage: '已撤销新建任务',
  });
  state.view = plannedDate === todayDate() ? 'today' : plannedDate ? 'upcoming' : 'inbox';
  state.query = '';
  state.quickDate = null;
  elements.searchInput.value = '';
  elements.taskInput.value = '';
  document.querySelectorAll('[data-quick-date]').forEach((button) => {
    button.classList.remove('is-active');
    button.setAttribute('aria-pressed', 'false');
  });
  render();
  elements.taskInput.focus();
}

async function patchTask(taskId, patch, options = {}) {
  const task = activeTasks().find((item) => item.id === taskId && !item.deletedAt);
  if (!task) return;
  const inverse = inverseTaskPatch(task, patch);
  let message = options.message;
  if (message === undefined && Object.prototype.hasOwnProperty.call(patch, 'plannedDate')) {
    message = patch.plannedDate
      ? `已将“${task.title}”安排到${formatShortDate(patch.plannedDate)}`
      : Object.prototype.hasOwnProperty.call(patch, 'dueDate') && !patch.dueDate
        ? `已将“${task.title}”移回收件箱`
        : `已清除“${task.title}”的计划日期`;
  } else if (message === undefined && Object.prototype.hasOwnProperty.call(patch, 'dueDate')) {
    message = `已更新“${task.title}”的最后期限`;
  }
  try {
    await dispatch({ type: 'update', taskId, payload: patch }, {
      undo: options.undo === false ? null : { type: 'update', taskId, payload: inverse },
      undoMessage: '已撤销任务修改',
      message,
    });
    return true;
  } catch {
    return false;
  }
}

function shiftedDate(date, from, to) {
  if (!date || !from || !to) return date || null;
  const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
  return addDays(date, days);
}

function shiftedDateTime(value, from, to) {
  if (!value || !from || !to) return null;
  const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function repeatRuleForNext(task, baseDate) {
  const rule = task.repeatRule;
  const frequency = typeof rule === 'string' ? rule : rule?.frequency;
  if (frequency !== 'monthly') return rule;
  const anchorDay = Number(rule?.anchorDay) || Number(String(baseDate).slice(-2));
  return { ...(typeof rule === 'object' ? rule : {}), frequency: 'monthly', anchorDay };
}

async function toggleTaskById(taskId) {
  if (pendingTaskActions.has(taskId)) return;
  const task = activeTasks().find((item) => item.id === taskId && !item.deletedAt);
  if (!task) return;
  pendingTaskActions.add(taskId);
  try {
    const completing = task.status !== 'completed';
    await dispatch({ type: 'toggle', taskId });
    const undoCommands = [];
    if (completing && task.repeatRule) {
      const recurrenceBase = task.plannedDate || todayDate();
      const nextDate = nextRecurringDate(task, todayDate());
      if (nextDate) {
        const nextId = commandId('task');
        await dispatch({
          type: 'create',
          taskId: nextId,
          payload: {
            title: task.title,
            notes: task.notes,
            dueDate: shiftedDate(task.dueDate, recurrenceBase, nextDate),
            priority: task.priority,
            plannedDate: nextDate,
            estimateMinutes: task.estimateMinutes,
            area: task.area,
            repeatRule: repeatRuleForNext(task, recurrenceBase),
            reminderAt: shiftedDateTime(task.reminderAt, recurrenceBase, nextDate),
            reminderFiredAt: null,
            sourceUrl: task.sourceUrl,
          },
        });
        undoCommands.push({ type: 'delete', taskId: nextId });
      }
    }
    undoCommands.push({ type: 'toggle', taskId });
    pushUndo(undoCommands, completing ? '已恢复任务状态' : '已重新完成任务');
    showToast(completing ? '任务已完成' : '任务已恢复', true);
    if ((completing && state.view !== 'completed') || (!completing && state.view === 'completed')) state.selectedId = null;
    render();
  } finally {
    pendingTaskActions.delete(taskId);
  }
}

async function deleteTaskById(taskId) {
  const task = activeTasks().find((item) => item.id === taskId && !item.deletedAt);
  if (!task) return;
  await dispatch({ type: 'delete', taskId }, {
    selectedId: state.selectedId === taskId ? null : state.selectedId,
    undo: { type: 'restore', taskId },
    undoMessage: '已恢复删除的任务',
    message: `已删除“${task.title}”`,
  });
}

function selectTask(taskId, focusRow = false, focusDetails = false) {
  if (!activeTasks().some((task) => task.id === taskId && !task.deletedAt)) return;
  state.selectedId = taskId;
  render();
  if (focusDetails || detailsOverlayQuery.matches) requestAnimationFrame(() => elements.detailTitle.focus());
  else if (focusRow) document.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`)?.focus();
}

function schedulePatch(field, value) {
  const task = selectedTask();
  if (!task) return;
  const taskId = task.id;
  const timerKey = `${taskId}:${field}`;
  clearTimeout(fieldTimers.get(timerKey));
  fieldTimers.set(timerKey, setTimeout(() => patchTask(taskId, { [field]: value }, { undo: false }), 500));
}

elements.addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(addTask(elements.taskInput.value));
});

document.querySelector('.sidebar').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  state.view = button.dataset.view;
  state.selectedId = null;
  state.query = '';
  elements.searchInput.value = '';
  render();
});

elements.focusDurationChips.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-minutes]');
  if (!button) return;
  state.focusMinutes = Number(button.dataset.minutes);
  renderFocusDurationChips();
  if (!runningFocusSession() && !state.focusOutcome) {
    elements.focusClock.textContent = formatFocusClock(selectedFocusMinutes() * 60);
  }
});

elements.focusStartChips.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-minutes]');
  if (!button) return;
  state.focusStartMinutes = Number(button.dataset.minutes);
  elements.focusStartHint.textContent = '';
  renderFocusStartChips();
});

elements.focusStartConfirm.addEventListener('click', () => {
  const taskId = state.focusStartTaskId;
  const minutes = state.focusStartMinutes;
  elements.focusStartDialog.close();
  // The chosen length becomes the new default so the focus view and the next
  // task both open on it.
  state.focusMinutes = minutes;
  runAction(startFocusSession(taskId, minutes));
});

elements.focusStartDialog.addEventListener('close', () => {
  state.focusStartTaskId = null;
});

elements.focusStart.addEventListener('click', () => runAction(startFocusSession()));

elements.focusGiveup.addEventListener('click', () => {
  elements.focusConfirm.hidden = false;
});

elements.focusConfirmNo.addEventListener('click', () => {
  elements.focusConfirm.hidden = true;
});

elements.focusConfirmYes.addEventListener('click', () => runAction(abandonRunningFocusSession()));

elements.focusPause.addEventListener('click', () => {
  const running = runningFocusSession();
  if (!running) return;
  runAction(dispatch({
    type: running.pausedAt ? 'resumeFocusSession' : 'pauseFocusSession',
    payload: { sessionId: running.id },
  }, { selectedId: state.selectedId }));
});

elements.focusAgain.addEventListener('click', () => {
  state.focusOutcome = null;
  runAction(startFocusSession());
});

elements.focusRest.addEventListener('click', () => {
  state.focusOutcome = null;
  render();
});

elements.focusRetry.addEventListener('click', () => {
  state.focusOutcome = null;
  render();
});

elements.focusChip.addEventListener('click', () => {
  state.view = 'focus';
  state.selectedId = null;
  render();
});

elements.focusStrictMode.addEventListener('change', () => {
  runAction(dispatch({
    type: 'setFocusSettings',
    payload: { strictMode: elements.focusStrictMode.checked },
  }, { selectedId: state.selectedId }));
});

elements.focusNotification.addEventListener('change', () => {
  runAction(dispatch({
    type: 'setFocusSettings',
    payload: { completionNotification: elements.focusNotification.checked },
  }, { selectedId: state.selectedId }));
});

elements.focusGoalSelect.addEventListener('change', () => {
  runAction(dispatch({
    type: 'setFocusSettings',
    payload: { dailyGoalMinutes: Number(elements.focusGoalSelect.value) },
  }, { selectedId: state.selectedId }));
});

document.querySelector('.worklog-mode').addEventListener('click', (event) => {
  const button = event.target.closest('[data-worklog-mode]');
  if (!button) return;
  state.worklogMode = button.dataset.worklogMode;
  delete elements.worklogScroll.dataset.initialized;
  renderWorklog();
  renderDebugState();
});

elements.worklogDate.addEventListener('change', () => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(elements.worklogDate.value)) return;
  state.worklogDate = elements.worklogDate.value;
  renderWorklog();
});

elements.worklogPrevious.addEventListener('click', () => {
  state.worklogDate = addDays(state.worklogDate || todayDate(), state.worklogMode === 'day' ? -1 : -7);
  renderWorklog();
});

elements.worklogNext.addEventListener('click', () => {
  state.worklogDate = addDays(state.worklogDate || todayDate(), state.worklogMode === 'day' ? 1 : 7);
  renderWorklog();
});

elements.worklogToday.addEventListener('click', () => {
  state.worklogDate = todayDate();
  renderWorklog();
});

elements.worklogCalendar.addEventListener('click', (event) => {
  const segment = event.target.closest('.worklog-segment');
  if (!segment || !segment.dataset.taskId) return;
  selectTask(segment.dataset.taskId);
});

// --- Todo calendar ---

document.querySelector('.calendar-mode').addEventListener('click', (event) => {
  const button = event.target.closest('[data-calendar-mode]');
  if (!button) return;
  state.calendarMode = button.dataset.calendarMode;
  renderTodoCalendar();
  renderHeader();
  renderDebugState();
});

elements.todoCalendarPrevious.addEventListener('click', () => {
  state.todoCalendarDate = state.calendarMode === 'week'
    ? addDays(todoCalendarAnchor(), -7)
    : shiftMonth(todoCalendarAnchor(), -1);
  renderTodoCalendar();
});

elements.todoCalendarNext.addEventListener('click', () => {
  state.todoCalendarDate = state.calendarMode === 'week'
    ? addDays(todoCalendarAnchor(), 7)
    : shiftMonth(todoCalendarAnchor(), 1);
  renderTodoCalendar();
});

elements.todoCalendarToday.addEventListener('click', () => {
  state.todoCalendarDate = todayDate();
  renderTodoCalendar();
});

function shiftMonth(date, delta) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 + delta;
  const target = new Date(Date.UTC(year, month, 1));
  return target.toISOString().slice(0, 10);
}

elements.todoCalendarBody.addEventListener('click', (event) => {
  const card = event.target.closest('[data-task-id]');
  if (!card) return;
  state.view = 'calendar';
  selectTask(card.dataset.taskId);
});

elements.todoCalendarBody.addEventListener('dragstart', (event) => {
  const card = event.target.closest('[data-task-id]');
  if (!card || card.draggable === false) return;
  draggedCalendarTask = { taskId: card.dataset.taskId, from: card.dataset.date };
  card.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  // Firefox refuses to start a drag without payload; the id is the payload.
  event.dataTransfer.setData('text/plain', card.dataset.taskId);
});

elements.todoCalendarBody.addEventListener('dragend', (event) => {
  event.target.closest('[data-task-id]')?.classList.remove('is-dragging');
  draggedCalendarTask = null;
  elements.todoCalendarBody.querySelectorAll('.is-drop-target')
    .forEach((item) => item.classList.remove('is-drop-target'));
});

elements.todoCalendarBody.addEventListener('dragover', (event) => {
  const target = event.target.closest('[data-drop-date]');
  if (!target || !draggedCalendarTask) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  elements.todoCalendarBody.querySelectorAll('.is-drop-target')
    .forEach((item) => item.classList.toggle('is-drop-target', item === target));
});

elements.todoCalendarBody.addEventListener('drop', (event) => {
  const target = event.target.closest('[data-drop-date]');
  if (!target || !draggedCalendarTask) return;
  event.preventDefault();
  const drag = draggedCalendarTask;
  draggedCalendarTask = null;
  elements.todoCalendarBody.querySelectorAll('.is-drop-target')
    .forEach((item) => item.classList.remove('is-drop-target'));
  runAction(moveTaskToDate(drag.taskId, target.dataset.dropDate));
});

// --- Task timing: start, pause, resume ---

async function startTaskTimer(taskId) {
  const task = activeTasks().find((item) => item.id === taskId && !item.deletedAt);
  if (!task || task.status === 'completed') return;
  const running = runningEntry();
  if (running) {
    // Only one thing can be timed at once, so switching tasks closes the old
    // run first rather than silently dropping it.
    if (running.taskId === taskId) return;
    await dispatch({
      type: 'stopFocus',
      taskId: running.taskId,
      payload: { entryId: running.id },
    }, { selectedId: state.selectedId });
  }
  state.lastTimedTaskId = taskId;
  await dispatch({
    type: 'startFocus',
    taskId,
    payload: { entryId: commandId('time') },
  }, {
    selectedId: state.selectedId,
    message: running ? `已切换到「${task.title}」` : '开始处理',
  });
}

async function pauseTaskTimer() {
  const running = runningEntry();
  if (!running) return;
  await dispatch({
    type: 'stopFocus',
    taskId: running.taskId,
    payload: { entryId: running.id },
  }, { selectedId: state.selectedId, message: '已暂停，这段时间已记录' });
}

// A run left open overnight is closed at the end of the day it belongs to, so a
// forgotten timer cannot log the small hours as work.
async function settleStaleRun() {
  const stale = Worklog.staleRunningEntry(state.store, todayDate());
  if (!stale) return;
  try {
    await dispatch({
      type: 'stopFocus',
      eventId: `stale-stop-${stale.id}`,
      taskId: stale.taskId,
      occurredAt: timeEntryDayEnd(stale, state.store?.meta?.timeZone || DAYMARK_TIME_ZONE),
      payload: { entryId: stale.id },
    }, { selectedId: state.selectedId });
    showToast(`${stale.reportingDate} 有一段计时忘了暂停，已按当天 24:00 结束`, false);
  } catch (error) {
    console.error('Unable to settle a stale run:', error);
  }
}

elements.runPause.addEventListener('click', () => {
  const running = runningEntry();
  if (running) runAction(pauseTaskTimer());
  else if (state.lastTimedTaskId) runAction(startTaskTimer(state.lastTimedTaskId));
});

elements.runComplete.addEventListener('click', () => {
  const running = runningEntry();
  if (running?.taskId) runAction(toggleTaskById(running.taskId));
});

function saveManualTime() {
  const taskId = elements.manualTimeTaskId.value;
  const date = elements.manualTimeDate.value;
  const minutes = Number(elements.manualTimeMinutes.value);
  if (!taskId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    showToast('请填写有效的日期和实际用时', false);
    return;
  }
  const entryId = commandId('time');
  runAction(dispatch({
    type: 'addManualTime',
    taskId,
    payload: {
      entryId,
      date,
      minutes,
      note: elements.manualTimeNote.value.trim(),
    },
  }, {
    undo: { type: 'deleteTimeEntry', taskId, payload: { entryId } },
    undoMessage: '已删除补录用时',
    message: '实际用时已补录',
  }).then(() => elements.manualTimeDialog.close()));
}

elements.manualTimeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveManualTime();
});
elements.saveManualTime.addEventListener('click', saveManualTime);

document.querySelector('.quick-options').addEventListener('click', (event) => {
  const button = event.target.closest('[data-quick-date]');
  if (!button) return;
  state.quickDate = state.quickDate === button.dataset.quickDate ? null : button.dataset.quickDate;
  document.querySelectorAll('[data-quick-date]').forEach((item) => {
    const active = item.dataset.quickDate === state.quickDate;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-pressed', String(active));
  });
});

elements.searchInput.addEventListener('input', () => {
  state.query = elements.searchInput.value.trim();
  renderHeader();
  renderTaskList();
});

elements.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    state.query = '';
    elements.searchInput.value = '';
    elements.searchInput.blur();
    render();
  }
});

elements.emptyAction.addEventListener('click', () => {
  if (state.query) {
    state.query = '';
    elements.searchInput.value = '';
    render();
  } else if (state.view === 'completed') {
    state.view = 'all';
    render();
  } else if (state.view === 'today' && visibleTasks(activeTasks(), 'inbox', '', todayDate()).length) {
    state.view = 'inbox';
    render();
  } else {
    elements.taskInput.focus();
  }
});

elements.taskList.addEventListener('click', (event) => {
  const row = event.target.closest('.task-row');
  if (!row) return;
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggle') runAction(toggleTaskById(row.dataset.taskId));
  else if (action === 'start') runAction(startTaskTimer(row.dataset.taskId));
  else if (action === 'pause') runAction(pauseTaskTimer());
  else if (action === 'focus') openFocusStart(row.dataset.taskId);
  else if (action === 'flag') {
    const task = activeTasks().find((item) => item.id === row.dataset.taskId);
    if (task) runAction(patchTask(task.id, { flagged: !task.flagged }, { message: '旗标已更新' }));
  }
  else if (action === 'delete') runAction(deleteTaskById(row.dataset.taskId));
  else selectTask(row.dataset.taskId);
});

elements.taskList.addEventListener('dblclick', (event) => {
  const row = event.target.closest('.task-row');
  if (!row || event.target.closest('[data-action]')) return;
  selectTask(row.dataset.taskId);
  requestAnimationFrame(() => elements.detailTitle.focus());
});

elements.taskList.addEventListener('keydown', (event) => {
  const row = event.target.closest('.task-row');
  if (!row || event.target !== row || event.key !== 'Enter') return;
  event.preventDefault();
  selectTask(row.dataset.taskId, false, true);
});

elements.detailCompleted.addEventListener('change', () => {
  const task = selectedTask();
  if (task) runAction(toggleTaskById(task.id));
});

elements.detailTitle.addEventListener('blur', () => {
  const task = selectedTask();
  if (!task) return;
  const value = elements.detailTitle.value.trim();
  if (!value) elements.detailTitle.value = task.title;
  else if (value !== task.title) patchTask(task.id, { title: value });
});

elements.detailPlanned.addEventListener('change', () => {
  const task = selectedTask();
  if (task) patchTask(task.id, { plannedDate: elements.detailPlanned.value || null });
});

elements.detailDue.addEventListener('change', () => {
  const task = selectedTask();
  if (task) patchTask(task.id, { dueDate: elements.detailDue.value || null });
});

elements.detailsForm.querySelector('.date-shortcuts').addEventListener('click', (event) => {
  const button = event.target.closest('[data-planned-shortcut]');
  const task = selectedTask();
  if (!button || !task) return;
  const values = { today: todayDate(), tomorrow: tomorrowDate(), clear: null };
  patchTask(task.id, { plannedDate: values[button.dataset.plannedShortcut] });
});

elements.detailEstimate.addEventListener('change', () => {
  const task = selectedTask();
  if (task) patchTask(task.id, { estimateMinutes: elements.detailEstimate.value ? Number(elements.detailEstimate.value) : null });
});

elements.detailArea.addEventListener('blur', () => {
  const task = selectedTask();
  if (task && elements.detailArea.value.trim() !== task.area) patchTask(task.id, { area: elements.detailArea.value.trim() });
});

elements.detailTop3.addEventListener('change', () => {
  const task = selectedTask();
  if (!task) return;
  patchTask(task.id, { top3Date: elements.detailTop3.checked ? task.plannedDate : null });
});

elements.detailFlagged.addEventListener('change', () => {
  const task = selectedTask();
  if (task) patchTask(task.id, { flagged: elements.detailFlagged.checked }, { message: '旗标已更新' });
});

elements.detailsForm.querySelector('.priority-options').addEventListener('change', (event) => {
  const task = selectedTask();
  if (task && event.target.name === 'priority') patchTask(task.id, { priority: event.target.value });
});

elements.detailRepeat.addEventListener('change', () => {
  const task = selectedTask();
  if (task) patchTask(task.id, { repeatRule: elements.detailRepeat.value === 'none' ? null : elements.detailRepeat.value });
});

elements.detailReminder.addEventListener('change', () => {
  const task = selectedTask();
  if (task) patchTask(task.id, { reminderAt: fromInputDateTime(elements.detailReminder.value), reminderFiredAt: null });
});

elements.detailSource.addEventListener('blur', () => {
  const task = selectedTask();
  if (task && elements.detailSource.value.trim() !== (task.sourceUrl || '')) patchTask(task.id, { sourceUrl: elements.detailSource.value.trim() || null });
});

elements.detailNotes.addEventListener('input', () => {
  elements.notesCount.textContent = `${elements.detailNotes.value.length} / 2000`;
  schedulePatch('notes', elements.detailNotes.value);
});

elements.detailCompletionNote.addEventListener('input', () => schedulePatch('completionNote', elements.detailCompletionNote.value));

elements.deleteTask.addEventListener('click', () => {
  const task = selectedTask();
  if (task) runAction(deleteTaskById(task.id));
});

elements.closeDetails.addEventListener('click', () => {
  const closingTaskId = state.selectedId;
  state.selectedId = null;
  render();
  if (closingTaskId) requestAnimationFrame(() => {
    document.querySelector(`[data-task-id="${CSS.escape(closingTaskId)}"]`)?.focus();
  });
});

elements.capacitySelect.addEventListener('change', () => {
  runAction(dispatch({ type: 'setCapacity', payload: { minutes: Number(elements.capacitySelect.value) } }, { message: '每日容量已更新' }));
});

function saveEndOfDayReminder() {
  runAction(dispatch({
    type: 'setEndOfDayReminder',
    payload: {
      enabled: elements.endOfDayEnabled.checked,
      time: elements.endOfDayTime.value || '17:30',
    },
  }, { message: elements.endOfDayEnabled.checked ? '下班提醒已更新' : '下班提醒已关闭' }));
}

elements.endOfDayEnabled.addEventListener('change', () => {
  elements.endOfDayTime.disabled = !elements.endOfDayEnabled.checked;
  saveEndOfDayReminder();
});
elements.endOfDayTime.addEventListener('change', saveEndOfDayReminder);

elements.planToday.addEventListener('click', () => runAction(openDailyPlan()));
elements.shutdownToday.addEventListener('click', openDailyShutdown);

elements.dailyPlanCandidates.addEventListener('change', (event) => {
  const row = event.target.closest('.ritual-candidate');
  if (!row) return;
  const include = row.querySelector('.plan-include');
  const top3 = row.querySelector('.plan-top3');
  if (event.target === top3 && top3.checked) {
    const checked = elements.dailyPlanCandidates.querySelectorAll('.plan-top3:checked');
    if (checked.length > 3) {
      top3.checked = false;
      showToast('一天最多只能选择 3 个 Top3', false);
    } else include.checked = true;
  }
  if (event.target === include && !include.checked && top3.checked) top3.checked = false;
  if (event.target === include) {
    const defer = row.querySelector('.ritual-defer');
    if (defer) defer.hidden = include.checked || row.dataset.wasSelected !== 'true';
  }
  if (event.target.matches('.plan-defer-select')) {
    const customDate = row.querySelector('.plan-defer-date');
    customDate.hidden = event.target.value !== 'date';
    if (!customDate.hidden) customDate.focus();
  }
  updateDailyPlanSummary();
});

elements.dailyPlanForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (elements.confirmDailyPlan.disabled) return;
  elements.confirmDailyPlan.disabled = true;
  runAction(confirmDailyPlan().finally(() => { elements.confirmDailyPlan.disabled = false; }));
});

elements.dailyShutdownTasks.addEventListener('change', (event) => {
  const row = event.target.closest('.shutdown-task');
  if (!row || !event.target.matches('.shutdown-action-select')) return;
  const customDate = row.querySelector('.shutdown-date-input');
  customDate.hidden = event.target.value !== 'date';
  if (!customDate.hidden) customDate.focus();
  updateDailyShutdownSummary();
});

elements.dailyShutdownForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (elements.confirmDailyShutdown.disabled) return;
  elements.confirmDailyShutdown.disabled = true;
  runAction(confirmDailyShutdown().finally(() => { elements.confirmDailyShutdown.disabled = false; }));
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-close-dialog]');
  if (!button) return;
  document.getElementById(button.dataset.closeDialog)?.close();
});

async function flushDailyNote() {
  clearTimeout(noteTimer);
  noteTimer = null;
  const pending = pendingDailyNote;
  pendingDailyNote = null;
  if (!pending) return;
  await dispatch({ type: 'setDailyNote', payload: pending });
}

elements.dailyNoteInput.addEventListener('input', () => {
  pendingDailyNote = {
    date: state.calendarDate || todayDate(),
    note: elements.dailyNoteInput.value,
  };
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => flushDailyNote().catch((error) => console.error('Unable to save daily note:', error)), 550);
});

const reviewTabs = document.querySelector('.review-tabs');

function cancelAiForContextChange() {
  const requestId = state.aiRequestId;
  if (!requestId) return;
  state.aiRequestId = null;
  if (typeof bridge.cancelAiReport === 'function') {
    Promise.resolve(bridge.cancelAiReport(requestId)).catch(() => {});
  }
  elements.reportStatus.textContent = '报告范围已切换，上一项 AI 生成已取消';
  renderAiSettingsStatus();
}

reviewTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-review-mode]');
  if (!button) return;
  cancelAiForContextChange();
  state.reviewMode = button.dataset.reviewMode;
  state.reportPeriodKey = '';
  renderReview();
  renderDebugState();
});

reviewTabs.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...reviewTabs.querySelectorAll('[data-review-mode]')];
  const currentIndex = tabs.indexOf(event.target.closest('[data-review-mode]'));
  if (currentIndex < 0) return;
  event.preventDefault();
  let nextIndex;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  else nextIndex = (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
});

function shiftMonth(value, amount) {
  const [year, month] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function setReviewMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) return;
  const reportCanFollow = value <= todayDate().slice(0, 7);
  if (reportCanFollow && state.reviewMode === 'month' && value !== state.reviewMonth) cancelAiForContextChange();
  state.calendarMonth = value;
  if (reportCanFollow) state.reviewMonth = value;
  if (!state.reviewSelectedDate?.startsWith(value)) {
    state.reviewSelectedDate = todayDate().startsWith(value) ? todayDate() : `${value}-01`;
  }
  if (state.reviewMode === 'month' && reportCanFollow) {
    state.reportPeriodKey = '';
    renderReview();
  } else {
    renderCalendar();
  }
}

elements.recordMonth.addEventListener('change', () => setReviewMonth(elements.recordMonth.value));
elements.previousMonth.addEventListener('click', () => setReviewMonth(shiftMonth(state.calendarMonth, -1)));
elements.nextMonth.addEventListener('click', () => setReviewMonth(shiftMonth(state.calendarMonth, 1)));

function selectReviewDate(date, focus = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const month = date.slice(0, 7);
  if (month !== state.calendarMonth) {
    const reportCanFollow = month <= todayDate().slice(0, 7);
    if (state.reviewMode === 'month') cancelAiForContextChange();
    state.calendarMonth = month;
    if (reportCanFollow) state.reviewMonth = month;
    state.reviewSelectedDate = date;
    if (state.reviewMode === 'month' && reportCanFollow) {
      state.reportPeriodKey = '';
      renderReview();
    } else {
      renderCalendar();
    }
  } else {
    state.reviewSelectedDate = date;
    renderCalendar();
  }
  if (focus) requestAnimationFrame(() => {
    elements.calendarGrid.querySelector(`[data-calendar-date="${CSS.escape(date)}"]`)?.focus();
  });
}

elements.calendarGrid.addEventListener('click', (event) => {
  const day = event.target.closest('[data-calendar-date]');
  if (day) selectReviewDate(day.dataset.calendarDate, true);
});

elements.calendarGrid.addEventListener('keydown', (event) => {
  const day = event.target.closest('[data-calendar-date]');
  if (!day || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  let target = day.dataset.calendarDate;
  if (event.key === 'Home') target = addDays(target, -((new Date(`${target}T00:00:00Z`).getUTCDay() + 6) % 7));
  else if (event.key === 'End') target = addDays(target, 6 - ((new Date(`${target}T00:00:00Z`).getUTCDay() + 6) % 7));
  else target = addDays(target, offsets[event.key]);
  selectReviewDate(target, true);
});

elements.reportYear.addEventListener('change', () => {
  cancelAiForContextChange();
  updateQuarterAvailability();
  state.reportPeriodKey = '';
  renderPeriodReport();
});
elements.reportQuarter.addEventListener('change', () => {
  cancelAiForContextChange();
  state.reportPeriodKey = '';
  renderPeriodReport();
});

function coerceAiSettings(result) {
  const candidate = result?.settings || result?.data?.settings || result?.data || result || {};
  const keySource = candidate.keySource || (candidate.hasStoredKey ? 'safeStorage' : 'none');
  const usableKey = typeof candidate.hasApiKey === 'boolean'
    ? candidate.hasApiKey
    : Boolean(candidate.hasKey || candidate.keyConfigured || (keySource && keySource !== 'none'));
  return {
    ...state.aiSettings,
    ...candidate,
    model: String(candidate.model || state.aiSettings.model || 'gpt-5.6-terra'),
    keySource,
    hasKey: usableKey,
    includeDailyNotes: Boolean(candidate.includeDailyNotes),
    includeCompletionNotes: candidate.includeCompletionNotes !== false,
  };
}

async function loadAiSettings() {
  if (typeof bridge.getAiSettings !== 'function') return;
  try {
    state.aiSettings = coerceAiSettings(await bridge.getAiSettings());
    elements.aiModel.value = state.aiSettings.model || 'gpt-5.6-terra';
    elements.includeDailyNotes.checked = Boolean(state.aiSettings.includeDailyNotes);
    elements.includeCompletionNotes.checked = state.aiSettings.includeCompletionNotes !== false;
    renderAiSettingsStatus();
  } catch (error) {
    elements.aiKeyStatus.textContent = `AI 配置不可用：${errorMessage(error)}`;
    elements.generateAiReport.disabled = true;
  }
}

async function saveAiPreferences() {
  const settings = {
    model: elements.aiModel.value.trim() || 'gpt-5.6-terra',
    includeDailyNotes: elements.includeDailyNotes.checked,
    includeCompletionNotes: elements.includeCompletionNotes.checked,
  };
  if (typeof bridge.saveAiSettings !== 'function') {
    state.aiSettings = { ...state.aiSettings, ...settings };
    return state.aiSettings;
  }
  state.aiSettings = coerceAiSettings(await bridge.saveAiSettings(settings));
  elements.aiModel.value = state.aiSettings.model;
  renderAiSettingsStatus();
  return state.aiSettings;
}

elements.aiModel.addEventListener('blur', () => {
  runAction(saveAiPreferences().catch((error) => showToast(`模型设置保存失败：${errorMessage(error)}`, false)));
});
elements.includeDailyNotes.addEventListener('change', () => {
  runAction(saveAiPreferences().catch((error) => showToast(`AI 输入设置保存失败：${errorMessage(error)}`, false)));
});
elements.includeCompletionNotes.addEventListener('change', () => {
  runAction(saveAiPreferences().catch((error) => showToast(`AI 输入设置保存失败：${errorMessage(error)}`, false)));
});

elements.saveAiKey.addEventListener('click', () => runAction((async () => {
  const apiKey = elements.aiApiKey.value.trim();
  if (!apiKey) {
    showToast('请输入 API Key', false);
    elements.aiApiKey.focus();
    return;
  }
  if (typeof bridge.setAiKey !== 'function') throw new Error('当前版本不支持安全保存 API Key');
  elements.saveAiKey.disabled = true;
  try {
    state.aiSettings = coerceAiSettings(await bridge.setAiKey(apiKey));
    elements.aiApiKey.value = '';
    renderAiSettingsStatus();
    showToast('API Key 已保存到本机安全存储', false);
  } catch (error) {
    showToast(`API Key 保存失败：${errorMessage(error)}`, false);
  } finally {
    elements.saveAiKey.disabled = false;
  }
})()));

elements.clearAiKey.addEventListener('click', () => runAction((async () => {
  if (typeof bridge.clearAiKey !== 'function') return;
  try {
    state.aiSettings = coerceAiSettings(await bridge.clearAiKey());
    renderAiSettingsStatus();
    showToast('本机 API Key 已移除', false);
  } catch (error) {
    showToast(`API Key 移除失败：${errorMessage(error)}`, false);
  }
})()));

elements.generateAiReport.addEventListener('click', () => runAction((async () => {
  if (state.aiRequestId) return;
  try {
    await saveAiPreferences();
  } catch (error) {
    showToast(`AI 设置保存失败：${errorMessage(error)}`, false);
    return;
  }
  if (!hasAiKey()) {
    showToast('请先配置 API Key；本地报告仍可直接使用', false);
    return;
  }
  if (typeof bridge.generateAiReport !== 'function') {
    showToast('当前版本不支持 AI 生成', false);
    return;
  }
  const selection = reportSelection();
  const requestId = commandId('ai').slice(0, 80);
  state.aiRequestId = requestId;
  renderAiSettingsStatus();
  elements.reportStatus.textContent = '正在生成 AI 草稿…';
  try {
    const result = await bridge.generateAiReport({
      requestId,
      mode: selection.mode,
      year: selection.year,
      ...(selection.mode === 'month' ? { month: selection.month } : {}),
      ...(selection.mode === 'quarter' ? { quarter: selection.quarter } : {}),
      includeDailyNotes: elements.includeDailyNotes.checked,
      includeCompletionNotes: elements.includeCompletionNotes.checked,
    });
    if (state.aiRequestId !== requestId) return;
    if (result?.canceled) {
      elements.reportStatus.textContent = '已取消发送，本地报告未受影响';
      return;
    }
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('AI 未返回可用内容');
    state.aiReportText = text;
    state.reportMarkdown = text;
    elements.reportOutput.value = text;
    elements.reportKind.textContent = 'AI 工作报告';
    elements.reportStatus.textContent = `AI 草稿 · ${result?.model || state.aiSettings.model}`;
    showToast('AI 工作总结已生成', false);
  } catch (error) {
    if (state.aiRequestId === requestId) {
      elements.reportStatus.textContent = 'AI 生成失败，本地报告仍可使用';
      showToast(`AI 生成失败：${errorMessage(error)}`, false);
    }
  } finally {
    if (state.aiRequestId === requestId) state.aiRequestId = null;
    renderAiSettingsStatus();
  }
})()));

elements.cancelAiReport.addEventListener('click', () => runAction((async () => {
  const requestId = state.aiRequestId;
  if (!requestId) return;
  state.aiRequestId = null;
  renderAiSettingsStatus();
  elements.reportStatus.textContent = '已取消 AI 生成，本地报告未受影响';
  if (typeof bridge.cancelAiReport === 'function') {
    try {
      await bridge.cancelAiReport(requestId);
    } catch (error) {
      showToast(`取消失败：${errorMessage(error)}`, false);
    }
  }
})()));

elements.reportOutput.addEventListener('input', () => {
  state.reportMarkdown = elements.reportOutput.value;
  if (elements.reportKind.textContent.startsWith('AI')) state.aiReportText = elements.reportOutput.value;
});

elements.copyReport.addEventListener('click', async () => {
  const content = elements.reportOutput.value;
  try {
    await navigator.clipboard.writeText(content);
    showToast('报告 Markdown 已复制', false);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = content;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    showToast('报告 Markdown 已复制', false);
  }
});

elements.saveReport.addEventListener('click', async () => {
  if (!state.report) return;
  const suggestedName = `${state.reportTitle.replace(/\s+/g, '-')}.md`;
  try {
    const result = await bridge.saveMarkdown({ suggestedName, content: elements.reportOutput.value });
    if (!result?.canceled) showToast('报告已保存', false);
  } catch (error) {
    showToast(`报告保存失败：${errorMessage(error)}`, false);
  }
});

elements.undoButton.addEventListener('click', undo);

document.addEventListener('keydown', (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  const editable = event.target.matches('input, textarea, select, [contenteditable="true"]');
  const nativeControl = Boolean(event.target.closest('button, input, textarea, select, a, [contenteditable="true"]'));
  if (modifier && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    if (['review', 'worklog', 'calendar', 'focus'].includes(state.view)) {
      state.view = 'inbox';
      state.selectedId = null;
      render();
    }
    elements.taskInput.focus();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    if (['review', 'worklog', 'calendar', 'focus'].includes(state.view)) state.view = 'all';
    render();
    elements.searchInput.focus();
    elements.searchInput.select();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'z' && !editable) {
    event.preventDefault();
    undo();
    return;
  }
  if (event.key === 'Escape' && state.selectedId) {
    const closingTaskId = state.selectedId;
    state.selectedId = null;
    render();
    requestAnimationFrame(() => document.querySelector(`[data-task-id="${CSS.escape(closingTaskId)}"]`)?.focus());
    return;
  }
  if (editable || nativeControl || ['review', 'worklog', 'calendar', 'focus'].includes(state.view)) return;
  const tasks = visibleTasks(activeTasks(), state.view, state.query, todayDate());
  const currentIndex = tasks.findIndex((task) => task.id === state.selectedId);
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && tasks.length) {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const fallback = delta > 0 ? 0 : tasks.length - 1;
    const nextIndex = currentIndex < 0 ? fallback : Math.max(0, Math.min(tasks.length - 1, currentIndex + delta));
    selectTask(tasks[nextIndex].id, true);
  } else if (event.key === ' ' && state.selectedId) {
    event.preventDefault();
    runAction(toggleTaskById(state.selectedId));
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
    event.preventDefault();
    runAction(deleteTaskById(state.selectedId));
  }
});

detailsOverlayQuery.addEventListener('change', renderDetails);

bridge.onFocusNewTask(() => {
  if (['review', 'worklog', 'calendar'].includes(state.view)) state.view = 'inbox';
  render();
  elements.taskInput.focus();
});

bridge.onFocusSearch(() => {
  if (['review', 'worklog', 'calendar'].includes(state.view)) state.view = 'all';
  render();
  elements.searchInput.focus();
  elements.searchInput.select();
});

bridge.onOpenDailyShutdown(() => {
  state.view = 'today';
  state.selectedId = null;
  state.query = '';
  elements.searchInput.value = '';
  render();
  requestAnimationFrame(openDailyShutdown);
});

bridge.onOpenFocus(() => {
  state.view = 'focus';
  state.query = '';
  elements.searchInput.value = '';
  render();
});

async function persistMissingArchives() {
  const finalized = Reporting.finalizeMissingArchives(state.store, todayDate(), { now: new Date().toISOString() });
  if (finalized.dailyArchives.length === state.store.dailyArchives.length) return;
  if (typeof bridge.persistArchives === 'function') {
    state.store = coerceStore(await bridge.persistArchives(finalized.dailyArchives));
  } else {
    state.store = finalized;
  }
}

async function handleDateBoundary() {
  if (!state.store) return;
  const currentDate = todayDate();
  if (!state.calendarDate) {
    state.calendarDate = currentDate;
    return;
  }
  if (currentDate === state.calendarDate) return;
  await flushDailyNote();
  await persistMissingArchives();
  state.calendarDate = currentDate;
  initializeReportControls();
  render();
}

function startDateBoundaryWatch() {
  clearInterval(dateCheckTimer);
  dateCheckTimer = setInterval(() => {
    handleDateBoundary().catch((error) => console.error('Unable to roll Daymark into a new day:', error));
  }, 30000);
}

function initializeReportControls() {
  const currentYear = Number(todayDate().slice(0, 4));
  const historyYear = Number(String(state.store.meta.historyStartAt).slice(0, 4)) || currentYear;
  const fragment = document.createDocumentFragment();
  for (let year = currentYear; year >= Math.min(historyYear, currentYear - 10); year -= 1) {
    const option = document.createElement('option');
    option.value = String(year);
    option.textContent = `${year} 年`;
    fragment.appendChild(option);
  }
  elements.reportYear.replaceChildren(fragment);
  elements.reportYear.value = String(currentYear);
  elements.reportQuarter.value = String(Math.floor((Number(todayDate().slice(5, 7)) - 1) / 3) + 1);
  updateQuarterAvailability();
  state.reviewMonth = todayDate().slice(0, 7);
  state.calendarMonth = state.reviewMonth;
  state.reviewSelectedDate = todayDate();
  elements.recordMonth.value = state.reviewMonth;
  elements.recordMonth.removeAttribute('max');
}

function updateQuarterAvailability() {
  const today = todayDate();
  const currentYear = Number(today.slice(0, 4));
  const currentQuarter = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  const selectedYear = Number(elements.reportYear.value || currentYear);
  [...elements.reportQuarter.options].forEach((option) => {
    option.disabled = selectedYear === currentYear && Number(option.value) > currentQuarter;
  });
  if (elements.reportQuarter.selectedOptions[0]?.disabled) {
    elements.reportQuarter.value = String(currentQuarter);
  }
}

async function bootstrap() {
  try {
    state.store = coerceStore(await bridge.load());
    state.calendarDate = todayDate();
    await resolveInterruptedFocusSessions();
    await persistMissingArchives();
    initializeReportControls();
    await loadAiSettings();
    setSaveState('saved');
  } catch (error) {
    console.error('Unable to load Daymark store:', error);
    setSaveState('error');
    showToast(errorMessage(error), false);
    state.store = sanitizeStore({ version: STORE_VERSION, meta: {}, tasks: [], events: [], dailyArchives: [] });
    initializeReportControls();
    await loadAiSettings();
  }
  render();
  if (bridgeUnavailable) {
    document.body.dataset.bridgeUnavailable = 'true';
    elements.saveStatus.textContent = '安全桥接未加载 · 已禁止写入';
    elements.statusDot.classList.add('is-error');
    elements.addForm.querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
    elements.dailyNoteInput.disabled = true;
    elements.saveReport.disabled = true;
    elements.generateAiReport.disabled = true;
    elements.saveAiKey.disabled = true;
    elements.aiActionNote.textContent = '应用安全组件未加载。请从正式桌面应用启动 Daymark。';
  }
  startDateBoundaryWatch();
  startFocusTicker();
}

window.addEventListener('focus', () => {
  handleDateBoundary().catch((error) => console.error('Unable to refresh Daymark date:', error));
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) handleDateBoundary().catch((error) => console.error('Unable to refresh Daymark date:', error));
});

bootstrap();
