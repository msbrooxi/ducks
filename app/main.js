import {
  getTaskList, getTask, saveTask, newTask, touchTask, getSettings, saveSettings,
  getLocal, saveLocal, getConn, saveConn, isPastDue, ducksDayDate,
  logEvent, CATEGORIES, SIZES, nowIso,
  getProjectList, getSteps, projectProgress
} from './store.js?v=2026-10-04.1';
import { scheduleSync, syncNow, onSyncStatus, startBackgroundSync, exportEventLog } from './sync.js?v=2026-10-04.1';
import { doNextList, minutesFilter, fiveDucksFill, sortForList, LIST_SORTS, DEFAULT_SORT_DIR, SORT_DIR_LABELS, isBlocked } from './rank.js?v=2026-10-04.1';
import { playQuack, playParade } from './quack.js?v=2026-10-04.1';
import { computeFirstDue, computeNextDue, FREQUENCIES, recurrenceLabel, WEEKDAY_NAMES, MONTH_NAMES } from './recurrence.js?v=2026-10-04.1';
import {
  createTemplateFromProject, editTemplate, deleteTemplate,
  renderTemplatePickerBody_, renderTemplateManageList_, renderTemplateBuilder_,
  wireTemplatePicker_, wireTemplateBuilder_, templateDraftIsOpen, templateBuilderSummary
} from './templates.js?v=2026-10-04.1';

// Bumped by hand on every shipped change. Shown in Settings so it's a
// one-glance way to tell whether a device is actually running the latest
// build, instead of guessing from a stale cached copy.
const APP_BUILD = '2026-10-04.1';

let activeTab = 'home';
let expandedTaskId = null;
let minutesQuery = null;
let listFilters = { category: '', size: '', ducks: '', projects: [], search: '', hideBlocked: false, sort: 'date', dir: {} };
// Typing in the List tab's search box debounces its own re-render (a full
// render on every keystroke would tear down and recreate the input,
// dropping focus and the cursor position, the same problem the task editor's
// text fields solve with their own debounce). This timer, plus refocusing
// the box by id right after that debounced render, is the List-search
// equivalent of that.
let listSearchDebounceTimer = null;
function currentListDir_() {
  return listFilters.dir[listFilters.sort] || DEFAULT_SORT_DIR[listFilters.sort] || 'asc';
}
let lastFiveDucksWhole = -1;
let openProjectId = null;

// While a task's Details is open, the List tab keeps it (and everything
// else) in whatever order it was already in, rather than re-sorting on
// every keystroke or field change. Changing a task's due date while its
// editor is open used to immediately jump it to wherever the new date
// sorts to, mid-edit, which read as the app "bouncing around" and losing
// her place. Cleared (forcing a fresh sort) whenever the editor closes,
// the expanded task changes, or the sort/filter controls change.
let frozenListOrder = null;
let frozenListForTaskId = null;

// 8 primaries/saturated colors, then 8 pastel versions of roughly the same
// hues, so a project's color is easy to tell apart from its neighbors
// whether she wants it bold or soft.
const PROJECT_COLORS = [
  '#e63946', '#f4a300', '#2a9d8f', '#3d5a80', '#457b9d', '#9b5de5', '#e07a5f', '#2b2d42',
  '#f7b2b7', '#fcd29f', '#a8dad5', '#aebfd6', '#a9c6da', '#d0b3f0', '#f3c6b8', '#c2c4d6'
];

const app = document.getElementById('app');

// A cute yellow duck, not the mallard the 🦆 emoji renders as on most
// platforms. One small PNG, reused everywhere at different sizes.
function duckIcon(px = 18) {
  return `<img src="./icons/duck-glyph.png" alt="" class="duck-ico" width="${px}" height="${px}">`;
}
function duckIcons(n, px = 16) {
  return duckIcon(px).repeat(n);
}

// A small colored, clickable chip on a step's card: nickname + progress
// (e.g. "Main St 3/7"). Tapping it jumps to that project's detail view.
function projectChip_(projectId) {
  const project = getTask(projectId);
  if (!project || !project.chip) return '';
  const prog = projectProgress(projectId);
  return `<button type="button" class="chip project-chip" style="background:${esc(project.chip.color)}" data-action="openProject" data-id="${esc(projectId)}">${esc(project.chip.nickname)} ${prog.done}/${prog.total}</button>`;
}

// ---------- helpers ----------

