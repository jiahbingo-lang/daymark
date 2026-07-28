const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ChinaCalendar = require('../src/china-calendar');
const Calendar = require('../src/calendar');
const Planning = require('../src/planning');
const { nextRecurringDate } = require('../src/domain');

const {
  HOLIDAY_SOURCE,
  getChinaHoliday,
  isWeekendDate,
  isChinaWorkday,
  chinaRestDay,
  isOrdinaryWeekend,
} = ChinaCalendar;

// Every 2026 date whose status is not simply "look at the day of the week".
const STATUTORY_2026 = [
  { date: '2026-01-01', name: '元旦', type: 'holiday' },
  { date: '2026-01-02', name: '元旦', type: 'holiday' },
  { date: '2026-01-03', name: '元旦', type: 'holiday' },
  { date: '2026-01-04', name: '元旦调休', type: 'makeup' },
  { date: '2026-02-14', name: '春节调休', type: 'makeup' },
  { date: '2026-02-15', name: '春节', type: 'holiday' },
  { date: '2026-02-23', name: '春节', type: 'holiday' },
  { date: '2026-02-28', name: '春节调休', type: 'makeup' },
  { date: '2026-04-04', name: '清明节', type: 'holiday' },
  { date: '2026-05-01', name: '劳动节', type: 'holiday' },
  { date: '2026-05-09', name: '劳动节调休', type: 'makeup' },
  { date: '2026-06-19', name: '端午节', type: 'holiday' },
  { date: '2026-09-20', name: '国庆节调休', type: 'makeup' },
  { date: '2026-09-25', name: '中秋节', type: 'holiday' },
  { date: '2026-10-01', name: '国庆节', type: 'holiday' },
  { date: '2026-10-07', name: '国庆节', type: 'holiday' },
  { date: '2026-10-10', name: '国庆节调休', type: 'makeup' },
];

