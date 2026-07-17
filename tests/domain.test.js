const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  STORE_VERSION,
  createTask,
  sanitizeStore,
  updateTask,
  toggleTask,
  visibleTasks,
  counts,
  sortTasks,
  applyCommand,
  inverseTaskPatch,
  nextRecurringDate,
} = require('../src/domain');

const NOW = new Date('2026-07-15T18:00:00.000Z');

function task(title, overrides = {}) {
  return {
    ...createTask(title, { id: `id-${title}`, now: NOW }),
    ...overrides,
  };
}

test('createTask trims a title and applies safe defaults', () => {
  const result = createTask('  写周报  ', { id: 'one', now: NOW });
  assert.deepEqual(result, {
    id: 'one',
    title: '写周报',
    notes: '',
    status: 'active',
    dueDate: null,
    priority: 'none',
    plannedDate: null,
    top3Date: null,
    flagged: false,
    estimateMinutes: null,
    area: '',
    completionNote: '',
    repeatRule: null,
    reminderAt: null,
    reminderFiredAt: null,
    sourceUrl: null,
    revision: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    completedAt: null,
    deletedAt: null,
  });
});

test('createTask rejects an empty title and caps long titles', () => {
  assert.equal(createTask('   ', { now: NOW }), null);
  assert.equal(createTask('a'.repeat(250), { now: NOW }).title.length, 200);
});

test('commands reject a deadline earlier than the planned start date', () => {
  const source = sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.throws(() => applyCommand(source, {
    type: 'create', eventId: 'invalid-range', taskId: 'invalid-range',
    payload: { title: '错误日期', plannedDate: '2026-07-20', dueDate: '2026-07-19' },
  }), /Due date cannot be earlier/);

  const created = applyCommand(source, {
    type: 'create', eventId: 'valid-range', taskId: 'valid-range',
    payload: { title: '正确日期', plannedDate: '2026-07-20', dueDate: '2026-07-24' },
  });
  assert.throws(() => applyCommand(created, {
    type: 'update', eventId: 'invalid-update', taskId: 'valid-range',
    payload: { plannedDate: '2026-07-25' },
  }), /Due date cannot be earlier/);
});

test('toggleTask completes and restores without mutating the source', () => {
  const source = task('测试');
  const completed = toggleTask(source, NOW);
  assert.equal(source.status, 'active');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completedAt, NOW.toISOString());
  assert.equal(completed.revision, 2);

  const restored = toggleTask(completed, new Date('2026-07-16T18:00:00.000Z'));
  assert.equal(restored.status, 'active');
  assert.equal(restored.completedAt, null);
  assert.equal(restored.revision, 3);
});

test('updateTask accepts editable fields but keeps the original id', () => {
  const source = task('原任务');
  const updated = updateTask(source, {
    id: 'attempted-replacement',
    title: '  新任务  ',
    notes: '说明',
    priority: 'high',
    dueDate: '2026-07-20',
  }, NOW);

  assert.equal(updated.id, source.id);
  assert.equal(updated.title, '新任务');
  assert.equal(updated.notes, '说明');
  assert.equal(updated.priority, 'high');
  assert.equal(updated.dueDate, '2026-07-20');
  assert.equal(updated.revision, 2);
});

test('sanitizeStore repairs malformed input and removes invalid tasks', () => {
  const result = sanitizeStore({
    version: 1,
    tasks: [
      { title: '  保留  ', status: 'unknown', priority: 'urgent', dueDate: 'not-a-date' },
      { title: '   ' },
      null,
    ],
  }, { now: NOW, timeZone: 'UTC' });

  assert.equal(result.version, STORE_VERSION);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].title, '保留');
  assert.equal(result.tasks[0].status, 'active');
  assert.equal(result.tasks[0].priority, 'none');
  assert.equal(result.tasks[0].dueDate, null);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'baseline_imported');
});

