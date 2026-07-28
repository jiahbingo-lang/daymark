// Execution calendar: the day/week timeline, focus timer, manual time entry
// and the drag/resize interactions that move schedule blocks around.
//
// Split out of renderer.js. Loads after it, so `elements`, `state`, `bridge`
// and the shared helpers are already defined by the time these listeners
// register. renderer-boot.js runs last and starts the app.


function executionDateLabel(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function focusClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = String(Math.floor(value / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const remainder = String(value % 60).padStart(2, '0');
  return `${hours}:${minutes}:${remainder}`;
}

function updateFocusClock() {
  const entry = Execution.activeFocusEntry(state.store);
  if (!entry) return;
  elements.focusElapsed.textContent = focusClock(Execution.durationSeconds(entry, new Date()));
}

function renderFocusStrip() {
  const entry = Execution.activeFocusEntry(state.store);
  clearInterval(focusTicker);
  focusTicker = null;
  elements.focusStrip.hidden = !entry;
  if (!entry) return;
  const task = activeTasks().find((item) => item.id === entry.taskId && !item.deletedAt);
  elements.focusTaskTitle.textContent = task?.title || '已移除的任务';
  updateFocusClock();
  focusTicker = setInterval(updateFocusClock, 1000);
}

function renderExecutionBlock(block, schedule) {
  const task = block.task;
  const actual = Execution.actualMinutesForTask(state.store, task.id, { now: new Date() });
  const risk = Execution.riskForTask(state.store, task, { today: todayDate(), schedule: schedule.schedule });
  const top = Math.max(EXECUTION_DAY_START_MINUTE, block.startMinute);
  const available = Math.max(30, EXECUTION_DAY_END_MINUTE - top);
  const height = Math.min(available, Math.max(38, block.durationMinutes));
  const densityClass = block.durationMinutes <= 45 ? ' is-compact' : block.durationMinutes <= 75 ? ' is-short' : '';
  const article = makeElement('article', `execution-block is-${block.source}${densityClass}${risk?.risky ? ' is-risk' : ''}`);
  article.draggable = true;
  article.dataset.blockId = block.id;
  article.dataset.taskId = task.id;
  article.dataset.date = block.date;
  article.dataset.startMinute = String(block.startMinute);
  article.dataset.durationMinutes = String(block.durationMinutes);
  article.dataset.source = block.source;
  article.style.top = `${top}px`;
  article.style.height = `${height}px`;
  article.setAttribute('aria-label', `${task.title}，${Execution.formatMinute(block.startMinute)}，${block.durationMinutes} 分钟，${block.source === 'manual' ? '已锁定' : '自动安排'}`);

  const heading = makeElement('div', 'execution-block-heading');
  const time = makeElement('span', 'execution-block-time', `${Execution.formatMinute(block.startMinute)} · ${block.durationMinutes} 分`);
  const badges = makeElement('span', 'execution-block-badges');
  const blockRestDay = Calendar.chinaRestDay(block.date);
  if (blockRestDay) badges.appendChild(makeElement('b', 'execution-restday', blockRestDay.short));
  if (task.top3Date === block.date) badges.appendChild(makeElement('b', 'execution-top3', '★ Top3'));
  if (task.flagged) badges.appendChild(makeElement('b', 'execution-flag', '⚑'));
  if (risk?.risky) badges.appendChild(makeElement('b', 'execution-risk', '期限风险'));
  heading.append(time, badges);
  const title = makeElement('strong', 'execution-block-title', task.title);
  title.title = task.title;
  article.append(heading, title);
  const meta = makeElement('span', 'execution-block-meta', `${actual ? `实际 ${actual} 分 · ` : ''}${block.source === 'manual' ? '手动锁定' : '自动安排'}`);
  article.appendChild(meta);

  const actions = makeElement('div', 'execution-block-actions');
  const focus = makeElement('button', '', '专注');
  focus.type = 'button';
  focus.dataset.executionAction = 'focus';
  const manual = makeElement('button', '', '补录');
  manual.type = 'button';
  manual.dataset.executionAction = 'manual-time';
  actions.append(focus, manual);
  if (block.source === 'manual') {
    const unlock = makeElement('button', '', '撤销锁定');
    unlock.type = 'button';
    unlock.dataset.executionAction = 'unlock';
    actions.appendChild(unlock);
    const resize = makeElement('span', 'execution-resize-handle');
    resize.dataset.executionAction = 'resize';
    resize.title = '拖动调整时长';
    resize.setAttribute('aria-label', '拖动调整时长');
    article.appendChild(resize);
  }
  article.appendChild(actions);
  return article;
}

function renderExecution() {
  const date = state.executionDate || todayDate();
  state.executionDate = date;
  elements.executionDate.value = date;
  document.querySelectorAll('[data-execution-mode]').forEach((button) => {
    const active = button.dataset.executionMode === state.executionMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const schedule = Execution.buildExecutionSchedule(state.store, {
    date,
    mode: state.executionMode,
    today: todayDate(),
  });
  const totalMinutes = schedule.blocks.reduce((total, block) => total + block.durationMinutes, 0);
  const manualMinutes = schedule.blocks.filter((block) => block.source === 'manual')
    .reduce((total, block) => total + block.durationMinutes, 0);
  const risks = activeTasks().filter((task) => !task.deletedAt && task.status !== 'completed')
    .map((task) => Execution.riskForTask(state.store, task, { today: todayDate(), schedule: schedule.schedule }))
    .filter((risk) => risk?.risky);
  elements.executionSummary.replaceChildren(
    makeElement('span', '', `${schedule.blocks.length} 个时间块`),
    makeElement('span', '', `计划 ${totalMinutes} 分钟`),
    makeElement('span', '', `已锁定 ${manualMinutes} 分钟`),
    makeElement('span', risks.length ? 'is-risk' : '', risks.length ? `${risks.length} 项期限风险` : '期限容量正常'),
  );

  const fragment = document.createDocumentFragment();
  const timeRail = makeElement('div', 'execution-time-rail');
  timeRail.appendChild(makeElement('div', 'execution-time-rail-spacer'));
  for (let hour = 0; hour <= 24; hour += 1) {
    timeRail.appendChild(makeElement('span', '', `${String(hour).padStart(2, '0')}:00`));
  }
  fragment.appendChild(timeRail);
  schedule.dates.forEach((day) => {
    const column = makeElement('section', `execution-day${day === todayDate() ? ' is-today' : ''}`);
    column.dataset.executionDate = day;
    const holiday = Calendar.getChinaHoliday(day);
    const isOrdinaryWeekend = Calendar.isOrdinaryWeekend(day);
    const heading = makeElement('header', 'execution-day-header');
    heading.append(makeElement('strong', '', executionDateLabel(day)));
    if (isOrdinaryWeekend) heading.appendChild(makeElement('span', 'is-weekend', '周末'));
    if (holiday) heading.appendChild(makeElement('span', holiday.type === 'makeup' ? 'is-makeup' : 'is-holiday', `${holiday.badge} ${holiday.name}`));
    const dayMinutes = schedule.byDate[day].reduce((total, block) => total + block.durationMinutes, 0);
    heading.appendChild(makeElement('small', dayMinutes > schedule.dailyCapacityMinutes ? 'is-overload' : '', `${dayMinutes}/${schedule.dailyCapacityMinutes} 分`));
    const body = makeElement('div', 'execution-day-body');
    body.dataset.executionDate = day;
    for (let hour = 0; hour < 24; hour += 1) body.appendChild(makeElement('i', 'execution-hour-line'));
    schedule.byDate[day].forEach((block) => body.appendChild(renderExecutionBlock(block, schedule)));
    column.append(heading, body);
    fragment.appendChild(column);
  });
  elements.executionCalendar.classList.toggle('is-day-mode', state.executionMode === 'day');
  elements.executionCalendar.replaceChildren(fragment);
  if (!elements.executionCalendarScroll.dataset.initialized) {
    const earliestMinute = schedule.blocks.length
      ? Math.min(EXECUTION_DEFAULT_SCROLL_MINUTE, ...schedule.blocks.map((block) => block.startMinute))
      : EXECUTION_DEFAULT_SCROLL_MINUTE;
    elements.executionCalendarScroll.scrollTop = 53 + Math.max(0, earliestMinute - 60);
    elements.executionCalendarScroll.dataset.initialized = 'true';
  }
  renderFocusStrip();
}

async function moveExecutionBlock(block, date, startMinute) {
  const task = activeTasks().find((item) => item.id === block.taskId && !item.deletedAt);
  if (!task) return;
  const patch = {};
  if (!task.dueDate && date !== task.plannedDate) patch.plannedDate = date;
  else if (date < task.plannedDate) patch.plannedDate = date;
  if (task.dueDate && date > task.dueDate) patch.dueDate = date;
  if (Object.keys(patch).length && !(await patchTask(task.id, patch, { undo: false, message: '任务日期范围已随排程调整' }))) return;
  const blockId = block.source === 'manual' ? block.id : commandId('block');
  const undo = block.source === 'manual'
    ? {
        type: 'upsertScheduleBlock',
        taskId: task.id,
        payload: {
          blockId: block.id,
          date: block.date,
          startMinute: block.startMinute,
          durationMinutes: block.durationMinutes,
          locked: true,
        },
      }
    : { type: 'deleteScheduleBlock', taskId: task.id, payload: { blockId } };
  await dispatch({
    type: 'upsertScheduleBlock',
    taskId: task.id,
    payload: {
      blockId,
      date,
      startMinute,
      durationMinutes: block.durationMinutes,
      locked: true,
    },
  }, {
    undo,
    undoMessage: '已撤销手动排程',
    message: `已锁定到 ${executionDateLabel(date)} ${Execution.formatMinute(startMinute)}`,
  });
}

function openManualTime(taskId, date = todayDate()) {
  const task = activeTasks().find((item) => item.id === taskId && !item.deletedAt);
  if (!task) return;
  elements.manualTimeTaskId.value = task.id;
  elements.manualTimeTaskTitle.textContent = task.title;
  elements.manualTimeDate.value = date;
  elements.manualTimeMinutes.value = '30';
  elements.manualTimeNote.value = '';
  if (!elements.manualTimeDialog.open) elements.manualTimeDialog.showModal();
}

document.querySelector('.execution-mode').addEventListener('click', (event) => {
  const button = event.target.closest('[data-execution-mode]');
  if (!button) return;
  state.executionMode = button.dataset.executionMode;
  renderExecution();
  renderDebugState();
});

elements.executionDate.addEventListener('change', () => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(elements.executionDate.value)) return;
  state.executionDate = elements.executionDate.value;
  renderExecution();
});

elements.executionPrevious.addEventListener('click', () => {
  state.executionDate = addDays(state.executionDate || todayDate(), state.executionMode === 'day' ? -1 : -7);
  renderExecution();
});

elements.executionNext.addEventListener('click', () => {
  state.executionDate = addDays(state.executionDate || todayDate(), state.executionMode === 'day' ? 1 : 7);
  renderExecution();
});

elements.executionToday.addEventListener('click', () => {
  state.executionDate = todayDate();
  renderExecution();
});

elements.executionCalendar.addEventListener('dragstart', (event) => {
  const article = event.target.closest('.execution-block');
  if (!article || event.target.closest('.execution-resize-handle')) return;
  draggedExecutionBlock = {
    id: article.dataset.blockId,
    taskId: article.dataset.taskId,
    date: article.dataset.date,
    startMinute: Number(article.dataset.startMinute),
    durationMinutes: Number(article.dataset.durationMinutes),
    source: article.dataset.source,
  };
  article.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', article.dataset.blockId);
});

elements.executionCalendar.addEventListener('dragend', (event) => {
  event.target.closest('.execution-block')?.classList.remove('is-dragging');
  draggedExecutionBlock = null;
  elements.executionCalendar.querySelectorAll('.is-drop-target').forEach((item) => item.classList.remove('is-drop-target'));
});

elements.executionCalendar.addEventListener('dragover', (event) => {
  const body = event.target.closest('.execution-day-body');
  if (!body || !draggedExecutionBlock) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  elements.executionCalendar.querySelectorAll('.is-drop-target').forEach((item) => item.classList.toggle('is-drop-target', item === body));
});

elements.executionCalendar.addEventListener('drop', (event) => {
  const body = event.target.closest('.execution-day-body');
  if (!body || !draggedExecutionBlock) return;
  event.preventDefault();
  const rect = body.getBoundingClientRect();
  const raw = Math.round((event.clientY - rect.top) / 15) * 15;
  const startMinute = Math.max(EXECUTION_DAY_START_MINUTE, Math.min(EXECUTION_DAY_END_MINUTE - draggedExecutionBlock.durationMinutes, raw));
  const block = { ...draggedExecutionBlock };
  draggedExecutionBlock = null;
  runAction(moveExecutionBlock(block, body.dataset.executionDate, startMinute));
});

elements.executionCalendar.addEventListener('click', (event) => {
  const article = event.target.closest('.execution-block');
  if (!article) return;
  const action = event.target.closest('[data-execution-action]')?.dataset.executionAction;
  const taskId = article.dataset.taskId;
  if (action === 'focus') {
    runAction(dispatch({ type: 'startFocus', taskId, payload: { entryId: commandId('time') } }, { message: '已开始专注计时' }));
  } else if (action === 'manual-time') {
    openManualTime(taskId, article.dataset.date);
  } else if (action === 'unlock') {
    const blockId = article.dataset.blockId;
    runAction(dispatch({ type: 'deleteScheduleBlock', taskId, payload: { blockId } }, {
      message: '已撤销锁定，任务将重新自动安排',
    }));
  }
});

elements.executionCalendar.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('.execution-resize-handle');
  const article = event.target.closest('.execution-block');
  if (!handle || !article) return;
  event.preventDefault();
  article.draggable = false;
  resizingExecutionBlock = {
    article,
    pointerId: event.pointerId,
    startY: event.clientY,
    initialDuration: Number(article.dataset.durationMinutes),
    id: article.dataset.blockId,
    taskId: article.dataset.taskId,
    date: article.dataset.date,
    startMinute: Number(article.dataset.startMinute),
  };
  handle.setPointerCapture?.(event.pointerId);
  article.classList.add('is-resizing');
});

