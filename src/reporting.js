(function exposeReporting(global) {
  'use strict';

  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const DAY_MS = 24 * 60 * 60 * 1000;
  function planningApi() {
    if (global.DaymarkPlanning) return global.DaymarkPlanning;
    if (typeof require === 'function') return require('./planning');
    throw new Error('DaymarkPlanning is required before DaymarkReporting');
  }

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
      const result = {};
      Object.keys(value).forEach((key) => {
        result[key] = clone(value[key]);
      });
      return result;
    }
    return value;
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isDate(value) {
    if (!DATE_PATTERN.test(String(value || ''))) return false;
    const [year, month, day] = String(value).split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }

  function dateInTimeZone(value, timeZone) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;

    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || undefined,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const parts = Object.fromEntries(
        formatter
          .formatToParts(parsed)
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, part.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch {
      return parsed.toISOString().slice(0, 10);
    }
  }

  function normalizeDate(value, timeZone) {
    if (isDate(value)) return String(value);
    if (value instanceof Date || (typeof value === 'string' && value.trim())) {
      return dateInTimeZone(value, timeZone);
    }
    return null;
  }

  function addDays(value, amount) {
    if (!isDate(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
  }

  function eventSequence(event, index) {
    const value = Number(event?.seq);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : index + 1;
  }

  function eventReportingDate(event, timeZone) {
    if (isDate(event?.reportingDate)) return event.reportingDate;
    return normalizeDate(event?.occurredAt || event?.at || event?.timestamp, timeZone);
  }

  function indexedEvents(store) {
    const timeZone = store?.meta?.timeZone;
    return (Array.isArray(store?.events) ? store.events : [])
      .map((event, index) => ({
        event,
        index,
        seq: eventSequence(event, index),
        date: eventReportingDate(event, timeZone),
      }))
      .sort((left, right) => left.seq - right.seq || left.index - right.index);
  }

  function taskId(task, fallback) {
    const value = task?.id ?? task?.taskId ?? fallback;
    return value === undefined || value === null || value === '' ? null : String(value);
  }

  function eventTaskId(event) {
    return taskId(event?.after, taskId(event?.before, event?.taskId));
  }

  function withTaskId(snapshot, id) {
    if (!isObject(snapshot)) return null;
    const result = clone(snapshot);
    if (!taskId(result) && id) result.id = id;
    return result;
  }

  function isDeleted(task) {
    return Boolean(task?.deletedAt) || task?.status === 'deleted';
  }

  function isCompleted(task) {
    return task?.status === 'completed';
  }

  function eventFlags(event) {
    const before = isObject(event?.before) ? event.before : null;
    const after = isObject(event?.after) ? event.after : null;
    const type = String(event?.type || '').toLocaleLowerCase();
    const baselineImport = type === 'baseline_imported';
    const beforeDeleted = isDeleted(before);
    const afterDeleted = isDeleted(after);

    return {
      created:
        (!baselineImport && !before && after && !afterDeleted) ||
        /(^|[._:-])(create|created)([._:-]|$)/.test(type),
      deleted:
        (before && (!after || (!beforeDeleted && afterDeleted))) ||
        /(^|[._:-])(delete|deleted|remove|removed)([._:-]|$)/.test(type),
      completed:
        (before && after && !isCompleted(before) && isCompleted(after)) ||
        /(^|[._:-])(complete|completed)([._:-]|$)/.test(type),
      reopened:
        (before && after && isCompleted(before) && !isCompleted(after) && !afterDeleted) ||
        /(^|[._:-])(reopen|reopened|uncomplete)([._:-]|$)/.test(type),
    };
  }

  function cutoffForDate(events, date) {
    let cutoff = 0;
    events.forEach((entry) => {
      if (entry.date && entry.date <= date) cutoff = Math.max(cutoff, entry.seq);
    });
    return cutoff;
  }

  function stateAtCutoff(store, events, cutoffSeq) {
    const state = new Map();
    (Array.isArray(store?.tasks) ? store.tasks : []).forEach((task) => {
      const id = taskId(task);
      if (id) state.set(id, clone(task));
    });

    // Current tasks are the source of truth. Replaying newer events backwards
    // recovers the exact historical snapshot, including tasks deleted later.
    let missingBefore = 0;
    [...events]
      .reverse()
      .filter((entry) => entry.seq > cutoffSeq)
      .forEach(({ event }) => {
        const id = eventTaskId(event);
        if (!id) return;
        if (Object.prototype.hasOwnProperty.call(event, 'before')) {
          if (isObject(event.before)) state.set(id, withTaskId(event.before, id));
          else state.delete(id);
        } else {
          missingBefore += 1;
        }
      });

    return { state, missingBefore };
  }

  function noteValue(value) {
    let result = value;
    if (isObject(result)) result = result.text ?? result.note ?? result.content ?? '';
    if (Array.isArray(result)) result = result.join('\n');
    return String(result ?? '').trim();
  }

  function noteForDate(store, date, options) {
    const source = options?.dailyNotes ?? store?.meta?.dailyNotes ?? store?.dailyNotes;
    let value = source;
    if (Array.isArray(source)) {
      value = source.find((entry) => entry?.date === date);
    } else if (isObject(source) && !('text' in source) && !('note' in source) && !('content' in source)) {
      value = source[date];
    }
    return noteValue(value);
  }

  function noteAtCutoff(store, date, options, events, cutoffSeq) {
    if (Object.prototype.hasOwnProperty.call(options || {}, 'dailyNotes')) {
      return noteForDate(store, date, options);
    }
    let value = store?.meta?.dailyNotes?.[date] ?? store?.dailyNotes?.[date] ?? '';
    [...events]
      .reverse()
      .filter((entry) => entry.seq > cutoffSeq)
      .forEach(({ event }) => {
        const type = String(event?.type || '').toLocaleLowerCase();
        const targetDate = event?.after?.date || event?.before?.date;
        if (type === 'setdailynote' && targetDate === date) value = event?.before?.note ?? '';
      });
    return noteValue(value);
  }

  function capacityAtCutoff(store, options, events, cutoffSeq) {
    if (Object.prototype.hasOwnProperty.call(options || {}, 'dailyCapacityMinutes')) {
      return numberOrZero(options.dailyCapacityMinutes);
    }
    let value = store?.meta?.dailyCapacityMinutes;
    [...events]
      .reverse()
      .filter((entry) => entry.seq > cutoffSeq)
      .forEach(({ event }) => {
        const type = String(event?.type || '').toLocaleLowerCase();
        if (type === 'setcapacity' && event?.before) value = event.before.dailyCapacityMinutes;
      });
    return numberOrZero(value);
  }

  function priorityRank(value) {
    return { high: 0, medium: 1, low: 2, none: 3 }[value] ?? 4;
  }

  function sortTaskSnapshots(tasks, date) {
    return [...tasks].sort((left, right) => {
      const topDifference = Number(right?.top3Date === date) - Number(left?.top3Date === date);
      if (topDifference) return topDifference;
      const priorityDifference = priorityRank(left?.priority) - priorityRank(right?.priority);
      if (priorityDifference) return priorityDifference;
      return String(left?.title || '').localeCompare(String(right?.title || ''), 'zh-CN');
    });
  }

  function uniqueEventSnapshots(entries, flag, preference) {
    const snapshots = new Map();
    entries.forEach(({ event }) => {
      if (!eventFlags(event)[flag]) return;
      const id = eventTaskId(event);
      const candidates = preference === 'before' ? [event.before, event.after] : [event.after, event.before];
      const snapshot = candidates.find(isObject);
      if (id && snapshot) snapshots.set(id, withTaskId(snapshot, id));
    });
    return [...snapshots.values()];
  }

  function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function sumMinutes(tasks) {
    return tasks.reduce((total, task) => total + numberOrZero(task?.estimateMinutes), 0);
  }

  function sumPlannedMinutes(tasks) {
    return tasks.reduce((total, task) => {
      const value = Object.prototype.hasOwnProperty.call(task || {}, 'scheduledMinutes')
        ? task.scheduledMinutes
        : task?.estimateMinutes;
      return total + numberOrZero(value);
    }, 0);
  }

  function actualTimeForDate(store, date) {
    const tasks = new Map((Array.isArray(store?.tasks) ? store.tasks : [])
      .filter((task) => taskId(task) && !isDeleted(task))
      .map((task) => [taskId(task), task]));
    const groups = new Map();
    (Array.isArray(store?.timeEntries) ? store.timeEntries : []).forEach((entry) => {
      if (entry?.reportingDate !== date || !entry.endedAt || !tasks.has(entry.taskId)) return;
      const seconds = Math.max(0, Number(entry.durationSeconds) || 0);
      if (!seconds) return;
      groups.set(entry.taskId, (groups.get(entry.taskId) || 0) + seconds);
    });
    const entries = [...groups.entries()].map(([id, seconds]) => {
      const task = tasks.get(id);
      return {
        taskId: id,
        title: task?.title || '未命名任务',
        area: areaName(task),
        minutes: Math.round(seconds / 60),
      };
    }).sort((left, right) => right.minutes - left.minutes || left.title.localeCompare(right.title, 'zh-CN'));
    return {
      minutes: entries.reduce((total, entry) => total + entry.minutes, 0),
      entries,
    };
  }

  function percentage(numerator, denominator) {
    if (!denominator) return null;
    return Math.round((numerator / denominator) * 1000) / 10;
  }

  function dailyIntegrity(store, date, missingSnapshotEvents) {
    const historyStartAt = store?.meta?.historyStartAt || null;
    const historyStartDate = normalizeDate(historyStartAt, store?.meta?.timeZone);
    let status = 'complete';
    let message = '';

    if (!historyStartDate) {
      status = 'partial';
      message = '缺少 historyStartAt，无法确认迁移前数据是否完整。';
    } else if (date < historyStartDate) {
      status = 'unavailable';
      message = `历史追踪从 ${historyStartDate} 开始，此日前记录不完整。`;
    } else if (date === historyStartDate) {
      status = 'partial';
      message = `历史追踪于 ${historyStartDate} 启用，当日较早活动可能缺失。`;
    }

    if (missingSnapshotEvents > 0) {
      status = status === 'unavailable' ? status : 'partial';
      message = `${message}${message ? ' ' : ''}${missingSnapshotEvents} 个事件缺少可回放的 before/after 快照。`;
    }

    return {
      status,
      complete: status === 'complete',
      historyStartAt,
      historyStartDate,
      missingSnapshotEvents,
      message,
    };
  }

  function buildDailyRecord(store, date, options = {}) {
    const timeZone = store?.meta?.timeZone || options.timeZone || null;
    const reportingDate = normalizeDate(date, timeZone);
    if (!reportingDate) throw new TypeError('buildDailyRecord requires a valid YYYY-MM-DD date');

    const events = indexedEvents(store);
    const requestedCutoff = Number(options.cutoffSeq);
    const cutoffSeq = Number.isFinite(requestedCutoff)
      ? Math.max(0, Math.trunc(requestedCutoff))
      : cutoffForDate(events, reportingDate);
    const dayEvents = events.filter((entry) => entry.date === reportingDate && entry.seq <= cutoffSeq);
    const { state, missingBefore } = stateAtCutoff(store, events, cutoffSeq);

    const created = uniqueEventSnapshots(dayEvents, 'created', 'after');
    const completionSnapshots = uniqueEventSnapshots(dayEvents, 'completed', 'after');
    // Completion notes are intentionally entered after a task is checked off.
    // Use the task's end-of-day snapshot so same-day edits (especially the
    // outcome note) appear in the daily record, while stateAtCutoff still
    // protects older records from edits made on later dates.
    const completed = completionSnapshots.flatMap((snapshot) => {
      const id = taskId(snapshot);
      const endOfDayTask = id ? state.get(id) : null;
      // A completion that was undone before the end of the day is not a
      // completed result. The reopen event remains available for audit.
      if (endOfDayTask && !isDeleted(endOfDayTask) && !isCompleted(endOfDayTask)) return [];
      return [endOfDayTask && !isDeleted(endOfDayTask) ? clone(endOfDayTask) : snapshot];
    });
    const deleted = uniqueEventSnapshots(dayEvents, 'deleted', 'before');
    const reopened = uniqueEventSnapshots(dayEvents, 'reopened', 'after');

    const plannedById = new Map();
    state.forEach((task, id) => {
      if (!isDeleted(task) && task?.plannedDate === reportingDate) {
        plannedById.set(id, clone(task));
      }
    });

    // A commitment still belongs to this day's denominator when it is moved
    // to another planned date during the day. Keep the last snapshot from
    // immediately before it left today's plan, so postponing work cannot
    // inflate the completion rate by silently removing the task. Explicitly
    // clearing the date means "move to Inbox" and withdraws the commitment.
    dayEvents.forEach(({ event }) => {
      if (event?.before?.plannedDate !== reportingDate) return;
      const id = eventTaskId(event);
      const finalTask = id ? state.get(id) : null;
      if (
        id
        && finalTask
        && !isDeleted(finalTask)
        && finalTask.plannedDate
        && finalTask.plannedDate !== reportingDate
      ) {
        plannedById.set(id, withTaskId(event.before, id));
      }
    });

    // A task deleted during the day still belonged to that day's plan and must
    // retain its pre-delete title/metadata in the archive.
    dayEvents.forEach(({ event }) => {
      if (!eventFlags(event).deleted || event?.before?.plannedDate !== reportingDate) return;
      const id = eventTaskId(event);
      const finalTask = id ? state.get(id) : null;
      if (id && (!finalTask || isDeleted(finalTask))) {
        plannedById.set(id, withTaskId(event.before, id));
      }
    });

    const planned = sortTaskSnapshots([...plannedById.values()], reportingDate);
    const top3 = planned.filter((task) => task?.top3Date === reportingDate);
    const carried = planned.filter((task) => {
      const current = state.get(taskId(task));
      return current && !isDeleted(current) && !isCompleted(current);
    });
    const completedIds = new Set(completed.map((task) => taskId(task)).filter(Boolean));
    const plannedCompleted = planned.filter(
      (task) => isCompleted(task) && completedIds.has(taskId(task)),
    );
    const top3Completed = top3.filter(
      (task) => isCompleted(task) && completedIds.has(taskId(task)),
    );

    let missingSnapshots = missingBefore;
    dayEvents.forEach(({ event }) => {
      const flags = eventFlags(event);
      if ((flags.created || flags.completed || flags.deleted || flags.reopened) && !event.before && !event.after) {
        missingSnapshots += 1;
      }
    });

    const dailyNotes = noteAtCutoff(store, reportingDate, options, events, cutoffSeq);
    const capacityMinutes = capacityAtCutoff(store, options, events, cutoffSeq);
    const finalizedAt = options.finalizedAt || null;
    const actualTime = actualTimeForDate(store, reportingDate);

    return {
      date: reportingDate,
      cutoffSeq,
      timeZone,
      finalized: Boolean(options.finalized),
      ...(finalizedAt ? { finalizedAt: String(finalizedAt) } : {}),
      capacityMinutes,
      dailyCapacityMinutes: capacityMinutes,
      dailyNotes,
      planned,
      top3,
      completed,
      created,
      deleted,
      reopened,
      carried,
      actualTime: actualTime.entries,
      summary: {
        plannedCount: planned.length,
        completedCount: completed.length,
        completedPlannedCount: plannedCompleted.length,
        completionRate: percentage(plannedCompleted.length, planned.length),
        createdCount: created.length,
        deletedCount: deleted.length,
        reopenedCount: reopened.length,
        carriedCount: carried.length,
        top3Count: top3.length,
        top3CompletedCount: top3Completed.length,
        top3CompletionRate: percentage(top3Completed.length, top3.length),
        plannedMinutes: sumMinutes(planned),
        completedMinutes: sumMinutes(completed),
        actualMinutes: actualTime.minutes,
      },
      dataIntegrity: dailyIntegrity(store, reportingDate, missingSnapshots),
    };
  }

  function finalizeMissingArchives(store, today, options = {}) {
    const timeZone = store?.meta?.timeZone || options.timeZone || null;
    const todayDate = normalizeDate(today, timeZone);
    if (!todayDate) throw new TypeError('finalizeMissingArchives requires a valid today date');

    const result = clone(isObject(store) ? store : {});
    if (!isObject(result.meta)) result.meta = {};
    if (!Array.isArray(result.tasks)) result.tasks = [];
    if (!Array.isArray(result.events)) result.events = [];
    if (!Array.isArray(result.dailyArchives)) result.dailyArchives = [];

    const historyStartDate = normalizeDate(result.meta.historyStartAt, result.meta.timeZone || timeZone);
    if (!historyStartDate) return result;

    const lastDate = addDays(todayDate, -1);
    const existingDates = new Set(result.dailyArchives.map((record) => record?.date).filter(isDate));
    const finalizedAtValue = options.finalizedAt || options.now;
    const finalizedAt = finalizedAtValue instanceof Date
      ? finalizedAtValue.toISOString()
      : finalizedAtValue
        ? String(finalizedAtValue)
        : null;

    for (let date = historyStartDate; date && date <= lastDate; date = addDays(date, 1)) {
      if (existingDates.has(date)) continue;
      const record = buildDailyRecord(result, date, {
        ...options,
        cutoffSeq: undefined,
        finalized: true,
        finalizedAt,
      });
      result.dailyArchives.push(record);
      existingDates.add(date);
    }

    result.dailyArchives.sort((left, right) => String(left?.date).localeCompare(String(right?.date)));
    return result;
  }

  function listDailyRecords(store, options = {}) {
    const timeZone = store?.meta?.timeZone || options.timeZone || null;
    const schedule = planningApi().buildSchedule(store || {}, options);
    const records = (Array.isArray(store?.dailyArchives) ? store.dailyArchives : [])
      .map((record) => reconcileDailyRecord(store, record, { ...options, schedule }));
    if (options.includeCurrent) {
      const today = normalizeDate(options.today, timeZone);
      if (!today) throw new TypeError('listDailyRecords requires today when includeCurrent is true');
      if (!records.some((record) => record?.date === today)) {
        records.push(reconcileDailyRecord(
          store,
          buildDailyRecord(store, today, { ...options, finalized: false }),
          { ...options, schedule },
        ));
      }
    }
    return records.sort((left, right) => String(right?.date).localeCompare(String(left?.date)));
  }

  function recordArrays(record, key) {
    return Array.isArray(record?.[key]) ? record[key] : [];
  }

  function recordTop3(record) {
    const explicit = recordArrays(record, 'top3');
    if (explicit.length) return explicit;
    return recordArrays(record, 'planned').filter((task) => task?.top3Date === record?.date);
  }

  function plannedCompletedTasks(record) {
    const completedIds = new Set(recordArrays(record, 'completed').map((task) => taskId(task)).filter(Boolean));
    const reopenedIds = new Set(recordArrays(record, 'reopened').map((task) => taskId(task)).filter(Boolean));
    return recordArrays(record, 'planned').filter(
      (task) => completedIds.has(taskId(task)) && !reopenedIds.has(taskId(task)),
    );
  }

  function reconcileDailyRecord(store, record, options = {}) {
    const result = clone(isObject(record) ? record : {});
    if (!isDate(result.date)) return result;

    const currentTasks = new Map();
    (Array.isArray(store?.tasks) ? store.tasks : []).forEach((task) => {
      const id = taskId(task);
      if (id) currentTasks.set(id, task);
    });

    // Archives remain the durable source for notes and audit metadata, but
    // user-facing membership is rebuilt from current tasks. This makes moving
    // a task replace its old calendar position instead of duplicating history.
    const live = planningApi().currentReviewForDate(store || {}, result.date, {
      today: options.today || normalizeDate(new Date(), store?.meta?.timeZone),
      schedule: options.schedule,
    });
    const preserveOrphans = (key) => recordArrays(result, key).filter((snapshot) => {
      const id = taskId(snapshot);
      return id && !currentTasks.has(id);
    });
    result.range = [...preserveOrphans('range'), ...live.range];
    result.planned = [...preserveOrphans('planned'), ...live.planned];
    result.completed = [...preserveOrphans('completed'), ...live.completed];
    result.top3 = [...preserveOrphans('top3'), ...live.top3];
    result.carried = [...preserveOrphans('carried'), ...live.carried];

    ['created', 'deleted', 'reopened'].forEach((key) => {
      result[key] = recordArrays(result, key).filter((snapshot) => {
        const current = currentTasks.get(taskId(snapshot));
        return !current || !isDeleted(current);
      });
    });

    const planned = recordArrays(result, 'planned');
    const completed = recordArrays(result, 'completed');
    const top3 = recordTop3(result);
    result.top3 = top3;
    const plannedCompleted = plannedCompletedTasks(result);
    const completedIds = new Set(completed.map((task) => taskId(task)).filter(Boolean));
    const reopenedIds = new Set(recordArrays(result, 'reopened').map((task) => taskId(task)).filter(Boolean));
    const top3Completed = top3.filter(
      (task) => completedIds.has(taskId(task)) && !reopenedIds.has(taskId(task)),
    );
    const actualTime = actualTimeForDate(store, result.date);
    result.actualTime = actualTime.entries;
    result.summary = {
      ...(isObject(result.summary) ? result.summary : {}),
      plannedCount: planned.length,
      completedCount: completed.length,
      completedPlannedCount: plannedCompleted.length,
      completionRate: percentage(plannedCompleted.length, planned.length),
      createdCount: recordArrays(result, 'created').length,
      deletedCount: recordArrays(result, 'deleted').length,
      reopenedCount: recordArrays(result, 'reopened').length,
      carriedCount: recordArrays(result, 'carried').length,
      top3Count: top3.length,
      top3CompletedCount: top3Completed.length,
      top3CompletionRate: percentage(top3Completed.length, top3.length),
      plannedMinutes: sumPlannedMinutes(planned),
      completedMinutes: sumMinutes(completed),
      actualMinutes: actualTime.minutes,
    };
    return result;
  }

  function recordIsActive(record) {
    return (
      // Creating a future task is scheduling activity, not work performed on
      // the creation date. Planned work belongs to plannedDate; completed work
      // belongs to its completion date. Keep `created` for audit totals only.
      ['planned', 'completed', 'deleted', 'reopened'].some(
        (key) => recordArrays(record, key).length > 0,
      ) || numberOrZero(record?.summary?.actualMinutes) > 0
      || Boolean(String(record?.dailyNotes || '').trim())
    );
  }

  function aggregateRecords(records) {
    const result = {
      activeDays: 0,
      planned: 0,
      completed: 0,
      completedPlanned: 0,
      completionRate: null,
      created: 0,
      deleted: 0,
      reopened: 0,
      carried: 0,
      plannedMinutes: 0,
      completedMinutes: 0,
      actualMinutes: 0,
      capacityMinutes: 0,
    };
    const plannedIds = new Set();
    const completedIds = new Set();
    const completedPlannedIds = new Set();
    records.forEach((record) => {
      if (recordIsActive(record)) result.activeDays += 1;
      const planned = recordArrays(record, 'planned');
      const completed = recordArrays(record, 'completed');
      planned.forEach((task) => plannedIds.add(taskId(task) || `${record.date}:${task?.title || ''}`));
      completed.forEach((task) => completedIds.add(taskId(task) || `${record.date}:${task?.title || ''}`));
      plannedCompletedTasks(record).forEach((task) => completedPlannedIds.add(taskId(task) || `${record.date}:${task?.title || ''}`));
      result.created += recordArrays(record, 'created').length;
      result.deleted += recordArrays(record, 'deleted').length;
      result.reopened += recordArrays(record, 'reopened').length;
      result.carried += recordArrays(record, 'carried').length;
      result.plannedMinutes += sumPlannedMinutes(planned);
      result.completedMinutes += sumMinutes(completed);
      result.actualMinutes += numberOrZero(record?.summary?.actualMinutes);
      result.capacityMinutes += numberOrZero(record?.dailyCapacityMinutes ?? record?.capacityMinutes);
    });
    result.planned = plannedIds.size;
    result.completed = completedIds.size;
    result.completedPlanned = completedPlannedIds.size;
    result.completionRate = percentage(result.completedPlanned, result.planned);
    return result;
  }

  function monthStart(date) {
    return `${date.slice(0, 7)}-01`;
  }

  function addMonths(value, amount) {
    const [year, month] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1 + amount, 1));
    return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  function quarterOf(date) {
    return Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
  }

  function areaName(task) {
    const value = String(task?.area || '').trim();
    return value || '未分类';
  }

  function reportIntegrity(store, records, startDate, effectiveEnd) {
    const historyStartAt = store?.meta?.historyStartAt || null;
    const historyStartDate = normalizeDate(historyStartAt, store?.meta?.timeZone);
    const problematic = records.filter((record) => record?.dataIntegrity?.complete === false);
    const missingSnapshotEvents = problematic.reduce(
      (total, record) => total + numberOrZero(record?.dataIntegrity?.missingSnapshotEvents),
      0,
    );
    const predatesHistory = !historyStartDate || (effectiveEnd && startDate < historyStartDate);
    const partial = predatesHistory || problematic.length > 0;
    let message = '该报告覆盖范围内的事件历史完整。';
    if (!historyStartDate) {
      message = '缺少 historyStartAt；迁移前活动无法完整重建。';
    } else if (partial) {
      message = `仅能可靠重建 ${historyStartDate} 之后的活动；迁移前历史及启用当天较早活动可能缺失。`;
    }
    if (missingSnapshotEvents) {
      message += ` 另有 ${missingSnapshotEvents} 个事件缺少可回放快照。`;
    }
    return {
      status: partial ? 'partial' : 'complete',
      complete: !partial,
      historyStartAt,
      historyStartDate,
      migrationHistoryIncomplete: predatesHistory,
      missingSnapshotEvents,
      partialRecordDates: problematic.map((record) => record.date),
      message,
    };
  }

  function buildPeriodReport(store, options = {}) {
    const year = Number(options.year);
    const quarter = options.quarter === undefined || options.quarter === null || options.quarter === ''
      ? null
      : Number(options.quarter);
    if (!Number.isInteger(year) || year < 1000 || year > 9999) {
      throw new TypeError('buildPeriodReport requires a four-digit year');
    }
    if (quarter !== null && (!Number.isInteger(quarter) || quarter < 1 || quarter > 4)) {
      throw new TypeError('quarter must be an integer from 1 to 4');
    }

    const timeZone = store?.meta?.timeZone || options.timeZone || null;
    const today = normalizeDate(options.today, timeZone);
    if (!today) throw new TypeError('buildPeriodReport requires a valid today date');

    const startMonth = quarter === null ? 1 : (quarter - 1) * 3 + 1;
    const endMonth = quarter === null ? 12 : quarter * 3;
    const startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`;
    const endDate = addDays(addMonths(`${year}-${String(endMonth).padStart(2, '0')}-01`, 1), -1);
    const effectiveEnd = today < endDate ? today : endDate;

    const hydrated = finalizeMissingArchives(store, today, options);
    const allRecords = listDailyRecords(hydrated, {
      includeCurrent: today >= startDate && today <= endDate,
      today,
    });
    const records = effectiveEnd < startDate
      ? []
      : allRecords
          .filter((record) => record?.date >= startDate && record?.date <= effectiveEnd)
          .sort((left, right) => left.date.localeCompare(right.date));
    const totals = aggregateRecords(records);

    const top3Entries = [];
    const top3PlannedIds = new Set();
    const top3CompletedIds = new Set();
    records.forEach((record) => {
      const items = recordTop3(record);
      const completedIds = new Set(plannedCompletedTasks(record).map((task) => taskId(task)));
      items.forEach((task) => {
        const id = taskId(task) || `${record.date}:${task?.title || ''}`;
        top3PlannedIds.add(id);
        if (!completedIds.has(taskId(task))) return;
        top3CompletedIds.add(id);
        top3Entries.push({ date: record.date, task: clone(task) });
      });
    });

    const highPriorityEntries = [];
    const highPlannedIds = new Set();
    const highCompletedPlannedIds = new Set();
    const highCompletedIds = new Set();
    records.forEach((record) => {
      const planned = recordArrays(record, 'planned').filter((task) => task?.priority === 'high');
      const plannedDone = plannedCompletedTasks(record).filter((task) => task?.priority === 'high');
      const completed = recordArrays(record, 'completed').filter((task) => task?.priority === 'high');
      planned.forEach((task) => highPlannedIds.add(taskId(task) || `${record.date}:${task?.title || ''}`));
      plannedDone.forEach((task) => highCompletedPlannedIds.add(taskId(task) || `${record.date}:${task?.title || ''}`));
      completed.forEach((task) => {
        highCompletedIds.add(taskId(task) || `${record.date}:${task?.title || ''}`);
        highPriorityEntries.push({ date: record.date, task: clone(task) });
      });
    });

    const areas = new Map();
    function ensureArea(name) {
      if (!areas.has(name)) {
        areas.set(name, {
          area: name,
          activeDates: new Set(),
          plannedIds: new Set(),
          completedIds: new Set(),
          completedPlannedIds: new Set(),
          plannedMinutes: 0,
          completedMinutes: 0,
          actualMinutes: 0,
        });
      }
      return areas.get(name);
    }
    records.forEach((record) => {
      const plannedDoneIds = new Set(plannedCompletedTasks(record).map((task) => taskId(task)));
      recordArrays(record, 'planned').forEach((task) => {
        const area = ensureArea(areaName(task));
        area.activeDates.add(record.date);
        const id = taskId(task) || `${record.date}:${task?.title || ''}`;
        area.plannedIds.add(id);
        area.plannedMinutes += numberOrZero(
          Object.prototype.hasOwnProperty.call(task || {}, 'scheduledMinutes')
            ? task.scheduledMinutes
            : task?.estimateMinutes,
        );
        if (plannedDoneIds.has(taskId(task))) area.completedPlannedIds.add(id);
      });
      recordArrays(record, 'completed').forEach((task) => {
        const area = ensureArea(areaName(task));
        area.activeDates.add(record.date);
        area.completedIds.add(taskId(task) || `${record.date}:${task?.title || ''}`);
        area.completedMinutes += numberOrZero(task?.estimateMinutes);
      });
      recordArrays(record, 'actualTime').forEach((entry) => {
        const area = ensureArea(String(entry?.area || '').trim() || '未分类');
        area.activeDates.add(record.date);
        area.actualMinutes += numberOrZero(entry?.minutes);
      });
    });
    const byArea = [...areas.values()]
      .map((area) => ({
        area: area.area,
        activeDays: area.activeDates.size,
        planned: area.plannedIds.size,
        completed: area.completedIds.size,
        completedPlanned: area.completedPlannedIds.size,
        completionRate: percentage(area.completedPlannedIds.size, area.plannedIds.size),
        plannedMinutes: area.plannedMinutes,
        completedMinutes: area.completedMinutes,
        actualMinutes: area.actualMinutes,
      }))
      .sort((left, right) => right.completed - left.completed || right.planned - left.planned || left.area.localeCompare(right.area, 'zh-CN'));

    const monthlyTrend = [];
    if (effectiveEnd >= startDate) {
      for (let month = monthStart(startDate); month <= monthStart(effectiveEnd); month = addMonths(month, 1)) {
        const metrics = aggregateRecords(records.filter((record) => record.date.startsWith(month.slice(0, 7))));
        monthlyTrend.push({ period: month.slice(0, 7), ...metrics });
      }
    }

    const quarterlyTrend = [];
    if (effectiveEnd >= startDate) {
      const lastQuarter = quarterOf(effectiveEnd);
      for (let value = quarterOf(startDate); value <= lastQuarter; value += 1) {
        const metrics = aggregateRecords(records.filter((record) => quarterOf(record.date) === value));
        quarterlyTrend.push({ period: `${year}-Q${value}`, ...metrics });
      }
    }

    const carriedByTask = new Map();
    records.forEach((record) => {
      recordArrays(record, 'carried').forEach((task) => {
        const id = taskId(task);
        if (!id) return;
        if (!carriedByTask.has(id)) {
          carriedByTask.set(id, {
            taskId: id,
            title: task.title || '',
            area: areaName(task),
            priority: task.priority || 'none',
            dates: new Set(),
          });
        }
        const entry = carriedByTask.get(id);
        entry.title = task.title || entry.title;
        entry.area = areaName(task);
        entry.priority = task.priority || entry.priority;
        entry.dates.add(record.date);
      });
    });
    const longCarryDays = Math.max(2, Math.trunc(Number(options.longCarryDays) || 3));
    const longCarried = [...carriedByTask.values()]
      .filter((entry) => entry.dates.size >= longCarryDays)
      .map((entry) => {
        const dates = [...entry.dates].sort();
        return {
          taskId: entry.taskId,
          title: entry.title,
          area: entry.area,
          priority: entry.priority,
          days: dates.length,
          firstDate: dates[0],
          lastDate: dates[dates.length - 1],
        };
      })
      .sort((left, right) => right.days - left.days || right.lastDate.localeCompare(left.lastDate));

    const dailyNotes = records
      .filter((record) => String(record?.dailyNotes || '').trim())
      .map((record) => ({ date: record.date, note: String(record.dailyNotes).trim() }));

    const dailyFocus = records
      .filter((record) => numberOrZero(record?.summary?.actualMinutes) > 0)
      .map((record) => ({
        date: record.date,
        minutes: numberOrZero(record.summary.actualMinutes),
        tasks: recordArrays(record, 'actualTime'),
      }));
    const timeAnalysis = {
      actualMinutes: totals.actualMinutes,
      estimatedCompletedMinutes: totals.completedMinutes,
      deviationMinutes: totals.actualMinutes - totals.completedMinutes,
      dailyFocus,
    };

    const title = quarter === null ? `${year} 年度工作总结` : `${year} 年第 ${quarter} 季度工作总结`;
    return {
      type: quarter === null ? 'year' : 'quarter',
      title,
      year,
      quarter,
      period: { startDate, endDate, throughDate: effectiveEnd },
      totals,
      top3: {
        planned: top3PlannedIds.size,
        completed: top3CompletedIds.size,
        completionRate: percentage(top3CompletedIds.size, top3PlannedIds.size),
        items: top3Entries,
      },
      highPriority: {
        planned: highPlannedIds.size,
        completed: highCompletedIds.size,
        completedPlanned: highCompletedPlannedIds.size,
        completionRate: percentage(highCompletedPlannedIds.size, highPlannedIds.size),
        items: highPriorityEntries,
      },
      byArea,
      monthlyTrend,
      quarterlyTrend,
      longCarried,
      dailyNotes,
      timeAnalysis,
      dataIntegrity: reportIntegrity(store, records, startDate, effectiveEnd >= startDate ? effectiveEnd : null),
    };
  }

  function markdownCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  }

  function rateLabel(value) {
    return Number.isFinite(value) ? `${value}%` : '—';
  }

  function taskLine(entry) {
    const task = entry?.task || entry || {};
    const details = [entry?.date, areaName(task) === '未分类' ? null : areaName(task)].filter(Boolean);
    return `- ${String(task.completionNote || task.title || '未命名任务').replace(/\r?\n/g, ' ')}${details.length ? `（${details.join(' · ')}）` : ''}`;
  }

  function reportToMarkdown(report) {
    if (!isObject(report)) throw new TypeError('reportToMarkdown requires a report object');
    const totals = report.totals || {};
    const lines = [
      `# ${report.title || '工作总结'}`,
      '',
      `> 数据范围：${report.period?.startDate || '—'} 至 ${report.period?.throughDate || report.period?.endDate || '—'}`,
      '',
    ];

    if (report.dataIntegrity?.complete === false) {
      lines.push(`> ⚠️ 数据完整性：${report.dataIntegrity.message || '部分历史可能不完整。'}`, '');
    }

    lines.push(
      '## 概览',
      '',
      `- 活跃天数：${totals.activeDays || 0} 天`,
      `- 计划任务：${totals.planned || 0} 项`,
      `- 完成任务：${totals.completed || 0} 项`,
      `- 计划内完成：${totals.completedPlanned || 0} 项`,
      `- 计划完成率：${rateLabel(totals.completionRate)}`,
      `- 延续任务次数：${totals.carried || 0} 次`,
      `- 实际投入：${totals.actualMinutes || 0} 分钟`,
      '',
      '## 每日 Top 3',
      '',
      `计划 ${report.top3?.planned || 0} 项，完成 ${report.top3?.completed || 0} 项，完成率 ${rateLabel(report.top3?.completionRate)}。`,
      '',
    );
    if (report.top3?.items?.length) lines.push(...report.top3.items.map(taskLine));
    else lines.push('- 暂无完成记录');

    lines.push(
      '',
      '## 高优先级工作',
      '',
      `计划 ${report.highPriority?.planned || 0} 项，完成 ${report.highPriority?.completed || 0} 项，计划完成率 ${rateLabel(report.highPriority?.completionRate)}。`,
      '',
    );
    if (report.highPriority?.items?.length) lines.push(...report.highPriority.items.map(taskLine));
    else lines.push('- 暂无完成记录');

    lines.push(
      '',
      '## 时间投入',
      '',
      `- 完成任务预计用时：${report.timeAnalysis?.estimatedCompletedMinutes || 0} 分钟`,
      `- 实际记录用时：${report.timeAnalysis?.actualMinutes || 0} 分钟`,
      `- 实际与预计偏差：${(report.timeAnalysis?.deviationMinutes || 0) >= 0 ? '+' : ''}${report.timeAnalysis?.deviationMinutes || 0} 分钟`,
      '',
      '## 工作领域',
      '',
      '| 领域 | 活跃天数 | 计划 | 完成 | 计划完成率 | 实际用时 |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
    );
    if (report.byArea?.length) {
      report.byArea.forEach((area) => {
        lines.push(`| ${markdownCell(area.area)} | ${area.activeDays} | ${area.planned} | ${area.completed} | ${rateLabel(area.completionRate)} | ${area.actualMinutes || 0} 分钟 |`);
      });
    } else {
      lines.push('| 暂无数据 | 0 | 0 | 0 | — | 0 分钟 |');
    }

    lines.push('', '## 月度趋势', '', '| 月份 | 活跃天数 | 计划 | 完成 | 计划完成率 |', '| --- | ---: | ---: | ---: | ---: |');
    if (report.monthlyTrend?.length) {
      report.monthlyTrend.forEach((period) => {
        lines.push(`| ${period.period} | ${period.activeDays} | ${period.planned} | ${period.completed} | ${rateLabel(period.completionRate)} |`);
      });
    } else {
      lines.push('| 暂无数据 | 0 | 0 | 0 | — |');
    }

    if (report.type === 'year') {
      lines.push('', '## 季度趋势', '', '| 季度 | 活跃天数 | 计划 | 完成 | 计划完成率 |', '| --- | ---: | ---: | ---: | ---: |');
      if (report.quarterlyTrend?.length) {
        report.quarterlyTrend.forEach((period) => {
          lines.push(`| ${period.period} | ${period.activeDays} | ${period.planned} | ${period.completed} | ${rateLabel(period.completionRate)} |`);
        });
      } else {
        lines.push('| 暂无数据 | 0 | 0 | 0 | — |');
      }
    }

    lines.push('', '## 长期延续事项', '');
    if (report.longCarried?.length) {
      report.longCarried.forEach((entry) => {
        lines.push(`- ${entry.title}：延续 ${entry.days} 天（${entry.firstDate} 至 ${entry.lastDate}）`);
      });
    } else {
      lines.push('- 暂无达到长期延续阈值的任务');
    }

    lines.push('', '## 每日备注', '');
    if (report.dailyNotes?.length) {
      report.dailyNotes.forEach((entry) => {
        lines.push(`### ${entry.date}`, '', ...String(entry.note).split(/\r?\n/).map((line) => `> ${line}`), '');
      });
    } else {
      lines.push('- 暂无每日备注', '');
    }

    lines.push('## 数据完整性', '', report.dataIntegrity?.message || '未提供数据完整性信息。');
    return `${lines.join('\n').trim()}\n`;
  }

  const api = {
    buildDailyRecord,
    reconcileDailyRecord,
    finalizeMissingArchives,
    listDailyRecords,
    buildPeriodReport,
    reportToMarkdown,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DaymarkReporting = api;
})(typeof window !== 'undefined' ? window : globalThis);
