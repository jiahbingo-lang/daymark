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
  const restDay = Calendar.chinaRestDay(date);
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
  elements.dayDetailHoliday.hidden = !holiday && !restDay;
  elements.dayDetailHoliday.textContent = holiday
    ? `${holiday.badge} · ${holiday.name}`
    : restDay ? restDay.name : '';
  elements.dayDetailHoliday.classList.toggle('is-makeup', holiday?.type === 'makeup');
  elements.dayDetailHoliday.classList.toggle('is-weekend', Boolean(restDay) && !holiday);
  elements.dayDetailScore.textContent = `完成 ${completed.length} · 计划 ${plannedCount} · 实际 ${Number(detail.summary?.actualMinutes) || 0} 分钟`;
  elements.dayDetailNote.textContent = detail.dailyNotes
    || (holiday ? `${holiday.name}${holiday.type === 'makeup' ? '，当天按调休工作日标注，不计入休息日。' : '，当天按法定假日标注。'}` : '')
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
  const weekendDays = calendar.cells.filter((cell) => cell.inCurrentMonth && cell.isOrdinaryWeekend);
  elements.holidaySourceNote.textContent = calendar.holidaySource
    ? `${calendar.holidaySource.label} · 本月 ${weekendDays.length} 个周末日，${specialDays.length} 天休假或调休`
    : `本月 ${weekendDays.length} 个周末日 · 该年份暂无内置官方节假日数据`;
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
    button.classList.toggle('is-weekend', cell.isOrdinaryWeekend);
    button.classList.toggle('is-holiday', cell.holiday?.type === 'holiday');
    button.classList.toggle('is-makeup', cell.holiday?.type === 'makeup');
    button.classList.toggle('has-schedule', cell.rangeCount > 0);
    const labelParts = [formatCalendarDate(cell.date)];
    if (cell.isOrdinaryWeekend) labelParts.push('周末');
    if (cell.holiday) labelParts.push(cell.holiday.name, cell.holiday.badge === '休' ? '休假' : '调休上班');
    if (cell.rangeCount) labelParts.push(`跨期任务 ${cell.rangeCount} 项`);
    if (cell.metrics.actualMinutes) labelParts.push(`实际投入 ${cell.metrics.actualMinutes} 分钟`);
    labelParts.push(`完成 ${cell.metrics.completedCount}，计划 ${cell.metrics.plannedCount}`);
    button.setAttribute('aria-label', labelParts.join('，'));

    const top = makeElement('span', 'calendar-day-top');
    top.appendChild(makeElement('span', 'day-number', String(cell.day)));
    const badges = makeElement('span', 'calendar-day-badges');
    if (cell.holiday) {
      badges.appendChild(makeElement('span', `day-badge${cell.holiday.type === 'makeup' ? ' is-makeup' : ''}`, cell.holiday.badge));
    }
    // Holidays and 调休 days already carry their own 休/班 badge; stacking a
    // second "周末" badge on a mandated workday would contradict it.
    if (cell.isOrdinaryWeekend) badges.appendChild(makeElement('span', 'day-badge is-weekend', '周末'));
    top.appendChild(badges);
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

