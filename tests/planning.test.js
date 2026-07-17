const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  isChinaWorkday,
  taskRange,
  buildSchedule,
  currentReviewForDate,
} = require('../src/planning');

function task(id, overrides = {}) {
  return {
    id,
    title: `任务 ${id}`,
    status: 'active',
    plannedDate: '2026-07-20',
    dueDate: null,
    estimateMinutes: null,
    priority: 'none',
    top3Date: null,
    completedAt: null,
    deletedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function store(tasks, capacity = 480) {
  return {
    meta: { timeZone: 'Asia/Shanghai', dailyCapacityMinutes: capacity },
    tasks,
  };
}

test('China workday rules exclude weekends and holidays but include makeup days', () => {
  assert.equal(isChinaWorkday('2026-07-20'), true);
  assert.equal(isChinaWorkday('2026-07-19'), false);
  assert.equal(isChinaWorkday('2026-10-02'), false);
  assert.equal(isChinaWorkday('2026-10-10'), true);
});

test('a start and deadline create an inclusive range with automatic daily allocations', () => {
  const source = store([task('range', {
    plannedDate: '2026-07-20',
    dueDate: '2026-07-24',
    estimateMinutes: 240,
  })]);

  const result = buildSchedule(source);
  const blocks = result.byTask.range;

  assert.deepEqual(blocks.map((block) => block.date), [
    '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24',
  ]);
  assert.deepEqual(blocks.map((block) => block.phase), ['start', 'middle', 'middle', 'middle', 'deadline']);
  assert.equal(blocks.reduce((sum, block) => sum + block.scheduledMinutes, 0), 240);
  assert.ok(blocks.every((block) => block.scheduledMinutes <= 60));
  assert.equal(blocks.at(-1).overflowMinutes, 0);
});

test('automatic allocations respect shared daily capacity and surface overflow', () => {
  const source = store([
    task('urgent', { dueDate: '2026-07-21', estimateMinutes: 180, priority: 'high' }),
    task('later', { dueDate: '2026-07-21', estimateMinutes: 180, priority: 'low' }),
  ], 120);

  const result = buildSchedule(source);
  assert.equal(result.usedByDate['2026-07-20'], 120);
  assert.equal(result.usedByDate['2026-07-21'], 120);
  assert.equal(result.byTask.urgent.reduce((sum, block) => sum + block.scheduledMinutes, 0), 180);
  assert.equal(result.byTask.later.reduce((sum, block) => sum + block.scheduledMinutes, 0), 60);
  assert.equal(result.byTask.later.at(-1).overflowMinutes, 120);
});

test('tasks without estimates keep workday placeholders and holidays remain range-only', () => {
  const source = store([task('holiday-range', {
    plannedDate: '2026-09-24',
    dueDate: '2026-09-28',
    estimateMinutes: null,
  })]);

  const result = buildSchedule(source);
  const holiday = result.byTask['holiday-range'].find((block) => block.date === '2026-09-25');
  const workday = result.byTask['holiday-range'].find((block) => block.date === '2026-09-28');

  assert.equal(holiday.isPlanningDay, false);
  assert.equal(workday.isPlanningDay, true);
  assert.equal(workday.needsEstimate, true);
});

test('current review moves active work and assigns completed work only to completion date', () => {
  const active = task('moving', { plannedDate: '2026-07-22', dueDate: '2026-07-24', estimateMinutes: 90 });
  const completed = task('done', {
    status: 'completed',
    plannedDate: '2026-07-20',
    dueDate: '2026-07-24',
    estimateMinutes: 60,
    completedAt: '2026-07-22T08:00:00.000Z',
  });
  const source = store([active, completed]);

  const oldDate = currentReviewForDate(source, '2026-07-20', { today: '2026-07-22' });
  const completionDate = currentReviewForDate(source, '2026-07-22', { today: '2026-07-22' });

  assert.equal(oldDate.range.some((item) => item.id === 'moving'), false);
  assert.equal(oldDate.range.some((item) => item.id === 'done'), false);
  assert.deepEqual(completionDate.completed.map((item) => item.id), ['done']);
  assert.equal(completionDate.range.some((item) => item.id === 'moving'), true);
  assert.equal(completionDate.range.some((item) => item.id === 'done'), true);
});

test('an Inbox or deleted task never creates calendar blocks', () => {
  const source = store([
    task('inbox', { plannedDate: null, dueDate: '2026-07-24' }),
    task('deleted', { deletedAt: '2026-07-20T00:00:00.000Z' }),
  ]);
  assert.deepEqual(buildSchedule(source).blocks, []);
  assert.equal(taskRange(source.tasks[0]), null);
});

test('the planning bundle exposes its pure API in a browser context', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'planning.js'), 'utf8');
  const context = vm.createContext({ window: {}, Intl, Date, Map, Set });
  vm.runInContext(source, context);

  assert.equal(typeof context.window.DaymarkPlanning.buildSchedule, 'function');
  assert.equal(typeof context.window.DaymarkPlanning.currentReviewForDate, 'function');
});
