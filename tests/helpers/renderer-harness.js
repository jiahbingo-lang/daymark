// Loads the renderer scripts in Node so their pure helpers can be unit tested.
//
// The renderer is a classic browser script: it reads `window.TodoDomain` and
// friends, queries the DOM at load time and registers listeners. Rather than
// mock the domain modules, the harness loads the real ones — these tests then
// exercise the same code path the app does. Only the DOM is faked, and only as
// far as evaluating the scripts requires; nothing here renders anything.
//
// renderer-boot.js is deliberately not loaded: it calls bootstrap(), which
// would try to reach the IPC bridge.

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');

function fakeNode() {
  const node = {
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    checked: false,
    disabled: false,
    children: [],
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    appendChild(child) { return child; },
    append() {},
    replaceChildren() {},
    focus() {},
    blur() {},
    click() {},
    closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    querySelector: () => fakeNode(),
    querySelectorAll: () => [],
    scrollTo() {},
    showModal() {},
    close() {},
    requestSubmit() {},
  };
  return node;
}

function createHarness() {
  // Real domain modules, exposed the way the browser exposes them.
  const win = {
    TodoDomain: require(path.join(SRC, 'domain')),
    DaymarkChinaCalendar: require(path.join(SRC, 'china-calendar')),
    DaymarkPlanning: require(path.join(SRC, 'planning')),
    DaymarkExecution: require(path.join(SRC, 'execution')),
    DaymarkDailyPlanning: require(path.join(SRC, 'daily-planning')),
    DaymarkReporting: require(path.join(SRC, 'reporting')),
    DaymarkCalendar: require(path.join(SRC, 'calendar')),
    DaymarkAiReport: require(path.join(SRC, 'ai-report')),
    location: { search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  };

  const doc = {
    body: fakeNode(),
    documentElement: fakeNode(),
    hidden: false,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => fakeNode(),
    querySelectorAll: () => [],
    createElement: () => fakeNode(),
    createDocumentFragment: () => fakeNode(),
    createElementNS: () => fakeNode(),
  };

  const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
  const source = [
    read('renderer.js'),
    read('renderer-review.js'),
    read('renderer-execution.js'),
  ].join('\n');

  // The names under test. Kept explicit so a rename shows up here as a
  // ReferenceError instead of silently skipping a test.
  const exported = [
    'toInputDateTime', 'fromInputDateTime',
    'addDays', 'todayDate', 'tomorrowDate',
    'formatShortDate', 'formatCompletedGroupDate', 'formatCompletionTime',
    'shiftedDate', 'shiftedDateTime', 'repeatRuleForNext',
    'errorMessage', 'coerceStore', 'plannedForNewTask',
    'formatCalendarDate', 'formatRecordDate', 'periodTitle', 'markdownList',
    'shiftMonth', 'coerceAiSettings',
    'executionDateLabel',
    'state',
  ];

  const factory = new Function(
    'window', 'document', 'CSS', 'requestAnimationFrame', 'cancelAnimationFrame',
    `${source}\n;return { ${exported.join(', ')} };`,
  );

  return factory(
    win,
    doc,
    { escape: (v) => String(v) },
    () => 0,
    () => {},
  );
}

module.exports = { createHarness };