function executionDateLabel(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function focusClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = String(Math.floor(value / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const remainder = String(value % 60).padStart(2, '0');
  return `${hours}:${minutes}:${remainder}`;
}

function updateFocusClock() {
  const entry = Execution.activeFocusEntry(state.store);
  if (!entry) return;
  elements.focusElapsed.textContent = focusClock(Execution.durationSeconds(entry, new Date()));
}

function renderFocusStrip() {
  const entry = Execution.activeFocusEntry(state.store);
  clearInterval(focusTicker);
  focusTicker = null;
  elements.focusStrip.hidden = !entry;
  if (!entry) return;
  const task = activeTasks().find((item) => item.id === entry.taskId && !item.deletedAt);
  elements.focusTaskTitle.textContent = task?.title || '已移除的任务';
  updateFocusClock();
  focusTicker = setInterval(updateFocusClock, 1000);
}

function renderExecutionBlock(block, schedule) {
  const task = block.task;
  const actual = Execution.actualMinutesForTask(state.store, task.id, { now: new Date() });
  const risk = Execution.riskForTask(state.store, task, { today: todayDate(), schedule: schedule.schedule });
  const top = Math.max(EXECUTION_DAY_START_MINUTE, block.startMinute);
  const available = Math.max(30, EXECUTION_DAY_END_MINUTE - top);
  const height = Math.min(available, Math.max(38, block.durationMinutes));
  const densityClass = block.durationMinutes <= 45 ? ' is-compact' : block.durationMinutes <= 75 ? ' is-short' : '';
  const article = makeElement('article', `execution-block is-${block.source}${densityClass}${risk?.risky ? ' is-risk' : ''}`);
  article.draggable = true;
  article.dataset.blockId = block.id;
  article.dataset.taskId = task.id;
  article.dataset.date = block.date;
  article.dataset.startMinute = String(block.startMinute);
  article.dataset.durationMinutes = String(block.durationMinutes);
  article.dataset.source = block.source;
  article.style.top = `${top}px`;
  article.style.height = `${height}px`;
  article.setAttribute('aria-label', `${task.title}，${Execution.formatMinute(block.startMinute)}，${block.durationMinutes} 分钟，${block.source === 'manual' ? '已锁定' : '自动安排'}`);

  const heading = makeElement('div', 'execution-block-heading');
  const time = makeElement('span', 'execution-block-time', `${Execution.formatMinute(block.startMinute)} · ${block.durationMinutes} 分`);
  const badges = makeElement('span', 'execution-block-badges');
  const blockRestDay = Calendar.chinaRestDay(block.date);
  if (blockRestDay) badges.appendChild(makeElement('b', 'execution-restday', blockRestDay.short));
  if (task.top3Date === block.date) badges.appendChild(makeElement('b', 'execution-top3', '★ Top3'));
  if (task.flagged) badges.appendChild(makeElement('b', 'execution-flag', '⚑'));
  if (risk?.risky) badges.appendChild(makeElement('b', 'execution-risk', '期限风险'));
  heading.append(time, badges);
  const title = makeElement('strong', 'execution-block-title', task.title);
  title.title = task.title;
  article.append(heading, title);
  const meta = makeElement('span', 'execution-block-meta', `${actual ? `实际 ${actual} 分 · ` : ''}${block.source === 'manual' ? '手动锁定' : '自动安排'}`);
  article.appendChild(meta);

  const actions = makeElement('div', 'execution-block-actions');
  const focus = makeElement('button', '', '专注');
  focus.type = 'button';
  focus.dataset.executionAction = 'focus';
  const manual = makeElement('button', '', '补录');
  manual.type = 'button';
  manual.dataset.executionAction = 'manual-time';
  actions.append(focus, manual);
  if (block.source === 'manual') {
    const unlock = makeElement('button', '', '撤销锁定');
    unlock.type = 'button';
    unlock.dataset.executionAction = 'unlock';
    actions.appendChild(unlock);
    const resize = makeElement('span', 'execution-resize-handle');
    resize.dataset.executionAction = 'resize';
    resize.title = '拖动调整时长';
    resize.setAttribute('aria-label', '拖动调整时长');
    article.appendChild(resize);
  }
  article.appendChild(actions);
  return article;
}

function renderExecution() {
  const date = state.executionDate || todayDate();
  state.executionDate = date;
  elements.executionDate.value = date;
  document.querySelectorAll('[data-execution-mode]').forEach((button) => {
    const active = button.dataset.executionMode === state.executionMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const schedule = Execution.buildExecutionSchedule(state.store, {
    date,
    mode: state.executionMode,
    today: todayDate(),
  });
  const totalMinutes = schedule.blocks.reduce((total, block) => total + block.durationMinutes, 0);
  const manualMinutes = schedule.blocks.filter((block) => block.source === 'manual')
    .reduce((total, block) => total + block.durationMinutes, 0);
  const risks = activeTasks().filter((task) => !task.deletedAt && task.status !== 'completed')
    .map((task) => Execution.riskForTask(state.store, task, { today: todayDate(), schedule: schedule.schedule }))
    .filter((risk) => risk?.risky);
  elements.executionSummary.replaceChildren(
    makeElement('span', '', `${schedule.blocks.length} 个时间块`),
    makeElement('span', '', `计划 ${totalMinutes} 分钟`),
    makeElement('span', '', `已锁定 ${manualMinutes} 分钟`),
    makeElement('span', risks.length ? 'is-risk' : '', risks.length ? `${risks.length} 项期限风险` : '期限容量正常'),
  );

  const fragment = document.createDocumentFragment();
  const timeRail = makeElement('div', 'execution-time-rail');
  timeRail.appendChild(makeElement('div', 'execution-time-rail-spacer'));
  for (let hour = 0; hour <= 24; hour += 1) {
    timeRail.appendChild(makeElement('span', '', `${String(hour).padStart(2, '0')}:00`));
  }
  fragment.appendChild(timeRail);
  schedule.dates.forEach((day) => {
    const column = makeElement('section', `execution-day${day === todayDate() ? ' is-today' : ''}`);
    column.dataset.executionDate = day;
    const holiday = Calendar.getChinaHoliday(day);
    const isOrdinaryWeekend = Calendar.isOrdinaryWeekend(day);
    const heading = makeElement('header', 'execution-day-header');
    heading.append(makeElement('strong', '', executionDateLabel(day)));
    if (isOrdinaryWeekend) heading.appendChild(makeElement('span', 'is-weekend', '周末'));
    if (holiday) heading.appendChild(makeElement('span', holiday.type === 'makeup' ? 'is-makeup' : 'is-holiday', `${holiday.badge} ${holiday.name}`));
    const dayMinutes = schedule.byDate[day].reduce((total, block) => total + block.durationMinutes, 0);
    heading.appendChild(makeElement('small', dayMinutes > schedule.dailyCapacityMinutes ? 'is-overload' : '', `${dayMinutes}/${schedule.dailyCapacityMinutes} 分`));
    const body = makeElement('div', 'execution-day-body');
    body.dataset.executionDate = day;
    for (let hour = 0; hour < 24; hour += 1) body.appendChild(makeElement('i', 'execution-hour-line'));
    schedule.byDate[day].forEach((block) => body.appendChild(renderExecutionBlock(block, schedule)));
    column.append(heading, body);
    fragment.appendChild(column);
  });
  elements.executionCalendar.classList.toggle('is-day-mode', state.executionMode === 'day');
  elements.executionCalendar.replaceChildren(fragment);
  if (!elements.executionCalendarScroll.dataset.initialized) {
    const earliestMinute = schedule.blocks.length
      ? Math.min(EXECUTION_DEFAULT_SCROLL_MINUTE, ...schedule.blocks.map((block) => block.startMinute))
      : EXECUTION_DEFAULT_SCROLL_MINUTE;
    elements.executionCalendarScroll.scrollTop = 53 + Math.max(0, earliestMinute - 60);
    elements.executionCalendarScroll.dataset.initialized = 'true';
  }
  renderFocusStrip();
}

async function moveExecutionBlock(block, date, startMinute) {
  const task = activeTasks().find((item) => item.id === block.taskId && !item.deletedAt);
  if (!task) return;
  const patch = {};
  if (!task.dueDate && date !== task.plannedDate) patch.plannedDate = date;
  else if (date < task.plannedDate) patch.plannedDate = date;
  if (task.dueDate && date > task.dueDate) patch.dueDate = date;
  if (Object.keys(patch).length && !(await patchTask(task.id, patch, { undo: false, message: '任务日期范围已随排程调整' }))) return;
  const blockId = block.source === 'manual' ? block.id : commandId('block');
  const undo = block.source === 'manual'
    ? {
        type: 'upsertScheduleBlock',
        taskId: task.id,
        payload: {
          blockId: block.id,
          date: block.date,
          startMinute: block.startMinute,
          durationMinutes: block.durationMinutes,
          locked: true,
        },
      }
    : { type: 'deleteScheduleBlock', taskId: task.id, payload: { blockId } };
  await dispatch({
    type: 'upsertScheduleBlock',
    taskId: task.id,
    payload: {
      blockId,
      date,
      startMinute,
      durationMinutes: block.durationMinutes,
      locked: true,
    },
  }, {
    undo,
    undoMessage: '已撤销手动排程',
    message: `已锁定到 ${executionDateLabel(date)} ${Execution.formatMinute(startMinute)}`,
  });
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

document.querySelector('.execution-mode').addEventListener('click', (event) => {
  const button = event.target.closest('[data-execution-mode]');
  if (!button) return;
  state.executionMode = button.dataset.executionMode;
  renderExecution();
  renderDebugState();
});

elements.executionDate.addEventListener('change', () => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(elements.executionDate.value)) return;
  state.executionDate = elements.executionDate.value;
  renderExecution();
});

elements.executionPrevious.addEventListener('click', () => {
  state.executionDate = addDays(state.executionDate || todayDate(), state.executionMode === 'day' ? -1 : -7);
  renderExecution();
});

elements.executionNext.addEventListener('click', () => {
  state.executionDate = addDays(state.executionDate || todayDate(), state.executionMode === 'day' ? 1 : 7);
  renderExecution();
});

elements.executionToday.addEventListener('click', () => {
  state.executionDate = todayDate();
  renderExecution();
});

elements.executionCalendar.addEventListener('dragstart', (event) => {
  const article = event.target.closest('.execution-block');
  if (!article || event.target.closest('.execution-resize-handle')) return;
  draggedExecutionBlock = {
    id: article.dataset.blockId,
    taskId: article.dataset.taskId,
    date: article.dataset.date,
    startMinute: Number(article.dataset.startMinute),
    durationMinutes: Number(article.dataset.durationMinutes),
    source: article.dataset.source,
  };
  article.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', article.dataset.blockId);
});

elements.executionCalendar.addEventListener('dragend', (event) => {
  event.target.closest('.execution-block')?.classList.remove('is-dragging');
  draggedExecutionBlock = null;
  elements.executionCalendar.querySelectorAll('.is-drop-target').forEach((item) => item.classList.remove('is-drop-target'));
});

elements.executionCalendar.addEventListener('dragover', (event) => {
  const body = event.target.closest('.execution-day-body');
  if (!body || !draggedExecutionBlock) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  elements.executionCalendar.querySelectorAll('.is-drop-target').forEach((item) => item.classList.toggle('is-drop-target', item === body));
});

elements.executionCalendar.addEventListener('drop', (event) => {
  const body = event.target.closest('.execution-day-body');
  if (!body || !draggedExecutionBlock) return;
  event.preventDefault();
  const rect = body.getBoundingClientRect();
  const raw = Math.round((event.clientY - rect.top) / 15) * 15;
  const startMinute = Math.max(EXECUTION_DAY_START_MINUTE, Math.min(EXECUTION_DAY_END_MINUTE - draggedExecutionBlock.durationMinutes, raw));
  const block = { ...draggedExecutionBlock };
  draggedExecutionBlock = null;
  runAction(moveExecutionBlock(block, body.dataset.executionDate, startMinute));
});

elements.executionCalendar.addEventListener('click', (event) => {
  const article = event.target.closest('.execution-block');
  if (!article) return;
  const action = event.target.closest('[data-execution-action]')?.dataset.executionAction;
  const taskId = article.dataset.taskId;
  if (action === 'focus') {
    runAction(dispatch({ type: 'startFocus', taskId, payload: { entryId: commandId('time') } }, { message: '已开始专注计时' }));
  } else if (action === 'manual-time') {
    openManualTime(taskId, article.dataset.date);
  } else if (action === 'unlock') {
    const blockId = article.dataset.blockId;
    runAction(dispatch({ type: 'deleteScheduleBlock', taskId, payload: { blockId } }, {
      message: '已撤销锁定，任务将重新自动安排',
    }));
  }
});

elements.executionCalendar.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('.execution-resize-handle');
  const article = event.target.closest('.execution-block');
  if (!handle || !article) return;
  event.preventDefault();
  article.draggable = false;
  resizingExecutionBlock = {
    article,
    pointerId: event.pointerId,
    startY: event.clientY,
    initialDuration: Number(article.dataset.durationMinutes),
    id: article.dataset.blockId,
    taskId: article.dataset.taskId,
    date: article.dataset.date,
    startMinute: Number(article.dataset.startMinute),
  };
  handle.setPointerCapture?.(event.pointerId);
  article.classList.add('is-resizing');
});

elements.executionCalendar.addEventListener('pointerdown', (event) => {
  const article = event.target.closest('.execution-block');
  if (!article || event.target.closest('button, .execution-resize-handle')) return;
  event.preventDefault();
  article.draggable = false;
  article.setPointerCapture?.(event.pointerId);
  pointerDraggingExecutionBlock = {
    article,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    startScrollTop: elements.executionCalendarScroll.scrollTop,
    moved: false,
    id: article.dataset.blockId,
    taskId: article.dataset.taskId,
    date: article.dataset.date,
    startMinute: Number(article.dataset.startMinute),
    durationMinutes: Number(article.dataset.durationMinutes),
    source: article.dataset.source,
  };
});

function stopExecutionAutoScroll() {
  executionAutoScrollVelocity = 0;
  if (executionAutoScrollFrame !== null) cancelAnimationFrame(executionAutoScrollFrame);
  executionAutoScrollFrame = null;
}

function renderPointerDragTransform(drag) {
  const scrollDelta = elements.executionCalendarScroll.scrollTop - drag.startScrollTop;
  drag.article.style.transform = `translate(${drag.lastX - drag.startX}px, ${drag.lastY - drag.startY + scrollDelta}px)`;
}

function runExecutionAutoScroll() {
  const drag = pointerDraggingExecutionBlock;
  if (!drag || !executionAutoScrollVelocity) {
    stopExecutionAutoScroll();
    return;
  }
  const before = elements.executionCalendarScroll.scrollTop;
  elements.executionCalendarScroll.scrollTop += executionAutoScrollVelocity;
  if (elements.executionCalendarScroll.scrollTop === before) {
    stopExecutionAutoScroll();
    return;
  }
  renderPointerDragTransform(drag);
  executionAutoScrollFrame = requestAnimationFrame(runExecutionAutoScroll);
}

function updateExecutionAutoScroll(clientY) {
  const rect = elements.executionCalendarScroll.getBoundingClientRect();
  const edge = Math.min(72, rect.height / 4);
  let velocity = 0;
  if (clientY < rect.top + edge) velocity = -Math.min(18, Math.max(4, Math.ceil((rect.top + edge - clientY) / 4)));
  if (clientY > rect.bottom - edge) velocity = Math.min(18, Math.max(4, Math.ceil((clientY - (rect.bottom - edge)) / 4)));
  executionAutoScrollVelocity = velocity;
  if (!velocity) {
    stopExecutionAutoScroll();
  } else if (executionAutoScrollFrame === null) {
    executionAutoScrollFrame = requestAnimationFrame(runExecutionAutoScroll);
  }
}

document.addEventListener('pointermove', (event) => {
  const drag = pointerDraggingExecutionBlock;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  const x = event.clientX - drag.startX;
  const y = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(x, y) < 5) return;
  drag.moved = true;
  drag.article.classList.add('is-dragging');
  renderPointerDragTransform(drag);
  updateExecutionAutoScroll(event.clientY);
});