elements.executionCalendar.addEventListener('pointerdown', (event) => {
  const article = event.target.closest('.execution-block');
  if (!article || event.target.closest('button, .execution-resize-handle')) return;
  event.preventDefault();
  article.draggable = false;
  article.setPointerCapture?.(event.pointerId);
  pointerDraggingExecutionBlock = {
    article,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    startScrollTop: elements.executionCalendarScroll.scrollTop,
    moved: false,
    id: article.dataset.blockId,
    taskId: article.dataset.taskId,
    date: article.dataset.date,
    startMinute: Number(article.dataset.startMinute),
    durationMinutes: Number(article.dataset.durationMinutes),
    source: article.dataset.source,
  };
});

function stopExecutionAutoScroll() {
  executionAutoScrollVelocity = 0;
  if (executionAutoScrollFrame !== null) cancelAnimationFrame(executionAutoScrollFrame);
  executionAutoScrollFrame = null;
}

function renderPointerDragTransform(drag) {
  const scrollDelta = elements.executionCalendarScroll.scrollTop - drag.startScrollTop;
  drag.article.style.transform = `translate(${drag.lastX - drag.startX}px, ${drag.lastY - drag.startY + scrollDelta}px)`;
}

function runExecutionAutoScroll() {
  const drag = pointerDraggingExecutionBlock;
  if (!drag || !executionAutoScrollVelocity) {
    stopExecutionAutoScroll();
    return;
  }
  const before = elements.executionCalendarScroll.scrollTop;
  elements.executionCalendarScroll.scrollTop += executionAutoScrollVelocity;
  if (elements.executionCalendarScroll.scrollTop === before) {
    stopExecutionAutoScroll();
    return;
  }
  renderPointerDragTransform(drag);
  executionAutoScrollFrame = requestAnimationFrame(runExecutionAutoScroll);
}

