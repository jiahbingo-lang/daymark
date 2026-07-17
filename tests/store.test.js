const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTask } = require('../src/domain');
const { createTodoStore } = require('../src/store');

const NOW = new Date('2026-07-15T18:00:00.000Z');

async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'daymark-test-'));
  const filePath = path.join(directory, 'data', 'todos.json');
  const config = { now: () => NOW, timeZone: 'UTC', ...options };
  const store = createTodoStore(filePath, config);
  return {
    directory,
    filePath,
    config,
    store,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

function legacyStore(title) {
  return {
    version: 1,
    tasks: [createTask(title, { id: title, now: NOW })],
  };
}

test('a first launch returns an empty v2 store', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const result = await context.store.load();
  assert.equal(result.version, 2);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.dailyArchives, []);
  assert.equal(result.meta.historyStartAt, NOW.toISOString());
});

test('v1 is migrated once, permanently backed up, and Chinese content survives', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const payload = legacyStore('完成桌面版 ✅');
  payload.tasks[0].notes = '仅保存在本机';
  await fs.mkdir(path.dirname(context.filePath), { recursive: true });
  await fs.writeFile(context.filePath, JSON.stringify(payload), 'utf8');

  const migrated = await context.store.load();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.tasks[0].title, '完成桌面版 ✅');
  assert.equal(migrated.tasks[0].notes, '仅保存在本机');
  assert.equal(migrated.events[0].type, 'baseline_imported');

  const permanent = JSON.parse(await fs.readFile(`${context.filePath}.v1-backup.json`, 'utf8'));
  assert.equal(permanent.version, 1);
  assert.equal(permanent.tasks[0].title, '完成桌面版 ✅');
  assert.equal(JSON.parse(await fs.readFile(context.filePath, 'utf8')).version, 2);
  assert.equal((await fs.stat(context.filePath)).mode & 0o777, 0o600);
});

test('forced China timezone migration reindexes events and rebuilds derived archives', async (t) => {
  const context = await fixture({
    timeZone: 'Asia/Shanghai',
    forceTimeZone: true,
  });
  t.after(context.cleanup);
  const raw = {
    version: 2,
    meta: {
      historyStartAt: '2026-07-15T00:00:00.000Z',
      timeZone: 'America/Los_Angeles',
      nextSeq: 2,
      dailyCapacityMinutes: 480,
      dailyNotes: { '2026-07-15': '用户明确填写的日期保持不变' },
    },
    tasks: [createTask('跨时区任务', {
      id: 'timezone-task',
      now: '2026-07-16T06:30:00.000Z',
      plannedDate: '2026-07-15',
    })],
    events: [{
      eventId: 'old-zone-event',
      seq: 1,
      taskId: 'timezone-task',
      type: 'create',
      occurredAt: '2026-07-16T06:30:00.000Z',
      reportingDate: '2026-07-15',
      timeZone: 'America/Los_Angeles',
      before: null,
      after: null,
    }],
    dailyArchives: [{ date: '2026-07-15', planned: [], completed: [] }],
  };
  await fs.mkdir(path.dirname(context.filePath), { recursive: true });
  await fs.writeFile(context.filePath, JSON.stringify(raw), 'utf8');

  const migrated = await context.store.load();
  assert.equal(migrated.meta.timeZone, 'Asia/Shanghai');
  assert.equal(migrated.events[0].reportingDate, '2026-07-16');
  assert.equal(migrated.events[0].timeZone, 'Asia/Shanghai');
  assert.deepEqual(migrated.dailyArchives, []);
  assert.equal(migrated.tasks[0].plannedDate, '2026-07-15');
  assert.equal(migrated.meta.dailyNotes['2026-07-15'], '用户明确填写的日期保持不变');

  const disk = JSON.parse(await fs.readFile(context.filePath, 'utf8'));
  const backup = JSON.parse(await fs.readFile(`${context.filePath}.bak`, 'utf8'));
  assert.equal(disk.meta.timeZone, 'Asia/Shanghai');
  assert.equal(backup.meta.timeZone, 'America/Los_Angeles');
  assert.equal(backup.dailyArchives.length, 1);
});

test('new commands use the configured China reporting date across the UTC boundary', async (t) => {
  const context = await fixture({
    timeZone: 'Asia/Shanghai',
    forceTimeZone: true,
    now: () => new Date('2026-07-16T06:30:00.000Z'),
  });
  t.after(context.cleanup);

  const result = await context.store.execute({
    type: 'create',
    eventId: 'china-date',
    taskId: 'china-date',
    occurredAt: '2026-07-16T06:30:00.000Z',
    payload: { title: '按中国日期归属' },
  });

  assert.equal(result.meta.timeZone, 'Asia/Shanghai');
  assert.equal(result.events[0].reportingDate, '2026-07-16');
  assert.equal(result.events[0].timeZone, 'Asia/Shanghai');
});