test('views separate inbox, planned, upcoming, completed and deleted tasks', () => {
  const tasks = [
    task('逾期计划', { plannedDate: '2026-07-14' }),
    task('今天计划', { plannedDate: '2026-07-15' }),
    task('未来计划', { plannedDate: '2026-07-16' }),
    task('仅有截止日期', { dueDate: '2026-07-15' }),
    task('完成', { status: 'completed', completedAt: NOW.toISOString() }),
    task('已删除', { deletedAt: NOW.toISOString() }),
  ];

  assert.deepEqual(visibleTasks(tasks, 'inbox', '', '2026-07-15').map((item) => item.title), ['仅有截止日期']);
  assert.deepEqual(visibleTasks(tasks, 'today', '', '2026-07-15').map((item) => item.title), ['逾期计划', '仅有截止日期', '今天计划']);
  assert.deepEqual(visibleTasks(tasks, 'upcoming', '', '2026-07-15').map((item) => item.title), ['未来计划']);
  assert.equal(visibleTasks(tasks, 'all', '', '2026-07-15').length, 4);
  assert.deepEqual(visibleTasks(tasks, 'completed', '', '2026-07-15').map((item) => item.title), ['完成']);
  assert.deepEqual(counts(tasks, '2026-07-15'), { all: 4, inbox: 1, today: 3, upcoming: 1, completed: 1 });
});

test('search includes titles and notes without case sensitivity', () => {
  const tasks = [
    task('Prepare DEMO'),
    task('买菜', { notes: '记得带 reusable BAG' }),
    task('无关任务'),
  ];

  assert.deepEqual(visibleTasks(tasks, 'all', 'demo', '2026-07-15').map((item) => item.title), ['Prepare DEMO']);
  assert.deepEqual(visibleTasks(tasks, 'all', 'bag', '2026-07-15').map((item) => item.title), ['买菜']);
});

test('sorting puts overdue and dated work before undated work', () => {
  const tasks = [
    task('无日期'),
    task('未来', { dueDate: '2026-07-19' }),
    task('今天低', { dueDate: '2026-07-15', priority: 'low' }),
    task('今天高', { dueDate: '2026-07-15', priority: 'high' }),
    task('逾期', { dueDate: '2026-07-13' }),
  ];

  assert.deepEqual(sortTasks(tasks, '2026-07-15').map((item) => item.title), [
    '逾期',
    '今天高',
    '今天低',
    '未来',
    '无日期',
  ]);
});

test('Today prioritizes current Top 3 and Upcoming follows planned dates', () => {
  const todayTasks = [
    task('普通今天', { plannedDate: '2026-07-15', priority: 'high' }),
    task('Top 3', { plannedDate: '2026-07-15', top3Date: '2026-07-15' }),
  ];
  assert.deepEqual(visibleTasks(todayTasks, 'today', '', '2026-07-15').map((item) => item.title), ['Top 3', '普通今天']);

  const upcoming = [
    task('后天高优', { plannedDate: '2026-07-17', priority: 'high' }),
    task('明天低优', { plannedDate: '2026-07-16', priority: 'low' }),
  ];
  assert.deepEqual(visibleTasks(upcoming, 'upcoming', '', '2026-07-15').map((item) => item.title), ['明天低优', '后天高优']);
});

