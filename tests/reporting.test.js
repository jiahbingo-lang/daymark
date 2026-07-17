const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  buildDailyRecord,
  finalizeMissingArchives,
  listDailyRecords,
  buildPeriodReport,
  reportToMarkdown,
} = require('../src/reporting');
const { sanitizeStore, applyCommand } = require('../src/domain');

function task(id, title, overrides = {}) {
  return {
    id,
    title,
    notes: '',
    status: 'active',
    plannedDate: null,
    top3Date: null,
    estimateMinutes: 0,
    area: '',
    priority: 'none',
    completedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function event(seq, reportingDate, type, before, after) {
  return {
    eventId: `event-${seq}`,
    seq,
    taskId: after?.id || before?.id,
    type,
    occurredAt: `${reportingDate}T18:00:00.000Z`,
    reportingDate,
    timeZone: 'UTC',
    before,
    after,
  };
}

function store(overrides = {}) {
  return {
    version: 2,
    meta: {
      historyStartAt: '2026-06-30T00:00:00.000Z',
      timeZone: 'UTC',
      nextSeq: 1,
      dailyCapacityMinutes: 360,
      dailyNotes: {},
    },
    tasks: [],
    events: [],
    dailyArchives: [],
    ...overrides,
  };
}

test('buildDailyRecord reverses later edits and deletion to retain event-time snapshots', () => {
  const original = task('one', '完成旧标题', {
    plannedDate: '2026-07-01',
    top3Date: '2026-07-01',
    estimateMinutes: 60,
    area: '研发',
    priority: 'high',
  });
  const completed = { ...original, status: 'completed', completedAt: '2026-07-01T18:00:00.000Z' };
  const renamed = { ...completed, title: '后来改过的标题' };
  const deleted = { ...renamed, deletedAt: '2026-07-03T18:00:00.000Z' };
  const source = store({
    meta: {
      ...store().meta,
      nextSeq: 5,
      dailyNotes: { '2026-07-01': '交付了第一版' },
    },
    tasks: [deleted],
    events: [
      event(1, '2026-07-01', 'task.created', null, original),
      event(2, '2026-07-01', 'task.completed', original, completed),
      event(3, '2026-07-02', 'task.updated', completed, renamed),
      event(4, '2026-07-03', 'task.deleted', renamed, deleted),
    ],
  });

  const record = buildDailyRecord(source, '2026-07-01');

  assert.equal(record.cutoffSeq, 2);
  assert.deepEqual(record.planned.map((item) => item.title), ['完成旧标题']);
  assert.deepEqual(record.completed.map((item) => item.title), ['完成旧标题']);
  assert.deepEqual(record.created.map((item) => item.title), ['完成旧标题']);
  assert.deepEqual(record.top3.map((item) => item.id), ['one']);
  assert.equal(record.dailyNotes, '交付了第一版');
  assert.equal(record.summary.completionRate, 100);
  assert.equal(record.summary.plannedMinutes, 60);
  assert.equal(record.dataIntegrity.complete, true);
  assert.equal(source.tasks[0].title, '后来改过的标题');
});

test('daily categories distinguish completed, reopened, deleted, and carried tasks', () => {
  const carrying = task('carry', '继续处理', { plannedDate: '2026-07-05' });
  const doneBefore = task('done', '当天完成', { plannedDate: '2026-07-05', priority: 'high' });
  const doneAfter = { ...doneBefore, status: 'completed', completedAt: '2026-07-05T12:00:00.000Z' };
  const reopenBefore = task('reopen', '完成后恢复', { plannedDate: '2026-07-05' });
  const reopenCompleted = { ...reopenBefore, status: 'completed', completedAt: '2026-07-05T13:00:00.000Z' };
  const reopenAfter = { ...reopenCompleted, status: 'active', completedAt: null };
  const deleteBefore = task('deleted', '删除前标题', { plannedDate: '2026-07-05' });
  const deleteAfter = { ...deleteBefore, title: '删除后的墓碑', deletedAt: '2026-07-05T15:00:00.000Z' };
  const source = store({
    meta: { ...store().meta, nextSeq: 5 },
    tasks: [carrying, doneAfter, reopenAfter, deleteAfter],
    events: [
      event(1, '2026-07-05', 'task.completed', doneBefore, doneAfter),
      event(2, '2026-07-05', 'task.completed', reopenBefore, reopenCompleted),
      event(3, '2026-07-05', 'task.reopened', reopenCompleted, reopenAfter),
      event(4, '2026-07-05', 'task.deleted', deleteBefore, deleteAfter),
    ],
  });

  const record = buildDailyRecord(source, '2026-07-05');

  assert.deepEqual(new Set(record.planned.map((item) => item.id)), new Set(['carry', 'done', 'reopen', 'deleted']));
  assert.deepEqual(record.completed.map((item) => item.id), ['done']);
  assert.deepEqual(record.reopened.map((item) => item.id), ['reopen']);
  assert.deepEqual(record.deleted.map((item) => item.title), ['删除前标题']);
  assert.deepEqual(new Set(record.carried.map((item) => item.id)), new Set(['carry', 'reopen']));
  assert.equal(record.summary.completedPlannedCount, 1);
  assert.equal(record.summary.completedCount, 1);
  assert.equal(record.summary.completionRate, 25);
});

test('same-day postponement remains in the original plan denominator', () => {
  let source = sanitizeStore(
    { version: 1, tasks: [] },
    { now: new Date('2026-01-01T08:00:00.000Z'), timeZone: 'UTC' },
  );
  source = applyCommand(source, {
    type: 'create', eventId: 'create-done', taskId: 'done', occurredAt: '2026-01-02T09:00:00.000Z',
    payload: { title: '当天完成', plannedDate: '2026-01-02' },
  });
  source = applyCommand(source, {
    type: 'create', eventId: 'create-delayed', taskId: 'delayed', occurredAt: '2026-01-02T09:01:00.000Z',
    payload: { title: '当天延期', plannedDate: '2026-01-02' },
  });
  source = applyCommand(source, {
    type: 'toggle', eventId: 'complete-done', taskId: 'done', occurredAt: '2026-01-02T12:00:00.000Z',
  });
  source = applyCommand(source, {
    type: 'update', eventId: 'postpone-delayed', taskId: 'delayed', occurredAt: '2026-01-02T13:00:00.000Z',
    payload: { plannedDate: '2026-01-03' },
  });

  const record = buildDailyRecord(source, '2026-01-02');

  assert.deepEqual(new Set(record.planned.map((item) => item.id)), new Set(['done', 'delayed']));
  assert.equal(record.planned.find((item) => item.id === 'delayed').plannedDate, '2026-01-02');
  assert.equal(record.summary.plannedCount, 2);
  assert.equal(record.summary.completedPlannedCount, 1);
  assert.equal(record.summary.completionRate, 50);
  assert.equal(source.tasks.find((item) => item.id === 'delayed').plannedDate, '2026-01-03');
});

test('moving a task to Inbox withdraws it from that date review', () => {
  let source = sanitizeStore(
    { version: 1, tasks: [] },
    { now: new Date('2026-01-02T08:00:00.000Z'), timeZone: 'UTC' },
  );
  source = applyCommand(source, {
    type: 'create', eventId: 'create-inbox', taskId: 'inbox', occurredAt: '2026-01-02T09:00:00.000Z',
    payload: { title: '撤回计划', plannedDate: '2026-01-02', top3Date: '2026-01-02' },
  });
  source = applyCommand(source, {
    type: 'update', eventId: 'move-inbox', taskId: 'inbox', occurredAt: '2026-01-02T10:00:00.000Z',
    payload: { plannedDate: null },
  });

  const record = buildDailyRecord(source, '2026-01-02');

  assert.deepEqual(record.planned, []);
  assert.deepEqual(record.top3, []);
  assert.deepEqual(record.carried, []);
  assert.equal(record.summary.plannedCount, 0);
  assert.equal(record.summary.top3Count, 0);
  assert.equal(source.tasks.find((item) => item.id === 'inbox').plannedDate, null);
});

test('a task created today for tomorrow is attributed only to its planned date', () => {
  let source = sanitizeStore({ version: 1, tasks: [] }, {
    now: new Date('2026-07-15T17:00:00.000Z'),
    timeZone: 'America/Los_Angeles',
  });
  source = applyCommand(source, {
    type: 'create',
    eventId: 'create-tomorrow',
    taskId: 'tomorrow',
    occurredAt: '2026-07-15T18:00:00.000Z',
    payload: { title: '准备明日评审', plannedDate: '2026-07-16', estimateMinutes: 60 },
  });

  const today = buildDailyRecord(source, '2026-07-15');
  const tomorrow = buildDailyRecord(source, '2026-07-16');
  const report = buildPeriodReport(source, {
    year: 2026,
    quarter: 3,
    today: '2026-07-15',
  });

  assert.deepEqual(today.planned, []);
  assert.deepEqual(today.completed, []);
  assert.deepEqual(today.created.map((item) => item.id), ['tomorrow'], 'creation remains auditable');
  assert.equal(today.summary.plannedCount, 0);
  assert.deepEqual(tomorrow.planned.map((item) => item.id), ['tomorrow']);
  assert.equal(tomorrow.summary.plannedCount, 1);
  assert.equal(report.totals.activeDays, 0, 'creation alone is not a worked day');
  assert.equal(report.totals.planned, 0, 'future work is outside a report through today');
});

test('same-day completion notes enrich the completed snapshot without rewriting later history', () => {
  let source = sanitizeStore({ version: 1, tasks: [] }, {
    now: new Date('2026-07-15T08:00:00.000Z'),
    timeZone: 'UTC',
  });
  source = applyCommand(source, {
    type: 'create', eventId: 'create-result', taskId: 'result', occurredAt: '2026-07-15T09:00:00.000Z',
    payload: { title: '完成季度复盘', plannedDate: '2026-07-15' },
  });
  source = applyCommand(source, {
    type: 'toggle', eventId: 'complete-result', taskId: 'result', occurredAt: '2026-07-15T10:00:00.000Z',
  });
  source = applyCommand(source, {
    type: 'update', eventId: 'note-result', taskId: 'result', occurredAt: '2026-07-15T11:00:00.000Z',
    payload: { completionNote: '交付了可验证的报告首版' },
  });
  source = applyCommand(source, {
    type: 'update', eventId: 'rename-later', taskId: 'result', occurredAt: '2026-07-16T11:00:00.000Z',
    payload: { title: '后来改名' },
  });

  const record = buildDailyRecord(source, '2026-07-15');

  assert.equal(record.completed[0].title, '完成季度复盘');
  assert.equal(record.completed[0].completionNote, '交付了可验证的报告首版');
});

test('deleting a completed task removes it from archived review records and period totals', () => {
  let source = sanitizeStore({ version: 1, tasks: [] }, {
    now: new Date('2026-07-14T08:00:00.000Z'),
    timeZone: 'UTC',
  });
  source = applyCommand(source, {
    type: 'create', eventId: 'create-removable', taskId: 'removable', occurredAt: '2026-07-14T09:00:00.000Z',
    payload: { title: '待删除的完成事项', plannedDate: '2026-07-14', estimateMinutes: 45 },
  });
  source = applyCommand(source, {
    type: 'toggle', eventId: 'complete-removable', taskId: 'removable', occurredAt: '2026-07-14T10:00:00.000Z',
  });
  source = finalizeMissingArchives(source, '2026-07-15', {
    finalizedAt: '2026-07-15T00:00:00.000Z',
  });
  assert.equal(source.dailyArchives[0].completed.length, 1);

  source = applyCommand(source, {
    type: 'delete', eventId: 'delete-removable', taskId: 'removable', occurredAt: '2026-07-15T09:00:00.000Z',
  });

  const record = listDailyRecords(source).find((entry) => entry.date === '2026-07-14');
  assert.deepEqual(record.planned, []);
  assert.deepEqual(record.completed, []);
  assert.equal(record.summary.plannedCount, 0);
  assert.equal(record.summary.completedCount, 0);
  assert.equal(record.summary.completedMinutes, 0);
  assert.equal(source.dailyArchives[0].completed.length, 1, 'audit archive remains immutable');

  const report = buildPeriodReport(source, { year: 2026, quarter: 3, today: '2026-07-15' });
  assert.equal(report.totals.planned, 0);
  assert.equal(report.totals.completed, 0);
  assert.equal(report.totals.completedMinutes, 0);
});

test('duration and completion notes edited later sync back to the archived completion day', () => {
  let source = sanitizeStore({ version: 1, tasks: [] }, {
    now: new Date('2026-07-14T08:00:00.000Z'),
    timeZone: 'UTC',
  });
  source = applyCommand(source, {
    type: 'create', eventId: 'create-duration', taskId: 'duration', occurredAt: '2026-07-14T09:00:00.000Z',
    payload: { title: '补录完成用时', plannedDate: '2026-07-14' },
  });
  source = applyCommand(source, {
    type: 'toggle', eventId: 'complete-duration', taskId: 'duration', occurredAt: '2026-07-14T10:00:00.000Z',
  });
  source = finalizeMissingArchives(source, '2026-07-15', {
    finalizedAt: '2026-07-15T00:00:00.000Z',
  });
  source = applyCommand(source, {
    type: 'update', eventId: 'update-duration', taskId: 'duration', occurredAt: '2026-07-15T09:00:00.000Z',
    payload: { estimateMinutes: 95, completionNote: '完成后补录结果' },
  });

  const record = listDailyRecords(source).find((entry) => entry.date === '2026-07-14');
  assert.equal(record.planned[0].estimateMinutes, 95);
  assert.equal(record.completed[0].estimateMinutes, 95);
  assert.equal(record.completed[0].completionNote, '完成后补录结果');
  assert.equal(record.summary.plannedMinutes, 95);
  assert.equal(record.summary.completedMinutes, 95);
  assert.equal(source.dailyArchives[0].completed[0].estimateMinutes, null, 'audit archive remains immutable');

  const report = buildPeriodReport(source, { year: 2026, quarter: 3, today: '2026-07-15' });
  assert.equal(report.totals.plannedMinutes, 95);
  assert.equal(report.totals.completedMinutes, 95);
});

test('reopening an archived completion withdraws it from review totals and AI-facing records', () => {
  let source = sanitizeStore({ version: 1, tasks: [] }, {
    now: new Date('2026-07-14T08:00:00.000Z'),
    timeZone: 'UTC',
  });
  source = applyCommand(source, {
    type: 'create', eventId: 'create-reopen', taskId: 'reopen', occurredAt: '2026-07-14T09:00:00.000Z',
    payload: { title: '误点完成的事项', plannedDate: '2026-07-14', estimateMinutes: 75 },
  });
  source = applyCommand(source, {
    type: 'toggle', eventId: 'complete-reopen', taskId: 'reopen', occurredAt: '2026-07-14T10:00:00.000Z',
  });
  source = finalizeMissingArchives(source, '2026-07-15', {
    finalizedAt: '2026-07-15T00:00:00.000Z',
  });
  assert.equal(source.dailyArchives[0].completed.length, 1);

  source = applyCommand(source, {
    type: 'toggle', eventId: 'restore-todo', taskId: 'reopen', occurredAt: '2026-07-15T09:00:00.000Z',
  });

  const record = listDailyRecords(source).find((entry) => entry.date === '2026-07-14');
  assert.deepEqual(record.planned.map((item) => item.id), ['reopen']);
  assert.deepEqual(record.completed, []);
  assert.equal(record.summary.completedCount, 0);
  assert.equal(record.summary.completedPlannedCount, 0);
  assert.equal(record.summary.completionRate, 0);
  assert.equal(record.summary.completedMinutes, 0);
  assert.equal(source.dailyArchives[0].completed.length, 1, 'audit archive remains immutable');

  const report = buildPeriodReport(source, { year: 2026, quarter: 3, today: '2026-07-15' });
  assert.equal(report.totals.planned, 1);
  assert.equal(report.totals.completed, 0);
  assert.equal(report.totals.completedPlanned, 0);
  assert.equal(report.totals.completedMinutes, 0);
});

test('reporting consumes domain v2 toggle/meta events and ignores baseline imports as new work', () => {
  let source = sanitizeStore(
    { version: 1, tasks: [{ id: 'legacy', title: '迁移前任务', plannedDate: '2026-07-15' }] },
    { now: new Date('2026-07-15T08:00:00.000Z'), timeZone: 'UTC' },
  );
  source = applyCommand(source, {
    type: 'create', eventId: 'create-live', taskId: 'live', occurredAt: '2026-07-15T09:00:00.000Z',
    payload: { title: '当天新建', plannedDate: '2026-07-15' },
  });
  source = applyCommand(source, {
    type: 'toggle', eventId: 'complete-live', taskId: 'live', occurredAt: '2026-07-15T10:00:00.000Z',
  });
  source = applyCommand(source, {
    type: 'toggle', eventId: 'reopen-live', taskId: 'live', occurredAt: '2026-07-15T11:00:00.000Z',
  });
  source = applyCommand(source, {
    type: 'delete', eventId: 'delete-live', taskId: 'live', occurredAt: '2026-07-15T12:00:00.000Z',
  });
  source = applyCommand(source, {
    type: 'restore', eventId: 'restore-live', taskId: 'live', occurredAt: '2026-07-15T13:00:00.000Z',
  });
  source = applyCommand(source, {
    type: 'setDailyNote', eventId: 'note-old', occurredAt: '2026-07-15T14:00:00.000Z',
    payload: { date: '2026-07-15', note: '当天版本' },
  });
  source = applyCommand(source, {
    type: 'setCapacity', eventId: 'capacity-old', occurredAt: '2026-07-15T15:00:00.000Z',
    payload: { minutes: 300 },
  });
  source = applyCommand(source, {
    type: 'setDailyNote', eventId: 'note-new', occurredAt: '2026-07-16T14:00:00.000Z',
    payload: { date: '2026-07-15', note: '后来修改' },
  });
  source = applyCommand(source, {
    type: 'setCapacity', eventId: 'capacity-new', occurredAt: '2026-07-16T15:00:00.000Z',
    payload: { minutes: 200 },
  });

  const record = buildDailyRecord(source, '2026-07-15');

  assert.deepEqual(record.created.map((item) => item.id), ['live']);
  assert.deepEqual(record.completed, []);
  assert.deepEqual(record.reopened.map((item) => item.id), ['live']);
  assert.equal(record.summary.completedCount, 0);
  assert.equal(record.dailyNotes, '当天版本');
  assert.equal(record.dailyCapacityMinutes, 300);
});

test('finalizeMissingArchives fills history through yesterday without replacing existing dates', () => {
  const existing = {
    date: '2026-07-02',
    cutoffSeq: 99,
    finalized: true,
    planned: [{ id: 'preserved', title: '保留归档' }],
  };
  const source = store({
    meta: {
      ...store().meta,
      historyStartAt: '2026-07-01T12:00:00.000Z',
      dailyNotes: { '2026-07-03': '第三天' },
    },
    dailyArchives: [existing],
  });

  const once = finalizeMissingArchives(source, '2026-07-04', {
    now: new Date('2026-07-04T08:00:00.000Z'),
  });
  const twice = finalizeMissingArchives(once, '2026-07-04', {
    now: new Date('2026-07-04T09:00:00.000Z'),
  });

  assert.deepEqual(once.dailyArchives.map((record) => record.date), [
    '2026-07-01',
    '2026-07-02',
    '2026-07-03',
  ]);
  assert.deepEqual(once.dailyArchives.find((record) => record.date === '2026-07-02'), existing);
  assert.equal(once.dailyArchives.find((record) => record.date === '2026-07-03').dailyNotes, '第三天');
  assert.deepEqual(twice, once);
  assert.equal(source.dailyArchives.length, 1);
});

test('listDailyRecords optionally adds the current day and sorts newest first', () => {
  const current = task('current', '今天的任务', { plannedDate: '2026-07-03' });
  const source = store({
    tasks: [current],
    dailyArchives: [{ date: '2026-07-01' }, { date: '2026-07-02' }],
  });

  assert.deepEqual(listDailyRecords(source).map((record) => record.date), ['2026-07-02', '2026-07-01']);
  const records = listDailyRecords(source, { includeCurrent: true, today: '2026-07-03' });
  assert.deepEqual(records.map((record) => record.date), ['2026-07-03', '2026-07-02', '2026-07-01']);
  assert.equal(records[0].planned[0].title, '今天的任务');
  assert.equal(source.dailyArchives.length, 2);
});

function archivedRecord(date, { planned = [], completed = [], carried = [], note = '' } = {}) {
  return {
    date,
    cutoffSeq: 0,
    finalized: true,
    capacityMinutes: 360,
    dailyNotes: note,
    planned,
    top3: planned.filter((item) => item.top3Date === date),
    completed,
    created: [],
    deleted: [],
    reopened: [],
    carried,
    dataIntegrity: {
      status: 'complete',
      complete: true,
      historyStartAt: '2025-12-30T00:00:00.000Z',
      historyStartDate: '2025-12-30',
      missingSnapshotEvents: 0,
      message: '',
    },
  };
}

function reportFixture() {
  const carryJan = task('carry', '跨日事项', {
    plannedDate: '2026-01-10',
    area: '运营',
    estimateMinutes: 30,
  });
  const topA = task('top-a', '完成核心原型', {
    status: 'completed',
    plannedDate: '2026-01-10',
    top3Date: '2026-01-10',
    area: '研发',
    priority: 'high',
    estimateMinutes: 60,
  });
  const topB = task('top-b', '完成评审', {
    status: 'completed',
    plannedDate: '2026-01-10',
    top3Date: '2026-01-10',
    area: '研发',
    priority: 'medium',
    estimateMinutes: 30,
  });
  const carryFeb = { ...carryJan, plannedDate: '2026-02-12' };
  const highFeb = task('high-feb', '处理线上问题', {
    status: 'completed',
    plannedDate: '2026-02-12',
    top3Date: '2026-02-12',
    area: '运营',
    priority: 'high',
    estimateMinutes: 20,
  });
  const carryMar = { ...carryJan, plannedDate: '2026-03-20' };

  return store({
    meta: {
      ...store().meta,
      historyStartAt: '2025-12-30T00:00:00.000Z',
    },
    dailyArchives: [
      archivedRecord('2026-01-10', {
        planned: [carryJan, topA, topB],
        completed: [topA, topB],
        carried: [carryJan],
        note: '完成原型并通过评审',
      }),
      archivedRecord('2026-02-12', {
        planned: [carryFeb, highFeb],
        completed: [highFeb],
        carried: [carryFeb],
      }),
      archivedRecord('2026-03-20', {
        planned: [carryMar],
        carried: [carryMar],
        note: '等待外部接口',
      }),
    ],
  });
}

test('buildPeriodReport aggregates quarter metrics, focus work, areas, trends, carryovers, and notes', () => {
  const report = buildPeriodReport(reportFixture(), {
    year: 2026,
    quarter: 1,
    today: '2026-03-31',
  });

  assert.equal(report.type, 'quarter');
  assert.deepEqual(report.period, {
    startDate: '2026-01-01',
    endDate: '2026-03-31',
    throughDate: '2026-03-31',
  });
  assert.equal(report.totals.activeDays, 3);
  assert.equal(report.totals.planned, 4);
  assert.equal(report.totals.completed, 3);
  assert.equal(report.totals.completedPlanned, 3);
  assert.equal(report.totals.completionRate, 75);
  assert.deepEqual(
    { planned: report.top3.planned, completed: report.top3.completed, rate: report.top3.completionRate },
    { planned: 3, completed: 3, rate: 100 },
  );
  assert.equal(report.highPriority.completed, 2);
  assert.equal(report.byArea.find((entry) => entry.area === '研发').completed, 2);
  assert.deepEqual(report.monthlyTrend.map((entry) => entry.period), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(report.quarterlyTrend.map((entry) => entry.period), ['2026-Q1']);
  assert.deepEqual(report.longCarried.map((entry) => [entry.title, entry.days]), [['跨日事项', 3]]);
  assert.deepEqual(report.dailyNotes.map((entry) => entry.date), ['2026-01-10', '2026-03-20']);
  assert.equal(report.dataIntegrity.complete, true);

  const annual = buildPeriodReport(reportFixture(), { year: 2026, today: '2026-03-31' });
  assert.equal(annual.type, 'year');
  assert.equal(annual.quarter, null);
  assert.deepEqual(annual.quarterlyTrend.map((entry) => entry.period), ['2026-Q1']);
});

test('period reports flag migration-era gaps and render deterministic Markdown', () => {
  const source = store({
    meta: {
      ...store().meta,
      historyStartAt: '2026-02-15T12:00:00.000Z',
      dailyNotes: { '2026-03-01': '补充说明 | 含表格字符' },
    },
  });
  const report = buildPeriodReport(source, {
    year: 2026,
    quarter: 1,
    today: '2026-03-31',
  });
  const markdown = reportToMarkdown(report);

  assert.equal(report.dataIntegrity.status, 'partial');
  assert.equal(report.dataIntegrity.migrationHistoryIncomplete, true);
  assert.match(markdown, /^# 2026 年第 1 季度工作总结/m);
  assert.match(markdown, /⚠️ 数据完整性/);
  assert.match(markdown, /## 工作领域/);
  assert.match(markdown, /## 月度趋势/);
  assert.match(markdown, /## 每日备注/);
  assert.match(markdown, /补充说明 \| 含表格字符/);
  assert.ok(markdown.endsWith('\n'));
});

test('period reports count a multi-day task once while summing its daily planned minutes', () => {
  const ranged = task('range-report', '跨期交付', {
    plannedDate: '2026-07-20',
    dueDate: '2026-07-24',
    estimateMinutes: 240,
    area: '研发',
  });
  const source = store({ tasks: [ranged] });

  const report = buildPeriodReport(source, {
    year: 2026,
    quarter: 3,
    today: '2026-07-24',
  });

  assert.equal(report.totals.planned, 1);
  assert.equal(report.totals.plannedMinutes, 240);
  assert.equal(report.byArea.find((area) => area.area === '研发').planned, 1);
  assert.equal(report.byArea.find((area) => area.area === '研发').plannedMinutes, 240);
});

test('actual time flows from daily review into area and period estimate comparisons', () => {
  const completed = task('timed', '实现执行日历', {
    status: 'completed',
    plannedDate: '2026-07-16',
    dueDate: '2026-07-16',
    estimateMinutes: 60,
    area: '研发',
    completedAt: '2026-07-16T10:00:00.000Z',
  });
  const source = store({
    tasks: [completed],
    timeEntries: [
      { id: 'focus-a', taskId: 'timed', reportingDate: '2026-07-16', startedAt: '2026-07-16T08:00:00.000Z', endedAt: '2026-07-16T08:45:00.000Z', durationSeconds: 2700, source: 'focus' },
      { id: 'manual-b', taskId: 'timed', reportingDate: '2026-07-16', startedAt: '2026-07-16T09:00:00.000Z', endedAt: '2026-07-16T09:00:00.000Z', durationSeconds: 1800, source: 'manual' },
    ],
  });

  const daily = buildDailyRecord(source, '2026-07-16');
  assert.equal(daily.summary.actualMinutes, 75);
  assert.deepEqual(daily.actualTime.map((entry) => [entry.taskId, entry.minutes]), [['timed', 75]]);

  const report = buildPeriodReport(source, { year: 2026, quarter: 3, today: '2026-07-16' });
  assert.equal(report.totals.actualMinutes, 75);
  assert.equal(report.timeAnalysis.estimatedCompletedMinutes, 60);
  assert.equal(report.timeAnalysis.deviationMinutes, 15);
  assert.equal(report.byArea.find((area) => area.area === '研发').actualMinutes, 75);
  assert.match(reportToMarkdown(report), /实际记录用时：75 分钟/);

  const deleted = { ...completed, deletedAt: '2026-07-16T12:00:00.000Z' };
  assert.equal(buildDailyRecord({ ...source, tasks: [deleted] }, '2026-07-16').summary.actualMinutes, 0);

  const inbox = { ...completed, status: 'active', plannedDate: null, dueDate: null, completedAt: null };
  const actualOnly = buildPeriodReport({ ...source, tasks: [inbox] }, { year: 2026, quarter: 3, today: '2026-07-16' });
  assert.equal(actualOnly.totals.activeDays, 1);
  assert.equal(actualOnly.totals.planned, 0);
  assert.equal(actualOnly.totals.actualMinutes, 75);
});

test('the reporting bundle exposes the same pure API in a browser context', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'reporting.js'), 'utf8');
  const context = vm.createContext({ window: {}, Intl, Date });
  vm.runInContext(source, context);

  assert.equal(typeof context.window.DaymarkReporting.buildDailyRecord, 'function');
  assert.equal(typeof context.window.DaymarkReporting.buildPeriodReport, 'function');
  assert.equal(typeof context.window.DaymarkReporting.reportToMarkdown, 'function');
});