function fmtDue(due) {
  if (!due) return '';
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}
function categoryLabel(id) {
  return (CATEGORIES.find((c) => c.id === id) || {}).label || id;
}
function sizeLabel(id) {
  return { XS: 'XS', S: 'Small', M: 'Medium', L: 'Large', XL: 'XL' }[id] || '';
}
function esc(s) {
  return (s ?? '').toString().replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function mutateTask(id, patch, eventType, eventExtra) {
  // Flush any pending debounced text-field edit for THIS task first, so a
  // duck rating (or any other button/select action) never reads a stale
  // copy of the task that's still missing a title/notes/link edit sitting
  // in the pending-save queue. render() also flushes everything, but
  // doing it here first means mutateTask's own read-modify-write is never
  // the one working from stale data, belt and suspenders.
  flushPendingFieldEdits();
  const t = getTask(id);
  if (!t) {
    // This used to fail silently: whatever called mutateTask (e.g.
    // completeTask) would carry on as if it worked, playing the quack and
    // all, while nothing was actually saved. The most likely way to land
    // here is tapping something on a screen that's gone stale relative to
    // the real data (see the sync-triggered render fix below), so surface
    // it loudly rather than pretend.
    console.error('mutateTask: no task found for id', id, 'patch', patch);
    alert("That didn't save, the screen may be out of date. Closing and reopening should fix it.");
    render(); // refresh to the current real data now, at least
    return false;
  }
  const updated = touchTask(t, patch);
  saveTask(updated);
  if (eventType) logEvent(eventType, id, eventExtra || {});
  scheduleSync();
  render();
  return true;
}

// Text fields (title/notes/link) autosave on every keystroke, debounced,
// but WITHOUT calling render(): re-rendering while she's mid-keystroke
// would tear down and rebuild the very input she's typing into, losing
// focus and the cursor position. Any other field (date, size, ducks...)
// still renders immediately when it changes, since that's a deliberate,
// discrete choice, not an in-progress keystroke.
//
// The real bug this fixes: changing the due date used to trigger an
// immediate render (a full rebuild + re-sort of the list), which would
// wipe out anything typed into another field that hadn't been blurred
// yet, since a render tears down and recreates every input from
// scratch. render() now flushes these first, so no keystroke is ever
// thrown away no matter what else triggers a rebuild.
const pendingFieldTimers = {};
const pendingFieldValues = {};

function flushPendingFieldEdits() {
  const keys = Object.keys(pendingFieldValues);
  for (const key of keys) {
    const pending = pendingFieldValues[key];
    clearTimeout(pendingFieldTimers[key]);
    delete pendingFieldTimers[key];
    delete pendingFieldValues[key];
    const t = getTask(pending.id);
    if (!t) continue;
    saveTask(touchTask(t, { [pending.field]: pending.value }));
    logEvent('edited', pending.id, { field: pending.field, to: pending.value });
  }
  if (keys.length > 0) scheduleSync();
}

// Fields whose debounced save should trigger a re-render once it actually
// commits (600ms after the last keystroke). Title/notes/link deliberately
// do NOT: she could still be typing in them, or another field, when this
// fires, and a render would tear down and rebuild those inputs out from
// under her. "due" is different: it's a single discrete value (not
// free-flowing text), and it changes which section a card lives in (past
// due vs. not) and how the list sorts. Without this, a due-date edit saved
// correctly but the screen just kept showing the old state until something
// unrelated happened to trigger another render, e.g. switching tabs,
// reading as "the date change didn't stick" even though it had.
const RENDER_AFTER_COMMIT_FIELDS = new Set(['due']);

function scheduleFieldSave(id, field, value) {
  const key = id + ':' + field;
  pendingFieldValues[key] = { id, field, value };
  clearTimeout(pendingFieldTimers[key]);
  pendingFieldTimers[key] = setTimeout(() => {
    delete pendingFieldTimers[key];
    const pending = pendingFieldValues[key];
    delete pendingFieldValues[key];
    if (!pending) return;
    const t = getTask(pending.id);
    if (!t) return;
    saveTask(touchTask(t, { [pending.field]: pending.value }));
    logEvent('edited', pending.id, { field: pending.field, to: pending.value });
    scheduleSync();
    if (RENDER_AFTER_COMMIT_FIELDS.has(pending.field)) render();
  }, 600);
}

function addQuickTask(title, { due, size, category, ducks, projectId } = {}) {
  const trimmed = title.trim();
  if (!trimmed) return;
  const t = newTask({
    title: trimmed,
    due: due || null,
    size: size || null,
    category: category || 'admin',
    ducks: ducks ? Number(ducks) : null,
    projectId: projectId || null,
    order: projectId ? getSteps(projectId).length : null
  });
  saveTask(t);
  logEvent('created', t.id, projectId ? { projectId } : {});
  scheduleSync();
  render();
}

function completeTask(id) {
  const t = getTask(id);
  const ok = mutateTask(id, { status: 'done', completedAt: nowIso(), doingSince: null }, 'completed');
  if (!ok) return; // mutateTask already alerted and refreshed the screen
  playQuack();

  // Recurring tasks keep only one live instance; completing it (whether
  // early, on time, or late) spawns the next one on schedule, computed
  // from the due date that was just completed, not from today.
  if (t && t.recurrence) {
    const nextDue = computeNextDue(t.recurrence, t.due || ducksDayDate());
    if (nextDue) {
      const spawned = newTask({
        title: t.title,
        ducks: t.ducks,
        size: t.size,
        category: t.category,
        due: nextDue,
        recurrence: t.recurrence,
        source: t.source,
        // Carry the project assignment forward: without this, assigning a
        // recurring task to a project would silently stop applying the very
        // next time it completed and respawned, since the fresh copy below
        // would otherwise start with no projectId at all.
        projectId: t.projectId,
        order: t.projectId ? getSteps(t.projectId).length : null
      });
      saveTask(spawned);
      logEvent('created', spawned.id, { recurringFrom: id });
      scheduleSync();
    }
  }

  const settings = getSettings();
  const whole = Math.floor(fiveDucksFill(getTaskList()));
  if (whole >= 5 && lastFiveDucksWhole < 5) {
    setTimeout(() => playParade(), 250);
  }
}
function reopenTask(id) {
  mutateTask(id, { status: 'active', completedAt: null }, 'reopened');
}
function startTask(id) {
  mutateTask(id, { doingSince: nowIso() }, 'started');
}
function snoozeTask(id, newDue) {
  mutateTask(id, { due: newDue, doingSince: null }, 'snoozed', { to: newDue });
}
function setDucks(id, ducks) {
  if (ducks === 0) {
    if (confirm("If you give no ducks, it doesn't belong on the list. Delete this task?")) {
      deleteTask(id);
    }
    return;
  }
  mutateTask(id, { ducks }, 'ducks', { to: ducks });
}
function deleteTask(id) {
  mutateTask(id, { deletedAt: nowIso(), status: 'active' }, 'deleted');
  if (expandedTaskId === id) expandedTaskId = null;
}
// Copies the task's basic shape (title/notes/link/due/ducks/size/category,
// and its project slot if it's a step) into a fresh task, for the "same
// task, tweaked per kid" case. Deliberately does NOT carry over status,
// doingSince, completedAt, dependsOn, or recurrence: a clone is a new,
// independent, active task, not a second instance of whatever state the
// original happened to be in. Opens the clone's editor immediately since
// the whole point is to go tweak it (the title especially) right away.
function cloneTask(id) {
  const t = getTask(id);
  if (!t) return;
  const clone = newTask({
    title: t.title,
    notes: t.notes,
    link: t.link,
    due: t.due,
    ducks: t.ducks,
    size: t.size,
    category: t.category,
    projectId: t.projectId,
    order: t.projectId ? getSteps(t.projectId).length : null,
    source: t.source
  });
  saveTask(clone);
  logEvent('created', clone.id, { clonedFrom: id });
  scheduleSync();
  expandedTaskId = clone.id;
  render();
}
function deleteProject(id) {
  const steps = getSteps(id);
  const warn = steps.length
    ? `Delete this project and its ${steps.length} step${steps.length > 1 ? 's' : ''}?`
    : 'Delete this project?';
  if (!confirm(warn)) return;
  deleteTask(id);
  steps.forEach((s) => deleteTask(s.id));
  if (openProjectId === id) openProjectId = null;
}
function restoreTask(id) {
  mutateTask(id, { deletedAt: null }, 'restored');
}
function moveToList(id) {
  mutateTask(id, { status: 'active' }, 'edited', { field: 'status', to: 'active' });
}

function nextMonday(from = new Date()) {
  const d = new Date(from);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const add = day === 1 ? 7 : (8 - day) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}
function plusDays(n, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- rendering ----------

function render() {
  flushPendingFieldEdits();
  const tasks = getTaskList();
  const settings = getSettings();
  const today = ducksDayDate();

  app.innerHTML = '';
  app.appendChild(renderHeader());

  let body;
  if (activeTab === 'home') body = renderHome(tasks, settings, today);
  else if (activeTab === 'inbox') body = renderInbox(tasks);
  else if (activeTab === 'list') body = renderList(tasks, settings, today);
  else if (activeTab === 'projects') body = renderProjects();
  else if (activeTab === 'done') body = renderDone(tasks);
  else body = renderSettings(settings);

  app.appendChild(body);
  app.appendChild(renderNav());

  const fill = fiveDucksFill(tasks, today);
  lastFiveDucksWhole = Math.floor(fill);
}

function renderHeader() {
  const header = el(`
    <header class="hdr">
      <div class="brand">${duckIcon(24)} Ducks</div>
      <form id="quickAddForm" class="quickadd">
        <input id="quickAddInput" type="text" placeholder="What needs doing?" autocomplete="off">
        <div class="quickadd-extra">
          <select id="quickAddDucks" title="Ducks (importance)">
            <option value="">Ducks</option>
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} duck${n > 1 ? 's' : ''}</option>`).join('')}
          </select>
          <select id="quickAddSize" title="Duration">
            <option value="">Duration</option>
            ${SIZES.map((s) => `<option value="${s.id}">${sizeLabel(s.id)}</option>`).join('')}
          </select>
          <input id="quickAddDue" type="date" title="Due date">
          <select id="quickAddCategory" title="Category">
            ${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === 'admin' ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
          <select id="quickAddProject" title="Project">
            <option value="">No project</option>
            ${getProjectList().map((p) => `<option value="${p.id}">${esc(p.chip.nickname)}</option>`).join('')}
          </select>
          <button type="submit">Add</button>
        </div>
      </form>
    </header>
  `);
  header.querySelector('#quickAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = header.querySelector('#quickAddInput');
    const due = header.querySelector('#quickAddDue');
    const size = header.querySelector('#quickAddSize');
    const category = header.querySelector('#quickAddCategory');
    const ducks = header.querySelector('#quickAddDucks');
    const project = header.querySelector('#quickAddProject');
    addQuickTask(input.value, { due: due.value, size: size.value, category: category.value, ducks: ducks.value, projectId: project.value });
    input.value = '';
    due.value = '';
    size.value = '';
    category.value = 'admin';
    ducks.value = '';
    project.value = '';
    input.focus();
  });
  return header;
}

// Switches to the Projects tab with a specific project open. Shared by the
// click dispatcher's "openProject" action and by templates.js, which needs
// to land on the just-created project right after instantiating a template.
export function openProject(id) {
  openProjectId = id;
  activeTab = 'projects';
  expandedTaskId = null;
  render();
}

function renderNav() {
  const tabs = [
    ['home', '🏠 Home'], ['list', '📋 List'], ['done', '✅ Done'],
    ['inbox', '📥 Inbox'], ['projects', '🗂️ Projects'], ['settings', '⚙️ Settings']
  ];
  const nav = el(`<nav class="tabs">${tabs.map(([id, label]) => (
    `<button data-tab="${id}" class="${activeTab === id ? 'active' : ''}">${label}</button>`
  )).join('')}</nav>`);
  nav.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      expandedTaskId = null;
      if (btn.dataset.tab === 'projects') openProjectId = null;
      render();
    });
  });
  return nav;
}

// Five ducks is the daily goal, not a hard ceiling: once all 5 are filled,
// 5 more empty ones appear so finishing a big day still has somewhere to
// go, rather than the row just maxing out and sitting there. Keeps growing
// by fives for as long as she keeps completing tasks that day.
function fiveDucksRow(fill) {
  // 5 is the daily floor, not a hard ceiling: once all 5 are lit, exactly
  // one more empty duck appears (not a whole new batch of 5), and another
  // each time the newest one gets lit too, so the row grows one at a time
  // to match what's actually been done instead of jumping ahead in blocks.
  const slots = Math.max(5, fill + 1);
  const pct = Math.min(100, (fill / slots) * 100);
  return `
    <div class="ducks-row" title="${fill} of ${slots} ducks today">
      <div class="ducks-row-base">${duckIcons(slots, 32)}</div>
      <div class="ducks-row-fill" style="width:${pct}%">${duckIcons(slots, 32)}</div>
    </div>
  `;
}

function renderHome(tasks, settings, today) {
  const fill = fiveDucksFill(tasks, today);
  const next = doNextList(tasks, settings, today);
  const wrap = el(`
    <section class="tabpanel">
      ${fiveDucksRow(fill)}
      ${fill >= 5 ? `<p class="parade">${duckIcons(3, 22)} All five ducks in a row today! ${duckIcons(3, 22)}</p>` : ''}

      <div class="slider-card">
        <label for="rankSlider">Deadline first
          <input id="rankSlider" type="range" min="0" max="100" value="${settings.rankSlider}">
        Ducks first</label>
      </div>

      <h2>Do next</h2>
      <div class="cards">
        ${next.length ? next.map((t) => taskCard(t, today)).join('') : '<p class="empty">Nothing on deck. Nice.</p>'}
      </div>

      <h2>I have <span id="minLabel">${minutesQuery ?? '__'}</span> minutes</h2>
      <form id="minutesForm" class="minutes-form">
        <input id="minutesInput" type="number" min="1" placeholder="e.g. 15" value="${minutesQuery ?? ''}">
        <button type="submit">Show what fits</button>
      </form>
      <div id="minutesResults"></div>
    </section>
  `);

  wrap.querySelector('#rankSlider').addEventListener('input', (e) => {
    saveSettings({ rankSlider: Number(e.target.value) });
    scheduleSync();
  });
  wrap.querySelector('#rankSlider').addEventListener('change', render);

  const minutesForm = wrap.querySelector('#minutesForm');
  minutesForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Number(wrap.querySelector('#minutesInput').value);
    minutesQuery = v > 0 ? v : null;
    renderMinutesResults(wrap, tasks, settings);
  });
  if (minutesQuery) renderMinutesResults(wrap, tasks, settings);

  return wrap;
}

function renderMinutesResults(wrap, tasks, settings) {
  const box = wrap.querySelector('#minutesResults');
  wrap.querySelector('#minLabel').textContent = minutesQuery;
  if (!minutesQuery) { box.innerHTML = ''; return; }
  const { fits, hiddenUnsized } = minutesFilter(tasks, minutesQuery, settings);
  box.innerHTML = `
    <div class="cards">
      ${fits.length ? fits.map((t) => taskCard(t)).join('') : '<p class="empty">Nothing sized to fit. Try a bigger number, or size up a task.</p>'}
    </div>
    ${hiddenUnsized ? `<p class="hint">${hiddenUnsized} task(s) with no size (or XL) are hidden here. Give them a size to see them.</p>` : ''}
  `;
}

function taskCard(t, today = ducksDayDate()) {
  const overdue = isPastDue(t, today);
  return `
    <div class="card ${overdue ? 'overdue' : ''}" data-id="${t.id}">
      <div class="card-title">${t.seq != null ? `<span class="seq">#${t.seq}</span> ` : ''}${esc(t.title)}</div>
      <div class="card-meta">
        ${t.due ? `<span class="chip due">${overdue ? 'was due' : 'due'} ${fmtDue(t.due)}</span>` : ''}
        ${t.ducks ? `<span class="chip">${duckIcons(t.ducks, 14)}</span>` : '<span class="chip muted">not rated</span>'}
        ${t.size ? `<span class="chip">${sizeLabel(t.size)}</span>` : ''}
        <span class="chip cat">${categoryLabel(t.category)}</span>
        ${t.doingSince ? '<span class="chip doing">doing now</span>' : ''}
        ${t.recurrence ? `<span class="chip" title="${recurrenceLabel(t.recurrence)}">&#8635; repeats</span>` : ''}
        ${t.projectId ? projectChip_(t.projectId) : ''}
        ${(() => { const b = blockedInfo_(t); return b ? `<span class="chip blocked">waiting on ${esc(b)}</span>` : ''; })()}
      </div>
      <div class="card-actions">
        <button data-action="complete" data-id="${t.id}">Done</button>
        ${overdue ? `
          <button data-action="start" data-id="${t.id}">Start</button>
          <button data-action="snooze" data-id="${t.id}" data-when="tomorrow">Snooze: tomorrow</button>
          <button data-action="snooze" data-id="${t.id}" data-when="3days">3 days</button>
          <button data-action="snooze" data-id="${t.id}" data-when="week">Next week</button>
        ` : !t.doingSince ? `<button data-action="start" data-id="${t.id}">Start</button>` : ''}
        <button data-action="expand" data-id="${t.id}">Details</button>
      </div>
      ${expandedTaskId === t.id ? taskEditor(t) : ''}
    </div>
  `;
}

function taskEditor(t) {
  return `
    <div class="editor">
      <label>Title
        <input data-field="title" data-id="${t.id}" value="${esc(t.title)}">
      </label>
      <label>Notes
        <textarea data-field="notes" data-id="${t.id}" rows="2">${esc(t.notes)}</textarea>
      </label>
      <label>Link
        <input data-field="link" data-id="${t.id}" value="${esc(t.link)}" placeholder="https://...">
      </label>
      <label>Due
        <input type="date" data-field="due" data-id="${t.id}" value="${t.due || ''}">
      </label>
      <label>Size
        <select data-field="size" data-id="${t.id}">
          <option value="">Not set</option>
          ${SIZES.map((s) => `<option value="${s.id}" ${t.size === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </label>
      <label>Category
        <select data-field="category" data-id="${t.id}">
          ${CATEGORIES.map((c) => `<option value="${c.id}" ${t.category === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select>
      </label>
      <div class="ducks-picker">
        Ducks:
        ${[0, 1, 2, 3, 4, 5].map((n) => `<button data-action="setDucks" data-id="${t.id}" data-n="${n}" class="${t.ducks === n ? 'sel' : ''}">${n === 0 ? '0' : duckIcons(n, 15)}</button>`).join('')}
      </div>
      <label>Depends on (must be done first)
        <select data-field="dependsOn" data-id="${t.id}" multiple size="4">
          ${getTaskList().filter((o) => o.id !== t.id && !o.chip && o.status !== 'done').map((o) => (
            `<option value="${o.id}" ${(t.dependsOn || []).includes(o.id) ? 'selected' : ''}>#${o.seq ?? '?'} ${esc(o.title)}</option>`
          )).join('')}
        </select>
      </label>
      <p class="hint">Ctrl/Cmd-click (or tap and drag on a phone) to pick more than one. Empty means no pre-reqs.</p>
      ${!t.chip ? `
        <label>Project
          <select data-action-select="moveToProject" data-id="${t.id}">
            <option value="">(none, not part of a project)</option>
            ${getProjectList().map((p) => (
              `<option value="${p.id}" ${t.projectId === p.id ? 'selected' : ''}>${esc(p.chip.nickname)}: ${esc(p.title)}</option>`
            )).join('')}
          </select>
        </label>
      ` : ''}
      <div class="save-row">
        <button data-action="explicitSave" data-id="${t.id}" class="save-btn">Save</button>
        <span class="save-confirm" id="saveConfirm-${t.id}"></span>
      </div>
      <div class="save-row">
        <button data-action="clone" data-id="${t.id}">Clone this task</button>
        <button data-action="delete" data-id="${t.id}" class="danger">Delete this task</button>
      </div>
    </div>
  `;
}

function blockedInfo_(t) {
  if (!t.dependsOn || !t.dependsOn.length) return null;
  const byId = {};
  for (const x of getTaskList()) byId[x.id] = x;
  if (!isBlocked(t, byId)) return null;
  return t.dependsOn
    .map((id) => byId[id])
    .filter((dep) => dep && !dep.deletedAt && dep.status !== 'done')
    .map((dep) => `#${dep.seq ?? '?'} ${dep.title}`)
    .join(', ');
}

function attachGlobalDelegation() {
  app.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === 'complete') completeTask(id);
    else if (action === 'start') startTask(id);
    else if (action === 'expand') { expandedTaskId = expandedTaskId === id ? null : id; render(); }
    else if (action === 'delete') deleteTask(id);
    else if (action === 'clone') cloneTask(id);
    else if (action === 'deleteProject') deleteProject(id);
    else if (action === 'restore') restoreTask(id);
    else if (action === 'reopen') reopenTask(id);
    else if (action === 'moveToList') moveToList(id);
    else if (action === 'stopRecurring') {
      mutateTask(id, { recurrence: null }, 'edited', { field: 'recurrence', to: null });
    }
    else if (action === 'openProject') openProject(id);
    else if (action === 'saveTemplate') createTemplateFromProject(id);
    else if (action === 'deleteTemplate') deleteTemplate(id);
    else if (action === 'editTemplate') editTemplate(id);
    else if (action === 'setDucks') setDucks(id, Number(btn.dataset.n));
    else if (action === 'snooze') {
      const when = btn.dataset.when;
      const to = when === 'tomorrow' ? plusDays(1) : when === '3days' ? plusDays(3) : nextMonday();
      snoozeTask(id, to);
    }
    else if (action === 'explicitSave') {
      // Read what's actually in the editor's own fields right now (not
      // relying on whatever did or didn't get captured by 'input' events)
      // and write it directly, so this button is a genuine guarantee, not
      // just a trigger for the same autosave path that's in question.
      const panel = btn.closest('.editor');
      if (panel) {
        const patch = {};
        panel.querySelectorAll('[data-field]').forEach((el) => {
          if (el.dataset.id !== id) return;
          if (el.multiple) patch[el.dataset.field] = Array.from(el.selectedOptions).map((o) => o.value);
          else patch[el.dataset.field] = el.dataset.field === 'due' && el.value === '' ? null : el.value;
        });
        const before = getTask(id);
        if (before) saveTask(touchTask(before, patch));
      }
      flushPendingFieldEdits();
      syncNow();
      render();
      // Verify, don't assume: re-read from storage and compare against
      // what the panel showed, so a false "Saved!" can't happen.
      const after = getTask(id);
      const ok = panel && after && Array.from(panel.querySelectorAll('[data-field]'))
        .filter((el) => el.dataset.id === id)
        .every((el) => {
          const expected = el.multiple
            ? JSON.stringify(Array.from(el.selectedOptions).map((o) => o.value))
            : (el.dataset.field === 'due' && el.value === '' ? null : el.value);
          const actual = el.multiple ? JSON.stringify(after[el.dataset.field] || []) : after[el.dataset.field];
          return expected === actual || (expected === null && actual == null);
        });
      const span = document.getElementById('saveConfirm-' + id);
      if (span) {
        span.textContent = ok ? 'Saved!' : 'Something did not save, please try again or tell Claude';
        span.style.color = ok ? '' : 'var(--danger)';
        setTimeout(() => { if (span.isConnected) span.textContent = ''; }, ok ? 2000 : 8000);
      }
    }
  });
  app.addEventListener('input', (e) => {
    const field = e.target.dataset && e.target.dataset.field;
    if (!field || !isDebouncedField_(e.target)) return;
    let value = e.target.value;
    if (field === 'due' && value === '') value = null;
    scheduleFieldSave(e.target.dataset.id, field, value);
  });
  // A field that just got debounced-saved commits immediately on blur
  // instead of waiting out the rest of its debounce window, so tabbing or
  // tapping away feels instant rather than laggy. 'blur' doesn't bubble,
  // so this listens in the capturing phase.
  app.addEventListener('blur', (e) => {
    const field = e.target.dataset && e.target.dataset.field;
    if (!field || !isDebouncedField_(e.target)) return;
    // Save quietly, do NOT render() here. Clicking another element (like
    // the Save button, or a duck rating) fires this field's blur FIRST,
    // before that click's own handler runs. Calling render() here tore
    // down and rebuilt the whole screen, including whatever was about to
    // be clicked, before the browser had finished dispatching that click
    // on a phone, which could swallow the tap entirely. The data is still
    // safe immediately (flush writes to storage synchronously); the
    // screen catches up on whatever render happens next regardless.
    flushPendingFieldEdits();
  }, true);
  app.addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.actionSelect === 'moveToProject') {
      const id = e.target.dataset.id;
      const projectId = e.target.value || null;
      const order = projectId ? getSteps(projectId).length : null;
      mutateTask(id, { projectId, order }, 'edited', { field: 'projectId', to: projectId });
      return;
    }
    const field = e.target.dataset && e.target.dataset.field;
    if (!field) return;
    // Title/notes/link/due already autosave via 'input' above (a date
    // input fires 'change' on every intermediate keystroke too, e.g.
    // typing "1" of "10" briefly reads as day/month "01", which used to
    // save and re-render immediately, jumping the card mid-keystroke;
    // debouncing through 'input' instead fixes that). Re-saving here on
    // top would just be redundant.
    if (isDebouncedField_(e.target)) return;
    const id = e.target.dataset.id;
    let value = e.target.value;
    if (field === 'dependsOn') {
      value = Array.from(e.target.selectedOptions).map((opt) => opt.value);
    }
    mutateTask(id, { [field]: value }, 'edited', { field, to: value });
  });
}