test('v1 migration is idempotent and future versions fail closed', () => {
  const legacy = {
    version: 1,
    tasks: [task('旧任务', { dueDate: '2026-07-20' })],
  };
  const migrated = sanitizeStore(legacy, { now: NOW, timeZone: 'UTC' });
  const migratedAgain = sanitizeStore(migrated, {
    now: new Date('2027-01-01T00:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  });

  assert.deepEqual(migratedAgain, migrated);
  assert.equal(migrated.meta.historyStartAt, NOW.toISOString());
  assert.equal(migrated.meta.timeZone, 'UTC');
  assert.equal(migrated.meta.nextSeq, 2);
  assert.equal(migrated.meta.dailyCapacityMinutes, 480);
  assert.deepEqual(migrated.meta.dailyNotes, {});
  assert.equal(migrated.tasks[0].dueDate, '2026-07-20');
  assert.equal(migrated.events[0].eventId.startsWith('v1-baseline-1-'), true);
  assert.deepEqual(migrated.dailyArchives, []);
  assert.throws(() => sanitizeStore({ version: 4, tasks: [] }), /Unsupported store version/);
});

test('task v2 fields are sanitized and preserved in browser-safe data', () => {
  const result = createTask('季度规划', {
    id: 'v2-task',
    now: NOW,
    dueDate: '2026-09-30',
    plannedDate: '2026-07-20',
    top3Date: '2026-07-20',
    flagged: true,
    estimateMinutes: 90,
    area: '工作',
    completionNote: '交付后补记',
    repeatRule: { frequency: 'weekly', interval: 1 },
    reminderAt: '2026-07-20T16:00:00.000Z',
    sourceUrl: 'https://example.com/spec',
  });

  assert.equal(result.plannedDate, '2026-07-20');
  assert.equal(result.top3Date, '2026-07-20');
  assert.equal(result.flagged, true);
  assert.equal(result.estimateMinutes, 90);
  assert.equal(result.area, '工作');
  assert.equal(result.completionNote, '交付后补记');
  assert.deepEqual(result.repeatRule, { frequency: 'weekly', interval: 1 });
  assert.equal(result.reminderAt, '2026-07-20T16:00:00.000Z');
  assert.equal(result.sourceUrl, 'https://example.com/spec');
  assert.equal(result.revision, 1);
  assert.equal(result.deletedAt, null);
});

test('applyCommand appends one immutable event and retries exactly once by eventId', () => {
  const empty = sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'America/Los_Angeles' });
  const create = {
    type: 'create',
    eventId: 'event-create-1',
    taskId: 'task-1',
    occurredAt: '2026-07-16T01:00:00.000Z',
    payload: { title: '写总结', plannedDate: '2026-07-15', estimateMinutes: 45 },
  };
  const created = applyCommand(empty, create);

  assert.equal(empty.tasks.length, 0);
  assert.equal(empty.events.length, 0);
  assert.equal(created.tasks.length, 1);
  assert.equal(created.tasks[0].revision, 1);
  assert.equal(created.events.length, 1);
  assert.equal(created.events[0].seq, 1);
  assert.equal(created.events[0].eventId, 'event-create-1');
  assert.equal(created.events[0].taskId, 'task-1');
  assert.equal(created.events[0].type, 'create');
  assert.equal(created.events[0].reportingDate, '2026-07-15');
  assert.equal(created.events[0].before, null);
  assert.equal(created.events[0].after.title, '写总结');
  assert.equal(created.meta.nextSeq, 2);

  const retried = applyCommand(created, create);
  assert.deepEqual(retried, created);
});

test('update, toggle and delete commands preserve before/after history and tombstone tasks', () => {
  let store = sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'UTC' });
  store = applyCommand(store, {
    type: 'create',
    eventId: 'create-1',
    taskId: 'task-1',
    occurredAt: NOW,
    payload: { title: '原任务' },
  });
  store = applyCommand(store, {
    type: 'update',
    eventId: 'update-1',
    taskId: 'task-1',
    occurredAt: '2026-07-16T18:00:00.000Z',
    payload: { title: '延期任务', plannedDate: '2026-07-20' },
  });

  const updateEvent = store.events.at(-1);
  assert.equal(updateEvent.before.title, '原任务');
  assert.equal(updateEvent.after.title, '延期任务');
  assert.equal(store.tasks[0].revision, 2);

  store = applyCommand(store, {
    type: 'toggle',
    eventId: 'toggle-1',
    taskId: 'task-1',
    occurredAt: '2026-07-17T18:00:00.000Z',
  });
  assert.equal(store.tasks[0].status, 'completed');
  assert.equal(store.tasks[0].revision, 3);
  assert.equal(store.events.at(-1).before.status, 'active');
  assert.equal(store.events.at(-1).after.status, 'completed');

  store = applyCommand(store, {
    type: 'delete',
    eventId: 'delete-1',
    taskId: 'task-1',
    occurredAt: '2026-07-18T18:00:00.000Z',
  });
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].deletedAt, '2026-07-18T18:00:00.000Z');
  assert.equal(store.tasks[0].revision, 4);
  assert.equal(store.events.length, 4);
  assert.equal(visibleTasks(store.tasks, 'completed', '', '2026-07-18').length, 0);
});

