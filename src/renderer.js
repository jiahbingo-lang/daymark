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
} = window.TodoDomain;

const Reporting = window.DaymarkReporting;
const Calendar = window.DaymarkCalendar;
const Planning = window.DaymarkPlanning;
const Execution = window.DaymarkExecution;
const DailyPlanning = window.DaymarkDailyPlanning;
const AiReport = window.DaymarkAiReport;
const DAYMARK_TIME_ZONE = 'Asia/Shanghai';
const EXECUTION_DAY_START_MINUTE = 0;
const EXECUTION_DAY_END_MINUTE = 1440;
const EXECUTION_DEFAULT_SCROLL_MINUTE = 480;

function commandId(prefix = 'event') {
  if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// The model shown before the main process reports saved AI settings. This is
// the renderer's only copy of the default, so it cannot drift away from
// DEFAULT_MODEL in src/ai-service.js.
const DEFAULT_AI_MODEL = 'gpt-5.6-terra';

let previewStore;
let previewAiSettings = {
  model: DEFAULT_AI_MODEL,
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
  execution: {
    title: '执行日历',
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
  executionMode: 'week',
  executionDate: null,
  history: [],
  report: null,
  reportMarkdown: '',
  reportTitle: '',
  reportPeriodKey: '',
  reportSource: null,
  aiSettings: {
    model: DEFAULT_AI_MODEL,
    hasKey: false,
    keySource: 'none',
    includeDailyNotes: false,
    includeCompletionNotes: true,
  },
  aiRequestId: null,
  aiReportText: '',
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
  executionWorkspace: $('#execution-workspace'),
  executionDate: $('#execution-date'),
  executionPrevious: $('#execution-previous'),
  executionNext: $('#execution-next'),
  executionToday: $('#execution-today'),
  executionSummary: $('#execution-summary'),
  executionCalendar: $('#execution-calendar'),
  executionCalendarScroll: $('#execution-calendar-scroll'),
  focusStrip: $('#focus-strip'),
  focusTaskTitle: $('#focus-task-title'),
  focusElapsed: $('#focus-elapsed'),
  stopFocus: $('#stop-focus'),
  completeFocus: $('#complete-focus'),
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
};

let commandChain = Promise.resolve();
let toastTimer;
let noteTimer;
let dateCheckTimer;
let focusTicker;
let pendingDailyNote = null;
let draggedExecutionBlock = null;
let resizingExecutionBlock = null;
let pointerDraggingExecutionBlock = null;
let executionAutoScrollFrame = null;
let executionAutoScrollVelocity = 0;
const fieldTimers = new Map();
const pendingTaskActions = new Set();
const detailsOverlayQuery = window.matchMedia('(max-width: 1030px)');

function activeTasks() {
  return state.store?.tasks || [];
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
  if (text.includes('focus session is already running')) return '请先暂停当前专注任务';
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
  const specialView = state.view === 'review' || state.view === 'execution';
  const count = specialView ? 0 : visibleTasks(activeTasks(), state.view, '', todayDate()).length;
  elements.dateLabel.textContent = formatHeaderDate();
  elements.viewTitle.textContent = copy.title;
  elements.searchBox.hidden = specialView;
  if (state.view === 'review') {
    elements.viewSummary.textContent = '每日记录自动沉淀，报告默认在本机生成';
  } else if (state.view === 'execution') {
    elements.viewSummary.textContent = '自动安排可拖动锁定，实际用时会进入工作总结';
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
  // Keyed off the statutory calendar, not the raw day of week: a 调休 Saturday
  // is a mandated workday and must not be labelled as time off, while a midweek
  // statutory holiday must be.
  const restDay = task.plannedDate ? Calendar.chinaRestDay(task.plannedDate) : null;
  const top3Label = task.top3Date === todayDate()
    ? '★ 今日 Top 3'
    : `★ ${formatShortDate(task.top3Date)} Top 3`;
  const row = document.createElement('article');
  row.className = 'task-row';
  row.classList.toggle('is-selected', task.id === state.selectedId);
  row.classList.toggle('is-completed', task.status === 'completed');
  row.classList.toggle('is-top3', showTop3);
  row.classList.toggle('is-flagged', Boolean(task.flagged));
  row.classList.toggle('is-restday-plan', Boolean(restDay));
  row.dataset.taskId = task.id;
  row.setAttribute('role', 'listitem');
  row.setAttribute('tabindex', task.id === state.selectedId ? '0' : '-1');
  row.setAttribute('aria-label', `${task.title}${showTop3 ? `，${top3Label.slice(2)}` : ''}${task.flagged ? '，已加旗标' : ''}${restDay ? `，${restDay.label}` : ''}`);

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
  if (restDay) appendMeta(meta, restDay.label, 'restday-pill');
  if (task.plannedDate) appendMeta(meta, `计划 ${formatShortDate(task.plannedDate)}`, 'planned-pill');
  if (task.dueDate) {
    const deadline = appendMeta(meta, `截止 ${formatShortDate(task.dueDate)}`, 'deadline-pill');
    deadline.classList.toggle('is-overdue', task.status === 'active' && task.dueDate < todayDate());
  }
  if (task.estimateMinutes) appendMeta(meta, `${task.estimateMinutes} 分钟`, 'estimate-pill');
  const actualMinutes = Execution.actualMinutesForTask(state.store, task.id, { now: new Date() });
  if (actualMinutes) appendMeta(meta, `实际 ${actualMinutes} 分钟`, 'actual-pill');
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

  row.append(checkbox, main, flag, priorityMark, remove);
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
  const task = state.view === 'review' ? null : selectedTask();
  // The overlay only covers a 320px strip on the right, so it is not a modal.
  // Marking the sidebar and the list inert froze the whole window behind it:
  // clicks stopped hit-testing onto them and the add-form's focus() call became
  // a silent no-op, leaving the × as the only way out. Keep the background live.
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

function renderDebugState() {
  const visible = ['review', 'execution'].includes(state.view) ? [] : visibleTasks(activeTasks(), state.view, state.query, todayDate());
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
  };
  elements.debugState.textContent = JSON.stringify(payload);
  document.body.dataset.appReady = String(Boolean(state.store));
  document.body.dataset.currentView = state.view;
}

function render() {
  if (!state.store) return;
  const reviewing = state.view === 'review';
  const executing = state.view === 'execution';
  elements.shell.classList.toggle('is-reviewing', reviewing || executing);
  elements.taskWorkspace.hidden = reviewing || executing;
  elements.executionWorkspace.hidden = !executing;
  elements.reviewWorkspace.hidden = !reviewing;
  renderSidebar();
  renderHeader();
  if (reviewing) renderReview();
  else if (executing) renderExecution();
  else renderTaskList();
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

function closeDetailsPanel() {
  const closingTaskId = state.selectedId;
  if (!closingTaskId) return;
  state.selectedId = null;
  render();
  requestAnimationFrame(() => {
    document.querySelector(`[data-task-id="${CSS.escape(closingTaskId)}"]`)?.focus();
  });
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

elements.closeDetails.addEventListener('click', closeDetailsPanel);

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

elements.undoButton.addEventListener('click', undo);

document.addEventListener('keydown', (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  const editable = event.target.matches('input, textarea, select, [contenteditable="true"]');
  const nativeControl = Boolean(event.target.closest('button, input, textarea, select, a, [contenteditable="true"]'));
  if (modifier && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    if (['review', 'execution'].includes(state.view)) {
      state.view = 'inbox';
      state.selectedId = null;
      render();
    }
    elements.taskInput.focus();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    if (['review', 'execution'].includes(state.view)) state.view = 'all';
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
    closeDetailsPanel();
    return;
  }
  if (editable || nativeControl || ['review', 'execution'].includes(state.view)) return;
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
  if (['review', 'execution'].includes(state.view)) state.view = 'inbox';
  render();
  elements.taskInput.focus();
});

bridge.onFocusSearch(() => {
  if (['review', 'execution'].includes(state.view)) state.view = 'all';
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
}
