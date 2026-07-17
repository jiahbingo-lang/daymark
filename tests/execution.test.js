const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startOfWeek,
  weekDates,
  formatMinute,
  actualMinutesForTask,
  activeFocusEntry,
  buildExecutionSchedule,
  riskForTask,
} = require('../src/execution');

function task(id, overrides = {}) {
  return {
    id,
    title: `任务 ${id}`,
    status: 'active',
    plannedDate: '2026-07-20',
    dueDate: '2026-07-24',
    estimateMinutes: 120,
    priority: 'none',
    completedAt: null,
    deletedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function store(tasks, overrides = {}) {
  return {
    version: 3,
    meta: { timeZone: 'Asia/Shanghai', dailyCapacityMinutes: 120 },
    tasks,
    scheduleBlocks: [],
    timeEntries: [],
    ...overrides,
  };
}

test('week helpers use a Monday-first China work week', () => {
  assert.equal(startOfWeek('2026-07-22'), '2026-07-20');
  assert.deepEqual(weekDates('2026-07-22'), [
    '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26',
  ]);
  assert.equal(formatMinute(570), '09:30');
});

test('manual locked blocks reserve capacity and auto blocks fill remaining work', () => {
  const source = store([task('one')], {
    scheduleBlocks: [{
      id: 'manual-one', taskId: 'one', date: '2026-07-20', startMinute: 600,
      durationMinutes: 60, source: 'manual', locked: true,
    }],
  });
  const execution = buildExecutionSchedule(source, { date: '2026-07-20', mode: 'week' });
  const blocks = execution.blocks.filter((block) => block.taskId === 'one');
  assert.equal(blocks.some((block) => block.id === 'manual-one' && block.locked), true);
  assert.equal(blocks.filter((block) => block.source === 'auto').reduce((sum, block) => sum + block.durationMinutes, 0), 60);
  assert.equal(execution.schedule.byTask.one.reduce((sum, block) => sum + (block.scheduledMinutes || 0), 0), 120);
});

test('execution schedule preserves locked blocks across the full 24-hour day', () => {
  const source = store([task('late', { estimateMinutes: 30 })], {
    scheduleBlocks: [{
      id: 'late-night', taskId: 'late', date: '2026-07-20', startMinute: 1410,
      durationMinutes: 30, source: 'manual', locked: true,
    }],
  });
  const execution = buildExecutionSchedule(source, { date: '2026-07-20', mode: 'day' });
  const lateBlock = execution.blocks.find((block) => block.id === 'late-night');
  assert.equal(lateBlock.startMinute, 1410);
  assert.equal(lateBlock.startMinute + lateBlock.durationMinutes, 1440);
  assert.equal(formatMinute(lateBlock.startMinute), '23:30');
});

test('actual time includes completed and running segments', () => {
  const source = store([task('one')], {
    timeEntries: [
      { id: 'manual', taskId: 'one', startedAt: '2026-07-20T01:00:00.000Z', endedAt: '2026-07-20T01:00:00.000Z', durationSeconds: 1800, reportingDate: '2026-07-20', source: 'manual' },
      { id: 'running', taskId: 'one', startedAt: '2026-07-20T02:00:00.000Z', endedAt: null, durationSeconds: 0, reportingDate: '2026-07-20', source: 'focus' },
    ],
  });
  assert.equal(actualMinutesForTask(source, 'one', { now: '2026-07-20T02:45:00.000Z' }), 75);
  assert.equal(activeFocusEntry(source).id, 'running');
});

test('risk compares remaining work with deadline capacity without changing the task', () => {
  const risky = task('risk', { plannedDate: '2026-07-20', dueDate: '2026-07-20', estimateMinutes: 240 });
  const source = store([risky]);
  const result = riskForTask(source, risky, { today: '2026-07-20' });
  assert.equal(result.risky, true);
  assert.equal(result.remainingMinutes, 240);
  assert.equal(result.availableMinutes, 120);
  assert.equal(source.tasks[0].estimateMinutes, 240);
});