function updateExecutionAutoScroll(clientY) {
  const rect = elements.executionCalendarScroll.getBoundingClientRect();
  const edge = Math.min(72, rect.height / 4);
  let velocity = 0;
  if (clientY < rect.top + edge) velocity = -Math.min(18, Math.max(4, Math.ceil((rect.top + edge - clientY) / 4)));
  if (clientY > rect.bottom - edge) velocity = Math.min(18, Math.max(4, Math.ceil((clientY - (rect.bottom - edge)) / 4)));
  executionAutoScrollVelocity = velocity;
  if (!velocity) {
    stopExecutionAutoScroll();
  } else if (executionAutoScrollFrame === null) {
    executionAutoScrollFrame = requestAnimationFrame(runExecutionAutoScroll);
  }
}

document.addEventListener('pointermove', (event) => {
  const drag = pointerDraggingExecutionBlock;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  const x = event.clientX - drag.startX;
  const y = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(x, y) < 5) return;
  drag.moved = true;
  drag.article.classList.add('is-dragging');
  renderPointerDragTransform(drag);
  updateExecutionAutoScroll(event.clientY);
});

document.addEventListener('pointerup', (event) => {
  const drag = pointerDraggingExecutionBlock;
  if (!drag || event.pointerId !== drag.pointerId) return;
  stopExecutionAutoScroll();
  pointerDraggingExecutionBlock = null;
  drag.article.draggable = true;
  drag.article.classList.remove('is-dragging');
  drag.article.style.transform = '';
  if (!drag.moved) return;
  const body = document.elementFromPoint(event.clientX, event.clientY)?.closest('.execution-day-body');
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const raw = Math.round((event.clientY - rect.top) / 15) * 15;
  const startMinute = Math.max(EXECUTION_DAY_START_MINUTE, Math.min(EXECUTION_DAY_END_MINUTE - drag.durationMinutes, raw));
  runAction(moveExecutionBlock(drag, body.dataset.executionDate, startMinute));
});

