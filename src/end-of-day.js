'use strict';

const DEFAULT_END_OF_DAY_REMINDER_TIME = '17:30';
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2, none: 3 });

function normalizeTime(value, fallback = DEFAULT_END_OF_DAY_REMINDER_TIME) {
  const candidate = String(value || '');
  return TIME_PATTERN.test(candidate) ? candidate : fallback;
}

function dateTimeParts(value, timeZone = DEFAULT_TIME_ZONE) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('A valid current time is required');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(parsed)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function pendingTasksForDate(store, date) {
  if (!DATE_PATTERN.test(String(date || ''))) throw new TypeError('date must use YYYY-MM-DD');
  return (Array.isArray(store?.tasks) ? store.tasks : [])
    .filter((task) => {
      if (!task || task.deletedAt || task.status === 'completed') return false;
      const started = DATE_PATTERN.test(String(task.plannedDate || '')) && task.plannedDate <= date;
      const due = DATE_PATTERN.test(String(task.dueDate || '')) && task.dueDate <= date;
      return started || due;
    })
    .slice()
    .sort((left, right) => {
      const leftTop3 = left.top3Date === date ? 0 : 1;
      const rightTop3 = right.top3Date === date ? 0 : 1;
      return leftTop3 - rightTop3
        || String(left.dueDate || '9999-12-31').localeCompare(String(right.dueDate || '9999-12-31'))
        || (PRIORITY_RANK[left.priority] ?? 3) - (PRIORITY_RANK[right.priority] ?? 3)
        || String(left.title || '').localeCompare(String(right.title || ''), 'zh-CN');
    });
}

function evaluateEndOfDayReminder(store, now = new Date(), options = {}) {
  const timeZone = store?.meta?.timeZone || options.timeZone || DEFAULT_TIME_ZONE;
  const current = dateTimeParts(now, timeZone);
  const enabled = store?.meta?.endOfDayReminderEnabled !== false;
  const reminderTime = normalizeTime(store?.meta?.endOfDayReminderTime);
  const lastDate = DATE_PATTERN.test(String(store?.meta?.endOfDayReminderLastDate || ''))
    ? store.meta.endOfDayReminderLastDate
    : null;
  const pending = pendingTasksForDate(store, current.date);
  const due = enabled && current.time >= reminderTime && lastDate !== current.date && pending.length > 0;
  return {
    due,
    enabled,
    date: current.date,
    currentTime: current.time,
    reminderTime,
    lastDate,
    pending,
  };
}

function notificationCopy(evaluation) {
  const pending = Array.isArray(evaluation?.pending) ? evaluation.pending : [];
  const titles = pending.slice(0, 3).map((task) => String(task.title || '未命名任务'));
  const remaining = Math.max(0, pending.length - titles.length);
  return {
    title: `下班前还有 ${pending.length} 项未完成`,
    body: `${titles.join('、')}${remaining ? `，另有 ${remaining} 项` : ''}`,
  };
}

module.exports = {
  DEFAULT_END_OF_DAY_REMINDER_TIME,
  normalizeTime,
  dateTimeParts,
  pendingTasksForDate,
  evaluateEndOfDayReminder,
  notificationCopy,
};