function isDebouncedField_(el) {
  return el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'url' || el.type === 'date'));
}

// Broader than isDebouncedField_ on purpose: that one only covers the
// task-editor fields that specifically autosave on a debounce. This one is
// for "is she actively composing something anywhere on screen right now",
// used to decide whether a background sync is allowed to re-render. It
// matters most for things like the "Add a step..." box in a project and
// the main quick-add bar: neither of those are task-editor fields (so
// isDebouncedField_ said no), which meant a background sync landing while
// she was mid-typing a NEW step's title (not yet clicked Add, so nothing
// had been saved yet to lose from storage, but the render tore down and
// rebuilt the whole screen, wiping out whatever was sitting unsent in that
// input) could silently eat a draft she hadn't submitted yet. This is the
// most likely explanation for project steps she'd typed going missing
// after adding several in a row.
function isTypingAnywhere_() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  // 'checkbox' covers the dependency picker's checkboxes: checking several
  // before clicking "Update step" is the same kind of in-progress,
  // not-yet-submitted interaction as typing, and just as vulnerable to
  // being silently reset by a background render in between.
  if (el.tagName === 'INPUT') return ['text', 'url', 'date', 'number', 'checkbox'].includes(el.type);
  // A <select> is just as vulnerable as a text field: clicking an option
  // IS the interaction, there's no separate "commit" step until whatever
  // button submits the surrounding form. A background-sync render landing
  // in between silently reverted the selection back to whatever was last
  // saved, so submitting right after looked like it had quietly ignored
  // the new pick and kept the old (wrong) one, every time, since the
  // revert always lands before the click that would have used it.
  if (el.tagName === 'SELECT') return true;
  return false;
}

