const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeStore,
  applyCommand,
  focusSessionEnd,
} = require('../src/domain');
const Focus = require('../src/focus');
const Reporting = require('../src/reporting');

const NOW = new Date('2026-07-17T02:00:00.000Z');

function emptyStore() {
  return sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'Asia/Shanghai' });
}

function storeWithSession() {
  let store = emptyStore();
  store = applyCommand(store, {
    type: 'create',
    taskId: 'task-1',
    payload: { title: '整理季度数据' },
    occurredAt: '2026-07-17T02:01:00.000Z',
  });
  store = applyCommand(store, {
    type: 'startFocusSession',
    eventId: 'start-1',
    payload: { sessionId: 'focus-1', taskId: 'task-1', plannedMinutes: 25 },
    occurredAt: '2026-07-17T02:10:00.000Z',
  });
  return store;
}

test('v1 and v2 stores upgrade to v3 with focus defaults', () => {
  const fromV1 = emptyStore();
  assert.equal(fromV1.version, 3);
  assert.deepEqual(fromV1.focusSessions, []);
  assert.deepEqual(fromV1.meta.focusSettings, {
    defaultMinutes: 25,
    strictMode: true,
    completionNotification: true,
    dailyGoalMinutes: 120,
  });

  const fromV2 = sanitizeStore({
    version: 2,
    meta: { historyStartAt: NOW.toISOString(), timeZone: 'Asia/Shanghai', nextSeq: 1, dailyNotes: {} },
    tasks: [],
    events: [],
    dailyArchives: [],
  }, { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(fromV2.version, 3);
  assert.deepEqual(fromV2.focusSessions, []);
  assert.equal(fromV2.meta.focusSettings.strictMode, true);
});

test('starting a focus session records attribution in China time and audits an event', () => {
  const store = storeWithSession();
  const session = store.focusSessions[0];
  assert.equal(session.status, 'running');
  assert.equal(session.taskId, 'task-1');
  assert.equal(session.reportingDate, '2026-07-17');
  assert.equal(session.plannedMinutes, 25);
  assert.equal(new Date(focusSessionEnd(session)).toISOString(), '2026-07-17T02:35:00.000Z');
  const event = store.events.at(-1);
  assert.equal(event.type, 'startFocusSession');
  assert.equal(event.taskId, 'task-1');
  assert.equal(event.after.id, 'focus-1');
});

test('only one focus session can run and linked tasks must exist', () => {
  const store = storeWithSession();
  assert.throws(
    () => applyCommand(store, { type: 'startFocusSession', payload: { plannedMinutes: 25 } }),
    /already running/,
  );
  assert.throws(
    () => applyCommand(emptyStore(), {
      type: 'startFocusSession',
      payload: { plannedMinutes: 25, taskId: 'missing' },
    }),
    /Task not found/,
  );
  assert.throws(
    () => applyCommand(emptyStore(), { type: 'startFocusSession', payload: { plannedMinutes: 3 } }),
    /5-180 minutes/,
  );
});

test('completion counts the planned minutes; abandonment records but never counts', () => {
  let store = storeWithSession();
  store = applyCommand(store, {
    type: 'completeFocusSession',
    eventId: 'focus-complete-focus-1',
    payload: { sessionId: 'focus-1' },
    occurredAt: '2026-07-17T02:35:00.000Z',
  });
  const completed = store.focusSessions[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.focusedMinutes, 25);

  store = applyCommand(store, {
    type: 'startFocusSession',
    eventId: 'start-2',
    payload: { sessionId: 'focus-2', plannedMinutes: 45 },
    occurredAt: '2026-07-17T03:00:00.000Z',
  });
  store = applyCommand(store, {
    type: 'abandonFocusSession',
    eventId: 'abandon-2',
    payload: { sessionId: 'focus-2' },
    occurredAt: '2026-07-17T03:08:40.000Z',
  });
  const abandoned = store.focusSessions.find((session) => session.id === 'focus-2');
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.focusedMinutes, 8);

  const summary = Focus.dailyFocusSummary(store.focusSessions, '2026-07-17');
  assert.equal(summary.minutes, 25);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.abandonedCount, 1);
});

