const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/renderer-harness');
const {
  sanitizeStore, applyCommand, dateInTimeZone, nextRecurringDate,
} = require('../src/domain');

const R = createHarness();

test('the renderer scripts load with every helper under test present', () => {
  // Guards the four-file split: a construct dropped or renamed during a future
  // reorganisation shows up here rather than as a blank panel in the app.
  [
    'toInputDateTime', 'fromInputDateTime', 'addDays', 'todayDate', 'tomorrowDate',
    'formatShortDate', 'formatCompletedGroupDate', 'formatCompletionTime',
    'shiftedDate', 'shiftedDateTime', 'repeatRuleForNext', 'errorMessage',
    'coerceStore', 'plannedForNewTask', 'formatCalendarDate', 'formatRecordDate',
    'periodTitle', 'markdownList', 'shiftMonth', 'coerceAiSettings', 'executionDateLabel',
  ].forEach((name) => assert.equal(typeof R[name], 'function', `${name} is missing`));
});

test('datetime-local values round-trip through China time without drifting', () => {
  // The reminder field is a datetime-local showing China time; storage is UTC
  // ISO. A regression here silently moves every reminder by eight hours.
  assert.equal(R.fromInputDateTime('2026-07-20T09:30'), '2026-07-20T01:30:00.000Z');
  assert.equal(R.toInputDateTime('2026-07-20T01:30:00.000Z'), '2026-07-20T09:30');

  const value = '2026-11-03T17:05';
  assert.equal(R.toInputDateTime(R.fromInputDateTime(value)), value, 'round-trip is stable');

  // 00:30 in China is the previous UTC day; the field must still show the
  // China date, not the UTC one.
  assert.equal(R.toInputDateTime('2026-07-19T16:30:00.000Z'), '2026-07-20T00:30');
  assert.equal(R.fromInputDateTime('2026-07-20T00:30'), '2026-07-19T16:30:00.000Z');
});

test('malformed datetime input is rejected instead of being coerced', () => {
  assert.equal(R.toInputDateTime(''), '');
  assert.equal(R.toInputDateTime('乱码'), '');
  assert.equal(R.toInputDateTime(null), '');
  assert.equal(R.fromInputDateTime(''), null);
  assert.equal(R.fromInputDateTime('2026-07-20'), null, 'a bare date carries no time');
  assert.equal(R.fromInputDateTime('2026-07-20T09:30:00'), null, 'seconds are not the field format');
  assert.equal(R.fromInputDateTime('not-a-date'), null);
});

test('list and calendar dates render in China time', () => {
  assert.equal(R.formatShortDate('2026-07-20'), '7月20日');
  assert.equal(R.formatCalendarDate('2026-07-20'), '7月20日星期一');
  assert.equal(R.formatRecordDate('2026-07-20'), '7月20日');
  assert.equal(R.executionDateLabel('2026-07-20'), '7/20周一');
  // 01:30 UTC is 09:30 in Shanghai.
  assert.equal(R.formatCompletionTime('2026-07-20T01:30:00.000Z'), '09:30');
  assert.equal(R.formatCompletionTime(''), '');
  assert.equal(R.formatCompletionTime('乱码'), '');
});

test('completed groups label today and yesterday, and add the year only across years', () => {
  assert.equal(R.formatCompletedGroupDate('2026-07-20', '2026-07-20'), '今天 · 7月20日周一');
  assert.equal(R.formatCompletedGroupDate('2026-07-19', '2026-07-20'), '昨天 · 7月19日周日');
  assert.equal(R.formatCompletedGroupDate('2026-07-15', '2026-07-20'), '7月15日周三');
  assert.equal(R.formatCompletedGroupDate('2025-12-31', '2026-07-20'), '2025年12月31日周三');
  assert.equal(R.formatCompletedGroupDate(null, '2026-07-20'), '日期未记录');
});

