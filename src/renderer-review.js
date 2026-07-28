// Work review: the month calendar, the day detail panel, deterministic period
// reports, and the optional OpenAI draft together with its settings UI.
//
// Split out of renderer.js. Loads after it, so the shared state, elements and
// helpers already exist when these listeners register.


function formatRecordDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function reportSelection() {
  const monthValue = state.reviewMonth || todayDate().slice(0, 7);
  const [monthYear, month] = monthValue.split('-').map(Number);
  const selectedYear = Number(elements.reportYear.value || todayDate().slice(0, 4));
  return {
    mode: state.reviewMode,
    year: state.reviewMode === 'month' ? monthYear : selectedYear,
    month: state.reviewMode === 'month' ? month : undefined,
    quarter: state.reviewMode === 'quarter' ? Number(elements.reportQuarter.value || 1) : undefined,
    today: todayDate(),
  };
}

function periodTitle(selection, suffix = '') {
  if (selection.mode === 'month') return `${selection.year} 年 ${selection.month} 月${suffix}`;
  if (selection.mode === 'quarter') return `${selection.year} 年第 ${selection.quarter} 季度${suffix}`;
  return `${selection.year} 年度${suffix}`;
}

function markdownList(items, formatter) {
  if (!items?.length) return '- 暂无记录';
  return items.map((item) => `- ${formatter(item)}`).join('\n');
}

function buildMonthMarkdown(source, title) {
  const rate = Number.isFinite(source.metrics.completionRate) ? `${source.metrics.completionRate}%` : '—';
  const achievements = source.achievements
    .filter((item, index, all) => all.findIndex((candidate) => `${candidate.date}:${candidate.title}` === `${item.date}:${item.title}`) === index)
    .slice(0, 12);
  return [
    `# ${title}`,
    '',
    `数据范围：${source.period.startDate} 至 ${source.period.throughDate}`,
    '',
    '## 概览',
    '',
    `- 活跃工作日：${source.metrics.activeDays} 天`,
    `- 计划任务：${source.metrics.planned} 项`,
    `- 完成计划内任务：${source.metrics.completedPlanned} 项`,
    `- 计划完成率：${rate}`,
    `- 实际投入：${source.metrics.actualMinutes || 0} 分钟`,
    '',
    '## 关键成果',
    '',
    markdownList(achievements, (item) => `${item.date} · ${item.completionNote || item.title}${item.area ? `（${item.area}）` : ''}`),
    '',
    '## 工作领域',
    '',
    markdownList(source.areas, (area) => `${area.area}：完成 ${area.completed} 项，计划 ${area.planned} 项，实际投入 ${area.actualMinutes || 0} 分钟`),
    '',
    '## 每日备注',
    '',
    markdownList(source.dailyNotes, (item) => `${item.date}：${item.note}`),
    '',
    source.dataIntegrity.complete ? '' : `> 数据提示：${source.dataIntegrity.message}`,
  ].filter((line, index, all) => line || all[index - 1] !== '').join('\n').trim();
}

function renderPeriodReport() {
  const selection = reportSelection();
  const source = AiReport.buildReportSourceData(state.store, selection);
  state.reportSource = source;
  const title = periodTitle(selection, '工作总结');
  const revision = `${state.store.events?.length || 0}:${state.store.dailyArchives?.length || 0}:${state.store.events?.at(-1)?.occurredAt || ''}`;
  const periodKey = `${selection.mode}:${selection.year}:${selection.month || ''}:${selection.quarter || ''}:${revision}`;

  let report = null;
  let markdown;
  if (selection.mode === 'month') {
    markdown = buildMonthMarkdown(source, title);
  } else {
    report = Reporting.buildPeriodReport(state.store, {
      year: selection.year,
      quarter: selection.mode === 'quarter' ? selection.quarter : null,
      today: selection.today,
    });
    markdown = Reporting.reportToMarkdown(report);
  }
  state.report = report || { title, period: source.period, dataIntegrity: source.dataIntegrity };
  state.reportTitle = report?.title || title;
  state.reportMarkdown = markdown;

  const metricValues = {
    active: String(source.metrics.activeDays),
    completed: `${source.metrics.completedPlanned} / ${source.metrics.planned}`,
    rate: Number.isFinite(source.metrics.completionRate) ? `${source.metrics.completionRate}%` : '—',
  };
  Object.entries(metricValues).forEach(([name, value]) => {
    const target = elements.reportMetrics.querySelector(`[data-metric="${name}"] strong`);
    if (target) target.textContent = value;
  });

  elements.reviewPeriodTitle.textContent = periodTitle(selection);
  elements.recordRangeNote.textContent = `${source.period.startDate} 至 ${source.period.throughDate}${source.dataIntegrity.complete ? '' : ' · 部分历史数据不完整'}`;
  elements.aiReportRange.textContent = `${periodTitle(selection)} · ${source.metrics.activeDays} 个活跃工作日 · 默认在本机生成`;

  if (state.reportPeriodKey !== periodKey) {
    state.reportPeriodKey = periodKey;
    state.aiReportText = '';
    elements.reportOutput.value = markdown;
    elements.reportKind.textContent = '本地工作报告';
    elements.reportStatus.textContent = source.dataIntegrity.complete
      ? '基于本地结构化工作记录生成'
      : `本地报告 · ${source.dataIntegrity.message}`;
  }
  elements.reportTitle.textContent = state.reportTitle;
}

function formatCalendarDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function renderDayDetail() {
  const date = state.reviewSelectedDate;
  if (!date) return;
  const detail = Calendar.buildDateDetail(state.store, date);
  const holiday = Calendar.getChinaHoliday(date);
  const restDay = Calendar.chinaRestDay(date);
  const planned = Array.isArray(detail.planned) ? detail.planned : [];
  const ranged = Array.isArray(detail.range) ? detail.range : [];
  const completed = Array.isArray(detail.completed) ? detail.completed : [];
  const completedIds = new Set(completed.map((task) => task.id).filter(Boolean));
  const plannedIds = new Set(planned.map((task) => task.id).filter(Boolean));
  const top3Ids = new Set((Array.isArray(detail.top3) ? detail.top3 : []).map((task) => task.id).filter(Boolean));
  const actualByTask = new Map((Array.isArray(detail.actualTime) ? detail.actualTime : []).map((entry) => [entry.taskId, Number(entry.minutes) || 0]));
  const items = [];
  const seen = new Set();
  [...ranged, ...planned, ...completed].forEach((task) => {
    const key = task.id || `${task.title}:${task.completedAt || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      title: task.completionNote || task.title || '未命名任务',
      done: completedIds.has(task.id) || completed.includes(task),
      planned: plannedIds.has(task.id),
      top3: top3Ids.has(task.id) || task.top3Date === date,
      flagged: Boolean(task.flagged),
      phase: task.schedulePhase || null,
      minutes: Number(task.scheduledMinutes) || 0,
      needsEstimate: Boolean(task.scheduleNeedsEstimate),
      overflowMinutes: Number(task.scheduleOverflowMinutes) || 0,
      actualMinutes: actualByTask.get(task.id) || 0,
    });
  });
  (Array.isArray(detail.actualTime) ? detail.actualTime : []).forEach((entry) => {
    if (!entry?.taskId || seen.has(entry.taskId)) return;
    seen.add(entry.taskId);
    items.push({
      title: entry.title || '未命名任务',
      done: false,
      planned: false,
      top3: false,
      flagged: false,
      phase: null,
      minutes: 0,
      needsEstimate: false,
      overflowMinutes: 0,
      actualMinutes: Number(entry.minutes) || 0,
    });
  });
  const plannedCount = Number(detail.summary?.plannedCount) || planned.length;
  const completedCount = Number(detail.summary?.completedPlannedCount);
  const done = Number.isFinite(completedCount)
    ? completedCount
    : planned.filter((task) => completedIds.has(task.id)).length;

  elements.dayDetailDate.textContent = formatCalendarDate(date);
  elements.dayDetailHoliday.hidden = !holiday && !restDay;
  elements.dayDetailHoliday.textContent = holiday
    ? `${holiday.badge} · ${holiday.name}`
    : restDay ? restDay.name : '';
  elements.dayDetailHoliday.classList.toggle('is-makeup', holiday?.type === 'makeup');
  elements.dayDetailHoliday.classList.toggle('is-weekend', Boolean(restDay) && !holiday);
  elements.dayDetailScore.textContent = `完成 ${completed.length} · 计划 ${plannedCount} · 实际 ${Number(detail.summary?.actualMinutes) || 0} 分钟`;
  elements.dayDetailNote.textContent = detail.dailyNotes
    || (holiday ? `${holiday.name}${holiday.type === 'makeup' ? '，当天按调休工作日标注，不计入休息日。' : '，当天按法定假日标注。'}` : '')
    || (detail.dataIntegrity?.complete === false ? detail.dataIntegrity.message : '当天没有填写每日备注。');

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const row = makeElement('li', `day-detail-task${item.done ? '' : ' is-open'}${item.top3 ? ' is-top3' : ''}${item.flagged ? ' is-flagged' : ''}${!item.planned && !item.done ? ' is-range-only' : ''}`);
    const content = makeElement('span', 'day-detail-task-content');
    if (item.top3) content.appendChild(makeElement('span', 'day-detail-top3', '★ Top 3'));
    if (item.flagged) content.appendChild(makeElement('span', 'day-detail-flagged', '⚑ 旗标'));
    const phaseLabels = { single: '单日', start: '开始', middle: '进行中', deadline: '截止' };
    if (item.phase) content.appendChild(makeElement('span', `day-detail-phase is-${item.phase}`, phaseLabels[item.phase]));
    if (item.minutes) content.appendChild(makeElement('span', 'day-detail-minutes', `${item.minutes} 分钟`));
    else if (item.needsEstimate && item.planned) content.appendChild(makeElement('span', 'day-detail-minutes', '待估时'));
    if (item.overflowMinutes) content.appendChild(makeElement('span', 'day-detail-overflow', `超载 ${item.overflowMinutes} 分钟`));
    if (item.actualMinutes) content.appendChild(makeElement('span', 'day-detail-minutes', `实际 ${item.actualMinutes} 分钟`));
    content.appendChild(makeElement('span', 'day-detail-task-title', item.title));
    row.append(makeElement('span', 'day-detail-task-mark', item.done ? '✓' : '○'), content);
    fragment.appendChild(row);
  });
  if (!items.length) fragment.appendChild(makeElement('li', 'day-detail-empty', '当天没有工作任务。'));
  elements.dayDetailTasks.replaceChildren(fragment);
}

function renderCalendar() {
  const monthValue = state.calendarMonth || todayDate().slice(0, 7);
  const [year, month] = monthValue.split('-').map(Number);
  if (!state.reviewSelectedDate || !state.reviewSelectedDate.startsWith(monthValue)) {
    state.reviewSelectedDate = todayDate().startsWith(monthValue) ? todayDate() : `${monthValue}-01`;
  }
  const calendar = Calendar.buildMonthGrid({ year, month, store: state.store, today: todayDate() });
  const specialDays = calendar.cells.filter((cell) => cell.inCurrentMonth && cell.holiday);
  const weekendDays = calendar.cells.filter((cell) => cell.inCurrentMonth && cell.isOrdinaryWeekend);
  elements.holidaySourceNote.textContent = calendar.holidaySource
    ? `${calendar.holidaySource.label} · 本月 ${weekendDays.length} 个周末日，${specialDays.length} 天休假或调休`
    : `本月 ${weekendDays.length} 个周末日 · 该年份暂无内置官方节假日数据`;
  elements.recordMonth.value = monthValue;
  elements.recordMonth.removeAttribute('max');
  elements.nextMonth.disabled = false;

  const fragment = document.createDocumentFragment();
  calendar.cells.forEach((cell) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-day';
    button.dataset.calendarDate = cell.date;
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-selected', String(cell.date === state.reviewSelectedDate));
    button.tabIndex = cell.date === state.reviewSelectedDate ? 0 : -1;
    button.classList.toggle('is-outside', !cell.inCurrentMonth);
    button.classList.toggle('is-today', cell.isToday);
    button.classList.toggle('is-selected', cell.date === state.reviewSelectedDate);
    button.classList.toggle('is-weekend', cell.isOrdinaryWeekend);
    button.classList.toggle('is-holiday', cell.holiday?.type === 'holiday');
    button.classList.toggle('is-makeup', cell.holiday?.type === 'makeup');
    button.classList.toggle('has-schedule', cell.rangeCount > 0);
    const labelParts = [formatCalendarDate(cell.date)];
    if (cell.isOrdinaryWeekend) labelParts.push('周末');
    if (cell.holiday) labelParts.push(cell.holiday.name, cell.holiday.badge === '休' ? '休假' : '调休上班');
    if (cell.rangeCount) labelParts.push(`跨期任务 ${cell.rangeCount} 项`);
    if (cell.metrics.actualMinutes) labelParts.push(`实际投入 ${cell.metrics.actualMinutes} 分钟`);
    labelParts.push(`完成 ${cell.metrics.completedCount}，计划 ${cell.metrics.plannedCount}`);
    button.setAttribute('aria-label', labelParts.join('，'));

    const top = makeElement('span', 'calendar-day-top');
    top.appendChild(makeElement('span', 'day-number', String(cell.day)));
    const badges = makeElement('span', 'calendar-day-badges');
    if (cell.holiday) {
      badges.appendChild(makeElement('span', `day-badge${cell.holiday.type === 'makeup' ? ' is-makeup' : ''}`, cell.holiday.badge));
    }
    // Holidays and 调休 days already carry their own 休/班 badge; stacking a
    // second "周末" badge on a mandated workday would contradict it.
    if (cell.isOrdinaryWeekend) badges.appendChild(makeElement('span', 'day-badge is-weekend', '周末'));
    top.appendChild(badges);
    const tally = makeElement('span', 'day-tally', cell.metrics.plannedCount || cell.metrics.completedCount
      ? `完成 ${cell.metrics.completedCount} · 计划 ${cell.metrics.plannedCount}`
      : cell.metrics.actualMinutes ? `实际投入 ${cell.metrics.actualMinutes} 分钟`
      : cell.rangeCount ? `跨期任务 ${cell.rangeCount} 项` : '无任务记录');
    const progress = makeElement('span', 'day-progress');
    const fill = makeElement('span');
    fill.style.width = `${Math.max(0, Math.min(100, Number(cell.metrics.completionRate) || 0))}%`;
    progress.appendChild(fill);
    button.append(top, tally, progress);
    fragment.appendChild(button);
  });
  elements.calendarGrid.replaceChildren(fragment);
  renderDayDetail();
}

function hasAiKey(settings = state.aiSettings) {
  return Boolean(settings?.hasKey || settings?.hasApiKey);
}

function renderAiSettingsStatus() {
  const settings = state.aiSettings || {};
  const configured = hasAiKey(settings);
  const sourceCopy = settings.keySource === 'environment'
    ? '正在使用 OPENAI_API_KEY 环境变量'
    : settings.keySource === 'preview'
      ? '浏览器预览密钥仅保存在内存中'
      : settings.hasStoredKey && !configured
        ? '本机密钥当前不可用，请移除后重新保存'
      : configured
        ? 'API Key 已保存在本机安全存储'
        : '尚未配置 API Key';
  elements.aiKeyStatus.textContent = sourceCopy;
  elements.clearAiKey.hidden = !settings.hasStoredKey && settings.keySource !== 'preview';
  elements.saveAiKey.disabled = settings.canStoreKey === false;
  elements.generateAiReport.disabled = !configured || Boolean(state.aiRequestId);
  elements.cancelAiReport.hidden = !state.aiRequestId;
  elements.aiActionNote.textContent = settings.canStoreKey === false && !configured
    ? '当前系统安全存储不可用；可通过 OPENAI_API_KEY 环境变量使用 AI。本地报告不受影响。'
    : configured
      ? '点击生成后，只发送上方勾选的结构化内容。'
      : '没有 API Key 也可复制或保存右侧本地总结。';
}

function renderReview() {
  elements.quarterControl.hidden = state.reviewMode !== 'quarter';
  elements.yearControl.hidden = state.reviewMode === 'month';
  if (state.reviewMode === 'quarter') updateQuarterAvailability();
  document.querySelectorAll('[data-review-mode]').forEach((button) => {
    const active = button.dataset.reviewMode === state.reviewMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active) elements.reviewDashboard.setAttribute('aria-labelledby', button.id);
  });
  renderPeriodReport();
  renderCalendar();
  renderAiSettingsStatus();
}

const reviewTabs = document.querySelector('.review-tabs');

function cancelAiForContextChange() {
  const requestId = state.aiRequestId;
  if (!requestId) return;
  state.aiRequestId = null;
  if (typeof bridge.cancelAiReport === 'function') {
    Promise.resolve(bridge.cancelAiReport(requestId)).catch(() => {});
  }
  elements.reportStatus.textContent = '报告范围已切换，上一项 AI 生成已取消';
  renderAiSettingsStatus();
}

reviewTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-review-mode]');
  if (!button) return;
  cancelAiForContextChange();
  state.reviewMode = button.dataset.reviewMode;
  state.reportPeriodKey = '';
  renderReview();
  renderDebugState();
});

reviewTabs.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...reviewTabs.querySelectorAll('[data-review-mode]')];
  const currentIndex = tabs.indexOf(event.target.closest('[data-review-mode]'));
  if (currentIndex < 0) return;
  event.preventDefault();
  let nextIndex;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  else nextIndex = (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
});

function shiftMonth(value, amount) {
  const [year, month] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function setReviewMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) return;
  const reportCanFollow = value <= todayDate().slice(0, 7);
  if (reportCanFollow && state.reviewMode === 'month' && value !== state.reviewMonth) cancelAiForContextChange();
  state.calendarMonth = value;
  if (reportCanFollow) state.reviewMonth = value;
  if (!state.reviewSelectedDate?.startsWith(value)) {
    state.reviewSelectedDate = todayDate().startsWith(value) ? todayDate() : `${value}-01`;
  }
  if (state.reviewMode === 'month' && reportCanFollow) {
    state.reportPeriodKey = '';
    renderReview();
  } else {
    renderCalendar();
  }
}

elements.recordMonth.addEventListener('change', () => setReviewMonth(elements.recordMonth.value));
elements.previousMonth.addEventListener('click', () => setReviewMonth(shiftMonth(state.calendarMonth, -1)));
elements.nextMonth.addEventListener('click', () => setReviewMonth(shiftMonth(state.calendarMonth, 1)));

function selectReviewDate(date, focus = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const month = date.slice(0, 7);
  if (month !== state.calendarMonth) {
    const reportCanFollow = month <= todayDate().slice(0, 7);
    if (state.reviewMode === 'month') cancelAiForContextChange();
    state.calendarMonth = month;
    if (reportCanFollow) state.reviewMonth = month;
    state.reviewSelectedDate = date;
    if (state.reviewMode === 'month' && reportCanFollow) {
      state.reportPeriodKey = '';
      renderReview();
    } else {
      renderCalendar();
    }
  } else {
    state.reviewSelectedDate = date;
    renderCalendar();
  }
  if (focus) requestAnimationFrame(() => {
    elements.calendarGrid.querySelector(`[data-calendar-date="${CSS.escape(date)}"]`)?.focus();
  });
}

elements.calendarGrid.addEventListener('click', (event) => {
  const day = event.target.closest('[data-calendar-date]');
  if (day) selectReviewDate(day.dataset.calendarDate, true);
});

elements.calendarGrid.addEventListener('keydown', (event) => {
  const day = event.target.closest('[data-calendar-date]');
  if (!day || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  let target = day.dataset.calendarDate;
  if (event.key === 'Home') target = addDays(target, -((new Date(`${target}T00:00:00Z`).getUTCDay() + 6) % 7));
  else if (event.key === 'End') target = addDays(target, 6 - ((new Date(`${target}T00:00:00Z`).getUTCDay() + 6) % 7));
  else target = addDays(target, offsets[event.key]);
  selectReviewDate(target, true);
});

elements.reportYear.addEventListener('change', () => {
  cancelAiForContextChange();
  updateQuarterAvailability();
  state.reportPeriodKey = '';
  renderPeriodReport();
});
elements.reportQuarter.addEventListener('change', () => {
  cancelAiForContextChange();
  state.reportPeriodKey = '';
  renderPeriodReport();
});

function coerceAiSettings(result) {
  const candidate = result?.settings || result?.data?.settings || result?.data || result || {};
  const keySource = candidate.keySource || (candidate.hasStoredKey ? 'safeStorage' : 'none');
  const usableKey = typeof candidate.hasApiKey === 'boolean'
    ? candidate.hasApiKey
    : Boolean(candidate.hasKey || candidate.keyConfigured || (keySource && keySource !== 'none'));
  return {
    ...state.aiSettings,
    ...candidate,
    model: String(candidate.model || state.aiSettings.model || DEFAULT_AI_MODEL),
    keySource,
    hasKey: usableKey,
    includeDailyNotes: Boolean(candidate.includeDailyNotes),
    includeCompletionNotes: candidate.includeCompletionNotes !== false,
  };
}

async function loadAiSettings() {
  if (typeof bridge.getAiSettings !== 'function') return;
  try {
    state.aiSettings = coerceAiSettings(await bridge.getAiSettings());
    elements.aiModel.placeholder = DEFAULT_AI_MODEL;
    elements.aiModel.value = state.aiSettings.model || DEFAULT_AI_MODEL;
    elements.includeDailyNotes.checked = Boolean(state.aiSettings.includeDailyNotes);
    elements.includeCompletionNotes.checked = state.aiSettings.includeCompletionNotes !== false;
    renderAiSettingsStatus();
  } catch (error) {
    elements.aiKeyStatus.textContent = `AI 配置不可用：${errorMessage(error)}`;
    elements.generateAiReport.disabled = true;
  }
}

async function saveAiPreferences() {
  const settings = {
    model: elements.aiModel.value.trim() || DEFAULT_AI_MODEL,
    includeDailyNotes: elements.includeDailyNotes.checked,
    includeCompletionNotes: elements.includeCompletionNotes.checked,
  };
  if (typeof bridge.saveAiSettings !== 'function') {
    state.aiSettings = { ...state.aiSettings, ...settings };
    return state.aiSettings;
  }
  state.aiSettings = coerceAiSettings(await bridge.saveAiSettings(settings));
  elements.aiModel.value = state.aiSettings.model;
  renderAiSettingsStatus();
  return state.aiSettings;
}

elements.aiModel.addEventListener('blur', () => {
  runAction(saveAiPreferences().catch((error) => showToast(`模型设置保存失败：${errorMessage(error)}`, false)));
});
elements.includeDailyNotes.addEventListener('change', () => {
  runAction(saveAiPreferences().catch((error) => showToast(`AI 输入设置保存失败：${errorMessage(error)}`, false)));
});
elements.includeCompletionNotes.addEventListener('change', () => {
  runAction(saveAiPreferences().catch((error) => showToast(`AI 输入设置保存失败：${errorMessage(error)}`, false)));
});

elements.saveAiKey.addEventListener('click', () => runAction((async () => {
  const apiKey = elements.aiApiKey.value.trim();
  if (!apiKey) {
    showToast('请输入 API Key', false);
    elements.aiApiKey.focus();
    return;
  }
  if (typeof bridge.setAiKey !== 'function') throw new Error('当前版本不支持安全保存 API Key');
  elements.saveAiKey.disabled = true;
  try {
    state.aiSettings = coerceAiSettings(await bridge.setAiKey(apiKey));
    elements.aiApiKey.value = '';
    renderAiSettingsStatus();
    showToast('API Key 已保存到本机安全存储', false);
  } catch (error) {
    showToast(`API Key 保存失败：${errorMessage(error)}`, false);
  } finally {
    elements.saveAiKey.disabled = false;
  }
})()));

elements.clearAiKey.addEventListener('click', () => runAction((async () => {
  if (typeof bridge.clearAiKey !== 'function') return;
  try {
    state.aiSettings = coerceAiSettings(await bridge.clearAiKey());
    renderAiSettingsStatus();
    showToast('本机 API Key 已移除', false);
  } catch (error) {
    showToast(`API Key 移除失败：${errorMessage(error)}`, false);
  }
})()));

elements.generateAiReport.addEventListener('click', () => runAction((async () => {
  if (state.aiRequestId) return;
  try {
    await saveAiPreferences();
  } catch (error) {
    showToast(`AI 设置保存失败：${errorMessage(error)}`, false);
    return;
  }
  if (!hasAiKey()) {
    showToast('请先配置 API Key；本地报告仍可直接使用', false);
    return;
  }
  if (typeof bridge.generateAiReport !== 'function') {
    showToast('当前版本不支持 AI 生成', false);
    return;
  }
  const selection = reportSelection();
  const requestId = commandId('ai').slice(0, 80);
  state.aiRequestId = requestId;
  renderAiSettingsStatus();
  elements.reportStatus.textContent = '正在生成 AI 草稿…';
  try {
    const result = await bridge.generateAiReport({
      requestId,
      mode: selection.mode,
      year: selection.year,
      ...(selection.mode === 'month' ? { month: selection.month } : {}),
      ...(selection.mode === 'quarter' ? { quarter: selection.quarter } : {}),
      includeDailyNotes: elements.includeDailyNotes.checked,
      includeCompletionNotes: elements.includeCompletionNotes.checked,
    });
    if (state.aiRequestId !== requestId) return;
    if (result?.canceled) {
      elements.reportStatus.textContent = '已取消发送，本地报告未受影响';
      return;
    }
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('AI 未返回可用内容');
    state.aiReportText = text;
    state.reportMarkdown = text;
    elements.reportOutput.value = text;
    elements.reportKind.textContent = 'AI 工作报告';
    elements.reportStatus.textContent = `AI 草稿 · ${result?.model || state.aiSettings.model}`;
    showToast('AI 工作总结已生成', false);
  } catch (error) {
    if (state.aiRequestId === requestId) {
      elements.reportStatus.textContent = 'AI 生成失败，本地报告仍可使用';
      showToast(`AI 生成失败：${errorMessage(error)}`, false);
    }
  } finally {
    if (state.aiRequestId === requestId) state.aiRequestId = null;
    renderAiSettingsStatus();
  }
})()));

elements.cancelAiReport.addEventListener('click', () => runAction((async () => {
  const requestId = state.aiRequestId;
  if (!requestId) return;
  state.aiRequestId = null;
  renderAiSettingsStatus();
  elements.reportStatus.textContent = '已取消 AI 生成，本地报告未受影响';
  if (typeof bridge.cancelAiReport === 'function') {
    try {
      await bridge.cancelAiReport(requestId);
    } catch (error) {
      showToast(`取消失败：${errorMessage(error)}`, false);
    }
  }
})()));

elements.reportOutput.addEventListener('input', () => {
  state.reportMarkdown = elements.reportOutput.value;
  if (elements.reportKind.textContent.startsWith('AI')) state.aiReportText = elements.reportOutput.value;
});

elements.copyReport.addEventListener('click', async () => {
  const content = elements.reportOutput.value;
  try {
    await navigator.clipboard.writeText(content);
    showToast('报告 Markdown 已复制', false);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = content;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    showToast('报告 Markdown 已复制', false);
  }
});

elements.saveReport.addEventListener('click', async () => {
  if (!state.report) return;
  const suggestedName = `${state.reportTitle.replace(/\s+/g, '-')}.md`;
  try {
    const result = await bridge.saveMarkdown({ suggestedName, content: elements.reportOutput.value });
    if (!result?.canceled) showToast('报告已保存', false);
  } catch (error) {
    showToast(`报告保存失败：${errorMessage(error)}`, false);
  }
});

function initializeReportControls() {
  const currentYear = Number(todayDate().slice(0, 4));
  const historyYear = Number(String(state.store.meta.historyStartAt).slice(0, 4)) || currentYear;
  const fragment = document.createDocumentFragment();
  for (let year = currentYear; year >= Math.min(historyYear, currentYear - 10); year -= 1) {
    const option = document.createElement('option');
    option.value = String(year);
    option.textContent = `${year} 年`;
    fragment.appendChild(option);
  }
  elements.reportYear.replaceChildren(fragment);
  elements.reportYear.value = String(currentYear);
  elements.reportQuarter.value = String(Math.floor((Number(todayDate().slice(5, 7)) - 1) / 3) + 1);
  updateQuarterAvailability();
  state.reviewMonth = todayDate().slice(0, 7);
  state.calendarMonth = state.reviewMonth;
  state.reviewSelectedDate = todayDate();
  elements.recordMonth.value = state.reviewMonth;
  elements.recordMonth.removeAttribute('max');
}
