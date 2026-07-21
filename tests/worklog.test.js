const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeStore, applyCommand, STORE_VERSION, timeEntryDayEnd } = require('../src/domain');
const Worklog = require('../src/worklog');

const NOW = new Date('2026-07-20T02:00:00.000Z');
const ZONE = 'Asia/Shanghai';

function baseStore() {
  return sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: ZONE });
}

function withTask(store, id, title, patch = {}) {
  return applyCommand(store, {
    type: 'create',
    taskId: id,
    payload: { title, ...patch },
    occurredAt: '2026-07-20T00:10:00.000Z',
  });
}

// China time is UTC+8, so 01:05Z is 09:05 locally.
function run(store, taskId, entryId, fromUtc, toUtc) {
  let next = applyCommand(store, {
    type: 'startFocus', taskId, payload: { entryId }, occurredAt: fromUtc,
  });
  if (toUtc) {
    next = applyCommand(next, {
      type: 'stopFocus', taskId, payload: { entryId }, occurredAt: toUtc,
    });
  }
  return next;
}

test('a paused and resumed task keeps every stretch as its own segment', () => {
  let store = withTask(baseStore(), 't1', '整理季度数据');
  store = run(store, 't1', 'e1', '2026-07-20T01:05:00.000Z', '2026-07-20T01:50:00.000Z');
  store = run(store, 't1', 'e2', '2026-07-20T03:00:00.000Z', '2026-07-20T03:42:00.000Z');

  const segments = Worklog.segmentsForDate(store, '2026-07-20', { now: NOW });
  assert.equal(segments.length, 2);
  assert.deepEqual(
    segments.map((s) => `${Worklog.formatMinute(s.startMinute)}–${Worklog.formatMinute(s.endMinute)}`),
    ['09:05–09:50', '11:00–11:42'],
  );
  assert.equal(Worklog.actualMinutesForTask(store, 't1', { now: NOW }), 87);
});

test('the daily summary separates recorded time from the gaps between it', () => {
  let store = withTask(baseStore(), 't1', '整理季度数据');
  store = run(store, 't1', 'e1', '2026-07-20T01:05:00.000Z', '2026-07-20T01:50:00.000Z');
  store = run(store, 't1', 'e2', '2026-07-20T03:00:00.000Z', '2026-07-20T03:42:00.000Z');

  const summary = Worklog.dailySummary(store, '2026-07-20', { now: NOW });
  assert.equal(summary.minutes, 87);
  assert.equal(summary.segmentCount, 2);
  assert.equal(summary.taskCount, 1);
  assert.equal(Worklog.formatMinute(summary.firstMinute), '09:05');
  assert.equal(Worklog.formatMinute(summary.lastMinute), '11:42');
  // 09:05 to 11:42 is 157 minutes, of which 87 were recorded.
  assert.equal(summary.idleMinutes, 70);
});

test('the rollup groups a task across its segments, busiest first', () => {
  let store = withTask(baseStore(), 't1', '整理季度数据');
  store = withTask(store, 't2', '回复评审意见');
  store = run(store, 't1', 'e1', '2026-07-20T01:05:00.000Z', '2026-07-20T01:50:00.000Z');
  store = run(store, 't2', 'e2', '2026-07-20T02:00:00.000Z', '2026-07-20T02:14:00.000Z');
  store = run(store, 't1', 'e3', '2026-07-20T03:00:00.000Z', '2026-07-20T03:42:00.000Z');

  const rollup = Worklog.taskRollup(store, '2026-07-20', { now: NOW });
  assert.deepEqual(rollup.map((row) => [row.title, row.minutes, row.segments.length]), [
    ['整理季度数据', 87, 2],
    ['回复评审意见', 14, 1],
  ]);
});

test('a running stretch is measured up to now and marked as still going', () => {
  let store = withTask(baseStore(), 't1', '整理季度数据');
  store = run(store, 't1', 'e1', '2026-07-20T01:05:00.000Z', null);

  const at = new Date('2026-07-20T01:35:00.000Z');
  const segments = Worklog.segmentsForDate(store, '2026-07-20', { now: at });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].running, true);
  assert.equal(segments[0].minutes, 30);
  assert.equal(Worklog.dailySummary(store, '2026-07-20', { now: at }).running, true);
});

