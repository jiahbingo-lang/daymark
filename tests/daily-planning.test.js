const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dailyPlanningCandidates,
  todayReason,
  groupTodayTasks,
  groupCompletedTasks,
  pendingShutdownTasks,
  shutdownComplete,
} = require('../src/daily-planning');

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    status: 'active',
    plannedDate: null,
    dueDate: null,
    top3Date: null,
    estimateMinutes: null,
    createdAt: '2026-07-15T08:00:00.000Z',
    completedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function store(tasks, meta = {}) {
  return { tasks, meta: { timeZone: 'Asia/Shanghai', dailyPlans: {}, ...meta } };
}

test('daily planning candidates are deduplicated and grouped by actionable reason', () => {
  const source = store([
    task('yesterday', { plannedDate: '2026-07-15' }),
    task('overdue', { plannedDate: '2026-07-10', dueDate: '2026-07-14' }),
    task('today', { plannedDate: '2026-07-16' }),
    task('soon', { dueDate: '2026-07-18' }),
    task('inbox'),
    task('far', { dueDate: '2026-08-01', createdAt: '2026-06-01T08:00:00.000Z' }),
    task('done', { status: 'completed' }),
    task('deleted', { deletedAt: '2026-07-16T08:00:00.000Z' }),
  ]);

  assert.deepEqual(
    dailyPlanningCandidates(source, '2026-07-16').map((item) => [item.task.id, item.category]),
    [
      ['yesterday', 'yesterday'],
      ['overdue', 'overdue'],
      ['today', 'today'],
      ['soon', 'upcoming'],
      ['inbox', 'inbox'],
    ],
  );
});

test('today reason explains overdue, carryover, due, allocation, and planned work', () => {
  assert.equal(todayReason(task('due-overdue', { dueDate: '2026-07-14' }), '2026-07-16'), '逾期 2 天');
  assert.equal(todayReason(task('carry', { plannedDate: '2026-07-15' }), '2026-07-16'), '昨日延续');
  assert.equal(todayReason(task('due', { dueDate: '2026-07-16' }), '2026-07-16'), '今天到期');
  assert.equal(todayReason(task('allocated', { plannedDate: '2026-07-16' }), '2026-07-16', { scheduledMinutes: 45 }), '自动分配 45 分钟');
  assert.equal(todayReason(task('planned', { plannedDate: '2026-07-16' }), '2026-07-16'), '今天计划开始');
});

test('today grouping is exclusive and keeps Top 3 visually separate', () => {
  const tasks = [
    task('top', { plannedDate: '2026-07-16', top3Date: '2026-07-16' }),
    task('planned', { plannedDate: '2026-07-16' }),
    task('overdue', { plannedDate: '2026-07-15' }),
    task('due-only', { dueDate: '2026-07-16' }),
  ];
  const groups = groupTodayTasks(tasks, '2026-07-16', { planned: { scheduledMinutes: 30 } });
  assert.deepEqual(groups.top3.map((item) => item.id), ['top']);
  assert.deepEqual(groups.planned.map((item) => item.id), ['planned']);
  assert.deepEqual(groups.overdue.map((item) => item.id), ['overdue']);
  assert.deepEqual(groups.other.map((item) => item.id), ['due-only']);
});

test('completed tasks are grouped by China completion date with newest groups first', () => {
  const groups = groupCompletedTasks([
    task('yesterday', { status: 'completed', completedAt: '2026-07-15T15:30:00.000Z' }),
    task('today-late', { status: 'completed', completedAt: '2026-07-16T03:00:00.000Z' }),
    task('today-boundary', { status: 'completed', completedAt: '2026-07-15T16:30:00.000Z' }),
    task('missing-date', { status: 'completed', completedAt: null }),
    task('active'),
  ], 'Asia/Shanghai');
  assert.deepEqual(groups.map((group) => [group.date, group.tasks.map((item) => item.id)]), [
    ['2026-07-16', ['today-late', 'today-boundary']],
    ['2026-07-15', ['yesterday']],
    [null, ['missing-date']],
  ]);
});

test('shutdown pending work follows live tasks and completion state follows the daily plan', () => {
  const source = store([
    task('today', { plannedDate: '2026-07-16' }),
    task('due', { dueDate: '2026-07-16' }),
    task('future', { plannedDate: '2026-07-17' }),
    task('done', { plannedDate: '2026-07-16', status: 'completed' }),
  ]);
  assert.deepEqual(pendingShutdownTasks(source, '2026-07-16').map((item) => item.id), ['today', 'due']);
  assert.equal(shutdownComplete(source, '2026-07-16'), false);
  source.meta.dailyPlans['2026-07-16'] = { shutdownCompletedAt: '2026-07-16T10:00:00.000Z' };
  assert.equal(shutdownComplete(source, '2026-07-16'), true);
});
