const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeStore, applyCommand } = require('../src/domain');
const {
  buildMonthGrid,
  getChinaHoliday,
  isWeekendDate,
  isChinaWorkday,
  chinaRestDay,
  isOrdinaryWeekend,
  buildDateDetail,
} = require('../src/calendar');
const { isChinaWorkday: planningIsChinaWorkday } = require('../src/planning');

const HISTORY_START = '2025-12-01T00:00:00.000Z';

function task(id, title, overrides = {}) {
  return {
    id,
    title,
    notes: '',
    status: 'active',
    dueDate: null,
    priority: 'none',
    plannedDate: null,
    top3Date: null,
    estimateMinutes: null,
    area: '',
    completionNote: '',
    repeatRule: null,
    reminderAt: null,
    reminderFiredAt: null,
    sourceUrl: null,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function dailyRecord(date, overrides = {}) {
  const planned = overrides.planned || [];
  const completed = overrides.completed || [];
  return {
    date,
    cutoffSeq: 0,
    timeZone: 'Asia/Shanghai',
    finalized: true,
    finalizedAt: `${date}T16:00:00.000Z`,
    capacityMinutes: 480,
    dailyCapacityMinutes: 480,
    dailyNotes: '',
    planned,
    top3: [],
    completed,
    created: [],
    deleted: [],
    reopened: [],
    carried: [],
    summary: {
      plannedCount: planned.length,
      completedCount: completed.length,
      completedPlannedCount: completed.length,
      completionRate: planned.length ? (completed.length / planned.length) * 100 : null,
      createdCount: 0,
      deletedCount: 0,
      reopenedCount: 0,
      carriedCount: 0,
      top3Count: 0,
      top3CompletedCount: 0,
      top3CompletionRate: null,
      plannedMinutes: 0,
      completedMinutes: 0,
    },
    dataIntegrity: {
      status: 'complete',
      complete: true,
      historyStartAt: HISTORY_START,
      historyStartDate: '2025-12-01',
      missingSnapshotEvents: 0,
      message: '',
    },
    ...overrides,
  };
}

function store(overrides = {}) {
  return {
    version: 2,
    meta: {
      historyStartAt: HISTORY_START,
      timeZone: 'Asia/Shanghai',
      nextSeq: 1,
      dailyCapacityMinutes: 480,
      dailyNotes: {},
    },
    tasks: [],
    events: [],
    dailyArchives: [],
    ...overrides,
  };
}

function datesBetween(start, end) {
  const result = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function expectedHolidayDates() {
  const result = new Map();
  const addHoliday = (name, start, end) => {
    datesBetween(start, end).forEach((date) => {
      result.set(date, { name, type: 'holiday', badge: '休' });
    });
  };
  const addMakeup = (name, dates) => {
    dates.forEach((date) => {
      result.set(date, { name: `${name}调休`, type: 'makeup', badge: '班' });
    });
  };

  addHoliday('元旦', '2026-01-01', '2026-01-03');
  addMakeup('元旦', ['2026-01-04']);
  addHoliday('春节', '2026-02-15', '2026-02-23');
  addMakeup('春节', ['2026-02-14', '2026-02-28']);
  addHoliday('清明节', '2026-04-04', '2026-04-06');
  addHoliday('劳动节', '2026-05-01', '2026-05-05');
  addMakeup('劳动节', ['2026-05-09']);
  addHoliday('端午节', '2026-06-19', '2026-06-21');
  addHoliday('中秋节', '2026-09-25', '2026-09-27');
  addHoliday('国庆节', '2026-10-01', '2026-10-07');
  addMakeup('国庆节', ['2026-09-20', '2026-10-10']);
  return result;
}

test('2026 China holiday and makeup-workday data matches the official schedule exactly', () => {
  const expected = expectedHolidayDates();
  const actualMarked = new Map();

  datesBetween('2026-01-01', '2026-12-31').forEach((date) => {
    const value = getChinaHoliday(date);
    if (value) actualMarked.set(date, value);
  });

  // 33 statutory holiday dates plus 6 official makeup workdays.
  assert.equal(expected.size, 39);
  assert.deepEqual([...actualMarked.keys()], [...expected.keys()].sort());
  expected.forEach((value, date) => {
    assert.deepEqual(getChinaHoliday(date), { date, ...value });
  });

  // Ordinary weekends are not mislabeled as a statutory holiday or makeup day.
  assert.equal(getChinaHoliday('2026-01-10'), null);
  assert.equal(getChinaHoliday('2025-12-31'), null);
  assert.equal(getChinaHoliday('not-a-date'), null);
});

test('weekends are derived from the date without claiming anything about days off', () => {
  assert.equal(isWeekendDate('2026-07-18'), true);
  assert.equal(isWeekendDate('2026-07-19'), true);
  assert.equal(isWeekendDate('2026-07-17'), false);
  assert.equal(isWeekendDate('not-a-date'), false);

  assert.equal(isWeekendDate('2026-02-14'), true, 'a makeup Saturday is still a Saturday');
  assert.deepEqual(getChinaHoliday('2026-02-14'), {
    date: '2026-02-14', name: '春节调休', type: 'makeup', badge: '班',
  });
});

test('rest-day labels follow the statutory calendar, not the raw day of week', () => {
  // A 调休 Saturday is a mandated workday: no rest-day label, no 周末 badge.
  assert.equal(isChinaWorkday('2026-02-14'), true);
  assert.equal(chinaRestDay('2026-02-14'), null);
  assert.equal(isOrdinaryWeekend('2026-02-14'), false);
  assert.equal(isOrdinaryWeekend('2026-02-28'), false);

  // A statutory holiday is time off even midweek (2026-10-01 is a Thursday).
  assert.equal(isWeekendDate('2026-10-01'), false);
  assert.equal(isChinaWorkday('2026-10-01'), false);
  assert.deepEqual(chinaRestDay('2026-10-01'), {
    kind: 'holiday', name: '国庆节', badge: '休', label: '假日安排', short: '假日',
  });
  assert.equal(isOrdinaryWeekend('2026-10-01'), false, 'a holiday shows 休, never a stacked 周末 badge');

  // An ordinary weekend is the only case that earns the 周末 label.
  assert.equal(isChinaWorkday('2026-07-18'), false);
  assert.deepEqual(chinaRestDay('2026-07-18'), {
    kind: 'weekend', name: '周末', badge: '周末', label: '周末安排', short: '周末',
  });
  assert.equal(isOrdinaryWeekend('2026-07-18'), true);

  // An ordinary workday earns nothing.
  assert.equal(isChinaWorkday('2026-07-17'), true);
  assert.equal(chinaRestDay('2026-07-17'), null);
  assert.equal(chinaRestDay('not-a-date'), null);
});

test('the scheduler and the review calendar read the same statutory dataset', () => {
  // planning.js used to keep its own copy of the 2026 holiday table. A silent
  // divergence there would make the auto-scheduler place work on days the
  // calendar shows as time off, so assert they agree across the whole year.
  for (let date = '2026-01-01'; date <= '2026-12-31';) {
    assert.equal(
      planningIsChinaWorkday(date),
      isChinaWorkday(date),
      `${date} must mean the same thing to the scheduler and the calendar`,
    );
    // A day is a workday exactly when it has no rest-day label.
    assert.equal(isChinaWorkday(date), chinaRestDay(date) === null, date);
    const next = new Date(`${date}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
});

test('buildMonthGrid returns a stable six-week Monday-first grid across month boundaries', () => {
  const grid = buildMonthGrid({
    year: 2026,
    month: 2,
    store: store(),
    today: '2026-02-18',
  });

  assert.equal(grid.year, 2026);
  assert.equal(grid.month, 2);
  assert.equal(grid.weekStartsOn, 'monday');
  assert.equal(grid.cells.length, 42);
  assert.equal(grid.cells[0].date, '2026-01-26');
  assert.equal(grid.cells[6].date, '2026-02-01');
  assert.equal(grid.cells[41].date, '2026-03-08');
  assert.equal(grid.cells.filter((cell) => cell.inCurrentMonth).length, 28);
  assert.deepEqual(
    grid.cells.filter((cell) => cell.isToday).map((cell) => cell.date),
    ['2026-02-18'],
  );

  grid.cells.forEach((cell, index) => {
    assert.equal(cell.day, Number(cell.date.slice(-2)));
    assert.equal(typeof cell.inCurrentMonth, 'boolean');
    assert.equal(typeof cell.isToday, 'boolean');
    assert.equal(typeof cell.isWeekend, 'boolean');
    assert.equal(cell.isWeekend, [0, 6].includes(new Date(`${cell.date}T00:00:00.000Z`).getUTCDay()));
    assert.equal(cell.isWorkday, chinaRestDay(cell.date) === null);
    assert.equal(cell.isOrdinaryWeekend, cell.isWeekend && !cell.holiday);
    assert.equal(index % 7, (new Date(`${cell.date}T00:00:00.000Z`).getUTCDay() + 6) % 7);
  });

  // February 2026 is the sharp case: 02-14 and 02-28 are 调休 Saturdays.
  const makeupSaturday = grid.cells.find((cell) => cell.date === '2026-02-14');
  assert.equal(makeupSaturday.isWeekend, true);
  assert.equal(makeupSaturday.isWorkday, true);
  assert.equal(makeupSaturday.isOrdinaryWeekend, false, 'must not stack 周末 on top of 班');
  assert.equal(makeupSaturday.restDay, null);
  assert.equal(makeupSaturday.holiday.badge, '班');
});

test('a task planned for an ordinary weekend is counted in the weekend calendar cell', () => {
  const weekendTask = task('weekend-task', '周末处理发布检查', {
    plannedDate: '2026-07-18',
    estimateMinutes: 60,
  });
  const source = store({ tasks: [weekendTask] });

  const grid = buildMonthGrid({ year: 2026, month: 7, store: source, today: '2026-07-17' });
  const saturday = grid.cells.find((cell) => cell.date === '2026-07-18');

  assert.equal(saturday.isWeekend, true);
  assert.equal(saturday.holiday, null);
  assert.deepEqual(saturday.metrics, {
    plannedCount: 1,
    completedCount: 0,
    completionRate: 0,
    actualMinutes: 0,
  });
});

test('month cells combine durable daily metrics with holiday labels without mutating data', () => {
  const plannedA = task('a', '整理季度数据', { plannedDate: '2026-01-02' });
  const plannedB = task('b', '写总结', { plannedDate: '2026-01-02' });
  const completedA = {
    ...plannedA,
    status: 'completed',
    completedAt: '2026-01-02T08:00:00.000Z',
  };
  const source = store({
    dailyArchives: [dailyRecord('2026-01-02', {
      planned: [plannedA, plannedB],
      completed: [completedA],
      dailyNotes: '完成了数据清理',
    })],
  });
  const before = structuredClone(source);

  const grid = buildMonthGrid({ year: 2026, month: 1, store: source, today: '2026-01-15' });
  const newYear = grid.cells.find((cell) => cell.date === '2026-01-01');
  const active = grid.cells.find((cell) => cell.date === '2026-01-02');
  const empty = grid.cells.find((cell) => cell.date === '2026-01-10');

  assert.deepEqual(newYear.holiday, {
    date: '2026-01-01', name: '元旦', type: 'holiday', badge: '休',
  });
  assert.deepEqual(active.metrics, {
    plannedCount: 2,
    completedCount: 1,
    completionRate: 50,
    actualMinutes: 0,
  });
  assert.deepEqual(empty.metrics, {
    plannedCount: 0,
    completedCount: 0,
    completionRate: null,
    actualMinutes: 0,
  });
  assert.deepEqual(source, before);
});

test('buildDateDetail exposes the archived day contract as an isolated copy', () => {
  const planned = task('review', '审阅设计', {
    plannedDate: '2026-02-16',
    estimateMinutes: 60,
  });
  const completed = {
    ...planned,
    status: 'completed',
    completionNote: '确认了新版日历布局',
    completedAt: '2026-02-16T08:00:00.000Z',
  };
  const source = store({
    dailyArchives: [dailyRecord('2026-02-16', {
      planned: [completed],
      completed: [completed],
      dailyNotes: '设计评审通过',
    })],
  });

  const detail = buildDateDetail(source, '2026-02-16');

  assert.equal(detail.date, '2026-02-16');
  assert.equal(detail.dailyNotes, '设计评审通过');
  assert.deepEqual(detail.planned.map((item) => item.id), ['review']);
  assert.deepEqual(detail.completed.map((item) => item.completionNote), ['确认了新版日历布局']);
  assert.deepEqual(detail.carried, []);
  assert.equal(detail.summary.plannedCount, 1);
  assert.equal(detail.summary.completedCount, 1);
  assert.equal(detail.dataIntegrity.complete, true);

  detail.completed[0].title = '外部修改';
  assert.equal(source.dailyArchives[0].completed[0].title, '审阅设计');
  assert.throws(() => buildDateDetail(source, '2026-02-30'), /valid|date|YYYY-MM-DD/i);
});

test('calendar review hides deleted completions and recalculates archived metrics', () => {
  const completed = task('removed', '已删除成果', {
    plannedDate: '2026-02-16',
    estimateMinutes: 50,
    status: 'completed',
    completedAt: '2026-02-16T08:00:00.000Z',
  });
  const source = store({
    tasks: [{ ...completed, deletedAt: '2026-02-17T08:00:00.000Z' }],
    dailyArchives: [dailyRecord('2026-02-16', {
      planned: [completed],
      completed: [completed],
    })],
  });

  const detail = buildDateDetail(source, '2026-02-16');
  assert.deepEqual(detail.planned, []);
  assert.deepEqual(detail.completed, []);
  assert.equal(detail.summary.plannedCount, 0);
  assert.equal(detail.summary.completedCount, 0);

  const grid = buildMonthGrid({ year: 2026, month: 2, today: '2026-02-17', store: source });
  const cell = grid.cells.find((entry) => entry.date === '2026-02-16');
  assert.deepEqual(cell.metrics, { plannedCount: 0, completedCount: 0, completionRate: null, actualMinutes: 0 });
});

test('calendar review syncs a corrected duration into the archived completion day', () => {
  const archived = task('duration', '补录用时', {
    plannedDate: '2026-02-16',
    status: 'completed',
    completedAt: '2026-02-16T08:00:00.000Z',
  });
  const current = { ...archived, estimateMinutes: 90, completionNote: '完成后补录' };
  const source = store({
    tasks: [current],
    dailyArchives: [dailyRecord('2026-02-16', {
      planned: [archived],
      completed: [archived],
    })],
  });

  const detail = buildDateDetail(source, '2026-02-16');
  assert.equal(detail.planned[0].estimateMinutes, 90);
  assert.equal(detail.completed[0].estimateMinutes, 90);
  assert.equal(detail.completed[0].completionNote, '完成后补录');
  assert.equal(detail.summary.plannedMinutes, 90);
  assert.equal(detail.summary.completedMinutes, 90);
});

test('calendar review reflects the task current ordinary flag state', () => {
  const archived = task('flagged', '需要持续关注', {
    plannedDate: '2026-02-16',
    status: 'completed',
    completedAt: '2026-02-16T08:00:00.000Z',
    flagged: false,
  });
  const current = { ...archived, flagged: true };
  const source = store({
    tasks: [current],
    dailyArchives: [dailyRecord('2026-02-16', {
      planned: [archived],
      completed: [archived],
    })],
  });

  const detail = buildDateDetail(source, '2026-02-16');
  assert.equal(detail.planned[0].flagged, true);
  assert.equal(detail.completed[0].flagged, true);
  assert.equal(source.dailyArchives[0].completed[0].flagged, false, 'audit archive remains immutable');
});

test('calendar withdraws an archived completion after the task is restored to Todo', () => {
  const archived = task('reopened', '误点完成的事项', {
    plannedDate: '2026-02-16',
    estimateMinutes: 75,
    status: 'completed',
    completedAt: '2026-02-16T08:00:00.000Z',
  });
  const current = {
    ...archived,
    status: 'active',
    completedAt: null,
    updatedAt: '2026-02-17T08:00:00.000Z',
  };
  const source = store({
    tasks: [current],
    dailyArchives: [dailyRecord('2026-02-16', {
      planned: [archived],
      completed: [archived],
    })],
  });

  const detail = buildDateDetail(source, '2026-02-16');
  const grid = buildMonthGrid({ year: 2026, month: 2, today: '2026-02-17', store: source });
  const cell = grid.cells.find((entry) => entry.date === '2026-02-16');

  assert.deepEqual(detail.planned.map((item) => item.id), ['reopened']);
  assert.deepEqual(detail.completed, []);
  assert.equal(detail.summary.completedCount, 0);
  assert.equal(detail.summary.completedMinutes, 0);
  assert.deepEqual(cell.metrics, { plannedCount: 1, completedCount: 0, completionRate: 0, actualMinutes: 0 });
});

test('calendar counts a reopened task when its current final state is completed again', () => {
  const completed = task('recompleted', '恢复后再次完成', {
    plannedDate: '2026-02-16',
    top3Date: '2026-02-16',
    estimateMinutes: 45,
    status: 'completed',
    completedAt: '2026-02-16T10:00:00.000Z',
  });
  const archived = dailyRecord('2026-02-16', {
    planned: [completed],
    completed: [completed],
  });
  archived.top3 = [completed];
  archived.reopened = [completed];
  const source = store({
    tasks: [completed],
    dailyArchives: [archived],
  });

  const detail = buildDateDetail(source, '2026-02-16');
  const grid = buildMonthGrid({ year: 2026, month: 2, today: '2026-02-17', store: source });
  const cell = grid.cells.find((entry) => entry.date === '2026-02-16');

  assert.equal(detail.summary.reopenedCount, 1, 'reopen audit history is retained');
  assert.equal(detail.summary.completedPlannedCount, 1);
  assert.equal(detail.summary.completionRate, 100);
  assert.equal(detail.summary.top3CompletedCount, 1);
  assert.equal(detail.summary.top3CompletionRate, 100);
  assert.deepEqual(cell.metrics, { plannedCount: 1, completedCount: 1, completionRate: 100, actualMinutes: 0 });
});

test('calendar withdraws an archived plan after the task is moved to Inbox', () => {
  const archived = task('inbox', '撤回原计划', {
    plannedDate: '2026-02-16',
    top3Date: '2026-02-16',
    estimateMinutes: 60,
  });
  const current = {
    ...archived,
    plannedDate: null,
    top3Date: null,
    updatedAt: '2026-02-17T08:00:00.000Z',
  };
  const source = store({
    tasks: [current],
    dailyArchives: [dailyRecord('2026-02-16', {
      planned: [archived],
      top3: [archived],
      carried: [archived],
    })],
  });

  const detail = buildDateDetail(source, '2026-02-16');
  const grid = buildMonthGrid({ year: 2026, month: 2, today: '2026-02-17', store: source });
  const cell = grid.cells.find((entry) => entry.date === '2026-02-16');

  assert.deepEqual(detail.planned, []);
  assert.deepEqual(detail.top3, []);
  assert.deepEqual(detail.carried, []);
  assert.equal(detail.summary.plannedCount, 0);
  assert.equal(detail.summary.top3Count, 0);
  assert.deepEqual(cell.metrics, { plannedCount: 0, completedCount: 0, completionRate: null, actualMinutes: 0 });
});

test('date detail builds the current day from live v2 events when no archive exists', () => {
  const active = task('live', '当天任务', {
    plannedDate: '2026-07-15',
    estimateMinutes: 45,
  });
  const source = store({ tasks: [active] });

  const detail = buildDateDetail(source, '2026-07-15');

  assert.equal(detail.date, '2026-07-15');
  assert.equal(detail.finalized, false);
  assert.deepEqual(detail.planned.map((item) => item.id), ['live']);
  assert.equal(detail.summary.plannedMinutes, 45);
});

test('calendar places a newly-created future task on its planned date, never today', () => {
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

  const today = buildDateDetail(source, '2026-07-15');
  const tomorrow = buildDateDetail(source, '2026-07-16');
  const grid = buildMonthGrid({ year: 2026, month: 7, today: '2026-07-15', store: source });
  const todayCell = grid.cells.find((entry) => entry.date === '2026-07-15');
  const tomorrowCell = grid.cells.find((entry) => entry.date === '2026-07-16');

  assert.deepEqual(today.planned, []);
  assert.equal(today.summary.plannedCount, 0);
  assert.deepEqual(tomorrow.planned.map((item) => item.id), ['tomorrow']);
  assert.equal(tomorrow.summary.plannedCount, 1);
  assert.deepEqual(todayCell.metrics, { plannedCount: 0, completedCount: 0, completionRate: null, actualMinutes: 0 });
  assert.deepEqual(tomorrowCell.metrics, { plannedCount: 1, completedCount: 0, completionRate: 0, actualMinutes: 0 });
});

test('calendar replaces an archived position when the current task is rescheduled', () => {
  const oldSnapshot = task('moved', '调整后的任务', { plannedDate: '2026-07-20' });
  const current = { ...oldSnapshot, plannedDate: '2026-07-22', updatedAt: '2026-07-19T08:00:00.000Z' };
  const source = store({
    tasks: [current],
    dailyArchives: [dailyRecord('2026-07-20', { planned: [oldSnapshot] })],
  });

  const oldDate = buildDateDetail(source, '2026-07-20');
  const newDate = buildDateDetail(source, '2026-07-22');

  assert.deepEqual(oldDate.planned, []);
  assert.deepEqual(oldDate.range, []);
  assert.deepEqual(newDate.planned.map((item) => item.id), ['moved']);
  assert.deepEqual(newDate.range.map((item) => item.id), ['moved']);
});

test('calendar expands a start-to-deadline task across future dates without duplicating task identity', () => {
  const ranged = task('range', '准备发布', {
    plannedDate: '2026-07-20',
    dueDate: '2026-07-24',
    estimateMinutes: 240,
  });
  const source = store({ tasks: [ranged] });

  const grid = buildMonthGrid({ year: 2026, month: 7, today: '2026-07-16', store: source });
  const dates = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];

  dates.forEach((date) => {
    const cell = grid.cells.find((entry) => entry.date === date);
    const detail = buildDateDetail(source, date);
    assert.equal(cell.rangeCount, 1);
    assert.equal(detail.range[0].id, 'range');
    if (date !== '2026-07-24') assert.equal(detail.planned[0].id, 'range');
    else assert.deepEqual(detail.planned, [], 'the deadline can remain a buffer day');
  });
  assert.equal(dates.reduce((sum, date) => sum + buildDateDetail(source, date).summary.plannedMinutes, 0), 240);
});

test('calendar features remain derived data and require no v2 schema migration', () => {
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
  const sanitized = sanitizeStore(oldV2, {
    now: new Date('2026-07-15T00:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  });

  buildMonthGrid({ year: 2026, month: 7, store: oldV2, today: '2026-07-15' });
  buildDateDetail(oldV2, '2026-07-15');

  assert.deepEqual(oldV2, before);
  assert.equal(sanitized.version, 3);
  assert.equal('holidays' in sanitized, false);
  assert.equal('calendar' in sanitized, false);
  assert.equal('ai' in sanitized, false);
  assert.equal('aiReports' in sanitized, false);
});

test('an actual-time-only day remains visible after the task is moved to Inbox', () => {
  const inboxTask = task('timed-inbox', '临时支持', { plannedDate: null, area: '支持' });
  const source = store({
    tasks: [inboxTask],
    timeEntries: [{
      id: 'manual-time',
      taskId: inboxTask.id,
      reportingDate: '2026-07-16',
      startedAt: '2026-07-16T08:00:00.000Z',
      endedAt: '2026-07-16T08:00:00.000Z',
      durationSeconds: 2700,
      source: 'manual',
    }],
  });

  const detail = buildDateDetail(source, '2026-07-16');
  const grid = buildMonthGrid({ year: 2026, month: 7, store: source, today: '2026-07-17' });
  const cell = grid.cells.find((entry) => entry.date === '2026-07-16');

  assert.equal(detail.summary.plannedCount, 0);
  assert.equal(detail.summary.actualMinutes, 45);
  assert.equal(detail.actualTime[0].taskId, inboxTask.id);
  assert.equal(cell.metrics.actualMinutes, 45);
});