test('completing a task closes the stretch it was being timed for', () => {
  let store = withTask(baseStore(), 't1', '整理季度数据');
  store = run(store, 't1', 'e1', '2026-07-20T01:05:00.000Z', null);
  assert.equal(Worklog.runningEntry(store).id, 'e1');

  store = applyCommand(store, { type: 'toggle', taskId: 't1', occurredAt: '2026-07-20T01:35:00.000Z' });
  assert.equal(store.tasks[0].status, 'completed');
  assert.equal(Worklog.runningEntry(store), null);
  assert.equal(store.timeEntries[0].durationSeconds, 1800);
});

test('a timer left running overnight is cut at the end of the day it belongs to', () => {
  let store = withTask(baseStore(), 't1', '整理季度数据');
  // Starts 22:00 China time and is only stopped at 09:00 the next morning.
  store = run(store, 't1', 'e1', '2026-07-20T14:00:00.000Z', '2026-07-21T01:00:00.000Z');

  const entry = store.timeEntries[0];
  assert.equal(entry.endedAt, '2026-07-20T16:00:00.000Z');
  assert.equal(entry.durationSeconds, 7200, '22:00 到 24:00 应记 2 小时');
  assert.equal(timeEntryDayEnd(entry, ZONE), '2026-07-20T16:00:00.000Z');
});

test('a run still open from an earlier day is reported as stale', () => {
  let store = withTask(baseStore(), 't1', '整理季度数据');
  store = run(store, 't1', 'e1', '2026-07-20T14:00:00.000Z', null);

  assert.equal(Worklog.staleRunningEntry(store, '2026-07-21').id, 'e1');
  assert.equal(Worklog.staleRunningEntry(store, '2026-07-20'), null, '当天的计时不算过期');
});

test('a free run and a deleted task both keep their place in the log', () => {
  let store = withTask(baseStore(), 't1', '临时任务');
  store = run(store, 't1', 'e1', '2026-07-20T01:05:00.000Z', '2026-07-20T01:35:00.000Z');
  store = applyCommand(store, { type: 'delete', taskId: 't1', occurredAt: '2026-07-20T04:00:00.000Z' });

  const segments = Worklog.segmentsForDate(store, '2026-07-20', { now: NOW });
  assert.equal(segments.length, 1, '时间花掉了就是花掉了，任务被删不代表没发生');
  assert.equal(segments[0].taskDeleted, true);
  assert.equal(segments[0].minutes, 30);
});

test('the week helper starts on Monday', () => {
  assert.equal(Worklog.startOfWeek('2026-07-22'), '2026-07-20');
  assert.deepEqual(Worklog.weekDates('2026-07-22').slice(0, 3), ['2026-07-20', '2026-07-21', '2026-07-22']);
});

test('v4 data upgrades to v5 without disturbing what it already held', () => {
  const upgraded = sanitizeStore({
    version: 4,
    meta: {
      historyStartAt: NOW.toISOString(), timeZone: ZONE, nextSeq: 1, dailyNotes: {},
    },
    tasks: [],
    events: [],
    dailyArchives: [],
    timeEntries: [{
      id: 'old-entry',
      taskId: null,
      startedAt: '2026-07-19T01:00:00.000Z',
      endedAt: '2026-07-19T01:30:00.000Z',
      durationSeconds: 1800,
      reportingDate: '2026-07-19',
      source: 'focus',
    }],
    scheduleBlocks: [{
      id: 'legacy-block', taskId: 't1', date: '2026-07-19', startMinute: 540, durationMinutes: 60, locked: true,
    }],
  }, { now: NOW, timeZone: ZONE });

  assert.equal(upgraded.version, STORE_VERSION);
  assert.equal(upgraded.timeEntries.length, 1);
  assert.equal(upgraded.timeEntries[0].durationSeconds, 1800);
  // The execution calendar is gone from the interface, but its data is kept so
  // the decision to drop that feature stays reversible.
  assert.equal(upgraded.scheduleBlocks.length, 1);
});
