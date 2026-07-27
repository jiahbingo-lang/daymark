(function exposePlanning(global) {
  'use strict';

  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const DEFAULT_CAPACITY_MINUTES = 480;
  const CHUNK_MINUTES = 30;
  const PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2, none: 3 });

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function isDate(value) {
    if (!DATE_PATTERN.test(String(value || ''))) return false;
    const [year, month, day] = String(value).split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  }

  function addDays(value, amount) {
    if (!isDate(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
  }

  function dateInTimeZone(value, timeZone = 'Asia/Shanghai') {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        })
          .formatToParts(parsed)
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, part.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch {
      return parsed.toISOString().slice(0, 10);
    }
  }

  // The statutory calendar lives in one place so the scheduler and the review
  // calendar cannot drift apart. Re-exported below for existing callers.
  const ChinaCalendar = typeof module !== 'undefined' && module.exports
    ? require('./china-calendar')
    : global.DaymarkChinaCalendar;

  function isChinaWorkday(date) {
    return isDate(date) && ChinaCalendar.isChinaWorkday(date);
  }

  function taskRange(task) {
    const startDate = isDate(task?.plannedDate) ? task.plannedDate : null;
    if (!startDate) return null;
    const dueDate = isDate(task?.dueDate) ? task.dueDate : null;
    const invalid = Boolean(dueDate && dueDate < startDate);
    const endDate = dueDate && dueDate >= startDate ? dueDate : startDate;
    return { startDate, endDate, invalid, multiDay: endDate > startDate };
  }

  function datesInRange(startDate, endDate) {
    const dates = [];
    for (let date = startDate; date && date <= endDate; date = addDays(date, 1)) dates.push(date);
    return dates;
  }

  function phaseForDate(date, range) {
    if (!range.multiDay) return 'single';
    if (date === range.startDate) return 'start';
    if (date === range.endDate) return 'deadline';
    return 'middle';
  }

  function capacityValue(input, options) {
    const raw = options.dailyCapacityMinutes ?? input?.meta?.dailyCapacityMinutes;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_CAPACITY_MINUTES;
  }

  function schedulableTasks(input) {
    const tasks = Array.isArray(input) ? input : Array.isArray(input?.tasks) ? input.tasks : [];
    return tasks
      .filter((task) => task && !task.deletedAt && taskRange(task))
      .slice()
      .sort((left, right) => {
        const leftRange = taskRange(left);
        const rightRange = taskRange(right);
        return leftRange.endDate.localeCompare(rightRange.endDate)
          || (PRIORITY_RANK[left.priority] ?? 3) - (PRIORITY_RANK[right.priority] ?? 3)
          || leftRange.startDate.localeCompare(rightRange.startDate)
          || String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
          || String(left.id || '').localeCompare(String(right.id || ''));
      });
  }

  function manualScheduleBlocks(input, tasks) {
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    return (Array.isArray(input?.scheduleBlocks) ? input.scheduleBlocks : [])
      .filter((block) => {
        const task = taskMap.get(block?.taskId);
        const range = taskRange(task);
        const start = Number(block?.startMinute);
        const duration = Number(block?.durationMinutes);
        return Boolean(
          task
          && range
          && block?.source !== 'auto'
          && isDate(block?.date)
          && block.date >= range.startDate
          && block.date <= range.endDate
          && Number.isFinite(start)
          && start >= 0
          && Number.isFinite(duration)
          && duration > 0,
        );
      })
      .map((block) => ({
        ...clone(block),
        startMinute: Math.max(0, Math.min(1435, Math.round(Number(block.startMinute)))),
        durationMinutes: Math.max(5, Math.min(720, Math.round(Number(block.durationMinutes)))),
        source: 'manual',
        locked: block.locked !== false,
      }));
  }

  function buildSchedule(input, options = {}) {
    const capacity = capacityValue(input, options);
    const tasks = schedulableTasks(input);
    const manualBlocks = manualScheduleBlocks(input, tasks);
    const manualByTaskDate = new Map();
    const usedByDate = new Map();
    manualBlocks.forEach((block) => {
      const key = `${block.taskId}:${block.date}`;
      manualByTaskDate.set(key, (manualByTaskDate.get(key) || 0) + block.durationMinutes);
      usedByDate.set(block.date, (usedByDate.get(block.date) || 0) + block.durationMinutes);
    });
    const blocks = [];
    const byTask = {};
    const byDate = {};

    tasks.forEach((task) => {
      const range = taskRange(task);
      const dates = datesInRange(range.startDate, range.endDate);
      let eligibleDates = dates.filter(isChinaWorkday);
      if (!range.multiDay || eligibleDates.length === 0) eligibleDates = [range.startDate];
      const eligible = new Set(eligibleDates);
      const estimate = Number(task.estimateMinutes);
      const hasEstimate = Number.isFinite(estimate) && estimate > 0;
      const manualTotal = dates.reduce(
        (total, date) => total + (manualByTaskDate.get(`${task.id}:${date}`) || 0),
        0,
      );
      let remaining = hasEstimate ? Math.max(0, Math.round(estimate) - manualTotal) : 0;
      const allocations = new Map(dates.map((date) => [date, hasEstimate ? 0 : null]));

      if (hasEstimate) {
        const target = Math.max(CHUNK_MINUTES, Math.ceil((remaining / eligibleDates.length) / CHUNK_MINUTES) * CHUNK_MINUTES);
        eligibleDates.forEach((date) => {
          const available = Math.max(0, capacity - (usedByDate.get(date) || 0));
          const minutes = Math.min(remaining, target, available);
          allocations.set(date, minutes);
          usedByDate.set(date, (usedByDate.get(date) || 0) + minutes);
          remaining -= minutes;
        });
        eligibleDates.forEach((date) => {
          if (remaining <= 0) return;
          const available = Math.max(0, capacity - (usedByDate.get(date) || 0));
          const minutes = Math.min(remaining, available);
          allocations.set(date, (allocations.get(date) || 0) + minutes);
          usedByDate.set(date, (usedByDate.get(date) || 0) + minutes);
          remaining -= minutes;
        });
      }

      const taskBlocks = dates.map((date) => {
        const manualScheduledMinutes = manualByTaskDate.get(`${task.id}:${date}`) || 0;
        const autoScheduledMinutes = allocations.get(date);
        return {
          taskId: task.id,
          date,
          startDate: range.startDate,
          endDate: range.endDate,
          phase: phaseForDate(date, range),
          isWorkday: isChinaWorkday(date),
          isPlanningDay: eligible.has(date) || manualScheduledMinutes > 0,
          autoScheduledMinutes,
          manualScheduledMinutes,
          scheduledMinutes: hasEstimate
            ? (Number(autoScheduledMinutes) || 0) + manualScheduledMinutes
            : null,
          needsEstimate: !hasEstimate,
          overflowMinutes: date === range.endDate ? remaining : 0,
          invalidRange: range.invalid,
        };
      });
      byTask[task.id] = taskBlocks;
      taskBlocks.forEach((block) => {
        blocks.push(block);
        if (!byDate[block.date]) byDate[block.date] = [];
        byDate[block.date].push(block);
      });
    });

    return {
      dailyCapacityMinutes: capacity,
      usedByDate: Object.fromEntries(usedByDate),
      blocks,
      byTask,
      byDate,
      manualBlocks,
    };
  }

  function withBlock(task, block) {
    return {
      ...clone(task),
      scheduleDate: block.date,
      scheduleStart: block.startDate,
      scheduleEnd: block.endDate,
      schedulePhase: block.phase,
      scheduleIsWorkday: block.isWorkday,
      scheduleIsPlanningDay: block.isPlanningDay,
      scheduledMinutes: block.scheduledMinutes,
      scheduleNeedsEstimate: block.needsEstimate,
      scheduleOverflowMinutes: block.overflowMinutes,
    };
  }

  function currentReviewForDate(input, date, options = {}) {
    if (!isDate(date)) throw new TypeError('currentReviewForDate requires YYYY-MM-DD');
    const tasks = Array.isArray(input) ? input : Array.isArray(input?.tasks) ? input.tasks : [];
    const timeZone = input?.meta?.timeZone || options.timeZone || 'Asia/Shanghai';
    const taskMap = new Map(tasks.filter((task) => task && !task.deletedAt).map((task) => [task.id, task]));
    const schedule = options.schedule || buildSchedule(input, options);
    const range = [];
    const planned = [];

    (schedule.byDate[date] || []).forEach((block) => {
      const task = taskMap.get(block.taskId);
      if (!task) return;
      const completionDate = task.completedAt ? dateInTimeZone(task.completedAt, timeZone) : null;
      if (task.status === 'completed' && completionDate !== date) return;
      const snapshot = withBlock(task, block);
      range.push(snapshot);
      if (
        block.isPlanningDay
        && (block.needsEstimate || Number(block.scheduledMinutes) > 0 || !taskRange(task).multiDay)
      ) planned.push(snapshot);
    });

    const completed = tasks
      .filter((task) => task && !task.deletedAt && task.status === 'completed')
      .filter((task) => dateInTimeZone(task.completedAt, timeZone) === date)
      .map((task) => {
        const block = (schedule.byTask[task.id] || []).find((entry) => entry.date === date);
        return block ? withBlock(task, block) : clone(task);
      });
    const completedIds = new Set(completed.map((task) => task.id));
    const top3 = planned.filter((task) => task.top3Date === date);
    const plannedCompleted = planned.filter((task) => completedIds.has(task.id));
    const carried = planned.filter((task) => task.status === 'active' && date < (options.today || '9999-12-31'));

    return { range, planned, completed, top3, plannedCompleted, carried, schedule };
  }

  const api = {
    DEFAULT_CAPACITY_MINUTES,
    CHUNK_MINUTES,
    isDate,
    addDays,
    isChinaWorkday,
    taskRange,
    buildSchedule,
    currentReviewForDate,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DaymarkPlanning = api;
})(typeof window !== 'undefined' ? window : globalThis);