test('Top 3 is limited to three tasks for one planned date', () => {
  let store = sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'UTC' });
  for (let index = 1; index <= 3; index += 1) {
    store = applyCommand(store, {
      type: 'create',
      eventId: `top-event-${index}`,
      taskId: `top-task-${index}`,
      occurredAt: NOW,
      payload: {
        title: `Top ${index}`,
        plannedDate: '2026-07-20',
        top3Date: '2026-07-20',
      },
    });
  }

  assert.throws(
    () => applyCommand(store, {
      type: 'create',
      eventId: 'top-event-4',
      taskId: 'top-task-4',
      occurredAt: NOW,
      payload: { title: 'Top 4', plannedDate: '2026-07-20', top3Date: '2026-07-20' },
    }),
    /Only three Top 3 tasks/,
  );
  assert.equal(store.events.length, 3);
});

test('ordinary flags are unlimited and remain independent from the Top 3 quota', () => {
  let source = sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'UTC' });
  for (let index = 1; index <= 6; index += 1) {
    source = applyCommand(source, {
      type: 'create',
      eventId: `flag-${index}`,
      taskId: `flag-${index}`,
      occurredAt: NOW,
      payload: {
        title: `旗标任务 ${index}`,
        plannedDate: '2026-07-20',
        flagged: true,
      },
    });
  }

  assert.equal(source.tasks.length, 6);
  assert.equal(source.tasks.every((item) => item.flagged === true), true);
  assert.equal(source.tasks.every((item) => item.top3Date === null), true);
  assert.equal(source.events.length, 6);
});

test('inverseTaskPatch restores Top 3 when undoing a planned-date move', () => {
  const source = task('Top 3 任务', {
    plannedDate: '2026-07-15',
    top3Date: '2026-07-15',
  });

  const inverse = inverseTaskPatch(source, { plannedDate: '2026-07-16' });

  assert.equal(inverse.plannedDate, '2026-07-15');
  assert.equal(inverse.top3Date, '2026-07-15');
});

test('daily note and capacity commands update meta and are audited', () => {
  let store = sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'UTC' });
  store = applyCommand(store, {
    type: 'setDailyNote',
    eventId: 'note-1',
    occurredAt: NOW,
    payload: { date: '2026-07-15', note: '完成领域层升级' },
  });
  store = applyCommand(store, {
    type: 'setCapacity',
    eventId: 'capacity-1',
    occurredAt: NOW,
    payload: { minutes: 360 },
  });

  assert.equal(store.meta.dailyNotes['2026-07-15'], '完成领域层升级');
  assert.equal(store.meta.dailyCapacityMinutes, 360);
  assert.equal(store.events.length, 2);
  assert.equal(store.events[0].taskId, null);
  assert.deepEqual(store.events[1].before, { dailyCapacityMinutes: 480 });
  assert.deepEqual(store.events[1].after, { dailyCapacityMinutes: 360 });
});

test('end-of-day reminder settings and delivery date are persisted as audited meta commands', () => {
  let store = sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(store.meta.endOfDayReminderEnabled, true);
  assert.equal(store.meta.endOfDayReminderTime, '17:30');
  assert.equal(store.meta.endOfDayReminderLastDate, null);

  store = applyCommand(store, {
    type: 'setEndOfDayReminder', eventId: 'eod-setting', occurredAt: NOW,
    payload: { enabled: true, time: '18:15' },
  });
  store = applyCommand(store, {
    type: 'markEndOfDayReminderFired', eventId: 'eod-fired', occurredAt: NOW,
    payload: { date: '2026-07-16' },
  });

  assert.equal(store.meta.endOfDayReminderEnabled, true);
  assert.equal(store.meta.endOfDayReminderTime, '18:15');
  assert.equal(store.meta.endOfDayReminderLastDate, '2026-07-16');
  assert.deepEqual(store.events.slice(-2).map((event) => event.type), [
    'setEndOfDayReminder', 'markEndOfDayReminderFired',
  ]);
  assert.throws(() => applyCommand(store, {
    type: 'setEndOfDayReminder', eventId: 'eod-invalid', payload: { enabled: true, time: '25:00' },
  }), /HH:mm/);
});

