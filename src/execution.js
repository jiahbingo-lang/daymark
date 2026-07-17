(function exposeExecution(global) {
  'use strict';

  const Planning = typeof module !== 'undefined' && module.exports
    ? require('./planning')
    : global.DaymarkPlanning;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function startOfWeek(date) {
    if (!Planning.isDate(date)) return null;
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    return Planning.addDays(date, -((day + 6) % 7));
  }

  function weekDates(date) {
    const monday = startOfWeek(date);
    return Array.from({ length: 7 }, (_, index) => Planning.addDays(monday, index));
  }

  function formatMinute(value) {
    const minute = Math.max(0, Math.min(1439, Math.round(Number(value) || 0)));
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  }

  function durationSeconds(entry, now = new Date()) {
    if (!entry?.startedAt) return 0;
    if (entry.endedAt) return Math.max(0, Number(entry.durationSeconds) || 0);
    const started = new Date(entry.startedAt);
    const current = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(started.getTime()) || Number.isNaN(current.getTime())) return 0;
    return Math.max(0, Math.round((current - started) / 1000));
  }

  function entriesForTask(store, taskId, options = {}) {
    const includeRunning = options.includeRunning !== false;
    return (Array.isArray(store?.timeEntries) ? store.timeEntries : [])
      .filter((entry) => entry?.taskId === taskId && (includeRunning || entry.endedAt))
      .map(clone);
  }

  function actualSecondsForTask(store, taskId, options = {}) {
    return entriesForTask(store, taskId, options)
      .reduce((total, entry) => total + durationSeconds(entry, options.now), 0);
  }

  function actualMinutesForTask(store, taskId, options = {}) {
    return Math.round(actualSecondsForTask(store, taskId, options) / 60);
  }

  function activeFocusEntry(store) {
    return (Array.isArray(store?.timeEntries) ? store.timeEntries : []).find((entry) => entry && !entry.endedAt) || null;
  }

  function overlaps(left, right) {
    return left.startMinute < right.startMinute + right.durationMinutes
      && right.startMinute < left.startMinute + left.durationMinutes;
  }

  function nextFreeStart(occupied, durationMinutes, preferred = 540) {
    const duration = Math.max(5, Math.round(Number(durationMinutes) || 30));
    for (let start = Math.max(0, preferred); start + duration <= 1440; start += 15) {
      const candidate = { startMinute: start, durationMinutes: duration };
      if (!occupied.some((block) => overlaps(candidate, block))) return start;
    }
    return Math.max(0, 1440 - duration);
  }

  function buildExecutionSchedule(store, options = {}) {
    const anchor = Planning.isDate(options.date) ? options.date : options.today;
    const dates = options.mode === 'day' ? [anchor] : weekDates(anchor);
    const dateSet = new Set(dates);
    const taskMap = new Map((Array.isArray(store?.tasks) ? store.tasks : [])
      .filter((task) => task && !task.deletedAt && task.status !== 'completed' && task.plannedDate)
      .map((task) => [task.id, task]));
    const schedule = Planning.buildSchedule(store, options);
    const byDate = Object.fromEntries(dates.map((date) => [date, []]));

    (schedule.manualBlocks || []).forEach((block) => {
      if (!dateSet.has(block.date) || !taskMap.has(block.taskId)) return;
      byDate[block.date].push({
        ...clone(block),
        task: clone(taskMap.get(block.taskId)),
        source: 'manual',
        locked: block.locked !== false,
      });
    });

    dates.forEach((date) => {
      const occupied = byDate[date];
      (schedule.byDate[date] || []).forEach((block) => {
        const task = taskMap.get(block.taskId);
        const minutes = Number(block.autoScheduledMinutes ?? block.scheduledMinutes) || 0;
        if (!task || minutes <= 0) return;
        const startMinute = nextFreeStart(occupied, minutes, Number(options.workdayStartMinute) || 540);
        const autoBlock = {
          id: `auto-${task.id}-${date}`,
          taskId: task.id,
          date,
          startMinute,
          durationMinutes: minutes,
          source: 'auto',
          locked: false,
          task: clone(task),
          overflowMinutes: Number(block.overflowMinutes) || 0,
        };
        occupied.push(autoBlock);
      });
      occupied.sort((a, b) => a.startMinute - b.startMinute || a.task.title.localeCompare(b.task.title, 'zh-CN'));
    });

    return {
      mode: options.mode === 'day' ? 'day' : 'week',
      dates,
      byDate,
      blocks: dates.flatMap((date) => byDate[date]),
      dailyCapacityMinutes: schedule.dailyCapacityMinutes,
      usedByDate: schedule.usedByDate,
      schedule,
    };
  }

  function riskForTask(store, task, options = {}) {
    const today = options.today;
    if (!task || task.deletedAt || task.status === 'completed' || !task.dueDate || !task.estimateMinutes || !Planning.isDate(today)) {
      return null;
    }
    const actualMinutes = actualMinutesForTask(store, task.id, options);
    const remainingMinutes = Math.max(0, Number(task.estimateMinutes) - actualMinutes);
    const schedule = options.schedule || Planning.buildSchedule(store, options);
    const capacity = schedule.dailyCapacityMinutes;
    const start = task.plannedDate && task.plannedDate > today ? task.plannedDate : today;
    const dates = [];
    for (let date = start; date && date <= task.dueDate; date = Planning.addDays(date, 1)) {
      if (Planning.isChinaWorkday(date) || date === start && start === task.dueDate) dates.push(date);
    }
    const availableMinutes = dates.reduce((total, date) => {
      const taskMinutes = (schedule.byTask[task.id] || [])
        .filter((block) => block.date === date)
        .reduce((sum, block) => sum + (Number(block.scheduledMinutes) || 0), 0);
      const otherUsed = Math.max(0, (Number(schedule.usedByDate[date]) || 0) - taskMinutes);
      return total + Math.max(0, capacity - otherUsed);
    }, 0);
    const risky = remainingMinutes > availableMinutes;
    return {
      taskId: task.id,
      risky,
      workdays: dates.length,
      remainingMinutes,
      availableMinutes,
      shortageMinutes: Math.max(0, remainingMinutes - availableMinutes),
      message: risky
        ? `距离期限还有 ${dates.length} 个工作日，需要 ${remainingMinutes} 分钟，但只剩 ${availableMinutes} 分钟可用容量。`
        : `剩余 ${remainingMinutes} 分钟，可用容量 ${availableMinutes} 分钟。`,
    };
  }

  const api = {
    startOfWeek,
    weekDates,
    formatMinute,
    durationSeconds,
    entriesForTask,
    actualSecondsForTask,
    actualMinutesForTask,
    activeFocusEntry,
    buildExecutionSchedule,
    riskForTask,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DaymarkExecution = api;
})(typeof window !== 'undefined' ? window : globalThis);