document.addEventListener('pointerup', (event) => {
  const drag = pointerDraggingExecutionBlock;
  if (!drag || event.pointerId !== drag.pointerId) return;
  stopExecutionAutoScroll();
  pointerDraggingExecutionBlock = null;
  drag.article.draggable = true;
  drag.article.classList.remove('is-dragging');
  drag.article.style.transform = '';
  if (!drag.moved) return;
  const body = document.elementFromPoint(event.clientX, event.clientY)?.closest('.execution-day-body');
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const raw = Math.round((event.clientY - rect.top) / 15) * 15;
  const startMinute = Math.max(EXECUTION_DAY_START_MINUTE, Math.min(EXECUTION_DAY_END_MINUTE - drag.durationMinutes, raw));
  runAction(moveExecutionBlock(drag, body.dataset.executionDate, startMinute));
});

document.addEventListener('pointermove', (event) => {
  if (!resizingExecutionBlock) return;
  const delta = Math.round((event.clientY - resizingExecutionBlock.startY) / 15) * 15;
  const max = EXECUTION_DAY_END_MINUTE - resizingExecutionBlock.startMinute;
  const duration = Math.max(15, Math.min(max, resizingExecutionBlock.initialDuration + delta));
  resizingExecutionBlock.nextDuration = duration;
  resizingExecutionBlock.article.style.height = `${Math.max(38, duration)}px`;
  resizingExecutionBlock.article.querySelector('.execution-block-time').textContent = `${Execution.formatMinute(resizingExecutionBlock.startMinute)} · ${duration} 分`;
});