test('execute writes task state and its audit event atomically', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const created = await context.store.execute({
    type: 'create',
    eventId: 'create-1',
    taskId: 'task-1',
    occurredAt: NOW,
    payload: { title: '写季度总结', plannedDate: '2026-07-15', area: '产品' },
  });
  assert.equal(created.tasks[0].title, '写季度总结');
  assert.equal(created.events.length, 1);
  assert.equal(created.events[0].after.area, '产品');

  const disk = JSON.parse(await fs.readFile(context.filePath, 'utf8'));
  assert.equal(disk.tasks[0].id, 'task-1');
  assert.equal(disk.events[0].taskId, 'task-1');
  assert.equal(disk.meta.nextSeq, 2);
});

test('the same event id is idempotent and queued commands cannot race', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await Promise.all([
    context.store.execute({ type: 'create', eventId: 'A', taskId: 'A', occurredAt: NOW, payload: { title: 'A' } }),
    context.store.execute({ type: 'create', eventId: 'B', taskId: 'B', occurredAt: NOW, payload: { title: 'B' } }),
    context.store.execute({ type: 'create', eventId: 'C', taskId: 'C', occurredAt: NOW, payload: { title: 'C' } }),
  ]);
  await context.store.execute({ type: 'create', eventId: 'C', taskId: 'C', occurredAt: NOW, payload: { title: 'C' } });
  const result = await context.store.load();
  assert.deepEqual(result.tasks.map((task) => task.title), ['A', 'B', 'C']);
  assert.deepEqual(result.events.map((event) => event.eventId), ['A', 'B', 'C']);
});

test('a second write keeps the previous valid v2 file as a backup', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await context.store.execute({ type: 'create', eventId: 'first', taskId: 'one', occurredAt: NOW, payload: { title: '第一版' } });
  await context.store.execute({ type: 'update', eventId: 'second', taskId: 'one', occurredAt: NOW, payload: { title: '第二版' } });

  const backup = JSON.parse(await fs.readFile(`${context.filePath}.bak`, 'utf8'));
  assert.equal(backup.tasks[0].title, '第一版');
  assert.equal((await context.store.load()).tasks[0].title, '第二版');
});

test('corrupt data is preserved and the last backup is recovered', async (t) => {
  const context = await fixture({ now: () => new Date(12345) });
  t.after(context.cleanup);
  await context.store.execute({ type: 'create', eventId: 'one', taskId: 'one', occurredAt: NOW, payload: { title: '可恢复版本' } });
  await context.store.execute({ type: 'update', eventId: 'two', taskId: 'one', occurredAt: NOW, payload: { title: '稍后损坏版本' } });
  await fs.writeFile(context.filePath, '{not json', 'utf8');

  const reopened = createTodoStore(context.filePath, context.config);
  const recovered = await reopened.load();
  assert.equal(recovered.tasks[0].title, '可恢复版本');
  assert.equal(await fs.readFile(`${context.filePath}.corrupt-12345.json`, 'utf8'), '{not json');
});

test('future versions fail closed without renaming or overwriting the file', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await fs.mkdir(path.dirname(context.filePath), { recursive: true });
  const future = '{"version":99,"tasks":[]}';
  await fs.writeFile(context.filePath, future, 'utf8');
  await assert.rejects(context.store.load(), /Unsupported store version/);
  assert.equal(await fs.readFile(context.filePath, 'utf8'), future);
  assert.equal((await fs.readdir(path.dirname(context.filePath))).some((name) => name.includes('.corrupt-')), false);
});

test('daily archives are persisted without mutating audit events', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await context.store.execute({ type: 'create', eventId: 'one', taskId: 'one', occurredAt: NOW, payload: { title: '留档任务' } });
  const archive = { date: '2026-07-14', cutoffSeq: 0, planned: [], completed: [], summary: {} };
  const result = await context.store.persistArchives([archive]);
  assert.deepEqual(result.dailyArchives, [archive]);
  assert.equal(result.events.length, 1);
});

test('the 10,001st task never leaves an audit event without its task state', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const tasks = Array.from({ length: 10_000 }, (_, index) =>
    createTask(`已有任务 ${index}`, { id: `seed-${index}`, now: NOW }));
  await context.store.save({
    version: 2,
    meta: {
      historyStartAt: NOW.toISOString(),
      timeZone: 'UTC',
      nextSeq: 1,
      dailyCapacityMinutes: 480,
      dailyNotes: {},
    },
    tasks,
    events: [],
    dailyArchives: [],
  });

  const result = await context.store.execute({
    type: 'create',
    eventId: 'overflow-create',
    taskId: 'overflow-task',
    occurredAt: NOW,
    payload: { title: '第 10,001 个任务' },
  });

  assert.equal(result.tasks.length, 10_001);
  assert.equal(result.tasks.some((task) => task.id === 'overflow-task'), true);
  assert.equal(result.events.some((event) => event.eventId === 'overflow-create'), true);

  const disk = JSON.parse(await fs.readFile(context.filePath, 'utf8'));
  assert.equal(disk.tasks.some((task) => task.id === 'overflow-task'), true);
  assert.equal(disk.events.some((event) => event.eventId === 'overflow-create'), true);
});
