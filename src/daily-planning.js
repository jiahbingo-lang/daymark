(function exposeDailyPlanning(global) {
  function addDays(dateString, amount) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + amount));
    return date.toISOString().slice(0, 10);
  }

  function dayDifference(from, to) {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    return Math.max(0, Math.round((end - start) / 86400000));
  }

  function activeTask(task) {
    return Boolean(task && !task.deletedAt && task.status !== 'completed');
  }

  function activeTasks(store) {
    return (Array.isArray(store?.tasks) ? store.tasks : []).filter(activeTask);
  }

  function createdDate(task, timeZone = 'Asia/Shanghai') {
    const value = new Date(task?.createdAt);
    if (Number.isNaN(value.getTime())) return null;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(value);
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    } catch {
      return value.toISOString().slice(0, 10);
    }
  }

  function candidateCategory(task, date, options = {}) {
    if (!activeTask(task)) return null;
    const yesterday = addDays(date, -1);
    if (task.plannedDate === yesterday) return 'yesterday';
    if ((task.plannedDate && task.plannedDate < date) || (task.dueDate && task.dueDate < date)) return 'overdue';
    if (task.plannedDate === date || task.dueDate === date) return 'today';
    const riskThrough = addDays(date, Number(options.riskDays) || 3);
    if (task.dueDate && task.dueDate > date && task.dueDate <= riskThrough) return 'upcoming';
    if (!task.plannedDate) {
      const created = createdDate(task, options.timeZone || 'Asia/Shanghai');
      if (!created || created >= addDays(date, -7)) return 'inbox';
    }
    return null;
  }

  const CATEGORY_COPY = Object.freeze({
    yesterday: { order: 0, label: '昨日未完成' },
    overdue: { order: 1, label: '已经逾期' },
    today: { order: 2, label: '今天相关' },
    upcoming: { order: 3, label: '即将到期' },
    inbox: { order: 4, label: '近期收件箱' },
  });

  function dailyPlanningCandidates(store, date, options = {}) {
    return activeTasks(store)
      .map((task) => {
        const category = candidateCategory(task, date, {
          ...options,
          timeZone: store?.meta?.timeZone || options.timeZone,
        });
        return category ? {
          task,
          category,
          categoryLabel: CATEGORY_COPY[category].label,
          selected: Boolean(
            (task.plannedDate && task.plannedDate <= date) ||
            (task.dueDate && task.dueDate <= date),
          ),
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => {
        const categoryOrder = CATEGORY_COPY[a.category].order - CATEGORY_COPY[b.category].order;
        if (categoryOrder) return categoryOrder;
        const top3 = Number(b.task.top3Date === date) - Number(a.task.top3Date === date);
        if (top3) return top3;
        return String(a.task.dueDate || a.task.plannedDate || '9999-12-31')
          .localeCompare(String(b.task.dueDate || b.task.plannedDate || '9999-12-31'));
      });
  }

  function todayReason(task, date, scheduleBlock = null) {
    if (!activeTask(task)) return '';
    if (task.dueDate && task.dueDate < date) return `逾期 ${dayDifference(task.dueDate, date)} 天`;
    if (task.plannedDate && task.plannedDate < date) {
      const days = dayDifference(task.plannedDate, date);
      return days === 1 ? '昨日延续' : `计划延续 ${days} 天`;
    }
    if (task.dueDate === date) return '今天到期';
    const minutes = Number(scheduleBlock?.scheduledMinutes) || 0;
    if (minutes > 0) return `自动分配 ${minutes} 分钟`;
    if (task.plannedDate === date) return '今天计划开始';
    return '手动加入今天';
  }

  function groupTodayTasks(tasks, date, scheduleByTask = {}) {
    const groups = { top3: [], planned: [], overdue: [], other: [] };
    (Array.isArray(tasks) ? tasks : []).forEach((task) => {
      if (task.top3Date === date) groups.top3.push(task);
      else if ((task.dueDate && task.dueDate < date) || (task.plannedDate && task.plannedDate < date)) {
        groups.overdue.push(task);
      } else if ((Number(scheduleByTask[task.id]?.scheduledMinutes) || 0) > 0 || task.plannedDate === date) {
        groups.planned.push(task);
      } else groups.other.push(task);
    });
    return groups;
  }

  function completedDate(task, timeZone = 'Asia/Shanghai') {
    if (!task?.completedAt) return null;
    const value = new Date(task?.completedAt);
    if (Number.isNaN(value.getTime())) return null;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(value);
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    } catch {
      return value.toISOString().slice(0, 10);
    }
  }

  function groupCompletedTasks(tasks, timeZone = 'Asia/Shanghai') {
    const byDate = new Map();
    (Array.isArray(tasks) ? tasks : [])
      .filter((task) => task && !task.deletedAt && task.status === 'completed')
      .sort((left, right) => String(right.completedAt || '').localeCompare(String(left.completedAt || '')))
      .forEach((task) => {
        const date = completedDate(task, timeZone);
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push(task);
      });
    return [...byDate.entries()]
      .sort(([left], [right]) => {
        if (left === null) return 1;
        if (right === null) return -1;
        return right.localeCompare(left);
      })
      .map(([date, groupedTasks]) => ({ date, tasks: groupedTasks }));
  }

  function pendingShutdownTasks(store, date) {
    return activeTasks(store).filter((task) => Boolean(
      (task.plannedDate && task.plannedDate <= date) ||
      (task.dueDate && task.dueDate <= date),
    ));
  }

  function dailyPlanForDate(store, date) {
    return store?.meta?.dailyPlans?.[date] || null;
  }

  function shutdownComplete(store, date) {
    return Boolean(dailyPlanForDate(store, date)?.shutdownCompletedAt);
  }

  const api = {
    addDays,
    dayDifference,
    candidateCategory,
    dailyPlanningCandidates,
    todayReason,
    groupTodayTasks,
    completedDate,
    groupCompletedTasks,
    pendingShutdownTasks,
    dailyPlanForDate,
    shutdownComplete,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DaymarkDailyPlanning = api;
})(typeof window !== 'undefined' ? window : globalThis);