test('daily planning and shutdown lifecycle is persisted without copying task state', () => {
  let store = sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.deepEqual(store.meta.dailyPlans, {});

  store = applyCommand(store, {
    type: 'startDailyPlan', eventId: 'plan-start', occurredAt: '2026-07-16T00:00:00.000Z',
    payload: { date: '2026-07-16' },
  });
  store = applyCommand(store, {
    type: 'completeDailyPlan', eventId: 'plan-complete', occurredAt: '2026-07-16T00:05:00.000Z',
    payload: { date: '2026-07-16' },
  });
  store = applyCommand(store, {
    type: 'completeDailyShutdown', eventId: 'shutdown-complete', occurredAt: '2026-07-16T10:00:00.000Z',
    payload: {
      date: '2026-07-16',
      shutdownNote: '完成核心交付',
      blockerNote: '等待外部数据',
      tomorrowFocus: '处理验收反馈',
      blockedTaskIds: ['missing-task'],
    },
  });

  const plan = store.meta.dailyPlans['2026-07-16'];
  assert.equal(plan.planningStartedAt, '2026-07-16T00:00:00.000Z');
  assert.equal(plan.planningCompletedAt, '2026-07-16T00:05:00.000Z');
  assert.equal(plan.shutdownCompletedAt, '2026-07-16T10:00:00.000Z');
  assert.equal(plan.shutdownNote, '完成核心交付');
  assert.equal(plan.blockerNote, '等待外部数据');
  assert.equal(plan.tomorrowFocus, '处理验收反馈');
  assert.deepEqual(plan.blockedTaskIds, []);
  assert.deepEqual(store.events.slice(-3).map((event) => event.type), [
    'startDailyPlan', 'completeDailyPlan', 'completeDailyShutdown',
  ]);

  const retried = applyCommand(store, {
    type: 'completeDailyShutdown', eventId: 'shutdown-complete', occurredAt: '2026-07-16T11:00:00.000Z',
    payload: { date: '2026-07-16', shutdownNote: '不应覆盖' },
  });
  assert.deepEqual(retried, store);

  const semanticRetry = applyCommand(store, {
    type: 'completeDailyShutdown', eventId: 'shutdown-complete-again', occurredAt: '2026-07-16T12:00:00.000Z',
    payload: { date: '2026-07-16', shutdownNote: '不同事件 ID 也不应覆盖' },
  });
  assert.deepEqual(semanticRetry, store);

  const planRetry = applyCommand(store, {
    type: 'completeDailyPlan', eventId: 'plan-complete-again', occurredAt: '2026-07-16T12:00:00.000Z',
    payload: { date: '2026-07-16' },
  });
  assert.deepEqual(planRetry, store);
});

