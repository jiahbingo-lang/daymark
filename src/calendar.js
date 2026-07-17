(function exposeCalendar(global) {
  const HOLIDAY_SOURCE = Object.freeze({
    jurisdiction: '中国大陆',
    year: 2026,
    publisher: '国务院办公厅',
    label: '中国大陆 · 2026 国务院办公厅',
    url: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
  });

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function isDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
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

  const holidayEntries = new Map();

  function addHoliday(name, startDate, endDate) {
    for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
      holidayEntries.set(date, Object.freeze({ date, name, type: 'holiday', badge: '休' }));
    }
  }

  function addMakeup(name, dates) {
    dates.forEach((date) => {
      holidayEntries.set(date, Object.freeze({ date, name: `${name}调休`, type: 'makeup', badge: '班' }));
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

  function reportingApi() {
    if (global.DaymarkReporting) return global.DaymarkReporting;
    if (typeof require === 'function') return require('./reporting');
    throw new Error('DaymarkReporting is required before DaymarkCalendar');
  }

  function planningApi() {
    if (global.DaymarkPlanning) return global.DaymarkPlanning;
    if (typeof require === 'function') return require('./planning');
    throw new Error('DaymarkPlanning is required before DaymarkCalendar');
  }

  function taskDateInTimeZone(value, timeZone) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(parsed);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function getChinaHoliday(date) {
    if (!isDate(date)) return null;
    return holidayEntries.has(date) ? clone(holidayEntries.get(date)) : null;
  }

  function emptySummary() {
    return {
      plannedCount: 0,
      completedCount: 0,
      completedPlannedCount: 0,
      completionRate: null,
      createdCount: 0,
      deletedCount: 0,
      reopenedCount: 0,
      carriedCount: 0,
      top3Count: 0,
      top3CompletedCount: 0,
      top3CompletionRate: null,
      plannedMinutes: 0,
      completedMinutes: 0,
      actualMinutes: 0,
    };
  }

  function normalizeDetail(record, date) {
    const detail = clone(record || {});
    return {
      date,
      dailyNotes: String(detail.dailyNotes || ''),
      range: Array.isArray(detail.range) ? detail.range : [],
      planned: Array.isArray(detail.planned) ? detail.planned : [],
      completed: Array.isArray(detail.completed) ? detail.completed : [],
      carried: Array.isArray(detail.carried) ? detail.carried : [],
      top3: Array.isArray(detail.top3) ? detail.top3 : [],
      created: Array.isArray(detail.created) ? detail.created : [],
      deleted: Array.isArray(detail.deleted) ? detail.deleted : [],
      reopened: Array.isArray(detail.reopened) ? detail.reopened : [],
      actualTime: Array.isArray(detail.actualTime) ? detail.actualTime : [],
      summary: { ...emptySummary(), ...(detail.summary || {}) },
      dataIntegrity: detail.dataIntegrity || {
        status: 'complete',
        complete: true,
        message: '该日期没有需要重建的历史活动。',
      },
      finalized: Boolean(detail.finalized),
      finalizedAt: detail.finalizedAt || null,
    };
  }

  function buildDateDetail(store, date, options = {}) {
    if (!isDate(date)) throw new TypeError('buildDateDetail requires a valid YYYY-MM-DD date');
    const reporting = reportingApi();
    const archive = (Array.isArray(store?.dailyArchives) ? store.dailyArchives : [])
      .find((record) => record?.date === date);
    const record = archive || reporting.buildDailyRecord(store || {}, date, { finalized: false });
    const reconciled = typeof reporting.reconcileDailyRecord === 'function'
      ? reporting.reconcileDailyRecord(store || {}, record, options)
      : record;
    return normalizeDetail(reconciled, date);
  }

  function buildMonthGrid(options = {}) {
    const year = Number(options.year);
    const month = Number(options.month);
    if (!Number.isInteger(year) || year < 1000 || year > 9999) {
      throw new TypeError('buildMonthGrid requires a four-digit year');
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new TypeError('buildMonthGrid requires a month from 1 to 12');
    }
    const today = options.today;
    if (today !== undefined && today !== null && !isDate(today)) {
      throw new TypeError('today must be a valid YYYY-MM-DD date');
    }

    const first = new Date(Date.UTC(year, month - 1, 1));
    const mondayOffset = (first.getUTCDay() + 6) % 7;
    const gridStart = new Date(first);
    gridStart.setUTCDate(first.getUTCDate() - mondayOffset);
    const cells = [];
    const source = options.store || {};
    const schedule = planningApi().buildSchedule(source, options);
    const archives = new Map(
      (Array.isArray(source.dailyArchives) ? source.dailyArchives : [])
        .filter((record) => isDate(record?.date))
        .map((record) => [record.date, record]),
    );
    const liveDates = new Set(Object.keys(source?.meta?.dailyNotes || {}).filter(isDate));
    (Array.isArray(source.events) ? source.events : []).forEach((event) => {
      if (isDate(event?.reportingDate)) liveDates.add(event.reportingDate);
    });
    (Array.isArray(source.tasks) ? source.tasks : []).forEach((task) => {
      if (isDate(task?.plannedDate)) liveDates.add(task.plannedDate);
      const completionDate = taskDateInTimeZone(task?.completedAt, source?.meta?.timeZone);
      if (isDate(completionDate)) liveDates.add(completionDate);
    });
    (Array.isArray(source.timeEntries) ? source.timeEntries : []).forEach((entry) => {
      if (isDate(entry?.reportingDate) && entry?.endedAt) liveDates.add(entry.reportingDate);
    });
    Object.keys(schedule.byDate).forEach((date) => liveDates.add(date));

    for (let index = 0; index < 42; index += 1) {
      const cursor = new Date(gridStart);
      cursor.setUTCDate(gridStart.getUTCDate() + index);
      const date = isoDate(cursor);
      const archived = archives.get(date);
      const detail = archived
        ? buildDateDetail(source, date, { ...options, schedule })
        : liveDates.has(date) || date === today
          ? buildDateDetail(source, date, { ...options, schedule })
          : normalizeDetail(null, date);
      const plannedCount = Number(detail.summary?.plannedCount) || detail.planned.length;
      const completedCount = Number(detail.summary?.completedCount) || detail.completed.length;
      const actualMinutes = Number(detail.summary?.actualMinutes) || 0;
      let completionRate = detail.summary?.completionRate;
      if (!Number.isFinite(completionRate)) completionRate = plannedCount ? Math.round((completedCount / plannedCount) * 100) : null;
      cells.push({
        date,
        day: cursor.getUTCDate(),
        inCurrentMonth: cursor.getUTCFullYear() === year && cursor.getUTCMonth() === month - 1,
        isToday: date === today,
        holiday: getChinaHoliday(date),
        rangeCount: detail.range.length,
        metrics: { plannedCount, completedCount, completionRate, actualMinutes },
      });
    }

    return {
      year,
      month,
      weekStartsOn: 'monday',
      holidaySource: year === HOLIDAY_SOURCE.year ? { ...HOLIDAY_SOURCE } : null,
      cells,
    };
  }

  const api = {
    HOLIDAY_SOURCE,
    getChinaHoliday,
    buildMonthGrid,
    buildDateDetail,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DaymarkCalendar = api;
})(typeof window !== 'undefined' ? window : globalThis);
