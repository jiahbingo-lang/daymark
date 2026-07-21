(function exposeDomain(global) {
  const STORE_VERSION = 5;
  const PRIORITIES = ['none', 'low', 'medium', 'high'];
  const VIEWS = ['all', 'inbox', 'today', 'upcoming', 'completed'];
  const FOCUS_SESSION_STATUSES = ['running', 'completed', 'abandoned'];
  const TIME_ENTRY_SOURCES = ['focus', 'manual', 'pomodoro'];
  const FOCUS_MIN_MINUTES = 5;
  const FOCUS_MAX_MINUTES = 180;
  const DEFAULT_FOCUS_SETTINGS = Object.freeze({
    defaultMinutes: 25,
    strictMode: true,
    completionNotification: true,
    dailyGoalMinutes: 120,
  });
  const TASK_PATCH_FIELDS = [
    'title',
    'notes',
    'dueDate',
    'priority',
    'plannedDate',
    'top3Date',
    'flagged',
    'estimateMinutes',
    'area',
    'completionNote',
    'repeatRule',
    'reminderAt',
    'reminderFiredAt',
    'sourceUrl',
  ];
  const DEFAULT_DAILY_CAPACITY_MINUTES = 480;
  const DEFAULT_END_OF_DAY_REMINDER_TIME = '17:30';

  function normalizeClockTime(value, fallback = DEFAULT_END_OF_DAY_REMINDER_TIME) {
    const candidate = String(value || '');
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(candidate) ? candidate : fallback;
  }

  function toDate(value, fallback = new Date()) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (value !== undefined && value !== null) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return fallback instanceof Date && !Number.isNaN(fallback.getTime()) ? fallback : new Date();
  }

  function isoNow(now = new Date()) {
    return toDate(now).toISOString();
  }

  function normalizeIso(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
  }

  function localDate(now = new Date()) {
    const date = toDate(now);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function defaultTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  function normalizeTimeZone(value, fallback = defaultTimeZone()) {
    const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    try {
      new Intl.DateTimeFormat('en', { timeZone: candidate }).format(new Date());
      return candidate;
    } catch {
      return fallback === candidate ? 'UTC' : normalizeTimeZone(fallback, 'UTC');
    }
  }

  function dateInTimeZone(now = new Date(), timeZone = defaultTimeZone()) {
    const date = toDate(now);
    const safeTimeZone = normalizeTimeZone(timeZone);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function normalizeDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
      ? value
      : null;
  }

  function normalizeTitle(value) {
    return String(value ?? '').trim().slice(0, 200);
  }

  function normalizeText(value, limit, fallback = '') {
    if (value === null || value === undefined) return fallback;
    return String(value).slice(0, limit);
  }

  function normalizeOptionalText(value, limit) {
    const text = normalizeText(value, limit).trim();
    return text || null;
  }

  function normalizeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  function jsonClone(value, fallback = null) {
    if (value === undefined) return fallback;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }

  function normalizeRepeatRule(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') {
      const text = value.trim().slice(0, 500);
      return !text || text === 'none' ? null : text;
    }
    if (typeof value === 'object' && !Array.isArray(value)) return jsonClone(value, null);
    return null;
  }

  function makeId(prefix = 'task') {
    if (global.crypto?.randomUUID) return `${prefix}-${global.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function sanitizeTask(input, options = {}) {
    if (!input || typeof input !== 'object') return null;
    const title = normalizeTitle(input.title);
    if (!title) return null;

    const fallbackTimestamp = isoNow(options.now);
    const status = input.status === 'completed' ? 'completed' : 'active';
    const createdAt = normalizeIso(input.createdAt, fallbackTimestamp);
    const updatedAt = normalizeIso(input.updatedAt, createdAt);
    const plannedDate = normalizeDate(input.plannedDate);
    const candidateTop3Date = normalizeDate(input.top3Date);
    const top3Date = plannedDate && candidateTop3Date === plannedDate ? candidateTop3Date : null;
    const deletedAt = normalizeIso(input.deletedAt, null);

    return {
      id: typeof input.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 120) : makeId(),
      title,
      notes: normalizeText(input.notes, 2000),
      status,
      dueDate: normalizeDate(input.dueDate),
      priority: PRIORITIES.includes(input.priority) ? input.priority : 'none',
      plannedDate,
      top3Date,
      flagged: Boolean(input.flagged),
      estimateMinutes: normalizeInteger(input.estimateMinutes, { min: 1, max: 1440, fallback: null }),
      area: normalizeText(input.area, 100),
      completionNote: normalizeText(input.completionNote, 2000),
      repeatRule: normalizeRepeatRule(input.repeatRule),
      reminderAt: normalizeIso(input.reminderAt, null),
      reminderFiredAt: normalizeIso(input.reminderFiredAt, null),
      sourceUrl: normalizeOptionalText(input.sourceUrl, 2048),
      revision: normalizeInteger(input.revision, { min: 1, fallback: 1 }),
      createdAt,
      updatedAt,
      completedAt:
        status === 'completed' ? normalizeIso(input.completedAt, updatedAt) : null,
      deletedAt,
    };
  }

  function createTask(title, options = {}) {
    const normalizedTitle = normalizeTitle(title);
    if (!normalizedTitle) return null;

    const timestamp = isoNow(options.now);
    return sanitizeTask(
      {
        ...options,
        id: options.id || makeId(),
        title: normalizedTitle,
        status: options.status === 'completed' ? 'completed' : 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: options.status === 'completed' ? options.completedAt || timestamp : null,
        revision: 1,
        deletedAt: options.deletedAt || null,
      },
      { now: options.now },
    );
  }

  function sanitizeDailyNotes(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    Object.entries(value).forEach(([date, note]) => {
      const safeDate = normalizeDate(date);
      if (safeDate) result[safeDate] = normalizeText(note, 10000);
    });
    return result;
  }

  function sanitizeFocusSettings(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      defaultMinutes: normalizeInteger(source.defaultMinutes, {
        min: FOCUS_MIN_MINUTES,
        max: FOCUS_MAX_MINUTES,
        fallback: DEFAULT_FOCUS_SETTINGS.defaultMinutes,
      }),
      strictMode: source.strictMode !== false,
      completionNotification: source.completionNotification !== false,
      dailyGoalMinutes: normalizeInteger(source.dailyGoalMinutes, {
        min: 0,
        max: 1440,
        fallback: DEFAULT_FOCUS_SETTINGS.dailyGoalMinutes,
      }),
    };
  }

  function sanitizeFocusSession(input) {
    if (!input || typeof input !== 'object') return null;
    const id = normalizeOptionalText(input.id, 120);
    const startedAt = normalizeIso(input.startedAt, null);
    const reportingDate = normalizeDate(input.reportingDate);
    const plannedMinutes = normalizeInteger(input.plannedMinutes, {
      min: FOCUS_MIN_MINUTES,
      max: FOCUS_MAX_MINUTES,
      fallback: null,
    });
    const status = FOCUS_SESSION_STATUSES.includes(input.status) ? input.status : null;
    if (!id || !startedAt || !reportingDate || !plannedMinutes || !status) return null;
    const running = status === 'running';
    return {
      id,
      taskId: normalizeOptionalText(input.taskId, 120),
      plannedMinutes,
      startedAt,
      endedAt: running ? null : normalizeIso(input.endedAt, startedAt),
      status,
      focusedMinutes: running
        ? 0
        : normalizeInteger(input.focusedMinutes, { min: 0, max: plannedMinutes, fallback: 0 }),
      pausedAt: running ? normalizeIso(input.pausedAt, null) : null,
      pausedMs: normalizeInteger(input.pausedMs, { min: 0, max: 86_400_000, fallback: 0 }),
      reportingDate,
    };
  }

  function sanitizeFocusSessions(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value
      .map(sanitizeFocusSession)
      .filter((session) => {
        if (!session || seen.has(session.id)) return false;
        seen.add(session.id);
        return true;
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }

  // The pomodoro timer and the stopwatch both measure wall-clock focus time, so
  // letting them run together would count the same minutes twice. A running
  // pomodoro has no time entry until it completes, and the stopwatch keeps no
  // focus session, so neither can see the other through its own records.
  function assertNoFocusInProgress(store) {
    if (store.focusSessions.some((session) => session.status === 'running')) {
      throw new Error('A focus session is already running');
    }
    if (store.timeEntries.some((entry) => !entry.endedAt)) {
      throw new Error('A focus session is already running');
    }
  }

  function focusSessionEnd(session) {
    const started = new Date(session.startedAt).getTime();
    return started + session.plannedMinutes * 60_000 + (Number(session.pausedMs) || 0);
  }

  function elapsedFocusMinutes(session, at) {
    const started = new Date(session.startedAt).getTime();
    const reference = session.pausedAt ? new Date(session.pausedAt).getTime() : toDate(at).getTime();
    const activeMs = reference - started - (Number(session.pausedMs) || 0);
    return Math.max(0, Math.min(session.plannedMinutes, Math.floor(activeMs / 60_000)));
  }

  function sanitizeTaskIdList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
      .map((item) => normalizeOptionalText(item, 120))
      .filter(Boolean))]
      .slice(0, 200);
  }

  function emptyDailyPlan(date) {
    return {
      date,
      planningStartedAt: null,
      planningCompletedAt: null,
      shutdownCompletedAt: null,
      shutdownNote: '',
      blockerNote: '',
      tomorrowFocus: '',
      blockedTaskIds: [],
    };
  }

  function sanitizeDailyPlan(input, date) {
    const safeDate = normalizeDate(date || input?.date);
    if (!safeDate) return null;
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      date: safeDate,
      planningStartedAt: normalizeIso(source.planningStartedAt, null),
      planningCompletedAt: normalizeIso(source.planningCompletedAt, null),
      shutdownCompletedAt: normalizeIso(source.shutdownCompletedAt, null),
      shutdownNote: normalizeText(source.shutdownNote, 10000),
      blockerNote: normalizeText(source.blockerNote, 5000),
      tomorrowFocus: normalizeText(source.tomorrowFocus, 2000),
      blockedTaskIds: sanitizeTaskIdList(source.blockedTaskIds),
    };
  }

  function sanitizeDailyPlans(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    Object.entries(value).forEach(([date, plan]) => {
      const safePlan = sanitizeDailyPlan(plan, date);
      if (safePlan) result[safePlan.date] = safePlan;
    });
    return result;
  }

  function sanitizeScheduleBlock(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const id = normalizeOptionalText(input.id, 120);
    const taskId = normalizeOptionalText(input.taskId, 120);
    const date = normalizeDate(input.date);
    const startMinute = normalizeInteger(input.startMinute, { min: 0, max: 1435, fallback: null });
    const requestedDuration = normalizeInteger(input.durationMinutes, { min: 5, max: 720, fallback: null });
    if (!id || !taskId || !date || startMinute === null || requestedDuration === null) return null;
    const durationMinutes = Math.min(requestedDuration, 1440 - startMinute);
    const fallbackTimestamp = isoNow(options.now);
    const createdAt = normalizeIso(input.createdAt, fallbackTimestamp);
    return {
      id,
      taskId,
      date,
      startMinute,
      durationMinutes,
      source: input.source === 'auto' ? 'auto' : 'manual',
      locked: input.locked !== false,
      createdAt,
      updatedAt: normalizeIso(input.updatedAt, createdAt),
    };
  }

  function sanitizeScheduleBlocks(value, options = {}) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value
      .map((block) => sanitizeScheduleBlock(block, options))
      .filter((block) => {
        if (!block || seen.has(block.id)) return false;
        seen.add(block.id);
        return true;
      })
      .slice(0, 20_000);
  }

  function sanitizeTimeEntry(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const id = normalizeOptionalText(input.id, 120);
    const taskId = normalizeOptionalText(input.taskId, 120);
    const startedAt = normalizeIso(input.startedAt, null);
    // taskId is optional because a pomodoro may run unattached to any task.
    // Stopwatch and manual entries still resolve their task before getting here.
    if (!id || !startedAt) return null;
    const endedAt = normalizeIso(input.endedAt, null);
    const calculatedSeconds = endedAt
      ? Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000))
      : 0;
    const durationSeconds = normalizeInteger(input.durationSeconds, {
      min: 0,
      max: 31_536_000,
      fallback: calculatedSeconds,
    });
    const timeZone = normalizeTimeZone(options.timeZone);
    return {
      id,
      taskId,
      startedAt,
      endedAt,
      durationSeconds,
      reportingDate: normalizeDate(input.reportingDate) || dateInTimeZone(startedAt, timeZone),
      source: TIME_ENTRY_SOURCES.includes(input.source) ? input.source : 'focus',
      note: normalizeText(input.note, 1000),
    };
  }

  // Minutes that the zone is ahead of UTC at a given instant. Two passes so a
  // DST boundary near the guess still resolves to the right offset.
  function zoneOffsetMinutes(instant, timeZone) {
    const read = (at) => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: normalizeTimeZone(timeZone),
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).formatToParts(at);
      const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const asUtc = Date.UTC(
        Number(value.year),
        Number(value.month) - 1,
        Number(value.day),
        Number(value.hour) % 24,
        Number(value.minute),
        Number(value.second),
      );
      return Math.round((asUtc - at.getTime()) / 60_000);
    };
    const first = read(instant);
    return read(new Date(instant.getTime() - first * 60_000));
  }

  // The instant at which the given local date begins.
  function zonedDayStart(date, timeZone) {
    const guess = new Date(`${date}T00:00:00.000Z`);
    return new Date(guess.getTime() - zoneOffsetMinutes(guess, timeZone) * 60_000);
  }

  // Midnight closing the day a time entry belongs to.
  function timeEntryDayEnd(entry, timeZone) {
    const started = toDate(entry?.startedAt);
    const date = normalizeDate(entry?.reportingDate) || dateInTimeZone(started, timeZone);
    return zonedDayStart(addDays(date, 1), timeZone).toISOString();
  }

  // Closing a run never crosses midnight: a timer left going overnight is cut
  // at the end of the day it belongs to rather than logging the small hours as
  // work. Both stopping and completing go through here so they agree.
  function closeTimeEntry(entry, at, timeZone) {
    const started = toDate(entry.startedAt);
    const boundary = new Date(timeEntryDayEnd(entry, timeZone));
    const requested = toDate(at);
    const ended = requested.getTime() > boundary.getTime() ? boundary : requested;
    return sanitizeTimeEntry({
      ...entry,
      endedAt: ended.toISOString(),
      durationSeconds: Math.max(1, Math.round((ended.getTime() - started.getTime()) / 1000)),
    }, { timeZone });
  }

  function sanitizeTimeEntries(value, options = {}) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value
      .map((entry) => sanitizeTimeEntry(entry, options))
      .filter((entry) => {
        if (!entry || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      })
      .slice(0, 100_000);
  }

  function sanitizeEvent(input) {
    if (!input || typeof input !== 'object') return null;
    const eventId = normalizeOptionalText(input.eventId, 180);
    const type = normalizeOptionalText(input.type, 80);
    const occurredAt = normalizeIso(input.occurredAt, null);
    const reportingDate = normalizeDate(input.reportingDate);
    const seq = normalizeInteger(input.seq, { min: 1, fallback: null });
    if (!eventId || !type || !occurredAt || !reportingDate || !seq) return null;
    return {
      eventId,
      seq,
      taskId: normalizeOptionalText(input.taskId, 120),
      type,
      occurredAt,
      reportingDate,
      timeZone: normalizeTimeZone(input.timeZone),
      before: jsonClone(input.before, null),
      after: jsonClone(input.after, null),
    };
  }

  function sanitizeArchives(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((archive) => (archive && typeof archive === 'object' ? jsonClone(archive, null) : null))
      .filter(Boolean);
  }

  function migrateV1(input, options = {}) {
    const migrationDate = toDate(options.now);
    const occurredAt = migrationDate.toISOString();
    const timeZone = normalizeTimeZone(options.timeZone);
    const reportingDate = dateInTimeZone(migrationDate, timeZone);
    const tasks = (Array.isArray(input?.tasks) ? input.tasks : [])
      .map((task) => sanitizeTask(task, { now: migrationDate }))
      .filter(Boolean);
    const events = tasks.map((task, index) => ({
      eventId: `v1-baseline-${index + 1}-${task.id}`.slice(0, 180),
      seq: index + 1,
      taskId: task.id,
      type: 'baseline_imported',
      occurredAt,
      reportingDate,
      timeZone,
      before: null,
      after: jsonClone(task),
    }));

    return {
      version: STORE_VERSION,
      meta: {
        historyStartAt: occurredAt,
        timeZone,
        nextSeq: events.length + 1,
        dailyCapacityMinutes: DEFAULT_DAILY_CAPACITY_MINUTES,
        endOfDayReminderEnabled: true,
        endOfDayReminderTime: DEFAULT_END_OF_DAY_REMINDER_TIME,
        endOfDayReminderLastDate: null,
        dailyNotes: {},
        focusSettings: sanitizeFocusSettings(null),
        dailyPlans: {},
      },
      tasks,
      events,
      dailyArchives: [],
      focusSessions: [],
      scheduleBlocks: [],
      timeEntries: [],
    };
  }

  function sanitizeV2(input, options = {}) {
    const fallbackDate = toDate(options.now);
    const metaInput = input?.meta && typeof input.meta === 'object' ? input.meta : {};
    const timeZone = normalizeTimeZone(metaInput.timeZone || options.timeZone);
    const historyStartAt = normalizeIso(metaInput.historyStartAt, fallbackDate.toISOString());
    const tasks = (Array.isArray(input?.tasks) ? input.tasks : [])
      .map((task) => sanitizeTask(task, { now: fallbackDate }))
      .filter(Boolean);
    const seenEventIds = new Set();
    const events = (Array.isArray(input?.events) ? input.events : [])
      .map(sanitizeEvent)
      .filter((event) => {
        if (!event || seenEventIds.has(event.eventId)) return false;
        seenEventIds.add(event.eventId);
        return true;
      })
      .sort((a, b) => a.seq - b.seq);
    const highestSeq = events.reduce((highest, event) => Math.max(highest, event.seq), 0);
    const requestedNextSeq = normalizeInteger(metaInput.nextSeq, { min: 1, fallback: 1 });

    return {
      version: STORE_VERSION,
      meta: {
        historyStartAt,
        timeZone,
        nextSeq: Math.max(requestedNextSeq, highestSeq + 1),
        dailyCapacityMinutes: normalizeInteger(metaInput.dailyCapacityMinutes, {
          min: 0,
          max: 1440,
          fallback: DEFAULT_DAILY_CAPACITY_MINUTES,
        }),
        endOfDayReminderEnabled: metaInput.endOfDayReminderEnabled !== false,
        endOfDayReminderTime: normalizeClockTime(metaInput.endOfDayReminderTime),
        endOfDayReminderLastDate: normalizeDate(metaInput.endOfDayReminderLastDate),
        dailyNotes: sanitizeDailyNotes(metaInput.dailyNotes),
        focusSettings: sanitizeFocusSettings(metaInput.focusSettings),
        dailyPlans: sanitizeDailyPlans(metaInput.dailyPlans),
      },
      tasks,
      events,
      dailyArchives: sanitizeArchives(input?.dailyArchives),
      focusSessions: sanitizeFocusSessions(input?.focusSessions),
      scheduleBlocks: sanitizeScheduleBlocks(input?.scheduleBlocks, { now: fallbackDate }),
      timeEntries: sanitizeTimeEntries(input?.timeEntries, { timeZone }),
    };
  }

  function sanitizeStore(input, options = {}) {
    const rawVersion = input?.version;
    const version = rawVersion === undefined || rawVersion === null ? 1 : Number(rawVersion);
    // Two incompatible v3 files exist in the wild: the released daily-planning
    // build wrote dailyPlans/scheduleBlocks/timeEntries, while the focus-timer
    // build wrote focusSessions/focusSettings. v4 is the union of both halves,
    // and the sanitizer below defaults whichever half a file lacks, so either
    // v3 upgrades without having to tell the two apart.
    if (!Number.isInteger(version) || ![1, 2, 3, 4, STORE_VERSION].includes(version)) {
      throw new Error(`Unsupported store version: ${rawVersion}`);
    }
    if (version === 1) return migrateV1(input, options);
    return sanitizeV2(input, options);
  }

  function updateTask(task, patch, now = new Date()) {
    const next = sanitizeTask(
      {
        ...task,
        ...patch,
        id: task.id,
        revision: Math.max(1, Number(task.revision) || 1) + 1,
        updatedAt: isoNow(now),
      },
      { now },
    );
    return next || task;
  }

  function toggleTask(task, now = new Date()) {
    const completing = task.status !== 'completed';
    return updateTask(
      task,
      {
        status: completing ? 'completed' : 'active',
        completedAt: completing ? isoNow(now) : null,
      },
      now,
    );
  }

  function matchesView(task, view, today = localDate()) {
    if (task.deletedAt) return false;
    if (view === 'completed') return task.status === 'completed';
    if (task.status === 'completed') return false;
    if (view === 'inbox') return !task.plannedDate;
    if (view === 'today') {
      return Boolean(
        (task.plannedDate && task.plannedDate <= today) ||
        (task.dueDate && task.dueDate <= today),
      );
    }
    if (view === 'upcoming') return Boolean(task.plannedDate && task.plannedDate > today);
    return true;
  }

  function matchesQuery(task, query) {
    const normalized = String(query ?? '').trim().toLocaleLowerCase();
    if (!normalized) return true;
    return `${task.title}\n${task.notes}\n${task.area}`.toLocaleLowerCase().includes(normalized);
  }

  function dueRank(task, today = localDate()) {
    if (!task.dueDate) return 3;
    if (task.dueDate < today) return 0;
    if (task.dueDate === today) return 1;
    return 2;
  }

  function sortTasks(tasks, today = localDate(), view = 'all') {
    return [...tasks].sort((a, b) => {
      if (a.status === 'completed' && b.status === 'completed') {
        return String(b.completedAt).localeCompare(String(a.completedAt));
      }
      if (view === 'upcoming' && a.plannedDate !== b.plannedDate) {
        return String(a.plannedDate || '9999-12-31').localeCompare(String(b.plannedDate || '9999-12-31'));
      }
      if (view === 'today') {
        const isOverdue = (task) => Boolean(
          (task.plannedDate && task.plannedDate < today) ||
          (task.dueDate && task.dueDate < today),
        );
        const overdueDifference = Number(isOverdue(b)) - Number(isOverdue(a));
        if (overdueDifference) return overdueDifference;
      }
      const top3Difference = Number(b.top3Date === today) - Number(a.top3Date === today);
      if (top3Difference) return top3Difference;
      const flaggedDifference = Number(Boolean(b.flagged)) - Number(Boolean(a.flagged));
      if (flaggedDifference) return flaggedDifference;
      const rankDifference = dueRank(a, today) - dueRank(b, today);
      if (rankDifference) return rankDifference;
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      const priorityRank = { high: 0, medium: 1, low: 2, none: 3 };
      const priorityDifference = priorityRank[a.priority] - priorityRank[b.priority];
      if (priorityDifference) return priorityDifference;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  }

  function visibleTasks(tasks, view = 'all', query = '', today = localDate()) {
    const safeView = VIEWS.includes(view) ? view : 'all';
    return sortTasks(
      tasks.filter((task) => matchesView(task, safeView, today) && matchesQuery(task, query)),
      today,
      safeView,
    );
  }

  function counts(tasks, today = localDate()) {
    return {
      all: tasks.filter((task) => matchesView(task, 'all', today)).length,
      inbox: tasks.filter((task) => matchesView(task, 'inbox', today)).length,
      today: tasks.filter((task) => matchesView(task, 'today', today)).length,
      upcoming: tasks.filter((task) => matchesView(task, 'upcoming', today)).length,
      completed: tasks.filter((task) => matchesView(task, 'completed', today)).length,
    };
  }

  function commandPayload(command) {
    if (!command || typeof command !== 'object') return {};
    const payload = {};
    ['task', 'patch', 'data', 'payload'].forEach((key) => {
      if (command[key] && typeof command[key] === 'object' && !Array.isArray(command[key])) {
        Object.assign(payload, command[key]);
      }
    });
    return payload;
  }

  function commandValue(command, key) {
    const payload = commandPayload(command);
    if (Object.prototype.hasOwnProperty.call(command || {}, key)) return command[key];
    return payload[key];
  }

  function activeTaskById(tasks, taskId) {
    return tasks.find((task) => task.id === taskId && !task.deletedAt) || null;
  }

  function taskById(tasks, taskId) {
    return tasks.find((task) => task.id === taskId) || null;
  }

  function validateExplicitTop3Pair(plannedDate, top3Date) {
    if (top3Date !== undefined && top3Date !== null && top3Date !== '') {
      const safeTop3Date = normalizeDate(top3Date);
      if (!safeTop3Date || normalizeDate(plannedDate) !== safeTop3Date) {
        throw new Error('top3Date must equal plannedDate');
      }
    }
  }

  function validateDateRange(plannedDate, dueDate) {
    const start = normalizeDate(plannedDate);
    const end = normalizeDate(dueDate);
    if (start && end && end < start) {
      throw new Error('Due date cannot be earlier than planned date');
    }
  }

  function assertTop3Limit(tasks) {
    const countsByDate = new Map();
    tasks.forEach((task) => {
      if (task.deletedAt || !task.plannedDate || task.top3Date !== task.plannedDate) return;
      const count = (countsByDate.get(task.plannedDate) || 0) + 1;
      if (count > 3) throw new Error(`Only three Top 3 tasks are allowed for ${task.plannedDate}`);
      countsByDate.set(task.plannedDate, count);
    });
  }

  function taskPatchFromCommand(command) {
    const payload = commandPayload(command);
    const patch = {};
    TASK_PATCH_FIELDS.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(payload, field)) patch[field] = payload[field];
      else if (Object.prototype.hasOwnProperty.call(command, field)) patch[field] = command[field];
    });
    return patch;
  }

  function inverseTaskPatch(task, patch) {
    const source = task && typeof task === 'object' ? task : {};
    const requested = patch && typeof patch === 'object' ? patch : {};
    const inverse = {};
    TASK_PATCH_FIELDS.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(requested, field)) inverse[field] = source[field] ?? null;
    });
    // Moving a task implicitly clears a now-invalid Top 3 marker. Undo must
    // restore both halves of that dependent pair.
    if (
      Object.prototype.hasOwnProperty.call(requested, 'plannedDate') &&
      !Object.prototype.hasOwnProperty.call(requested, 'top3Date')
    ) {
      inverse.top3Date = source.top3Date ?? null;
    }
    return inverse;
  }

  function appendEvent(store, command, details, options = {}) {
    const occurredDate = toDate(command.occurredAt ?? options.now);
    const occurredAt = occurredDate.toISOString();
    const timeZone = normalizeTimeZone(command.timeZone || store.meta.timeZone);
    const event = {
      eventId: details.eventId,
      seq: store.meta.nextSeq,
      taskId: details.taskId || null,
      type: command.type,
      occurredAt,
      reportingDate: normalizeDate(command.reportingDate) || dateInTimeZone(occurredDate, timeZone),
      timeZone,
      before: jsonClone(details.before, null),
      after: jsonClone(details.after, null),
    };
    return {
      ...store,
      meta: { ...store.meta, nextSeq: event.seq + 1 },
      events: [...store.events, event],
    };
  }

  function applyCommand(inputStore, command, options = {}) {
    if (!command || typeof command !== 'object') throw new TypeError('Command must be an object');
    const supported = [
      'create',
      'update',
      'toggle',
      'delete',
      'restore',
      'markReminderFired',
      'setDailyNote',
      'setCapacity',
      'setEndOfDayReminder',
      'markEndOfDayReminderFired',
      'startFocusSession',
      'pauseFocusSession',
      'resumeFocusSession',
      'completeFocusSession',
      'abandonFocusSession',
      'setFocusSettings',
      'startDailyPlan',
      'completeDailyPlan',
      'completeDailyShutdown',
      'upsertScheduleBlock',
      'deleteScheduleBlock',
      'startFocus',
      'stopFocus',
      'addManualTime',
      'deleteTimeEntry',
    ];
    if (!supported.includes(command.type)) throw new Error(`Unsupported command: ${command.type}`);

    const store = sanitizeStore(inputStore, options);
    const suppliedEventId = normalizeOptionalText(command.eventId || command.commandId, 180);
    const eventId = suppliedEventId || makeId('event');
    if (store.events.some((event) => event.eventId === eventId)) return store;

    const occurredDate = toDate(command.occurredAt ?? options.now);
    const occurredAt = occurredDate.toISOString();
    let next = {
      ...store,
      meta: {
        ...store.meta,
        dailyNotes: { ...store.meta.dailyNotes },
        dailyPlans: { ...store.meta.dailyPlans },
      },
      tasks: [...store.tasks],
      events: [...store.events],
      dailyArchives: [...store.dailyArchives],
      focusSessions: [...store.focusSessions],
      scheduleBlocks: [...store.scheduleBlocks],
      timeEntries: [...store.timeEntries],
    };
    let taskId = normalizeOptionalText(command.taskId || commandValue(command, 'id'), 120);
    let before = null;
    let after = null;

    if (command.type === 'create') {
      const payload = commandPayload(command);
      const taskFields = taskPatchFromCommand(command);
      taskId = taskId || makeId();
      if (next.tasks.some((task) => task.id === taskId)) throw new Error(`Task already exists: ${taskId}`);
      validateExplicitTop3Pair(commandValue(command, 'plannedDate'), commandValue(command, 'top3Date'));
      validateDateRange(commandValue(command, 'plannedDate'), commandValue(command, 'dueDate'));
      const task = createTask(commandValue(command, 'title'), {
        ...payload,
        ...taskFields,
        id: taskId,
        now: occurredDate,
      });
      if (!task) throw new Error('Task title cannot be empty');
      next.tasks.push(task);
      after = task;
    } else if (command.type === 'update') {
      const task = activeTaskById(next.tasks, taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      before = task;
      const patch = taskPatchFromCommand(command);
      if (Object.prototype.hasOwnProperty.call(patch, 'title') && !normalizeTitle(patch.title)) {
        throw new Error('Task title cannot be empty');
      }
      const nextPlannedDate = Object.prototype.hasOwnProperty.call(patch, 'plannedDate')
        ? normalizeDate(patch.plannedDate)
        : task.plannedDate;
      const nextDueDate = Object.prototype.hasOwnProperty.call(patch, 'dueDate')
        ? normalizeDate(patch.dueDate)
        : task.dueDate;
      validateDateRange(nextPlannedDate, nextDueDate);
      if (Object.prototype.hasOwnProperty.call(patch, 'top3Date')) {
        validateExplicitTop3Pair(nextPlannedDate, patch.top3Date);
      } else if (Object.prototype.hasOwnProperty.call(patch, 'plannedDate') && task.top3Date !== nextPlannedDate) {
        patch.top3Date = null;
      }
      after = updateTask(task, patch, occurredDate);
      next.tasks = next.tasks.map((item) => (item.id === task.id ? after : item));
    } else if (command.type === 'toggle') {
      const task = activeTaskById(next.tasks, taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      before = task;
      after = toggleTask(task, occurredDate);
      next.tasks = next.tasks.map((item) => (item.id === task.id ? after : item));
      // Finishing the task is the only way to end its timing, so completing it
      // from anywhere — row, details panel, keyboard — has to close the running
      // entry. Otherwise it would keep accruing against a task already done.
      if (after.status === 'completed') {
        next.timeEntries = next.timeEntries.map((entry) => (
          entry.taskId === task.id && !entry.endedAt
            ? closeTimeEntry(entry, occurredDate, next.meta.timeZone)
            : entry
        ));
      }
    } else if (command.type === 'delete') {
      const task = activeTaskById(next.tasks, taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      before = task;
      after = updateTask(task, { deletedAt: occurredAt }, occurredDate);
      next.tasks = next.tasks.map((item) => (item.id === task.id ? after : item));
    } else if (command.type === 'restore') {
      const task = taskById(next.tasks, taskId);
      if (!task || !task.deletedAt) throw new Error(`Deleted task not found: ${taskId}`);
      before = task;
      after = updateTask(task, { deletedAt: null }, occurredDate);
      next.tasks = next.tasks.map((item) => (item.id === task.id ? after : item));
    } else if (command.type === 'markReminderFired') {
      const task = activeTaskById(next.tasks, taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      before = task;
      after = updateTask(task, { reminderFiredAt: occurredAt }, occurredDate);
      next.tasks = next.tasks.map((item) => (item.id === task.id ? after : item));
    } else if (command.type === 'setDailyNote') {
      const date =
        normalizeDate(commandValue(command, 'date') || commandValue(command, 'reportingDate')) ||
        dateInTimeZone(occurredDate, next.meta.timeZone);
      const previous = Object.prototype.hasOwnProperty.call(next.meta.dailyNotes, date)
        ? next.meta.dailyNotes[date]
        : null;
      const note = normalizeText(commandValue(command, 'note'), 10000);
      before = { date, note: previous };
      if (note) next.meta.dailyNotes[date] = note;
      else delete next.meta.dailyNotes[date];
      after = { date, note: note || null };
      taskId = null;
    } else if (command.type === 'setCapacity') {
      const minutes = normalizeInteger(
        commandValue(command, 'minutes') ??
          commandValue(command, 'dailyCapacityMinutes') ??
          commandValue(command, 'capacity'),
        { min: 0, max: 1440, fallback: null },
      );
      if (minutes === null) throw new Error('Capacity must be between 0 and 1440 minutes');
      before = { dailyCapacityMinutes: next.meta.dailyCapacityMinutes };
      next.meta.dailyCapacityMinutes = minutes;
      after = { dailyCapacityMinutes: minutes };
      taskId = null;
    } else if (command.type === 'setEndOfDayReminder') {
      const enabledValue = commandValue(command, 'enabled');
      if (typeof enabledValue !== 'boolean') throw new Error('End-of-day reminder enabled must be boolean');
      const rawTime = commandValue(command, 'time');
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(rawTime || ''))) {
        throw new Error('End-of-day reminder time must use HH:mm');
      }
      before = {
        enabled: next.meta.endOfDayReminderEnabled,
        time: next.meta.endOfDayReminderTime,
      };
      next.meta.endOfDayReminderEnabled = enabledValue;
      next.meta.endOfDayReminderTime = rawTime;
      after = { enabled: enabledValue, time: rawTime };
      taskId = null;
    } else if (command.type === 'markEndOfDayReminderFired') {
      const date = normalizeDate(commandValue(command, 'date'));
      if (!date) throw new Error('End-of-day reminder date must use YYYY-MM-DD');
      before = { date: next.meta.endOfDayReminderLastDate };
      next.meta.endOfDayReminderLastDate = date;
      after = { date };
      taskId = null;
    } else if (command.type === 'startFocusSession') {
      const plannedMinutes = normalizeInteger(commandValue(command, 'plannedMinutes'), {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        fallback: null,
      });
      if (
        plannedMinutes === null ||
        plannedMinutes < FOCUS_MIN_MINUTES ||
        plannedMinutes > FOCUS_MAX_MINUTES
      ) {
        throw new Error(`Focus session length must be ${FOCUS_MIN_MINUTES}-${FOCUS_MAX_MINUTES} minutes`);
      }
      assertNoFocusInProgress(next);
      const linkedTaskId = normalizeOptionalText(commandValue(command, 'taskId'), 120);
      if (linkedTaskId && !activeTaskById(next.tasks, linkedTaskId)) {
        throw new Error(`Task not found: ${linkedTaskId}`);
      }
      const sessionId = normalizeOptionalText(commandValue(command, 'sessionId'), 120) || makeId('focus');
      if (next.focusSessions.some((session) => session.id === sessionId)) {
        throw new Error(`Focus session already exists: ${sessionId}`);
      }
      const session = sanitizeFocusSession({
        id: sessionId,
        taskId: linkedTaskId,
        plannedMinutes,
        startedAt: occurredAt,
        status: 'running',
        reportingDate:
          normalizeDate(command.reportingDate) || dateInTimeZone(occurredDate, next.meta.timeZone),
      });
      if (!session) throw new Error('Unable to create focus session');
      next.focusSessions.push(session);
      after = session;
      taskId = linkedTaskId;
    } else if (
      ['pauseFocusSession', 'resumeFocusSession', 'completeFocusSession', 'abandonFocusSession'].includes(command.type)
    ) {
      const sessionId = normalizeOptionalText(commandValue(command, 'sessionId'), 120);
      const session = next.focusSessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Focus session not found: ${sessionId}`);
      if (session.status !== 'running') throw new Error(`Focus session is not running: ${sessionId}`);
      before = session;
      let updated;
      if (command.type === 'pauseFocusSession') {
        if (next.meta.focusSettings.strictMode) throw new Error('Strict mode forbids pausing a focus session');
        if (session.pausedAt) throw new Error('Focus session is already paused');
        updated = { ...session, pausedAt: occurredAt };
      } else if (command.type === 'resumeFocusSession') {
        if (!session.pausedAt) throw new Error('Focus session is not paused');
        const pausedSpan = Math.max(0, occurredDate.getTime() - new Date(session.pausedAt).getTime());
        updated = { ...session, pausedAt: null, pausedMs: (Number(session.pausedMs) || 0) + pausedSpan };
      } else if (command.type === 'completeFocusSession') {
        updated = {
          ...session,
          status: 'completed',
          endedAt: occurredAt,
          pausedAt: null,
          focusedMinutes: session.plannedMinutes,
        };
      } else {
        // Abandoning withers the tree. The session keeps its real focused
        // minutes for the record, but focus statistics only ever count
        // completed sessions (Forest-style loss aversion).
        const suppliedMinutes = normalizeInteger(commandValue(command, 'focusedMinutes'), {
          min: 0,
          max: session.plannedMinutes,
          fallback: null,
        });
        updated = {
          ...session,
          status: 'abandoned',
          endedAt: occurredAt,
          pausedAt: null,
          focusedMinutes: suppliedMinutes ?? elapsedFocusMinutes(session, occurredDate),
        };
      }
      const safeSession = sanitizeFocusSession(updated);
      if (!safeSession) throw new Error('Unable to update focus session');
      next.focusSessions = next.focusSessions.map((candidate) => (candidate.id === session.id ? safeSession : candidate));
      after = safeSession;
      taskId = session.taskId;
      // A finished pomodoro records a time entry so focus minutes have one
      // source of truth shared with the stopwatch. An abandoned session records
      // none: its minutes deliberately do not count towards any statistic.
      if (safeSession.status === 'completed') {
        const entryId = normalizeOptionalText(commandValue(command, 'entryId'), 120)
          || `time-${safeSession.id}`.slice(0, 120);
        if (!next.timeEntries.some((entry) => entry.id === entryId)) {
          const entry = sanitizeTimeEntry({
            id: entryId,
            taskId: safeSession.taskId,
            startedAt: safeSession.startedAt,
            endedAt: safeSession.endedAt,
            durationSeconds: safeSession.focusedMinutes * 60,
            reportingDate: safeSession.reportingDate,
            source: 'pomodoro',
          }, { timeZone: next.meta.timeZone });
          if (entry) next.timeEntries.push(entry);
        }
      }
    } else if (command.type === 'setFocusSettings') {
      const payload = commandPayload(command);
      const known = ['defaultMinutes', 'strictMode', 'completionNotification', 'dailyGoalMinutes'];
      const requested = known.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
      if (!requested.length) throw new Error('setFocusSettings requires at least one focus setting');
      before = { ...next.meta.focusSettings };
      next.meta.focusSettings = sanitizeFocusSettings({ ...next.meta.focusSettings, ...payload });
      after = { ...next.meta.focusSettings };
      taskId = null;
    } else if (['startDailyPlan', 'completeDailyPlan', 'completeDailyShutdown'].includes(command.type)) {
      const date =
        normalizeDate(commandValue(command, 'date') || commandValue(command, 'reportingDate')) ||
        dateInTimeZone(occurredDate, next.meta.timeZone);
      const previous = sanitizeDailyPlan(next.meta.dailyPlans[date], date) || emptyDailyPlan(date);
      if (
        (command.type === 'startDailyPlan' && previous.planningStartedAt) ||
        (command.type === 'completeDailyPlan' && previous.planningCompletedAt) ||
        (command.type === 'completeDailyShutdown' && previous.shutdownCompletedAt)
      ) return store;
      const plan = { ...previous, blockedTaskIds: [...previous.blockedTaskIds] };
      before = jsonClone(previous);
      if (command.type === 'startDailyPlan') {
        plan.planningStartedAt = plan.planningStartedAt || occurredAt;
      } else if (command.type === 'completeDailyPlan') {
        plan.planningStartedAt = plan.planningStartedAt || occurredAt;
        plan.planningCompletedAt = occurredAt;
      } else {
        const shutdownNote = commandValue(command, 'shutdownNote');
        const blockerNote = commandValue(command, 'blockerNote');
        const tomorrowFocus = commandValue(command, 'tomorrowFocus');
        const blockedTaskIds = commandValue(command, 'blockedTaskIds');
        plan.shutdownCompletedAt = occurredAt;
        if (shutdownNote !== undefined) plan.shutdownNote = normalizeText(shutdownNote, 10000);
        if (blockerNote !== undefined) plan.blockerNote = normalizeText(blockerNote, 5000);
        if (tomorrowFocus !== undefined) plan.tomorrowFocus = normalizeText(tomorrowFocus, 2000);
        if (blockedTaskIds !== undefined) {
          const activeIds = new Set(next.tasks.filter((task) => !task.deletedAt).map((task) => task.id));
          plan.blockedTaskIds = sanitizeTaskIdList(blockedTaskIds).filter((id) => activeIds.has(id));
        }
      }
      after = sanitizeDailyPlan(plan, date);
      next.meta.dailyPlans[date] = after;
      taskId = null;
    } else if (command.type === 'upsertScheduleBlock') {
      const task = activeTaskById(next.tasks, taskId);
      if (!task || task.status === 'completed' || !task.plannedDate) {
        throw new Error(`Schedulable task not found: ${taskId}`);
      }
      const blockId = normalizeOptionalText(commandValue(command, 'blockId') || commandValue(command, 'id'), 120)
        || makeId('block');
      const existing = next.scheduleBlocks.find((block) => block.id === blockId) || null;
      if (existing && existing.taskId !== task.id) throw new Error('Schedule block task cannot change');
      const block = sanitizeScheduleBlock({
        ...existing,
        id: blockId,
        taskId: task.id,
        date: commandValue(command, 'date'),
        startMinute: commandValue(command, 'startMinute'),
        durationMinutes: commandValue(command, 'durationMinutes'),
        source: 'manual',
        locked: commandValue(command, 'locked') !== false,
        createdAt: existing?.createdAt || occurredAt,
        updatedAt: occurredAt,
      }, { now: occurredDate });
      if (!block) throw new Error('Invalid schedule block');
      if (block.date < task.plannedDate || (task.dueDate && block.date > task.dueDate)) {
        throw new Error('Schedule block must stay inside the task date range');
      }
      const blockEnd = block.startMinute + block.durationMinutes;
      const conflict = next.scheduleBlocks.find((candidate) => (
        candidate.id !== block.id
        && candidate.locked
        && block.locked
        && candidate.date === block.date
        && candidate.startMinute < blockEnd
        && block.startMinute < candidate.startMinute + candidate.durationMinutes
      ));
      if (conflict) throw new Error('Schedule block conflicts with a locked block');
      before = existing;
      after = block;
      next.scheduleBlocks = existing
        ? next.scheduleBlocks.map((item) => (item.id === block.id ? block : item))
        : [...next.scheduleBlocks, block];
    } else if (command.type === 'deleteScheduleBlock') {
      const blockId = normalizeOptionalText(commandValue(command, 'blockId') || commandValue(command, 'id'), 120);
      const existing = next.scheduleBlocks.find((block) => block.id === blockId) || null;
      if (!existing) throw new Error(`Schedule block not found: ${blockId}`);
      taskId = existing.taskId;
      before = existing;
      after = null;
      next.scheduleBlocks = next.scheduleBlocks.filter((block) => block.id !== blockId);
    } else if (command.type === 'startFocus') {
      const task = activeTaskById(next.tasks, taskId);
      if (!task || task.status === 'completed') throw new Error(`Focusable task not found: ${taskId}`);
      assertNoFocusInProgress(next);
      const entryId = normalizeOptionalText(commandValue(command, 'entryId') || commandValue(command, 'id'), 120)
        || makeId('time');
      if (next.timeEntries.some((entry) => entry.id === entryId)) throw new Error(`Time entry already exists: ${entryId}`);
      after = sanitizeTimeEntry({
        id: entryId,
        taskId: task.id,
        startedAt: occurredAt,
        endedAt: null,
        durationSeconds: 0,
        reportingDate: dateInTimeZone(occurredDate, next.meta.timeZone),
        source: 'focus',
      }, { timeZone: next.meta.timeZone });
      next.timeEntries.push(after);
    } else if (command.type === 'stopFocus') {
      const entryId = normalizeOptionalText(commandValue(command, 'entryId') || commandValue(command, 'id'), 120);
      const existing = next.timeEntries.find((entry) => !entry.endedAt && (!entryId || entry.id === entryId)) || null;
      if (!existing) throw new Error('Running focus session not found');
      taskId = existing.taskId;
      before = existing;
      after = closeTimeEntry(existing, occurredDate, next.meta.timeZone);
      next.timeEntries = next.timeEntries.map((entry) => (entry.id === existing.id ? after : entry));
    } else if (command.type === 'addManualTime') {
      const task = activeTaskById(next.tasks, taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const entryId = normalizeOptionalText(commandValue(command, 'entryId') || commandValue(command, 'id'), 120)
        || makeId('time');
      if (next.timeEntries.some((entry) => entry.id === entryId)) throw new Error(`Time entry already exists: ${entryId}`);
      const date = normalizeDate(commandValue(command, 'date')) || dateInTimeZone(occurredDate, next.meta.timeZone);
      const minutes = normalizeInteger(commandValue(command, 'minutes'), { min: 1, max: 1440, fallback: null });
      if (minutes === null) throw new Error('Manual time must be between 1 and 1440 minutes');
      after = sanitizeTimeEntry({
        id: entryId,
        taskId: task.id,
        startedAt: occurredAt,
        endedAt: occurredAt,
        durationSeconds: minutes * 60,
        reportingDate: date,
        source: 'manual',
        note: commandValue(command, 'note'),
      }, { timeZone: next.meta.timeZone });
      next.timeEntries.push(after);
    } else if (command.type === 'deleteTimeEntry') {
      const entryId = normalizeOptionalText(commandValue(command, 'entryId') || commandValue(command, 'id'), 120);
      const existing = next.timeEntries.find((entry) => entry.id === entryId) || null;
      if (!existing) throw new Error(`Time entry not found: ${entryId}`);
      if (!existing.endedAt) throw new Error('Stop a running focus session before deleting it');
      taskId = existing.taskId;
      before = existing;
      after = null;
      next.timeEntries = next.timeEntries.filter((entry) => entry.id !== entryId);
    }

    assertTop3Limit(next.tasks);
    return appendEvent(next, command, { eventId, taskId, before, after }, options);
  }

  function addDays(dateString, days) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function nextRecurringDate(task, fallbackDate = localDate()) {
    const repeatRule = task?.repeatRule;
    const rule = typeof repeatRule === 'string' ? repeatRule : repeatRule?.frequency;
    const base = normalizeDate(task?.plannedDate) || normalizeDate(fallbackDate) || localDate();
    if (!rule) return null;
    if (rule === 'daily') return addDays(base, 1);
    if (rule === 'weekdays') {
      let candidate = addDays(base, 1);
      while ([0, 6].includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) candidate = addDays(candidate, 1);
      return candidate;
    }
    if (rule === 'weekly') return addDays(base, 7);
    if (rule === 'monthly') {
      const [year, month, day] = base.split('-').map(Number);
      const anchorDay = normalizeInteger(repeatRule?.anchorDay, { min: 1, max: 31, fallback: day });
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      return `${new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay))).toISOString().slice(0, 10)}`;
    }
    return null;
  }

  const api = {
    STORE_VERSION,
    PRIORITIES,
    VIEWS,
    FOCUS_MIN_MINUTES,
    FOCUS_MAX_MINUTES,
    DEFAULT_FOCUS_SETTINGS,
    localDate,
    dateInTimeZone,
    normalizeTitle,
    createTask,
    sanitizeTask,
    sanitizeStore,
    updateTask,
    toggleTask,
    matchesView,
    matchesQuery,
    sortTasks,
    visibleTasks,
    counts,
    applyCommand,
    inverseTaskPatch,
    nextRecurringDate,
    focusSessionEnd,
    elapsedFocusMinutes,
    timeEntryDayEnd,
    addDays,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TodoDomain = api;
})(typeof window !== 'undefined' ? window : globalThis);