document.addEventListener('pointerup', (event) => {
  if (!resizingExecutionBlock || event.pointerId !== resizingExecutionBlock.pointerId) return;
  const resize = resizingExecutionBlock;
  resizingExecutionBlock = null;
  resize.article.draggable = true;
  resize.article.classList.remove('is-resizing');
  const durationMinutes = resize.nextDuration || resize.initialDuration;
  if (durationMinutes === resize.initialDuration) return;
  runAction(dispatch({
    type: 'upsertScheduleBlock',
    taskId: resize.taskId,
    payload: {
      blockId: resize.id,
      date: resize.date,
      startMinute: resize.startMinute,
      durationMinutes,
      locked: true,
    },
  }, {
    undo: {
      type: 'upsertScheduleBlock',
      taskId: resize.taskId,
      payload: {
        blockId: resize.id,
        date: resize.date,
        startMinute: resize.startMinute,
        durationMinutes: resize.initialDuration,
        locked: true,
      },
    },
    undoMessage: '已恢复原排程时长',
    message: `排程时长已调整为 ${durationMinutes} 分钟`,
  }));
});

elements.stopFocus.addEventListener('click', () => {
  const entry = Execution.activeFocusEntry(state.store);
  if (entry) runAction(dispatch({ type: 'stopFocus', taskId: entry.taskId, payload: { entryId: entry.id } }, { message: '专注计时已暂停' }));
});

elements.completeFocus.addEventListener('click', () => runAction((async () => {
  const entry = Execution.activeFocusEntry(state.store);
  if (!entry) return;
  await dispatch({ type: 'stopFocus', taskId: entry.taskId, payload: { entryId: entry.id } });
  await toggleTaskById(entry.taskId);
})()));

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
    model: String(candidate.model || state.aiSettings.model || DEFAULT_AI_MODEL),
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
    elements.aiModel.placeholder = DEFAULT_AI_MODEL;
    elements.aiModel.value = state.aiSettings.model || DEFAULT_AI_MODEL;
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
    model: elements.aiModel.value.trim() || DEFAULT_AI_MODEL,
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

window.addEventListener('focus', () => {
  handleDateBoundary().catch((error) => console.error('Unable to refresh Daymark date:', error));
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) handleDateBoundary().catch((error) => console.error('Unable to refresh Daymark date:', error));
});

bootstrap();