document.addEventListener('pointermove', (event) => {
  if (!resizingExecutionBlock) return;
  const delta = Math.round((event.clientY - resizingExecutionBlock.startY) / 15) * 15;
  const max = EXECUTION_DAY_END_MINUTE - resizingExecutionBlock.startMinute;
  const duration = Math.max(15, Math.min(max, resizingExecutionBlock.initialDuration + delta));
  resizingExecutionBlock.nextDuration = duration;
  resizingExecutionBlock.article.style.height = `${Math.max(38, duration)}px`;
  resizingExecutionBlock.article.querySelector('.execution-block-time').textContent = `${Execution.formatMinute(resizingExecutionBlock.startMinute)} · ${duration} 分`;
});

document.addEventListener('pointerup', (event) => {
  if (!resizingExecutionBlock || event.pointerId !== resizingExecutionBlock.pointerId) return;
  const resize = resizingExecutionBlock;
  resizingExecutionBlock = null;
  resize.article.draggable = true;
  resize.article.classList.remove('is-resizing');
  const durationMinutes = resize.nextDuration || resize.initialDuration;
  if (durationMinutes === resize.initialDuration) return;
  runAction(dispatch({
    type: 'upsertScheduleBlock',
    taskId: resize.taskId,
    payload: {
      blockId: resize.id,
      date: resize.date,
      startMinute: resize.startMinute,
      durationMinutes,
      locked: true,
    },
  }, {
    undo: {
      type: 'upsertScheduleBlock',
      taskId: resize.taskId,
      payload: {
        blockId: resize.id,
        date: resize.date,
        startMinute: resize.startMinute,
        durationMinutes: resize.initialDuration,
        locked: true,
      },
    },
    undoMessage: '已恢复原排程时长',
    message: `排程时长已调整为 ${durationMinutes} 分钟`,
  }));
});