function renderInbox(tasks) {
  const inbox = tasks.filter((t) => t.status === 'inbox');
  return el(`
    <section class="tabpanel">
      <h2>Inbox</h2>
      <p class="hint">Requests from the kids land here. Rate them, size them, or send them to your list.</p>
      ${inbox.length ? inbox.map((t) => `
        <div class="card" data-id="${t.id}">
          <div class="card-title">${esc(t.title)}</div>
          <div class="card-meta">
            <span class="chip">from ${esc(t.source)}</span>
            ${t.due ? `<span class="chip due">needed by ${fmtDue(t.due)}</span>` : ''}
          </div>
          <div class="card-actions">
            <button data-action="moveToList" data-id="${t.id}">Move to list</button>
            <button data-action="expand" data-id="${t.id}">Details</button>
            <button data-action="delete" data-id="${t.id}">Delete</button>
          </div>
          ${expandedTaskId === t.id ? taskEditor(t) : ''}
        </div>
      `).join('') : '<p class="empty">Empty. Quiet day.</p>'}
    </section>
  `);
}

function sortHeading_() {
  const label = LIST_SORTS.find((s) => s.id === listFilters.sort).label;
  const dirLabel = (SORT_DIR_LABELS[listFilters.sort] || {})[currentListDir_()] || '';
  return `Sorted by ${label.toLowerCase()}${dirLabel ? ', ' + dirLabel.toLowerCase() : ''}`;
}