test('duplicate completion event ids resolve as idempotent no-ops', () => {
  let store = storeWithSession();
  store = applyCommand(store, {
    type: 'completeFocusSession',
    eventId: 'focus-complete-focus-1',
    payload: { sessionId: 'focus-1' },
    occurredAt: '2026-07-17T02:35:00.000Z',
  });
  const replay = applyCommand(store, {
    type: 'completeFocusSession',
    eventId: 'focus-complete-focus-1',
    payload: { sessionId: 'focus-1' },
    occurredAt: '2026-07-17T02:36:00.000Z',
  });
  assert.deepEqual(replay, store);
  assert.throws(
    () => applyCommand(store, {
      type: 'completeFocusSession',
      eventId: 'different-id',
      payload: { sessionId: 'focus-1' },
    }),
    /not running/,
  );
});

test('strict mode forbids pausing; relaxed mode shifts the effective end', () => {
  let store = storeWithSession();
  assert.throws(
    () => applyCommand(store, { type: 'pauseFocusSession', payload: { sessionId: 'focus-1' } }),
    /Strict mode/,
  );

  store = applyCommand(store, {
    type: 'setFocusSettings',
    eventId: 'settings-1',
    payload: { strictMode: false },
    occurredAt: '2026-07-17T02:11:00.000Z',
  });
  assert.equal(store.meta.focusSettings.strictMode, false);
  store = applyCommand(store, {
    type: 'pauseFocusSession',
    eventId: 'pause-1',
    payload: { sessionId: 'focus-1' },
    occurredAt: '2026-07-17T02:15:00.000Z',
  });
  assert.equal(store.focusSessions[0].pausedAt, '2026-07-17T02:15:00.000Z');
  assert.throws(
    () => applyCommand(store, { type: 'pauseFocusSession', payload: { sessionId: 'focus-1' } }),
    /already paused/,
  );
  store = applyCommand(store, {
    type: 'resumeFocusSession',
    eventId: 'resume-1',
    payload: { sessionId: 'focus-1' },
    occurredAt: '2026-07-17T02:20:00.000Z',
  });
  const session = store.focusSessions[0];
  assert.equal(session.pausedAt, null);
  assert.equal(session.pausedMs, 5 * 60_000);
  assert.equal(new Date(focusSessionEnd(session)).toISOString(), '2026-07-17T02:40:00.000Z');
});