elements.stopFocus.addEventListener('click', () => {
  const entry = Execution.activeFocusEntry(state.store);
  if (entry) runAction(dispatch({ type: 'stopFocus', taskId: entry.taskId, payload: { entryId: entry.id } }, { message: '专注计时已暂停' }));
});

elements.completeFocus.addEventListener('click', () => runAction((async () => {
  const entry = Execution.activeFocusEntry(state.store);
  if (!entry) return;
  await dispatch({ type: 'stopFocus', taskId: entry.taskId, payload: { entryId: entry.id } });
  await toggleTaskById(entry.taskId);
})()));

function saveManualTime() {
  const taskId = elements.manualTimeTaskId.value;
  const date = elements.manualTimeDate.value;
  const minutes = Number(elements.manualTimeMinutes.value);
  if (!taskId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    showToast('请填写有效的日期和实际用时', false);
    return;
  }
  const entryId = commandId('time');
  runAction(dispatch({
    type: 'addManualTime',
    taskId,
    payload: {
      entryId,
      date,
      minutes,
      note: elements.manualTimeNote.value.trim(),
    },
  }, {
    undo: { type: 'deleteTimeEntry', taskId, payload: { entryId } },
    undoMessage: '已删除补录用时',
    message: '实际用时已补录',
  }).then(() => elements.manualTimeDialog.close()));
}

elements.manualTimeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveManualTime();
});
elements.saveManualTime.addEventListener('click', saveManualTime);
