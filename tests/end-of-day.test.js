const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTime,
  pendingTasksForDate,
  evaluateEndOfDayReminder,
  notificationCopy,
} = require('../src/end-of-day');

function task(id, overrides = {}) {
  return {
    id,
    title: `事项 ${id}`,
    status: 'active',
    plannedDate: null,
    dueDate: null,
    top3Date: null,
    priority: 'none',
    completedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function store(tasks, meta = {}) {
  return {
    meta: {
      timeZone: 'Asia/Shanghai',
      endOfDayReminderEnabled: true,
      endOfDayReminderTime: '17:30',
      endOfDayReminderLastDate: null,
      ...meta,
    },
    tasks,
  };
}

test('pending work includes started, due, and overdue tasks but excludes unrelated Inbox work', () => {
  const source = store([
    task('today-top3', { plannedDate: '2026-07-16', top3Date: '2026-07-16' }),
    task('overdue', { plannedDate: '2026-07-15', dueDate: '2026-07-15', priority: 'high' }),
    task('due-inbox', { dueDate: '2026-07-16' }),
    task('future', { plannedDate: '2026-07-17' }),
    task('undated'),
    task('done', { plannedDate: '2026-07-16', status: 'completed', completedAt: '2026-07-16T08:00:00.000Z' }),
    task('deleted', { plannedDate: '2026-07-16', deletedAt: '2026-07-16T08:00:00.000Z' }),
  ]);

  assert.deepEqual(
    pendingTasksForDate(source, '2026-07-16').map((item) => item.id),
    ['today-top3', 'overdue', 'due-inbox'],
  );
});

test('China-time reminder fires at or after the configured time only once per date', () => {
  const source = store([task('today', { plannedDate: '2026-07-16' })]);
  assert.equal(evaluateEndOfDayReminder(source, '2026-07-16T09:29:00.000Z').due, false);

  const due = evaluateEndOfDayReminder(source, '2026-07-16T09:30:00.000Z');
  assert.equal(due.due, true);
  assert.equal(due.date, '2026-07-16');
  assert.equal(due.currentTime, '17:30');

  const delivered = store(source.tasks, { endOfDayReminderLastDate: '2026-07-16' });
  assert.equal(evaluateEndOfDayReminder(delivered, '2026-07-16T12:00:00.000Z').due, false);
  assert.equal(evaluateEndOfDayReminder(delivered, '2026-07-17T09:30:00.000Z').due, true);
});

test('disabled reminders and days with no pending work remain silent', () => {
  const disabled = store([task('today', { plannedDate: '2026-07-16' })], {
    endOfDayReminderEnabled: false,
  });
  const empty = store([task('future', { plannedDate: '2026-07-17' })]);
  assert.equal(evaluateEndOfDayReminder(disabled, '2026-07-16T12:00:00.000Z').due, false);
  assert.equal(evaluateEndOfDayReminder(empty, '2026-07-16T12:00:00.000Z').due, false);
});

test('a completed daily shutdown suppresses the reminder even when pending tasks remain', () => {
  const source = store([task('today', { plannedDate: '2026-07-16' })], {
    dailyPlans: {
      '2026-07-16': { shutdownCompletedAt: '2026-07-16T09:00:00.000Z' },
    },
  });
  const evaluation = evaluateEndOfDayReminder(source, '2026-07-16T12:00:00.000Z');
  assert.equal(evaluation.due, false);
  assert.equal(evaluation.alreadyShutdown, true);
  assert.equal(evaluation.pending.length, 1);
});

test('notification copy summarizes at most three task titles', () => {
  const evaluation = {
    pending: [task('a'), task('b'), task('c'), task('d')],
  };
  assert.deepEqual(notificationCopy(evaluation), {
    title: '下班前还有 4 项未完成',
    body: '事项 a、事项 b、事项 c，另有 1 项',
  });
  assert.equal(normalizeTime('25:00'), '17:30');
});
