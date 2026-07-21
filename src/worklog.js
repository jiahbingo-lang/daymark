(function exposeWorklog(global) {
  'use strict';

  const Planning = typeof module !== 'undefined' && module.exports
    ? require('./planning')
    : global.DaymarkPlanning;

  const MINUTES_PER_DAY = 1440;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function startOfWeek(date) {
    if (!Planning.isDate(date)) return null;
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    return Planning.addDays(date, -((day + 6) % 7));
  }

  function weekDates(date) {
    const monday = startOfWeek(date);
    return monday ? Array.from({ length: 7 }, (_, index) => Planning.addDays(monday, index)) : [];
  }

  function formatMinute(value) {
    const minute = Math.max(0, Math.min(MINUTES_PER_DAY - 1, Math.round(Number(value) || 0)));
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  }

  function durationSeconds(entry, now = new Date()) {
    if (!entry?.startedAt) return 0;
    if (entry.endedAt) return Math.max(0, Number(entry.durationSeconds) || 0);
    const started = new Date(entry.startedAt);
    const current = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(started.getTime()) || Number.isNaN(current.getTime())) return 0;
    return Math.max(0, Math.round((current - started) / 1000));
  }

  function entriesForTask(store, taskId, options = {}) {
    const includeRunning = options.includeRunning !== false;
    return (Array.isArray(store?.timeEntries) ? store.timeEntries : [])
      .filter((entry) => entry?.taskId === taskId && (includeRunning || entry.endedAt))
      .map(clone);
  }

  function actualSecondsForTask(store, taskId, options = {}) {
    return entriesForTask(store, taskId, options)
      .reduce((total, entry) => total + durationSeconds(entry, options.now), 0);
  }

  function actualMinutesForTask(store, taskId, options = {}) {
    return Math.round(actualSecondsForTask(store, taskId, options) / 60);
  }

  function runningEntry(store) {
    return (Array.isArray(store?.timeEntries) ? store.timeEntries : [])
      .find((entry) => entry && !entry.endedAt) || null;
  }

  // A run still open from an earlier day: the user started something and never
  // paused or finished it. The caller closes it at that day's midnight.
  function staleRunningEntry(store, today) {
    const running = runningEntry(store);
    if (!running || !Planning.isDate(today)) return null;
    return running.reportingDate && running.reportingDate < today ? clone(running) : null;
  }

  function zoneMinuteOfDay(instant, timeZone) {
    const date = instant instanceof Date ? instant : new Date(instant);
    if (Number.isNaN(date.getTime())) return 0;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return (Number(value.hour) % 24) * 60 + Number(value.minute);
  }

  function taskMap(store) {
    return new Map((Array.isArray(store?.tasks) ? store.tasks : [])
      .filter((task) => task?.id)
      .map((task) => [task.id, task]));
  }

  // Every recorded stretch of work on a date, positioned by wall-clock minute so
  // a timeline can lay them out. A run still going is included and measured up
  // to `now`, which is what makes the current block grow on screen.
  function segmentsForDate(store, date, options = {}) {
    if (!Planning.isDate(date)) return [];
    const timeZone = store?.meta?.timeZone || 'UTC';
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const tasks = taskMap(store);

    return (Array.isArray(store?.timeEntries) ? store.timeEntries : [])
      .filter((entry) => entry?.reportingDate === date && entry.startedAt)
      .map((entry) => {
        const startMinute = zoneMinuteOfDay(entry.startedAt, timeZone);
        const seconds = durationSeconds(entry, now);
        const minutes = Math.max(1, Math.round(seconds / 60));
        const task = entry.taskId ? tasks.get(entry.taskId) : null;
        return {
          id: entry.id,
          taskId: entry.taskId || null,
          // A task deleted after the fact leaves its record behind; the log is a
          // statement about time spent, not about tasks that still exist.
          title: task ? task.title : entry.taskId ? '已删除的任务' : '自由计时',
          area: task?.area || '',
          taskDeleted: Boolean(entry.taskId && (!task || task.deletedAt)),
          startMinute,
          endMinute: Math.min(MINUTES_PER_DAY, startMinute + minutes),
          minutes,
          running: !entry.endedAt,
          source: entry.source || 'focus',
          note: entry.note || '',
        };
      })
      .sort((left, right) => left.startMinute - right.startMinute
        || left.title.localeCompare(right.title, 'zh-CN'));
  }

  function dailySummary(store, date, options = {}) {
    const segments = segmentsForDate(store, date, options);
    const minutes = segments.reduce((total, segment) => total + segment.minutes, 0);
    const taskIds = new Set(segments.map((segment) => segment.taskId || 'free'));
    const firstMinute = segments.length
      ? Math.min(...segments.map((segment) => segment.startMinute))
      : null;
    const lastMinute = segments.length
      ? Math.max(...segments.map((segment) => segment.endMinute))
      : null;
    // The gap between first and last that no segment covers: time inside the
    // working stretch that went unrecorded.
    const span = firstMinute === null ? 0 : lastMinute - firstMinute;
    return {
      date,
      segments,
      minutes,
      taskCount: taskIds.size,
      segmentCount: segments.length,
      firstMinute,
      lastMinute,
      idleMinutes: Math.max(0, span - minutes),
      running: segments.some((segment) => segment.running),
    };
  }

  // One row per task worked on that day, ordered by how much time it took.
  function taskRollup(store, date, options = {}) {
    const segments = segmentsForDate(store, date, options);
    const groups = new Map();
    segments.forEach((segment) => {
      const key = segment.taskId || 'free';
      if (!groups.has(key)) {
        groups.set(key, {
          taskId: segment.taskId,
          title: segment.title,
          area: segment.area,
          minutes: 0,
          segments: [],
        });
      }
      const group = groups.get(key);
      group.minutes += segment.minutes;
      group.segments.push(segment);
    });
    return [...groups.values()]
      .sort((left, right) => right.minutes - left.minutes
        || left.title.localeCompare(right.title, 'zh-CN'));
  }

  function rangeSummary(store, dates, options = {}) {
    const days = (Array.isArray(dates) ? dates : []).filter(Planning.isDate);
    const summaries = days.map((date) => dailySummary(store, date, options));
    return {
      dates: days,
      byDate: Object.fromEntries(summaries.map((summary) => [summary.date, summary])),
      minutes: summaries.reduce((total, summary) => total + summary.minutes, 0),
      segmentCount: summaries.reduce((total, summary) => total + summary.segmentCount, 0),
      activeDays: summaries.filter((summary) => summary.minutes > 0).length,
    };
  }

  const api = {
    MINUTES_PER_DAY,
    startOfWeek,
    weekDates,
    formatMinute,
    durationSeconds,
    entriesForTask,
    actualSecondsForTask,
    actualMinutesForTask,
    runningEntry,
    staleRunningEntry,
    segmentsForDate,
    dailySummary,
    taskRollup,
    rangeSummary,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DaymarkWorklog = api;
})(typeof window !== 'undefined' ? window : globalThis);