test('v3 schedule blocks and multi-segment time entries are audited and conflict-safe', () => {
  let store = sanitizeStore({ version: 2, tasks: [] }, { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(store.version, 3);
  assert.deepEqual(store.scheduleBlocks, []);
  assert.deepEqual(store.timeEntries, []);
  store = applyCommand(store, {
    type: 'create', eventId: 'create-execution', taskId: 'execution-task', occurredAt: NOW,
    payload: { title: '执行任务', plannedDate: '2026-07-20', dueDate: '2026-07-21', estimateMinutes: 120 },
  });
  store = applyCommand(store, {
    type: 'upsertScheduleBlock', eventId: 'block-one', taskId: 'execution-task', occurredAt: NOW,
    payload: { blockId: 'block-one', date: '2026-07-20', startMinute: 540, durationMinutes: 60, locked: true },
  });
  assert.equal(store.scheduleBlocks[0].startMinute, 540);
  assert.throws(() => applyCommand(store, {
    type: 'upsertScheduleBlock', eventId: 'block-conflict', taskId: 'execution-task', occurredAt: NOW,
    payload: { blockId: 'block-two', date: '2026-07-20', startMinute: 570, durationMinutes: 60, locked: true },
  }), /conflicts/);

  store = applyCommand(store, {
    type: 'startFocus', eventId: 'focus-start', taskId: 'execution-task', occurredAt: '2026-07-20T01:00:00.000Z',
    payload: { entryId: 'focus-one' },
  });
  assert.equal(store.timeEntries[0].endedAt, null);
  store = applyCommand(store, {
    type: 'stopFocus', eventId: 'focus-stop', taskId: 'execution-task', occurredAt: '2026-07-20T01:45:00.000Z',
    payload: { entryId: 'focus-one' },
  });
  assert.equal(store.timeEntries[0].durationSeconds, 2700);
  store = applyCommand(store, {
    type: 'addManualTime', eventId: 'manual-time', taskId: 'execution-task', occurredAt: '2026-07-20T02:00:00.000Z',
    payload: { entryId: 'manual-one', date: '2026-07-20', minutes: 30, note: '补录' },
  });
  assert.equal(store.timeEntries[1].durationSeconds, 1800);
  assert.equal(store.events.slice(-5).map((event) => event.type).join(','),
    'create,upsertScheduleBlock,startFocus,stopFocus,addManualTime');
});

test('deleted tasks can be restored and reminder delivery is persisted', () => {
  let store = sanitizeStore({ version: 1, tasks: [] }, { now: NOW, timeZone: 'UTC' });
  store = applyCommand(store, {
    type: 'create', eventId: 'create-restore', taskId: 'restore-task', occurredAt: NOW,
    payload: { title: '可恢复', reminderAt: '2026-07-15T19:00:00.000Z' },
  });
  store = applyCommand(store, { type: 'delete', eventId: 'delete-restore', taskId: 'restore-task', occurredAt: NOW });
  store = applyCommand(store, { type: 'restore', eventId: 'restore-1', taskId: 'restore-task', occurredAt: NOW });
  store = applyCommand(store, {
    type: 'markReminderFired', eventId: 'reminded-1', taskId: 'restore-task', occurredAt: '2026-07-15T19:00:00.000Z',
  });

  assert.equal(store.tasks[0].deletedAt, null);
  assert.equal(store.tasks[0].reminderFiredAt, '2026-07-15T19:00:00.000Z');
  assert.deepEqual(store.events.slice(-2).map((event) => event.type), ['restore', 'markReminderFired']);
});

test('recurrence dates handle weekdays and month ends', () => {
  assert.equal(nextRecurringDate({ plannedDate: '2026-07-17', repeatRule: 'weekdays' }), '2026-07-20');
  assert.equal(nextRecurringDate({ plannedDate: '2026-01-31', repeatRule: 'monthly' }), '2026-02-28');
  assert.equal(nextRecurringDate({ plannedDate: '2026-02-28', repeatRule: { frequency: 'monthly', anchorDay: 31 } }), '2026-03-31');
  assert.equal(nextRecurringDate({ plannedDate: '2026-07-15', repeatRule: 'weekly' }), '2026-07-22');
  assert.equal(nextRecurringDate({ plannedDate: '2026-07-15', repeatRule: null }), null);
});

test('the domain bundle exposes the same API directly in a browser context', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain.js'), 'utf8');
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context);

  assert.equal(context.window.TodoDomain.STORE_VERSION, 3);
  assert.equal(typeof context.window.TodoDomain.applyCommand, 'function');
  assert.equal(context.window.TodoDomain.createTask('浏览器任务', { id: 'browser-task' }).title, '浏览器任务');
});