test('the statutory 2026 table matches the published schedule', () => {
  STATUTORY_2026.forEach(({ date, name, type }) => {
    assert.deepEqual(getChinaHoliday(date), {
      date,
      name,
      type,
      badge: type === 'makeup' ? '班' : '休',
    });
  });

  assert.equal(getChinaHoliday('2026-01-10'), null, 'an ordinary weekend carries no statutory entry');
  assert.equal(getChinaHoliday('2025-12-31'), null, 'years without data are not guessed at');
  assert.equal(getChinaHoliday('not-a-date'), null);
  assert.equal(HOLIDAY_SOURCE.year, 2026);
  assert.match(HOLIDAY_SOURCE.url, /^https:\/\/www\.gov\.cn\//);
});

test('isWeekendDate stays a raw calendar fact and says nothing about working days', () => {
  assert.equal(isWeekendDate('2026-07-18'), true, 'Saturday');
  assert.equal(isWeekendDate('2026-07-19'), true, 'Sunday');
  assert.equal(isWeekendDate('2026-07-17'), false, 'Friday');
  assert.equal(isWeekendDate('not-a-date'), false);

  // The distinction the whole module exists for: a 调休 Saturday is a weekend
  // date and a mandated working day at the same time.
  assert.equal(isWeekendDate('2026-02-14'), true);
  assert.equal(isChinaWorkday('2026-02-14'), true);
});

test('isChinaWorkday follows the statutory calendar, not the day of the week', () => {
  // Makeup days are working days even though they fall on a Saturday.
  ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
    .forEach((date) => assert.equal(isChinaWorkday(date), true, `${date} is a makeup workday`));

  // Statutory holidays are not, even midweek.
  ['2026-01-01', '2026-02-16', '2026-04-06', '2026-05-01', '2026-10-01']
    .forEach((date) => assert.equal(isChinaWorkday(date), false, `${date} is a statutory holiday`));

  assert.equal(isChinaWorkday('2026-07-17'), true, 'ordinary Friday');
  assert.equal(isChinaWorkday('2026-07-18'), false, 'ordinary Saturday');
  assert.equal(isChinaWorkday('not-a-date'), false);

  // A year with no published data degrades to Monday-Friday rather than
  // inventing holidays.
  assert.equal(isChinaWorkday('2030-03-01'), true, '2030-03-01 is a Friday');
  assert.equal(isChinaWorkday('2030-03-02'), false, '2030-03-02 is a Saturday');
  assert.equal(isChinaWorkday('2030-03-04'), true, '2030-03-04 is a Monday');
});

test('chinaRestDay produces the label the UI should show, or null on working days', () => {
  assert.equal(chinaRestDay('2026-02-14'), null, 'a makeup Saturday must never be labelled a rest day');
  assert.equal(chinaRestDay('2026-07-17'), null, 'an ordinary Friday is a working day');
  assert.equal(chinaRestDay('not-a-date'), null);

  assert.deepEqual(chinaRestDay('2026-07-18'), {
    kind: 'weekend', name: '周末', badge: '周末', label: '周末安排', short: '周末',
  });

  // A holiday is labelled as one whether or not it lands on a weekend.
  assert.deepEqual(chinaRestDay('2026-10-01'), {
    kind: 'holiday', name: '国庆节', badge: '休', label: '假日安排', short: '假日',
  }, '2026-10-01 is a Thursday and still a rest day');
  assert.equal(chinaRestDay('2026-10-03').kind, 'holiday', 'a holiday on a Saturday reports as a holiday, not a weekend');
});

test('isOrdinaryWeekend keeps the calendar from stacking a second badge on 休/班 days', () => {
  assert.equal(isOrdinaryWeekend('2026-07-18'), true);
  assert.equal(isOrdinaryWeekend('2026-02-14'), false, 'the 班 badge must stand alone');
  assert.equal(isOrdinaryWeekend('2026-10-03'), false, 'the 休 badge must stand alone');
  assert.equal(isOrdinaryWeekend('2026-07-17'), false);
});

test('the scheduler and the review calendar read the same work calendar', () => {
  // This is the regression guard for the duplicated 2026 dataset that used to
  // live in both planning.js and calendar.js. Any divergence means the
  // auto-scheduler and the UI disagree about which days are working days.
  for (let date = new Date(Date.UTC(2026, 0, 1)); date <= new Date(Date.UTC(2026, 11, 31)); date.setUTCDate(date.getUTCDate() + 1)) {
    const iso = date.toISOString().slice(0, 10);
    assert.equal(
      Planning.isChinaWorkday(iso),
      isChinaWorkday(iso),
      `planning.js disagrees about ${iso}`,
    );
    assert.deepEqual(
      Calendar.getChinaHoliday(iso),
      getChinaHoliday(iso),
      `calendar.js disagrees about ${iso}`,
    );
  }
});

test('the weekdays recurrence rule uses the same calendar as everything else', () => {
  // Walk a year of weekday recurrences: every landing date must be a working
  // day by the shared calendar, never merely a Monday-to-Friday date.
  let cursor = '2026-01-01';
  for (let step = 0; step < 240; step += 1) {
    cursor = nextRecurringDate({ plannedDate: cursor, repeatRule: 'weekdays' });
    if (cursor > '2026-12-31') break;
    assert.equal(isChinaWorkday(cursor), true, `${cursor} is not a working day`);
  }
});

test('the module is a self-contained browser global with no dependencies', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'china-calendar.js'), 'utf8');
  assert.doesNotMatch(source, /require\(/, 'china-calendar must load first, so it cannot require anything');

  const sandbox = {};
  new Function('window', 'globalThis', source)(sandbox, sandbox);
  assert.equal(typeof sandbox.DaymarkChinaCalendar?.isChinaWorkday, 'function');
  assert.equal(sandbox.DaymarkChinaCalendar.isChinaWorkday('2026-02-14'), true);
});
