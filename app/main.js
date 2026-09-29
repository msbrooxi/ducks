import {
  getTaskList, getTask, saveTask, newTask, getSettings, saveSettings,
  getLocal, saveLocal, getConn, saveConn, isPastDue, ducksDayDate,
  logEvent, CATEGORIES, SIZES, nowIso, uuid
} from './store.js';
import { scheduleSync, syncNow, onSyncStatus, startBackgroundSync, exportEventLog } from './sync.js';
import { doNextList, minutesFilter, fiveDucksFill, score } from './rank.js';
import { playQuack, playParade } from './quack.js';

let activeTab = 'home';
let expandedTaskId = null;
let minutesQuery = null;
let listFilters = { category: '', size: '', ducks: '' };
let lastFiveDucksWhole = -1;

const app = document.getElementById('app');

// A cute yellow duck, not the mallard the 🦆 emoji renders as on most
// platforms. One small PNG, reused everywhere at different sizes.
function duckIcon(px = 18) {
  return `<img src="./icons/duck-glyph.png" alt="" class="duck-ico" width="${px}" height="${px}">`;
}
function duckIcons(n, px = 16) {
  return duckIcon(px).repeat(n);
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
  return { S: 'Small', M: 'Medium', L: 'Large', XL: 'XL' }[id] || '';
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
  const t = getTask(id);
  if (!t) return;
  const updated = Object.assign({}, t, patch, { updatedAt: nowIso() });
  saveTask(updated);
  if (eventType) logEvent(eventType, id, eventExtra || {});
  scheduleSync();
  render();
}

function addQuickTask(title, { due, size, category } = {}) {
  const trimmed = title.trim();
  if (!trimmed) return;
  const t = newTask({
    title: trimmed,
    due: due || null,
    size: size || null,
    category: category || 'admin'
  });
  saveTask(t);
  logEvent('created', t.id);
  scheduleSync();
  render();
}

function completeTask(id) {
  mutateTask(id, { status: 'done', completedAt: nowIso(), doingSince: null }, 'completed');
  playQuack();
  const settings = getSettings();
  const whole = Math.floor(fiveDucksFill(getTaskList(), settings));
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
  const tasks = getTaskList();
  const settings = getSettings();
  const today = ducksDayDate();

  app.innerHTML = '';
  app.appendChild(renderHeader());

  let body;
  if (activeTab === 'home') body = renderHome(tasks, settings, today);
  else if (activeTab === 'inbox') body = renderInbox(tasks);
  else if (activeTab === 'list') body = renderList(tasks, settings, today);
  else if (activeTab === 'done') body = renderDone(tasks);
  else body = renderSettings(settings);

  app.appendChild(body);
  app.appendChild(renderNav());

  const fill = fiveDucksFill(tasks, settings, today);
  lastFiveDucksWhole = Math.floor(fill);
}

function renderHeader() {
  const header = el(`
    <header class="hdr">
      <div class="brand">${duckIcon(24)} Ducks</div>
      <form id="quickAddForm" class="quickadd">
        <input id="quickAddInput" type="text" placeholder="What needs doing?" autocomplete="off">
        <div class="quickadd-extra">
          <select id="quickAddSize" title="Duration">
            <option value="">Duration</option>
            ${SIZES.map((s) => `<option value="${s.id}">${sizeLabel(s.id)}</option>`).join('')}
          </select>
          <input id="quickAddDue" type="date" title="Due date">
          <select id="quickAddCategory" title="Category">
            ${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === 'admin' ? 'selected' : ''}>${c.label}</option>`).join('')}
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
    addQuickTask(input.value, { due: due.value, size: size.value, category: category.value });
    input.value = '';
    due.value = '';
    size.value = '';
    category.value = 'admin';
    input.focus();
  });
  return header;
}