function renderList(tasks, settings, today) {
  // Project "head" tasks are containers, not to-dos, they live on the
  // Projects tab; their steps show here like any other task.
  const active = tasks.filter((t) => t.status === 'active' && !t.chip);
  const pastDue = active.filter((t) => isPastDue(t, today))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  let rest = active.filter((t) => !isPastDue(t, today));

  if (listFilters.category) rest = rest.filter((t) => t.category === listFilters.category);
  if (listFilters.size) rest = rest.filter((t) => t.size === listFilters.size);
  if (listFilters.ducks) {
    if (listFilters.ducks === 'unrated') rest = rest.filter((t) => t.ducks == null);
    else rest = rest.filter((t) => t.ducks === Number(listFilters.ducks));
  }
  // 'none' is a sentinel for "not associated with a project" (no real
  // project ever has that as its id), so picking it alongside one or more
  // real projects reads as "this project OR no project", not an
  // impossible intersection.
  if (listFilters.projects.length) {
    rest = rest.filter((t) => (
      (listFilters.projects.includes('none') && !t.projectId) ||
      listFilters.projects.includes(t.projectId)
    ));
  }
  if (listFilters.search.trim()) {
    const q = listFilters.search.trim().toLowerCase();
    rest = rest.filter((t) => (
      (t.title || '').toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q)
    ));
  }
  if (listFilters.hideBlocked) {
    const byId = {};
    for (const x of getTaskList()) byId[x.id] = x;
    rest = rest.filter((t) => !isBlocked(t, byId));
  }

  if (expandedTaskId && frozenListOrder && frozenListForTaskId === expandedTaskId) {
    // Keep editing in place: reuse the last order, dropping anything that
    // no longer matches (deleted, done, filtered out), appending anything
    // new at the end in normal sorted order.
    const byId = {};
    rest.forEach((t) => { byId[t.id] = t; });
    const kept = frozenListOrder.map((id) => byId[id]).filter(Boolean);
    const keptIds = new Set(kept.map((t) => t.id));
    const fresh = sortForList(rest.filter((t) => !keptIds.has(t.id)), listFilters.sort, currentListDir_());
    rest = kept.concat(fresh);
  } else {
    rest = sortForList(rest, listFilters.sort, currentListDir_());
  }
  frozenListOrder = rest.map((t) => t.id);
  frozenListForTaskId = expandedTaskId;

  const fill = fiveDucksFill(tasks, today);

  const wrap = el(`
    <section class="tabpanel">
      ${fiveDucksRow(fill)}
      <h2>List</h2>
      <div class="filters">
        <input type="text" id="fSearch" placeholder="Search title or notes..." value="${esc(listFilters.search)}">
        <select id="fSort">${LIST_SORTS.map((s) => `<option value="${s.id}" ${listFilters.sort === s.id ? 'selected' : ''}>Sort: ${s.label}</option>`).join('')}</select>
        <button type="button" id="fDir" class="dir-toggle" title="Click to flip the sort direction">
          ${currentListDir_() === 'asc' ? '&#8593;' : '&#8595;'} ${(SORT_DIR_LABELS[listFilters.sort] || {})[currentListDir_()] || ''}
        </button>
        <select id="fCategory"><option value="">All categories</option>${CATEGORIES.map((c) => `<option value="${c.id}" ${listFilters.category === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        <select id="fSize"><option value="">All sizes</option>${SIZES.map((s) => `<option value="${s.id}" ${listFilters.size === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
        <select id="fDucks">
          <option value="">All ducks</option>
          <option value="unrated" ${listFilters.ducks === 'unrated' ? 'selected' : ''}>Not rated yet</option>
          ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${listFilters.ducks === String(n) ? 'selected' : ''}>${n} duck${n > 1 ? 's' : ''}</option>`).join('')}
        </select>
        <span class="project-filter-group">
          <select id="fProjects" multiple size="4" title="Project (Ctrl/Cmd-click to pick more than one)">
            <option value="none" ${listFilters.projects.includes('none') ? 'selected' : ''}>No project</option>
            ${getProjectList().map((p) => `<option value="${p.id}" ${listFilters.projects.includes(p.id) ? 'selected' : ''}>${esc(p.chip.nickname)}</option>`).join('')}
          </select>
          <button type="button" id="fProjectsClear" title="Clear the project filter">Clear</button>
        </span>
        <label class="hide-blocked-toggle"><input type="checkbox" id="fHideBlocked" ${listFilters.hideBlocked ? 'checked' : ''}> Hide blocked</label>
      </div>
      ${pastDue.length ? `<h3>Past due</h3><div class="cards">${pastDue.map((t) => taskCard(t, today)).join('')}</div>` : ''}
      <h3>${sortHeading_()}</h3>
      <div class="cards">
        ${rest.length ? rest.map((t) => taskCard(t, today)).join('') : '<p class="empty">Nothing matches these filters.</p>'}
      </div>
    </section>
  `);
  const resortAnd_ = (fn) => (e) => { fn(e); frozenListOrder = null; render(); };
  wrap.querySelector('#fSort').addEventListener('change', resortAnd_((e) => { listFilters.sort = e.target.value; }));
  wrap.querySelector('#fDir').addEventListener('click', resortAnd_(() => {
    listFilters.dir[listFilters.sort] = currentListDir_() === 'asc' ? 'desc' : 'asc';
  }));
  wrap.querySelector('#fCategory').addEventListener('change', resortAnd_((e) => { listFilters.category = e.target.value; }));
  wrap.querySelector('#fSize').addEventListener('change', resortAnd_((e) => { listFilters.size = e.target.value; }));
  wrap.querySelector('#fDucks').addEventListener('change', resortAnd_((e) => { listFilters.ducks = e.target.value; }));
  wrap.querySelector('#fProjects').addEventListener('change', resortAnd_((e) => {
    listFilters.projects = Array.from(e.target.selectedOptions).map((o) => o.value);
  }));
  // A native multi-select can only be fully cleared with Ctrl/Cmd-click on
  // every selected option, which isn't discoverable; a plain click on one
  // option just swaps the single selection rather than clearing it. This
  // button is the obvious, reliable way back to "all projects" without
  // reloading the app.
  wrap.querySelector('#fProjectsClear').addEventListener('click', resortAnd_(() => {
    listFilters.projects = [];
  }));
  wrap.querySelector('#fHideBlocked').addEventListener('change', resortAnd_((e) => {
    listFilters.hideBlocked = e.target.checked;
  }));
  // Debounced like the task editor's own text fields: a render on every
  // keystroke would tear down and recreate this input, dropping focus and
  // the cursor position mid-word. Refocus (and restore cursor position)
  // right after the debounced render actually runs, once the new input
  // exists in the real DOM.
  wrap.querySelector('#fSearch').addEventListener('input', (e) => {
    listFilters.search = e.target.value;
    clearTimeout(listSearchDebounceTimer);
    listSearchDebounceTimer = setTimeout(() => {
      frozenListOrder = null;
      render();
      const box = document.getElementById('fSearch');
      if (box) {
        box.focus();
        const pos = box.value.length;
        box.setSelectionRange(pos, pos);
      }
    }, 250);
  });
  return wrap;
}

function renderProjects() {
  if (openProjectId) {
    const project = getTask(openProjectId);
    // Only requiring "project exists and isn't itself someone's step" (not
    // requiring .chip specifically) is deliberate: openProjectId only ever
    // gets set by opening an actual project, so trust that over a .chip
    // field that could in principle go missing for a moment from a sync
    // hiccup. Bouncing back to the project list on that alone is exactly
    // what looked like "the project disappeared" after adding a step.
    if (project && !project.deletedAt && !project.projectId) return renderProjectDetail(project);
    openProjectId = null; // genuinely gone (deleted, or never existed)
  }

  const projects = getProjectList();
  const wrap = el(`
    <section class="tabpanel">
      <h2>Projects</h2>
      <p class="hint">A project holds a set of steps under one bigger body of work, like a real estate deal with everything that has to happen before close.</p>
      ${projects.length ? `
        <div class="cards">
          ${projects.map((p) => {
            const prog = projectProgress(p.id);
            return `
              <div class="card" data-id="${p.id}">
                <div class="card-title">
                  <span class="project-dot" style="background:${esc(p.chip.color)}"></span>
                  ${esc(p.chip.nickname)}: ${esc(p.title)}
                </div>
                <div class="card-meta">
                  <span class="chip">${prog.done}/${prog.total} steps</span>
                  ${p.ducks ? `<span class="chip">${duckIcons(p.ducks, 14)}</span>` : ''}
                  ${p.due ? `<span class="chip due">due ${fmtDue(p.due)}</span>` : ''}
                </div>
                <div class="card-actions">
                  <button data-action="openProject" data-id="${p.id}">Open</button>
                  <button data-action="deleteProject" data-id="${p.id}">Delete project</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      ` : '<p class="empty">No projects yet.</p>'}

      <details class="new-project">
        <summary>+ New project</summary>
        <label>Project title
          <input id="projTitle" placeholder="e.g. Sell Main Street">
        </label>
        <label>Short nickname (shown as a chip everywhere its steps appear)
          <input id="projNickname" placeholder="e.g. Main St" maxlength="16">
        </label>
        <label>Color</label>
        <div class="color-picker" id="projColor">
          ${PROJECT_COLORS.map((c, i) => `<button type="button" data-color="${c}" class="${i === 0 ? 'sel' : ''}" style="background:${c}"></button>`).join('')}
        </div>
        <label>Target/due date (optional)
          <input id="projDue" type="date">
        </label>
        <label>Ducks
          <select id="projDucks">
            <option value="">Not rated</option>
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} duck${n > 1 ? 's' : ''}</option>`).join('')}
          </select>
        </label>
        <label>Category
          <select id="projCategory">
            ${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === 'admin' ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
        </label>
        <button id="projCreate">Create project</button>
      </details>

      <details class="new-project">
        <summary>+ New project from template</summary>
        ${renderTemplatePickerBody_()}
      </details>

      ${renderTemplateManageList_()}

      <details class="new-project" ${templateDraftIsOpen() ? 'open' : ''}>
        <summary>${templateBuilderSummary()}</summary>
        <div id="tplBuilder">${renderTemplateBuilder_()}</div>
      </details>
    </section>
  `);

  wrap.querySelectorAll('#projColor button').forEach((btn) => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('#projColor button').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
    });
  });
  wrap.querySelector('#projCreate').addEventListener('click', () => {
    const title = wrap.querySelector('#projTitle').value.trim();
    const nickname = wrap.querySelector('#projNickname').value.trim();
    const colorBtn = wrap.querySelector('#projColor button.sel');
    if (!title || !nickname) {
      alert('Give the project a title and a short nickname.');
      return;
    }
    const ducksVal = wrap.querySelector('#projDucks').value;
    const p = newTask({
      title,
      size: 'XL',
      due: wrap.querySelector('#projDue').value || null,
      ducks: ducksVal ? Number(ducksVal) : null,
      category: wrap.querySelector('#projCategory').value || 'admin',
      chip: { nickname, color: colorBtn.dataset.color }
    });
    saveTask(p);
    logEvent('created', p.id, { project: true });
    scheduleSync();
    openProject(p.id);
  });

  wireTemplatePicker_(wrap);
  wireTemplateBuilder_(wrap);

  return wrap;
}

function renderProjectDetail(project) {
  const steps = getSteps(project.id);
  const prog = projectProgress(project.id);
  const chip = project.chip || { nickname: '(untitled project)', color: '#999' };
  const wrap = el(`
    <section class="tabpanel">
      <button type="button" id="backToProjects" class="back-link">&larr; All projects</button>
      <h2><span class="project-dot" style="background:${esc(chip.color)}"></span> ${esc(chip.nickname)}: ${esc(project.title)}</h2>
      <p class="hint">${prog.done} of ${prog.total} steps done</p>
      <button type="button" data-action="saveTemplate" data-id="${project.id}" class="back-link">Save as template</button>

      <div class="cards">
        ${steps.length ? steps.map((s) => `
          <div class="card ${s.status === 'done' ? 'step-done' : ''}" data-id="${s.id}">
            <div class="card-title">${esc(s.title)}</div>
            <div class="card-meta">
              ${s.due ? `<span class="chip due">due ${fmtDue(s.due)}</span>` : ''}
              ${s.ducks ? `<span class="chip">${duckIcons(s.ducks, 14)}</span>` : ''}
              ${s.size ? `<span class="chip">${sizeLabel(s.size)}</span>` : ''}
              ${(() => { const b = blockedInfo_(s); return b ? `<span class="chip blocked">waiting on ${esc(b)}</span>` : ''; })()}
            </div>
            <div class="card-actions">
              ${s.status === 'done'
                ? `<button data-action="reopen" data-id="${s.id}">Reopen</button>`
                : `<button data-action="complete" data-id="${s.id}">Done</button>`}
              <button data-action="expand" data-id="${s.id}">Details</button>
              <button data-action="delete" data-id="${s.id}">Delete step</button>
            </div>
            ${expandedTaskId === s.id ? taskEditor(s) : ''}
          </div>
        `).join('') : '<p class="empty">No steps yet, add the first one below.</p>'}
      </div>

      <form id="addStepForm" class="quickadd" style="margin-top:16px">
        <input id="addStepInput" type="text" placeholder="Add a step..." autocomplete="off">
        <div class="quickadd-extra">
          <select id="addStepDucks" title="Ducks (importance)">
            <option value="">Ducks</option>
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${project.ducks === n ? 'selected' : ''}>${n} duck${n > 1 ? 's' : ''}</option>`).join('')}
          </select>
          <select id="addStepSize" title="Duration">
            <option value="">Duration</option>
            ${SIZES.map((s) => `<option value="${s.id}">${sizeLabel(s.id)}</option>`).join('')}
          </select>
          <input id="addStepDue" type="date" title="Due date">
          <select id="addStepCategory" title="Category">
            ${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === (project.category || 'admin') ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
          <button type="submit">Add</button>
        </div>
      </form>
    </section>
  `);

  wrap.querySelector('#backToProjects').addEventListener('click', () => { openProjectId = null; render(); });
  wrap.querySelector('#addStepForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = wrap.querySelector('#addStepInput');
    const title = input.value.trim();
    if (!title) return;
    const order = getSteps(project.id).length;
    const ducksVal = wrap.querySelector('#addStepDucks').value;
    const s = newTask({
      title,
      projectId: project.id,
      order,
      due: wrap.querySelector('#addStepDue').value || null,
      ducks: ducksVal ? Number(ducksVal) : null,
      size: wrap.querySelector('#addStepSize').value || null,
      category: wrap.querySelector('#addStepCategory').value || 'admin'
    });
    saveTask(s);
    logEvent('created', s.id, { step: true, projectId: project.id });
    scheduleSync();
    input.value = '';
    input.focus();
    render();
  });

  return wrap;
}

