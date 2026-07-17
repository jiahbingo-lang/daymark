const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeStore,
  applyCommand,
  focusSessionEnd,
  STORE_VERSION,
} = require('../src/domain');
const Focus = require('../src/focus');
const Reporting = require('../src/reporting');
const Calendar = require('../src/calendar');

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

test('v1 and v2 stores upgrade to the current version with focus defaults', () => {
  const fromV1 = emptyStore();
  assert.equal(fromV1.version, STORE_VERSION);
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
  assert.equal(fromV2.version, STORE_VERSION);
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

test('the pomodoro and the stopwatch cannot run at the same time', () => {
  // Both measure wall-clock focus time, so overlapping them would count the
  // same minutes twice across two statistics that would then disagree.
  const running = storeWithSession();
  assert.throws(
    () => applyCommand(running, {
      type: 'startFocus',
      taskId: 'task-1',
      payload: { entryId: 'time-1' },
      occurredAt: '2026-07-17T02:12:00.000Z',
    }),
    /already running/,
  );

  let stopwatch = emptyStore();
  stopwatch = applyCommand(stopwatch, {
    type: 'create',
    taskId: 'task-1',
    payload: { title: '整理季度数据' },
    occurredAt: '2026-07-17T02:01:00.000Z',
  });
  stopwatch = applyCommand(stopwatch, {
    type: 'startFocus',
    taskId: 'task-1',
    payload: { entryId: 'time-1' },
    occurredAt: '2026-07-17T02:05:00.000Z',
  });
  assert.throws(
    () => applyCommand(stopwatch, {
      type: 'startFocusSession',
      payload: { sessionId: 'focus-9', plannedMinutes: 25 },
      occurredAt: '2026-07-17T02:06:00.000Z',
    }),
    /already running/,
  );
});

test('a completed pomodoro records a time entry, an abandoned one records none', () => {
  let store = storeWithSession();
  store = applyCommand(store, {
    type: 'completeFocusSession',
    eventId: 'complete-1',
    payload: { sessionId: 'focus-1' },
    occurredAt: '2026-07-17T02:35:00.000Z',
  });
  assert.equal(store.timeEntries.length, 1);
  const entry = store.timeEntries[0];
  assert.equal(entry.source, 'pomodoro');
  assert.equal(entry.taskId, 'task-1');
  assert.equal(entry.durationSeconds, 25 * 60);
  assert.equal(entry.reportingDate, '2026-07-17');
  assert.equal(entry.endedAt, '2026-07-17T02:35:00.000Z');

  let abandoned = storeWithSession();
  abandoned = applyCommand(abandoned, {
    type: 'abandonFocusSession',
    eventId: 'abandon-1',
    payload: { sessionId: 'focus-1' },
    occurredAt: '2026-07-17T02:20:00.000Z',
  });
  assert.equal(abandoned.focusSessions[0].status, 'abandoned');
  assert.deepEqual(abandoned.timeEntries, []);
});

test('a free pomodoro with no task still records its minutes', () => {
  let store = emptyStore();
  store = applyCommand(store, {
    type: 'startFocusSession',
    eventId: 'start-free',
    payload: { sessionId: 'focus-free', plannedMinutes: 45 },
    occurredAt: '2026-07-17T02:10:00.000Z',
  });
  store = applyCommand(store, {
    type: 'completeFocusSession',
    eventId: 'complete-free',
    payload: { sessionId: 'focus-free' },
    occurredAt: '2026-07-17T02:55:00.000Z',
  });
  assert.equal(store.timeEntries.length, 1);
  assert.equal(store.timeEntries[0].taskId, null);
  assert.equal(store.timeEntries[0].durationSeconds, 45 * 60);
});

test('either v3 shape upgrades to v4 keeping the half it already had', () => {
  // Two mutually unaware v3 builds shipped: one wrote daily-planning data, the
  // other focus sessions. Both files must survive the upgrade intact.
  const releasedV3 = sanitizeStore({
    version: 3,
    meta: {
      historyStartAt: NOW.toISOString(),
      timeZone: 'Asia/Shanghai',
      nextSeq: 1,
      dailyNotes: {},
      dailyPlans: { '2026-07-17': { date: '2026-07-17', shutdownNote: '收尾说明' } },
    },
    tasks: [],
    events: [],
    dailyArchives: [],
    scheduleBlocks: [],
    timeEntries: [],
  }, { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(releasedV3.version, STORE_VERSION);
  assert.equal(releasedV3.meta.dailyPlans['2026-07-17'].shutdownNote, '收尾说明');
  assert.deepEqual(releasedV3.focusSessions, []);
  assert.equal(releasedV3.meta.focusSettings.defaultMinutes, 25);

  const focusV3 = sanitizeStore({
    version: 3,
    meta: {
      historyStartAt: NOW.toISOString(),
      timeZone: 'Asia/Shanghai',
      nextSeq: 1,
      dailyNotes: {},
      focusSettings: { defaultMinutes: 45, strictMode: false },
    },
    tasks: [],
    events: [],
    dailyArchives: [],
    focusSessions: [{
      id: 'focus-old',
      taskId: null,
      plannedMinutes: 25,
      startedAt: '2026-07-16T02:00:00.000Z',
      endedAt: '2026-07-16T02:25:00.000Z',
      status: 'completed',
      focusedMinutes: 25,
      reportingDate: '2026-07-16',
    }],
  }, { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(focusV3.version, STORE_VERSION);
  assert.equal(focusV3.focusSessions.length, 1);
  assert.equal(focusV3.focusSessions[0].id, 'focus-old');
  assert.equal(focusV3.meta.focusSettings.defaultMinutes, 45);
  assert.equal(focusV3.meta.focusSettings.strictMode, false);
  assert.deepEqual(focusV3.meta.dailyPlans, {});
  assert.deepEqual(focusV3.timeEntries, []);
});

test('free focus minutes reach the day detail, deleted task minutes do not', () => {
  let free = emptyStore();
  free = applyCommand(free, {
    type: 'startFocusSession',
    eventId: 'start-free-2',
    payload: { sessionId: 'focus-free-2', plannedMinutes: 45 },
    occurredAt: '2026-07-17T02:10:00.000Z',
  });
  free = applyCommand(free, {
    type: 'completeFocusSession',
    eventId: 'complete-free-2',
    payload: { sessionId: 'focus-free-2' },
    occurredAt: '2026-07-17T02:55:00.000Z',
  });
  const freeDetail = Calendar.buildDateDetail(free, '2026-07-17');
  assert.equal(freeDetail.summary.actualMinutes, 45);
  assert.equal(freeDetail.actualTime[0].title, '自由专注');
  assert.equal(freeDetail.actualTime[0].taskId, null);

  // Withdrawing a task must still withdraw the time recorded against it.
  let deleted = storeWithSession();
  deleted = applyCommand(deleted, {
    type: 'completeFocusSession',
    eventId: 'complete-2',
    payload: { sessionId: 'focus-1' },
    occurredAt: '2026-07-17T02:35:00.000Z',
  });
  assert.equal(Calendar.buildDateDetail(deleted, '2026-07-17').summary.actualMinutes, 25);
  deleted = applyCommand(deleted, {
    type: 'delete',
    taskId: 'task-1',
    occurredAt: '2026-07-17T03:00:00.000Z',
  });
  assert.equal(Calendar.buildDateDetail(deleted, '2026-07-17').summary.actualMinutes, 0);
});