function renderNav() {
  const tabs = [
    ['home', '🏠 Home'], ['inbox', '📥 Inbox'], ['list', '📋 List'],
    ['done', '✅ Done'], ['settings', '⚙️ Settings']
  ];
  const nav = el(`<nav class="tabs">${tabs.map(([id, label]) => (
    `<button data-tab="${id}" class="${activeTab === id ? 'active' : ''}">${label}</button>`
  )).join('')}</nav>`);
  nav.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => { activeTab = btn.dataset.tab; expandedTaskId = null; render(); });
  });
  return nav;
}

function fiveDucksRow(fill) {
  const pct = Math.min(100, (fill / 5) * 100);
  return `
    <div class="ducks-row" title="${fill.toFixed(2)} of 5 ducks today">
      <div class="ducks-row-base">${duckIcons(5, 32)}</div>
      <div class="ducks-row-fill" style="width:${pct}%">${duckIcons(5, 32)}</div>
    </div>
  `;
}

function renderHome(tasks, settings, today) {
  const fill = fiveDucksFill(tasks, settings, today);
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

  wrap.querySelectorAll('[data-action]').forEach(bindCardActions);

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
  box.querySelectorAll('[data-action]').forEach(bindCardActions);
}

function taskCard(t, today = ducksDayDate()) {
  const overdue = isPastDue(t, today);
  return `
    <div class="card ${overdue ? 'overdue' : ''}" data-id="${t.id}">
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-meta">
        ${t.due ? `<span class="chip due">${overdue ? 'was due' : 'due'} ${fmtDue(t.due)}</span>` : ''}
        ${t.ducks ? `<span class="chip">${duckIcons(t.ducks, 14)}</span>` : '<span class="chip muted">not rated</span>'}
        ${t.size ? `<span class="chip">${sizeLabel(t.size)}</span>` : ''}
        <span class="chip cat">${categoryLabel(t.category)}</span>
        ${t.doingSince ? '<span class="chip doing">doing now</span>' : ''}
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
      <button data-action="delete" data-id="${t.id}" class="danger">Delete this task</button>
    </div>
  `;
}

function bindCardActions(container) {
  const root = container.closest('section') || container;
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
    else if (action === 'restore') restoreTask(id);
    else if (action === 'reopen') reopenTask(id);
    else if (action === 'moveToList') moveToList(id);
    else if (action === 'setDucks') setDucks(id, Number(btn.dataset.n));
    else if (action === 'snooze') {
      const when = btn.dataset.when;
      const to = when === 'tomorrow' ? plusDays(1) : when === '3days' ? plusDays(3) : nextMonday();
      snoozeTask(id, to);
    }
  });
  app.addEventListener('change', (e) => {
    const field = e.target.dataset && e.target.dataset.field;
    if (!field) return;
    const id = e.target.dataset.id;
    let value = e.target.value;
    if (field === 'due' && value === '') value = null;
    mutateTask(id, { [field]: value }, 'edited', { field, to: value });
  });
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

