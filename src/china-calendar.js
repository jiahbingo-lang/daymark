(function exposeChinaCalendar(global) {
  'use strict';

  // The single source of truth for China's statutory rest days and the makeup
  // workdays that pay them back. Both the auto-scheduler (planning.js) and the
  // review calendar (calendar.js) read from here, so display and scheduling can
  // never disagree about which days are working days. Adding a new year means
  // editing this file — and only this file.
  const HOLIDAY_SOURCE = Object.freeze({
    jurisdiction: '中国大陆',
    year: 2026,
    publisher: '国务院办公厅',
    label: '中国大陆 · 2026 国务院办公厅',
    url: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
  });

  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

  function isDate(value) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  }

  function isoDate(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function addDays(value, amount) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    parsed.setUTCDate(parsed.getUTCDate() + amount);
    return isoDate(parsed);
  }

  const entries = new Map();

  function addHoliday(name, startDate, endDate) {
    for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
      entries.set(date, Object.freeze({ date, name, type: 'holiday', badge: '休' }));
    }
  }

  function addMakeup(name, dates) {
    dates.forEach((date) => {
      entries.set(date, Object.freeze({ date, name: `${name}调休`, type: 'makeup', badge: '班' }));
    });
  }

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

  function getChinaHoliday(date) {
    if (!isDate(date)) return null;
    return entries.has(date) ? { ...entries.get(date) } : null;
  }

  // The raw calendar fact: is this a Saturday or Sunday? This says nothing
  // about whether it is a day off — a 调休 Saturday is a mandated workday.
  // Use isChinaWorkday or chinaRestDay to decide what to tell the user.
  function isWeekendDate(date) {
    if (!isDate(date)) return false;
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    return day === 0 || day === 6;
  }

  function isChinaWorkday(date) {
    if (!isDate(date)) return false;
    const entry = entries.get(date);
    if (entry) return entry.type === 'makeup';
    return !isWeekendDate(date);
  }

  // What the UI should actually label a non-working day as, or null when the
  // date is a working day. A 调休 Saturday returns null; a statutory holiday
  // returns a holiday label even when it falls midweek.
  function chinaRestDay(date) {
    if (!isDate(date) || isChinaWorkday(date)) return null;
    const entry = entries.get(date);
    if (entry && entry.type === 'holiday') {
      return { kind: 'holiday', name: entry.name, badge: entry.badge, label: '假日安排', short: '假日' };
    }
    return { kind: 'weekend', name: '周末', badge: '周末', label: '周末安排', short: '周末' };
  }

  // An ordinary weekend carries no statutory entry of its own. Holidays and
  // makeup days already show their own 休/班 badge, so the calendar must not
  // stack a second, contradictory "周末" badge on top of them.
  function isOrdinaryWeekend(date) {
    return isWeekendDate(date) && !entries.has(date);
  }

  const api = {
    HOLIDAY_SOURCE,
    getChinaHoliday,
    isWeekendDate,
    isChinaWorkday,
    chinaRestDay,
    isOrdinaryWeekend,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DaymarkChinaCalendar = api;
})(typeof window !== 'undefined' ? window : globalThis);