function addDaysToDateStr(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function dayHeading(dateStr) {
  const today = ducksDayDate();
  if (dateStr === today) return 'Today';
  if (dateStr === addDaysToDateStr(today, -1)) return 'Yesterday';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
}

function renderDone(tasks) {
  // Most recent first, grouped by the day it was completed. Nothing here
  // ever gets purged, this is meant to be a durable record you can scroll
  // back through, not just "today's done list".
  const done = tasks.filter((t) => t.status === 'done')
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

  let rows = '';
  let lastDay = null;
  for (const t of done) {
    const day = ducksDayDate(new Date(t.completedAt));
    if (day !== lastDay) {
      if (lastDay !== null) rows += '<hr class="day-sep">';
      rows += `<h3 class="day-heading">${dayHeading(day)}</h3>`;
      lastDay = day;
    }
    rows += `
      <div class="card" data-id="${t.id}">
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-meta"><span class="chip">${new Date(t.completedAt).toLocaleString()}</span></div>
        <div class="card-actions"><button data-action="reopen" data-id="${t.id}">Reopen</button></div>
      </div>
    `;
  }

  return el(`
    <section class="tabpanel">
      <h2>Done</h2>
      ${done.length ? rows : '<p class="empty">Nothing checked off yet today. It\'ll fill in.</p>'}
    </section>
  `);
}

// The "+ New recurring task" day-selection fields change shape per
// frequency: weekly/biweekly need a day-of-week picker, monthly/quarterly
// need a day number (each frequency's own maxDay, NOT a hardcoded 31: a
// quarter can run up to 92 days, so "day 37 of the quarter" used to be
// rejected by a max="31" that only ever made sense for monthly), annually
// needs both a month picker and a day number. Swapped in via innerHTML
// when the frequency changes.
function renderRecDayFields_(freqId) {
  const f = FREQUENCIES.find((x) => x.id === freqId) || FREQUENCIES[0];
  if (f.kind === 'weekday') {
    return `<label>${f.dayHint}
      <select id="recDay">${WEEKDAY_NAMES.map((name, i) => `<option value="${i}">${name}</option>`).join('')}</select>
    </label>`;
  }
  if (f.kind === 'monthDay') {
    return `<label>Month
      <select id="recMonth">${MONTH_NAMES.map((name, i) => `<option value="${i + 1}">${name}</option>`).join('')}</select>
    </label>
    <label>${f.dayHint}
      <input id="recDay" type="number" min="1" max="${f.maxDay || 31}" value="1">
    </label>`;
  }
  return `<label>${f.dayHint}
    <input id="recDay" type="number" min="1" max="${f.maxDay || 31}" value="1">
  </label>`;
}

function renderSettings(settings) {
  const conn = getConn();
  const local = getLocal();
  const wrap = el(`
    <section class="tabpanel">
      <h2>Connection</h2>
      <label>Apps Script web app URL
        <input id="connUrl" value="${esc(conn.url)}" placeholder="https://script.google.com/macros/s/.../exec">
      </label>
      <label>Your owner key
        <input id="connKey" value="${esc(conn.key)}" placeholder="your long key">
      </label>
      <button id="saveConn">Save connection</button>
      <button id="syncNowBtn" type="button">Sync now</button>
      <p id="syncStatus" class="hint"></p>

      <h2>Ranking</h2>
      <label>Deadline first
        <input id="rankSlider2" type="range" min="0" max="100" value="${settings.rankSlider}">
      Ducks first</label>

      <h2>Sound</h2>
      <label><input type="checkbox" id="muted" ${local.muted ? 'checked' : ''}> Mute the quack</label>

      <h2>Export</h2>
      <button id="exportBtn">Export event log (JSON + CSV)</button>

      <h2>Recurring tasks</h2>
      <p class="hint">Keeps one live instance going. Completing it creates the next one on schedule, computed from the due date, not from when you actually check it off.</p>
      ${(() => {
        const active = getTaskList().filter((t) => t.status === 'active' && t.recurrence);
        return active.length ? `
          <div class="cards">
            ${active.map((t) => `
              <div class="card" data-id="${t.id}">
                <div class="card-title">${esc(t.title)}</div>
                <div class="card-meta">
                  <span class="chip">${recurrenceLabel(t.recurrence)}</span>
                  ${t.due ? `<span class="chip due">next ${fmtDue(t.due)}</span>` : ''}
                  ${t.projectId ? projectChip_(t.projectId) : ''}
                </div>
                <div class="card-actions">
                  <button data-action="expand" data-id="${t.id}">Details</button>
                  <button data-action="stopRecurring" data-id="${t.id}">Stop repeating</button>
                </div>
                ${expandedTaskId === t.id ? taskEditor(t) : ''}
              </div>
            `).join('')}
          </div>
        ` : '<p class="empty">None set up yet.</p>';
      })()}

      <details class="new-recurring">
        <summary>+ New recurring task</summary>
        <label>Title
          <input id="recTitle" placeholder="e.g. Deposit mortgage check">
        </label>
        <label>Frequency
          <select id="recFreq">
            ${FREQUENCIES.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}
          </select>
        </label>
        <div id="recDayFields">${renderRecDayFields_(FREQUENCIES[0].id)}</div>
        <label>Ducks
          <select id="recDucks">
            <option value="">Not rated</option>
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} duck${n > 1 ? 's' : ''}</option>`).join('')}
          </select>
        </label>
        <label>Duration
          <select id="recSize">
            <option value="">Not set</option>
            ${SIZES.map((s) => `<option value="${s.id}">${sizeLabel(s.id)}</option>`).join('')}
          </select>
        </label>
        <label>Category
          <select id="recCategory">
            ${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === 'money' ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
        </label>
        <button id="recCreate">Create recurring task</button>
      </details>

      <h2>Kid links</h2>
      <p class="hint">Paste each kid's key (the value you set as KID_ANGEL / KID_MAX / KID_BRIE in Apps Script) to get their shareable link.</p>
      ${['angel', 'max', 'brie'].map((slug) => `
        <label>${slug[0].toUpperCase() + slug.slice(1)}'s key
          <input data-kidkey="${slug}" value="${esc(local['kid_' + slug] || '')}" placeholder="key for ${slug}">
        </label>
        <div class="kidlink" id="kidlink_${slug}"></div>
      `).join('')}

      <p class="hint build-line">App version ${APP_BUILD}. If this doesn't match what Claude last told you, fully close the app (swipe it away in the app switcher on iPhone, or close the tab on your laptop) and reopen it.</p>
    </section>
  `);

  wrap.querySelector('#saveConn').addEventListener('click', () => {
    saveConn({ url: wrap.querySelector('#connUrl').value.trim(), key: wrap.querySelector('#connKey').value.trim() });
    syncNow();
  });
  // Pulls (and pushes any pending local changes) right now instead of
  // waiting for the next 60-second check-in or a tab switch. onSyncStatus
  // already re-renders on a background sync, but only when its fingerprint
  // check finds something changed; this is a deliberate action, so force a
  // render regardless, otherwise "nothing changed" looks indistinguishable
  // from "didn't actually sync."
  wrap.querySelector('#syncNowBtn').addEventListener('click', async () => {
    flushPendingFieldEdits();
    const result = await syncNow();
    render();
    if (!result.ok) alert('Sync failed: ' + result.error);
  });
  wrap.querySelector('#rankSlider2').addEventListener('change', (e) => {
    saveSettings({ rankSlider: Number(e.target.value) });
    scheduleSync();
  });
  wrap.querySelector('#muted').addEventListener('change', (e) => saveLocal({ muted: e.target.checked }));
  wrap.querySelector('#exportBtn').addEventListener('click', doExport);

  const recFreq = wrap.querySelector('#recFreq');
  recFreq.addEventListener('change', () => {
    wrap.querySelector('#recDayFields').innerHTML = renderRecDayFields_(recFreq.value);
  });
  wrap.querySelector('#recCreate').addEventListener('click', () => {
    const title = wrap.querySelector('#recTitle').value.trim();
    if (!title) {
      alert('Give it a title.');
      return;
    }
    const freqDef = FREQUENCIES.find((f) => f.id === recFreq.value) || FREQUENCIES[0];
    const day = Number(wrap.querySelector('#recDay').value);
    let recurrence;
    if (freqDef.kind === 'weekday') {
      recurrence = { freq: freqDef.id, day }; // 0-6, always valid from the <select>
    } else if (freqDef.kind === 'monthDay') {
      if (!day || day < 1 || day > freqDef.maxDay) { alert(`Give it a day of the month from 1 to ${freqDef.maxDay}.`); return; }
      recurrence = { freq: freqDef.id, month: Number(wrap.querySelector('#recMonth').value), day };
    } else {
      if (!day || day < 1 || day > freqDef.maxDay) { alert(`Give it a day number from 1 to ${freqDef.maxDay}.`); return; }
      recurrence = { freq: freqDef.id, day };
    }
    const due = computeFirstDue(recurrence, ducksDayDate());
    const ducksVal = wrap.querySelector('#recDucks').value;
    const t = newTask({
      title,
      recurrence,
      due,
      ducks: ducksVal ? Number(ducksVal) : null,
      size: wrap.querySelector('#recSize').value || null,
      category: wrap.querySelector('#recCategory').value || 'admin'
    });
    saveTask(t);
    logEvent('created', t.id, { recurring: true });
    scheduleSync();
    // Clear the form so it's obvious the submit actually went through
    // (previously the old title/day sat there looking unchanged, which
    // read as "did that even save?") and so a second recurring task can't
    // be entered by accident with the first one's leftover values.
    wrap.querySelector('#recTitle').value = '';
    recFreq.value = FREQUENCIES[0].id;
    wrap.querySelector('#recDayFields').innerHTML = renderRecDayFields_(FREQUENCIES[0].id);
    wrap.querySelector('#recDucks').value = '';
    wrap.querySelector('#recSize').value = '';
    wrap.querySelector('#recCategory').value = 'money';
    alert(`Added "${title}". First due ${fmtDue(due)}, it'll show on your List tab (not just here).`);
    render();
  });

  for (const slug of ['angel', 'max', 'brie']) {
    const input = wrap.querySelector(`[data-kidkey="${slug}"]`);
    const updateLink = () => {
      const key = input.value.trim();
      saveLocal({ ['kid_' + slug]: key });
      const linkBox = wrap.querySelector(`#kidlink_${slug}`);
      if (key) {
        const link = `${location.origin}${location.pathname.replace(/\/[^/]*$/, '')}/kid/?k=${encodeURIComponent(key)}`;
        linkBox.innerHTML = `<code>${esc(link)}</code>`;
      } else {
        linkBox.innerHTML = '';
      }
    };
    input.addEventListener('input', updateLink);
    updateLink();
  }

  return wrap;
}