function renderList(tasks, settings, today) {
  const active = tasks.filter((t) => t.status === 'active');
  const pastDue = active.filter((t) => isPastDue(t, today))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  let rest = active.filter((t) => !isPastDue(t, today));

  if (listFilters.category) rest = rest.filter((t) => t.category === listFilters.category);
  if (listFilters.size) rest = rest.filter((t) => t.size === listFilters.size);
  if (listFilters.ducks) {
    if (listFilters.ducks === 'unrated') rest = rest.filter((t) => t.ducks == null);
    else rest = rest.filter((t) => t.ducks === Number(listFilters.ducks));
  }
  rest.sort((a, b) => score(b, settings, today) - score(a, settings, today));

  const wrap = el(`
    <section class="tabpanel">
      <h2>List</h2>
      <div class="filters">
        <select id="fCategory"><option value="">All categories</option>${CATEGORIES.map((c) => `<option value="${c.id}" ${listFilters.category === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        <select id="fSize"><option value="">All sizes</option>${SIZES.map((s) => `<option value="${s.id}" ${listFilters.size === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
        <select id="fDucks">
          <option value="">All ducks</option>
          <option value="unrated" ${listFilters.ducks === 'unrated' ? 'selected' : ''}>Not rated yet</option>
          ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${listFilters.ducks === String(n) ? 'selected' : ''}>${n} duck${n > 1 ? 's' : ''}</option>`).join('')}
        </select>
      </div>
      ${pastDue.length ? `<h3>Past due</h3><div class="cards">${pastDue.map((t) => taskCard(t, today)).join('')}</div>` : ''}
      <h3>Everything else</h3>
      <div class="cards">
        ${rest.length ? rest.map((t) => taskCard(t, today)).join('') : '<p class="empty">Nothing matches these filters.</p>'}
      </div>
    </section>
  `);
  wrap.querySelector('#fCategory').addEventListener('change', (e) => { listFilters.category = e.target.value; render(); });
  wrap.querySelector('#fSize').addEventListener('change', (e) => { listFilters.size = e.target.value; render(); });
  wrap.querySelector('#fDucks').addEventListener('change', (e) => { listFilters.ducks = e.target.value; render(); });
  return wrap;
}

function renderDone(tasks) {
  const done = tasks.filter((t) => t.status === 'done')
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  return el(`
    <section class="tabpanel">
      <h2>Done</h2>
      ${done.length ? done.map((t) => `
        <div class="card" data-id="${t.id}">
          <div class="card-title">${esc(t.title)}</div>
          <div class="card-meta"><span class="chip">${new Date(t.completedAt).toLocaleString()}</span></div>
          <div class="card-actions"><button data-action="reopen" data-id="${t.id}">Reopen</button></div>
        </div>
      `).join('') : '<p class="empty">Nothing checked off yet today. It\'ll fill in.</p>'}
    </section>
  `);
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
      <p id="syncStatus" class="hint"></p>

      <h2>Ranking</h2>
      <label>Deadline first
        <input id="rankSlider2" type="range" min="0" max="100" value="${settings.rankSlider}">
      Ducks first</label>

      <h2>Sound</h2>
      <label><input type="checkbox" id="muted" ${local.muted ? 'checked' : ''}> Mute the quack</label>

      <h2>Export</h2>
      <button id="exportBtn">Export event log (JSON + CSV)</button>

      <h2>Kid links</h2>
      <p class="hint">Paste each kid's key (the value you set as KID_ANGEL / KID_MAX / KID_BRIE in Apps Script) to get their shareable link.</p>
      ${['angel', 'max', 'brie'].map((slug) => `
        <label>${slug[0].toUpperCase() + slug.slice(1)}'s key
          <input data-kidkey="${slug}" value="${esc(local['kid_' + slug] || '')}" placeholder="key for ${slug}">
        </label>
        <div class="kidlink" id="kidlink_${slug}"></div>
      `).join('')}
    </section>
  `);

  wrap.querySelector('#saveConn').addEventListener('click', () => {
    saveConn({ url: wrap.querySelector('#connUrl').value.trim(), key: wrap.querySelector('#connKey').value.trim() });
    syncNow();
  });
  wrap.querySelector('#rankSlider2').addEventListener('change', (e) => {
    saveSettings({ rankSlider: Number(e.target.value) });
    scheduleSync();
  });
  wrap.querySelector('#muted').addEventListener('change', (e) => saveLocal({ muted: e.target.checked }));
  wrap.querySelector('#exportBtn').addEventListener('click', doExport);

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

// ---------- boot ----------

onSyncStatus((status, detail) => {
  const box = document.getElementById('syncStatus');
  if (!box) return;
  if (status === 'syncing') box.textContent = 'Syncing...';
  else if (status === 'ok') box.textContent = 'Synced.';
  else if (status === 'unconfigured') box.textContent = 'Not connected yet. Fill in the URL and key above.';
  else if (status === 'error') box.textContent = 'Sync error: ' + detail;
});

attachGlobalDelegation();
render();
startBackgroundSync();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