test('completing a repeating task shifts its deadline and reminder by the same span', () => {
  // The next occurrence must keep the gap between planned date and deadline,
  // and keep the reminder at the same clock time.
  assert.equal(R.shiftedDate('2026-07-25', '2026-07-20', '2026-07-27'), '2026-08-01');
  assert.equal(
    R.shiftedDateTime('2026-07-25T01:30:00.000Z', '2026-07-20', '2026-07-27'),
    '2026-08-01T01:30:00.000Z',
    'the reminder stays at 09:30 China time',
  );

  assert.equal(R.shiftedDate(null, '2026-07-20', '2026-07-27'), null);
  assert.equal(R.shiftedDate('2026-07-25', null, '2026-07-27'), '2026-07-25', 'no span means no shift');
  assert.equal(R.shiftedDateTime(null, '2026-07-20', '2026-07-27'), null);
  assert.equal(R.shiftedDateTime('乱码', '2026-07-20', '2026-07-27'), null);
});

test('a month-end repeat keeps its original day anchor instead of walking backwards', () => {
  // README: 月末重复会保留原始日期锚点. Without the anchor a task due on the
  // 31st would land on the 28th in February and stay there for good.
  let plannedDate = '2026-01-31';
  let repeatRule = 'monthly';
  const landed = [];

  for (let i = 0; i < 4; i += 1) {
    const next = nextRecurringDate({ plannedDate, repeatRule });
    repeatRule = R.repeatRuleForNext({ repeatRule }, plannedDate);
    plannedDate = next;
    landed.push(next);
  }

  assert.deepEqual(landed, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.deepEqual(repeatRule, { frequency: 'monthly', anchorDay: 31 });
});

test('repeatRuleForNext preserves an explicit anchor and leaves other rules alone', () => {
  assert.deepEqual(
    R.repeatRuleForNext({ repeatRule: { frequency: 'monthly', anchorDay: 15 } }, '2026-02-28'),
    { frequency: 'monthly', anchorDay: 15 },
    'an explicit anchor is not overwritten by the base date',
  );
  assert.equal(R.repeatRuleForNext({ repeatRule: 'weekly' }, '2026-01-31'), 'weekly');
  assert.equal(R.repeatRuleForNext({ repeatRule: null }, '2026-01-31'), null);
});

test('errorMessage still recognises the errors the domain actually throws', () => {
  // A drift guard. These strings are produced in domain.js and matched by
  // substring in the renderer; renaming one there would otherwise surface raw
  // English to the user with no test failing.
  let store = sanitizeStore({ version: 1, tasks: [] }, {
    now: new Date('2026-07-20T00:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  });
  const create = (id, payload) => applyCommand(store, {
    type: 'create', eventId: `e-${id}`, taskId: id, occurredAt: '2026-07-20T01:00:00.000Z', payload,
  });

  for (let i = 1; i <= 3; i += 1) {
    store = create(`t${i}`, { title: `T${i}`, plannedDate: '2026-07-21', top3Date: '2026-07-21' });
  }
  assert.throws(
    () => create('t4', { title: 'T4', plannedDate: '2026-07-21', top3Date: '2026-07-21' }),
    (error) => {
      assert.equal(R.errorMessage(error), '一天最多只能标记 3 个 Top 3 任务');
      return true;
    },
  );

  assert.throws(
    () => create('bad', { title: 'X', plannedDate: '2026-07-25', dueDate: '2026-07-20' }),
    (error) => {
      assert.equal(R.errorMessage(error), '最后期限不能早于计划日期');
      return true;
    },
  );

  assert.throws(
    () => sanitizeStore({ version: 99, tasks: [] }),
    (error) => {
      assert.equal(R.errorMessage(error), '数据来自更新版本，为避免覆盖已切换到只读保护');
      return true;
    },
  );

  // Anything unrecognised is surfaced verbatim rather than swallowed.
  assert.equal(R.errorMessage(new Error('磁盘写入失败')), '磁盘写入失败');
  assert.equal(R.errorMessage(null), '未知错误');
});

test('coerceStore accepts every shape the bridge may hand back', () => {
  const raw = { version: 1, tasks: [{ id: 'a', title: '任务' }] };
  const expected = R.coerceStore(raw).tasks.map((task) => task.title);
  assert.deepEqual(expected, ['任务']);
  assert.deepEqual(R.coerceStore({ store: raw }).tasks.map((t) => t.title), ['任务']);
  assert.deepEqual(R.coerceStore({ data: raw }).tasks.map((t) => t.title), ['任务']);
  assert.deepEqual(R.coerceStore({ data: { store: raw } }).tasks.map((t) => t.title), ['任务']);
  assert.equal(R.coerceStore(raw).version, 3, 'v1 payloads are migrated on the way in');
});

test('coerceAiSettings defaults to opting daily notes out and completion notes in', () => {
  const empty = R.coerceAiSettings({});
  assert.equal(empty.includeDailyNotes, false, '每日备注 defaults to off');
  assert.equal(empty.includeCompletionNotes, true, '完成说明 defaults to on');
  assert.equal(empty.hasKey, false);
  assert.equal(empty.keySource, 'none');
  assert.equal(typeof empty.model, 'string');
  assert.ok(empty.model.length > 0, 'a model id is always present');

  const stored = R.coerceAiSettings({ hasStoredKey: true, model: 'custom-model' });
  assert.equal(stored.model, 'custom-model');
  assert.equal(stored.hasKey, true);
  assert.equal(stored.keySource, 'safeStorage');

  // An explicit hasApiKey from the main process wins over the inferred value.
  assert.equal(R.coerceAiSettings({ hasStoredKey: true, hasApiKey: false }).hasKey, false);
  assert.equal(R.coerceAiSettings({ includeCompletionNotes: false }).includeCompletionNotes, false);
});

test('month navigation crosses year boundaries in both directions', () => {
  assert.equal(R.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(R.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(R.shiftMonth('2026-07', 0), '2026-07');
  assert.equal(R.shiftMonth('2026-03', -14), '2025-01');
});

test('report titles and markdown lists render the empty case explicitly', () => {
  assert.equal(R.periodTitle({ mode: 'month', year: 2026, month: 7 }), '2026 年 7 月');
  assert.equal(R.periodTitle({ mode: 'quarter', year: 2026, quarter: 3 }), '2026 年第 3 季度');
  assert.equal(R.periodTitle({ mode: 'year', year: 2026 }), '2026 年度');
  assert.equal(R.periodTitle({ mode: 'month', year: 2026, month: 7 }, '工作总结'), '2026 年 7 月工作总结');

  assert.equal(R.markdownList([], (x) => x), '- 暂无记录');
  assert.equal(R.markdownList(null, (x) => x), '- 暂无记录');
  assert.equal(R.markdownList(['甲', '乙'], (x) => `${x}项`), '- 甲项\n- 乙项');
});

test('a new task inherits the planned date implied by the current view', () => {
  const today = dateInTimeZone(new Date(), 'Asia/Shanghai');
  const tomorrow = R.addDays(today, 1);

  R.state.view = 'inbox';
  R.state.quickDate = null;
  assert.equal(R.plannedForNewTask(), null, 'the inbox collects without scheduling');

  R.state.view = 'today';
  assert.equal(R.plannedForNewTask(), today);

  R.state.view = 'upcoming';
  assert.equal(R.plannedForNewTask(), tomorrow);

  R.state.view = 'inbox';
  R.state.quickDate = 'today';
  assert.equal(R.plannedForNewTask(), today, 'the quick-date button wins over the view');
  R.state.quickDate = 'tomorrow';
  assert.equal(R.plannedForNewTask(), tomorrow);

  R.state.quickDate = null;
});

test('addDays walks across month and year boundaries', () => {
  assert.equal(R.addDays('2026-07-20', 1), '2026-07-21');
  assert.equal(R.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(R.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(R.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(R.addDays('2026-03-01', -1), '2026-02-28', '2026 is not a leap year');
});
