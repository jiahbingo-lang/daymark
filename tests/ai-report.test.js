const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReportSourceData } = require('../src/ai-report');
const { sanitizeStore, applyCommand } = require('../src/domain');

const HISTORY_START = '2025-12-01T00:00:00.000Z';

function workTask(id, title, date, overrides = {}) {
  return {
    id,
    title,
    notes: `private-notes-${id}`,
    status: 'completed',
    dueDate: date,
    priority: 'medium',
    plannedDate: date,
    top3Date: null,
    estimateMinutes: 30,
    area: '产品',
    completionNote: `result-${id}`,
    repeatRule: null,
    reminderAt: `${date}T01:00:00.000Z`,
    reminderFiredAt: `${date}T01:00:00.000Z`,
    sourceUrl: `https://private.example/${id}`,
    revision: 2,
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T02:00:00.000Z`,
    completedAt: `${date}T02:00:00.000Z`,
    deletedAt: null,
    ...overrides,
  };
}

function record(date, completed, note = '') {
  const items = completed ? [completed] : [];
  return {
    date,
    cutoffSeq: 0,
    finalized: true,
    finalizedAt: `${date}T16:00:00.000Z`,
    capacityMinutes: 480,
    dailyCapacityMinutes: 480,
    dailyNotes: note,
    planned: items,
    top3: items.filter((item) => item.top3Date === date),
    completed: items,
    created: [],
    deleted: [],
    reopened: [],
    carried: [],
    summary: {
      plannedCount: items.length,
      completedCount: items.length,
      completedPlannedCount: items.length,
      completionRate: items.length ? 100 : null,
      createdCount: 0,
      deletedCount: 0,
      reopenedCount: 0,
      carriedCount: 0,
      top3Count: items.filter((item) => item.top3Date === date).length,
      top3CompletedCount: items.filter((item) => item.top3Date === date).length,
      top3CompletionRate: items.some((item) => item.top3Date === date) ? 100 : null,
      plannedMinutes: items.reduce((sum, item) => sum + item.estimateMinutes, 0),
      completedMinutes: items.reduce((sum, item) => sum + item.estimateMinutes, 0),
    },
    dataIntegrity: {
      status: 'complete',
      complete: true,
      historyStartAt: HISTORY_START,
      historyStartDate: '2025-12-01',
      missingSnapshotEvents: 0,
      message: '',
    },
  };
}

function reportStore() {
  const q1 = workTask('q1-secret', '一季度成果', '2026-03-31', {
    completionNote: '一季度交付，不应进入 Q2',
  });
  const april = workTask('apr', '四月交付原型', '2026-04-18', {
    priority: 'high',
    area: '研发',
    completionNote: '完成可测试原型',
    top3Date: '2026-04-18',
    estimateMinutes: 90,
  });
  const june = workTask('jun', '六月完成评审', '2026-06-30', {
    area: '产品',
    completionNote: '评审通过并收口需求',
    estimateMinutes: 60,
  });
  const july = workTask('jul-secret', '七月私密项目', '2026-07-01', {
    notes: 'OUT_OF_RANGE_PRIVATE_NOTE',
    completionNote: 'OUT_OF_RANGE_RESULT',
    sourceUrl: 'https://private.example/out-of-range',
  });
  return {
    version: 2,
    meta: {
      historyStartAt: HISTORY_START,
      timeZone: 'Asia/Shanghai',
      nextSeq: 3,
      dailyCapacityMinutes: 480,
      dailyNotes: {},
    },
    tasks: [q1, april, june, july],
    events: [
      {
        eventId: 'raw-secret-event',
        seq: 1,
        taskId: 'apr',
        type: 'toggle',
        occurredAt: '2026-04-18T02:00:00.000Z',
        reportingDate: '2026-04-18',
        timeZone: 'Asia/Shanghai',
        before: { title: 'RAW_BEFORE_SECRET', reminderAt: 'private' },
        after: { title: 'RAW_AFTER_SECRET', sourceUrl: 'private' },
      },
      {
        eventId: 'raw-secret-event-2',
        seq: 2,
        taskId: 'jun',
        type: 'toggle',
        occurredAt: '2026-06-30T02:00:00.000Z',
        reportingDate: '2026-06-30',
        timeZone: 'Asia/Shanghai',
        before: { title: 'RAW_BEFORE_SECRET_2' },
        after: { title: 'RAW_AFTER_SECRET_2' },
      },
    ],
    dailyArchives: [
      record('2026-03-31', q1, '一季度备注不应泄漏'),
      record('2026-04-18', april, '完成产品原型'),
      record('2026-06-30', june, '召开季度评审'),
      record('2026-07-01', july, 'OUT_OF_RANGE_DAILY_NOTE'),
    ],
  };
}

function collectKeys(value, result = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, result));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, nested]) => {
      result.add(key);
      collectKeys(nested, result);
    });
  }
  return result;
}

test('quarter AI source data is scoped, useful, deterministic, and privacy-minimized', () => {
  const source = reportStore();
  const before = structuredClone(source);

  const payload = buildReportSourceData(source, {
    mode: 'quarter',
    year: 2026,
    quarter: 2,
    today: '2026-07-15',
  });

  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.mode, 'quarter');
  assert.deepEqual(payload.period, {
    startDate: '2026-04-01',
    endDate: '2026-06-30',
    throughDate: '2026-06-30',
  });
  assert.equal(payload.metrics.planned, 2);
  assert.equal(payload.metrics.completed, 2);
  assert.equal(payload.metrics.completedPlanned, 2);
  assert.equal(payload.metrics.completionRate, 100);
  assert.deepEqual(payload.achievements, [
    {
      date: '2026-04-18',
      title: '四月交付原型',
      completionNote: '完成可测试原型',
      area: '研发',
      priority: 'high',
      estimateMinutes: 90,
    },
    {
      date: '2026-06-30',
      title: '六月完成评审',
      completionNote: '评审通过并收口需求',
      area: '产品',
      priority: 'medium',
      estimateMinutes: 60,
    },
  ]);
  assert.deepEqual(payload.dailyNotes, [
    { date: '2026-04-18', note: '完成产品原型' },
    { date: '2026-06-30', note: '召开季度评审' },
  ]);
  assert.ok(Array.isArray(payload.areas));
  assert.ok(Array.isArray(payload.trends));
  assert.equal(payload.dataIntegrity.complete, true);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /q1-secret|jul-secret|OUT_OF_RANGE|RAW_BEFORE|RAW_AFTER|private\.example/);
  assert.deepEqual(source, before);
});

test('AI report source follows review deletion and completion metadata corrections', () => {
  const source = reportStore();
  const april = source.tasks.find((task) => task.id === 'apr');
  april.deletedAt = '2026-07-10T02:00:00.000Z';
  const june = source.tasks.find((task) => task.id === 'jun');
  june.estimateMinutes = 120;
  june.completionNote = '补录后的评审结果';

  const payload = buildReportSourceData(source, {
    mode: 'quarter',
    year: 2026,
    quarter: 2,
    today: '2026-07-15',
  });

  assert.equal(payload.metrics.planned, 1);
  assert.equal(payload.metrics.completed, 1);
  assert.equal(payload.metrics.plannedMinutes, 120);
  assert.equal(payload.metrics.completedMinutes, 120);
  assert.deepEqual(payload.achievements.map((item) => item.title), ['六月完成评审']);
  assert.equal(payload.achievements[0].completionNote, '补录后的评审结果');
});

test('AI report does not count today as active when a task is only created for tomorrow', () => {
  let source = sanitizeStore({ version: 1, tasks: [] }, {
    now: new Date('2026-07-15T17:00:00.000Z'),
    timeZone: 'America/Los_Angeles',
  });
  source = applyCommand(source, {
    type: 'create',
    eventId: 'create-tomorrow',
    taskId: 'tomorrow',
    occurredAt: '2026-07-15T18:00:00.000Z',
    payload: { title: '准备明日评审', plannedDate: '2026-07-16' },
  });

  const payload = buildReportSourceData(source, {
    mode: 'quarter',
    year: 2026,
    quarter: 3,
    today: '2026-07-15',
  });

  assert.equal(payload.metrics.activeDays, 0);
  assert.equal(payload.metrics.planned, 0);
  assert.equal(payload.metrics.completed, 0);
  assert.deepEqual(payload.achievements, []);
});

test('AI report removes an archived achievement after the task is restored to Todo', () => {
  const source = reportStore();
  const april = source.tasks.find((task) => task.id === 'apr');
  april.status = 'active';
  april.completedAt = null;

  const payload = buildReportSourceData(source, {
    mode: 'quarter',
    year: 2026,
    quarter: 2,
    today: '2026-07-15',
  });

  assert.equal(payload.metrics.planned, 2);
  assert.equal(payload.metrics.completed, 1);
  assert.equal(payload.metrics.completedPlanned, 1);
  assert.equal(payload.metrics.completedMinutes, 60);
  assert.deepEqual(payload.achievements.map((item) => item.title), ['六月完成评审']);
});

test('AI report payload never contains raw tasks, audit snapshots, reminder, URL, or private task notes', () => {
  const payload = buildReportSourceData(reportStore(), {
    mode: 'quarter', year: 2026, quarter: 2, today: '2026-07-15',
  });
  const keys = collectKeys(payload);

  [
    'tasks',
    'events',
    'before',
    'after',
    'reminderAt',
    'reminderFiredAt',
    'sourceUrl',
    'notes',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ].forEach((forbidden) => assert.equal(keys.has(forbidden), false, `${forbidden} must not be sent to AI`));
});

test('month, quarter, and year modes calculate exact bounded report ranges', () => {
  const source = reportStore();
  const cases = [
    {
      options: { mode: 'month', year: 2026, month: 7, today: '2026-07-15' },
      period: { startDate: '2026-07-01', endDate: '2026-07-31', throughDate: '2026-07-15' },
      achievementTitles: ['七月私密项目'],
    },
    {
      options: { mode: 'quarter', year: 2026, quarter: 2, today: '2026-07-15' },
      period: { startDate: '2026-04-01', endDate: '2026-06-30', throughDate: '2026-06-30' },
      achievementTitles: ['四月交付原型', '六月完成评审'],
    },
    {
      options: { mode: 'year', year: 2026, today: '2026-07-15' },
      period: { startDate: '2026-01-01', endDate: '2026-12-31', throughDate: '2026-07-15' },
      achievementTitles: ['一季度成果', '四月交付原型', '六月完成评审', '七月私密项目'],
    },
  ];

  cases.forEach(({ options, period, achievementTitles }) => {
    const payload = buildReportSourceData(source, options);
    assert.deepEqual(payload.period, period);
    assert.deepEqual(payload.achievements.map((item) => item.title), achievementTitles);
    payload.achievements.forEach((item) => {
      assert.ok(item.date >= period.startDate && item.date <= period.throughDate);
    });
  });
});

test('AI source validation rejects invalid or future report selections', () => {
  const source = reportStore();
  assert.throws(
    () => buildReportSourceData(source, { mode: 'week', year: 2026, today: '2026-07-15' }),
    /mode/i,
  );
  assert.throws(
    () => buildReportSourceData(source, { mode: 'month', year: 2026, month: 13, today: '2026-07-15' }),
    /month/i,
  );
  assert.throws(
    () => buildReportSourceData(source, { mode: 'quarter', year: 2026, quarter: 5, today: '2026-07-15' }),
    /quarter/i,
  );
  assert.throws(
    () => buildReportSourceData(source, { mode: 'month', year: 2026, month: 8, today: '2026-07-15' }),
    /future|today|range/i,
  );
});

test('AI report preparation accepts an old v2 store and never adds persistence fields', () => {
  const oldV2 = {
    version: 2,
    meta: {
      historyStartAt: '2026-01-01T00:00:00.000Z',
      timeZone: 'Asia/Shanghai',
      nextSeq: 1,
      dailyCapacityMinutes: 480,
      dailyNotes: {},
    },
    tasks: [],
    events: [],
    dailyArchives: [],
  };
  const before = structuredClone(oldV2);

  const payload = buildReportSourceData(oldV2, {
    mode: 'month', year: 2026, month: 1, today: '2026-07-15',
  });

  assert.equal(payload.schemaVersion, 1);
  assert.deepEqual(oldV2, before);
  assert.equal('ai' in oldV2, false);
  assert.equal('aiReports' in oldV2, false);
  assert.equal('calendar' in oldV2, false);
  assert.equal('holidays' in oldV2, false);
});