async function doExport() {
  try {
    const events = await exportEventLog();
    const json = JSON.stringify(events, null, 2);
    downloadFile('ducks-events.json', json, 'application/json');
    const cols = ['id', 'ts', 'taskId', 'type', 'field', 'from', 'to', 'device'];
    const csv = [cols.join(',')].concat(
      events.map((e) => cols.map((c) => csvCell(e[c])).join(','))
    ).join('\n');
    downloadFile('ducks-events.csv', csv, 'text/csv');
  } catch (err) {
    alert('Export failed: ' + err.message);
  }
}
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// What templates.js borrows from here: the small rendering/formatting
// helpers it needs so template markup looks like everything else, plus
// render() and openProject() so it can refresh the screen or jump to a
// newly-instantiated project. (openProject itself is exported right where
// it's declared, above.)
export { esc, duckIcons, sizeLabel, fmtDue, PROJECT_COLORS, addDaysToDateStr, render };

// ---------- boot ----------

onSyncStatus((status, detail) => {
  const box = document.getElementById('syncStatus');
  if (box) {
    if (status === 'syncing') box.textContent = 'Syncing...';
    else if (status === 'ok') box.textContent = 'Synced.';
    else if (status === 'unconfigured') box.textContent = 'Not connected yet. Fill in the URL and key above.';
    else if (status === 'error') box.textContent = 'Sync error: ' + detail;
  }
  // A background sync (periodic, or on regaining focus) used to update
  // the data with no way for the screen to know it should catch up, so
  // what she was looking at could go stale relative to reality, tapping
  // something on a stale card could silently find nothing to act on (see
  // mutateTask's own check for this). Only re-render when something
  // genuinely changed, and not while she's actively mid-keystroke in a
  // text field, so this never interrupts typing, just keeps a screen
  // that's sitting idle honest.
  if (status === 'ok' && detail && detail.changed && !isTypingAnywhere_()) {
    render();
  }
});

attachGlobalDelegation();
render();
startBackgroundSync();

// If the phone locks or the app gets backgrounded while a note/title edit
// is still sitting in its 600ms debounce window, that timer can be
// suspended by the OS and never fire, which is genuine data loss, not
// just a display lag: the text was never written to local storage at
// all. Flushing on the two events that fire right before that happens
// closes the gap: whatever was last typed is saved to this device before
// it goes to sleep, and a best-effort sync push goes out immediately
// rather than waiting for the normal debounce.
function flushBeforeBackground_() {
  flushPendingFieldEdits();
  syncNow();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushBeforeBackground_();
});
window.addEventListener('pagehide', flushBeforeBackground_);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
