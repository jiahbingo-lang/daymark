(function exposeFocus(global) {
  'use strict';

  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const GROWTH_STAGES = Object.freeze(['seed', 'sprout', 'sapling', 'young', 'mature']);

  function isValidDate(value) {
    return typeof value === 'string' && DATE_PATTERN.test(value);
  }

  function safeSessions(sessions) {
    return Array.isArray(sessions) ? sessions.filter((session) => session && isValidDate(session.reportingDate)) : [];
  }

  function addDays(date, amount) {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
  }

  // Focus statistics deliberately count only completed sessions. Abandoned
  // sessions stay in the record (the withered tree), but none of their
  // minutes enter any total — the Forest-style contract the product chose.
  function countedMinutes(session) {
    return session.status === 'completed' ? Number(session.focusedMinutes) || 0 : 0;
  }

  function sessionsForDate(sessions, date) {
    if (!isValidDate(date)) return [];
    return safeSessions(sessions)
      .filter((session) => session.reportingDate === date)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  }

  function dailyFocusSummary(sessions, date) {
    const daySessions = sessionsForDate(sessions, date);
    const completed = daySessions.filter((session) => session.status === 'completed');
    const abandoned = daySessions.filter((session) => session.status === 'abandoned');
    return {
      date,
      minutes: completed.reduce((total, session) => total + countedMinutes(session), 0),
      completedCount: completed.length,
      abandonedCount: abandoned.length,
      runningCount: daySessions.filter((session) => session.status === 'running').length,
      sessions: daySessions,
    };
  }

  function recentFocusDays(sessions, endDate, count = 7) {
    if (!isValidDate(endDate)) return [];
    const days = Math.max(1, Math.min(31, Math.trunc(Number(count) || 7)));
    const list = safeSessions(sessions);
    const result = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = addDays(endDate, -offset);
      const minutes = list
        .filter((session) => session.reportingDate === date)
        .reduce((total, session) => total + countedMinutes(session), 0);
      result.push({ date, minutes });
    }
    return result;
  }

  function rangeFocusStats(sessions, startDate, endDate) {
    const empty = {
      totalMinutes: 0,
      completedCount: 0,
      abandonedCount: 0,
      activeDays: 0,
      dailyAverage: 0,
      bestDay: null,
    };
    if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) return empty;
    const inRange = safeSessions(sessions).filter(
      (session) => session.reportingDate >= startDate && session.reportingDate <= endDate,
    );
    if (!inRange.length) return empty;

    const byDate = new Map();
    let completedCount = 0;
    let abandonedCount = 0;
    inRange.forEach((session) => {
      if (session.status === 'completed') completedCount += 1;
      if (session.status === 'abandoned') abandonedCount += 1;
      const minutes = countedMinutes(session);
      if (!minutes) return;
      byDate.set(session.reportingDate, (byDate.get(session.reportingDate) || 0) + minutes);
    });
    const totalMinutes = [...byDate.values()].reduce((total, minutes) => total + minutes, 0);
    let bestDay = null;
    byDate.forEach((minutes, date) => {
      if (!bestDay || minutes > bestDay.minutes || (minutes === bestDay.minutes && date < bestDay.date)) {
        bestDay = { date, minutes };
      }
    });
    const activeDays = byDate.size;
    return {
      totalMinutes,
      completedCount,
      abandonedCount,
      activeDays,
      dailyAverage: activeDays ? Math.round(totalMinutes / activeDays) : 0,
      bestDay,
    };
  }

  function runningSession(sessions) {
    return safeSessions(sessions).find((session) => session.status === 'running') || null;
  }

  function growthStage(progress) {
    const value = Number(progress);
    if (!Number.isFinite(value) || value <= 0) return GROWTH_STAGES[0];
    if (value < 0.18) return GROWTH_STAGES[0];
    if (value < 0.42) return GROWTH_STAGES[1];
    if (value < 0.68) return GROWTH_STAGES[2];
    if (value < 0.92) return GROWTH_STAGES[3];
    return GROWTH_STAGES[4];
  }

  // Resolves a session that was left running across an app restart. Nobody
  // watched the tree while the app was closed: if the planned window already
  // elapsed the tree survived (complete at its scheduled end), otherwise the
  // session was interrupted and withers.
  function resolveInterruptedSession(session, now, domain) {
    if (!session || session.status !== 'running') return null;
    const reference = now instanceof Date ? now : new Date(now || Date.now());
    if (session.pausedAt) {
      return { action: 'abandon', occurredAt: reference.toISOString() };
    }
    const end = domain.focusSessionEnd(session);
    if (reference.getTime() >= end) {
      return { action: 'complete', occurredAt: new Date(end).toISOString() };
    }
    return { action: 'abandon', occurredAt: reference.toISOString() };
  }

  const api = {
    GROWTH_STAGES,
    sessionsForDate,
    dailyFocusSummary,
    recentFocusDays,
    rangeFocusStats,
    runningSession,
    growthStage,
    resolveInterruptedSession,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DaymarkFocus = api;
})(typeof window !== 'undefined' ? window : globalThis);