test('focus settings validate and persist through sanitization', () => {
  let store = emptyStore();
  assert.throws(
    () => applyCommand(store, { type: 'setFocusSettings', payload: {} }),
    /at least one/,
  );
  store = applyCommand(store, {
    type: 'setFocusSettings',
    eventId: 'settings-2',
    payload: { dailyGoalMinutes: 9999, defaultMinutes: 1 },
  });
  assert.equal(store.meta.focusSettings.dailyGoalMinutes, 1440);
  assert.equal(store.meta.focusSettings.defaultMinutes, 5);
  const reloaded = sanitizeStore(JSON.parse(JSON.stringify(store)), { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.deepEqual(reloaded.meta.focusSettings, store.meta.focusSettings);
});

test('interrupted sessions complete when the window elapsed and wither otherwise', () => {
  const store = storeWithSession();
  const session = store.focusSessions[0];
  const domain = require('../src/domain');

  const past = Focus.resolveInterruptedSession(session, new Date('2026-07-17T03:00:00.000Z'), domain);
  assert.equal(past.action, 'complete');
  assert.equal(past.occurredAt, '2026-07-17T02:35:00.000Z');

  const early = Focus.resolveInterruptedSession(session, new Date('2026-07-17T02:20:00.000Z'), domain);
  assert.equal(early.action, 'abandon');

  const paused = Focus.resolveInterruptedSession(
    { ...session, pausedAt: '2026-07-17T02:12:00.000Z' },
    new Date('2026-07-18T00:00:00.000Z'),
    domain,
  );
  assert.equal(paused.action, 'abandon');
});

test('daily bars and range statistics only ever count completed sessions', () => {
  const sessions = [
    { id: 'a', plannedMinutes: 25, startedAt: '2026-07-15T01:00:00.000Z', endedAt: '2026-07-15T01:25:00.000Z', status: 'completed', focusedMinutes: 25, pausedAt: null, pausedMs: 0, reportingDate: '2026-07-15' },
    { id: 'b', plannedMinutes: 60, startedAt: '2026-07-15T03:00:00.000Z', endedAt: '2026-07-15T04:00:00.000Z', status: 'completed', focusedMinutes: 60, pausedAt: null, pausedMs: 0, reportingDate: '2026-07-15' },
    { id: 'c', plannedMinutes: 45, startedAt: '2026-07-16T01:00:00.000Z', endedAt: '2026-07-16T01:20:00.000Z', status: 'abandoned', focusedMinutes: 20, pausedAt: null, pausedMs: 0, reportingDate: '2026-07-16' },
    { id: 'd', plannedMinutes: 30, startedAt: '2026-07-17T01:00:00.000Z', endedAt: '2026-07-17T01:30:00.000Z', status: 'completed', focusedMinutes: 30, pausedAt: null, pausedMs: 0, reportingDate: '2026-07-17' },
  ];

  const days = Focus.recentFocusDays(sessions, '2026-07-17', 7);
  assert.equal(days.length, 7);
  assert.deepEqual(days.at(-1), { date: '2026-07-17', minutes: 30 });
  assert.deepEqual(days.at(-2), { date: '2026-07-16', minutes: 0 });
  assert.deepEqual(days.at(-3), { date: '2026-07-15', minutes: 85 });

  const stats = Focus.rangeFocusStats(sessions, '2026-07-01', '2026-07-31');
  assert.equal(stats.totalMinutes, 115);
  assert.equal(stats.completedCount, 3);
  assert.equal(stats.abandonedCount, 1);
  assert.equal(stats.activeDays, 2);
  assert.equal(stats.dailyAverage, 58);
  assert.deepEqual(stats.bestDay, { date: '2026-07-15', minutes: 85 });

  assert.equal(Focus.rangeFocusStats(sessions, '2026-08-01', '2026-08-31').totalMinutes, 0);
});

test('growth stages progress from seed to mature', () => {
  assert.equal(Focus.growthStage(0), 'seed');
  assert.equal(Focus.growthStage(0.3), 'sprout');
  assert.equal(Focus.growthStage(0.5), 'sapling');
  assert.equal(Focus.growthStage(0.8), 'young');
  assert.equal(Focus.growthStage(1), 'mature');
});

test('quarter reports embed focus statistics only when sessions exist', () => {
  let store = storeWithSession();
  const before = Reporting.buildPeriodReport(emptyStore(), { year: 2026, quarter: 3, today: '2026-07-17' });
  assert.equal(before.focus.completedCount, 0);
  assert.equal(Reporting.reportToMarkdown(before).includes('专注统计'), false);

  store = applyCommand(store, {
    type: 'completeFocusSession',
    eventId: 'focus-complete-focus-1',
    payload: { sessionId: 'focus-1' },
    occurredAt: '2026-07-17T02:35:00.000Z',
  });
  const report = Reporting.buildPeriodReport(store, { year: 2026, quarter: 3, today: '2026-07-17' });
  assert.equal(report.focus.totalMinutes, 25);
  assert.equal(report.focus.completedCount, 1);
  const markdown = Reporting.reportToMarkdown(report);
  assert.equal(markdown.includes('## 专注统计'), true);
  assert.equal(markdown.includes('专注总时长：25 分钟（1 次完成）'), true);
});
