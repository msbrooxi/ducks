// Project templates: a reusable shape for a repeatable multi-step project
// (the realtor's "sell a house" checklist, run again for each new
// listing). Split out of main.js (2026-10-02) because it had grown into
// its own self-contained system: draft-building state, a from-scratch
// builder UI, instantiating a template into a real project, and
// propagating a template edit back onto projects already made from it.
// Everything here either reads/writes tasks and settings through store.js,
// or calls back into main.js for the handful of shared UI helpers
// (esc/duckIcons/sizeLabel/fmtDue/PROJECT_COLORS/addDaysToDateStr) and to
// trigger a re-render. See docs/SPEC.md Rounds 12-18 for the history of
// bugs found in this system (position-based vs. key-based dependencies
// especially) before reading too much into any single line here.

import {
  getTask, saveTask, newTask, touchTask, getSettings, saveSettings,
  getTaskList, getSteps, logEvent, CATEGORIES, SIZES
} from './store.js?v=2026-10-02.16';
import { scheduleSync } from './sync.js?v=2026-10-02.16';
import { esc, duckIcons, sizeLabel, fmtDue, PROJECT_COLORS, addDaysToDateStr, render, openProject } from './main.js?v=2026-10-02.16';

function uuid_() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function getTemplates_() {
  return getSettings().templates || [];
}
function saveTemplates_(templates) {
  saveSettings({ templates });
  scheduleSync();
}

export function createTemplateFromProject(projectId) {
  const project = getTask(projectId);
  if (!project) return;
  const name = prompt('Name this template (e.g. "Sell a house"):', project.chip ? project.chip.nickname : '');
  if (!name) return;
  const steps = getSteps(projectId);
  if (!steps.length) {
    alert('This project has no steps yet, nothing to save as a template.');
    return;
  }
  // Day offsets are relative to the EARLIEST due date among the steps (or
  // 0 for everything if none have dates), so re-applying the template just
  // needs one new start date to shift every step forward from.
  const dated = steps.filter((s) => s.due).map((s) => s.due).sort();
  const base = dated[0] || null;
  const dayOffsetFrom_ = (dueStr) => {
    if (!dueStr || !base) return 0;
    const [y1, m1, d1] = base.split('-').map(Number);
    const [y2, m2, d2] = dueStr.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  };
  // Each step gets a stable key up front so dependencies can reference
  // steps BY KEY rather than by position in the array. Positions shift
  // every time a step is added, removed, or reordered, keys don't.
  const stepKeys = steps.map(() => uuid_());
  const idToKey = {};
  steps.forEach((s, i) => { idToKey[s.id] = stepKeys[i]; });
  const template = {
    id: uuid_(),
    name,
    steps: steps.map((s, i) => ({
      key: stepKeys[i],
      title: s.title,
      dayOffset: dayOffsetFrom_(s.due),
      hasDue: !!s.due,
      ducks: s.ducks,
      size: s.size,
      category: s.category,
      // Map each step's real dependsOn (task ids) to the key of the step
      // it points at within THIS SAME steps array. A dependency pointing
      // outside this project can't mean anything once reinstantiated
      // elsewhere, so it's dropped.
      dependsOnKeys: (s.dependsOn || []).map((id) => idToKey[id]).filter(Boolean)
    }))
  };
  const templates = getTemplates_().concat(template);
  saveTemplates_(templates);
  alert(`Saved "${name}" as a template with ${steps.length} step${steps.length > 1 ? 's' : ''}. Use "+ New project from template" on the Projects tab to reuse it.`);
  render();
}

// ---------- building a template from scratch, no live tasks involved ----------
// Unlike createTemplateFromProject above (which reads an already-existing,
// already-real project), this builds a template entirely in memory first:
// nothing here is saved as a template, and definitely nothing is added to
// the task list or numbered, until "Save template" is clicked. This is the
// right tool when there's no reason to ever create a throwaway real
// project just to turn it into a template.
let templateDraftName = '';
let templateDraftSteps = []; // [{ key, title, dayOffset, ducks, size, category, dependsOnKeys: [] }]
let templateDraftEditingId = null; // set when editing an existing template in place, vs. creating a new one
let templateEditingStepIdx = null; // set when the step sub-form is editing an existing drafted step, vs. adding a new one

// main.js needs to know, when rendering the Projects tab, whether the
// "+ New template" section should start open and what its summary should
// say, without reaching into this module's private mutable state directly.
export function templateDraftIsOpen() {
  return templateDraftSteps.length > 0;
}
export function templateBuilderSummary() {
  return templateDraftEditingId ? '+ Editing template' : '+ New template (define from scratch, nothing added to your list until you use it)';
}

export function editTemplate(id) {
  const template = getTemplates_().find((t) => t.id === id);
  if (!template) return;
  templateDraftEditingId = id;
  templateDraftName = template.name;
  templateEditingStepIdx = null;
  // Deep copy so cancelling an edit never mutates the saved template.
  // `key: s.key || uuid_()` is a defensive backfill: if a step ever ended
  // up without one (an old template, or any other way), every such step
  // would collide on the literal property name "undefined" the moment
  // their keys are used as object keys, making every dependency on ANY of
  // them resolve to whichever one of them happened to be read last. That
  // would look exactly like "every pick shows the same one wrong step,
  // repeated." Giving any key-less step a fresh one here self-heals it the
  // next time the template is opened, regardless of how it happened.
  templateDraftSteps = template.steps.map((s) => Object.assign({}, s, {
    key: s.key || uuid_(),
    dependsOnKeys: (s.dependsOnKeys || []).slice()
  }));
  render();
}

export function deleteTemplate(id) {
  if (!confirm('Delete this template? (Projects already made from it are not affected.)')) return;
  saveTemplates_(getTemplates_().filter((t) => t.id !== id));
  render();
}

// Applies a template's CURRENT step definitions to every project previously
// created from it, matched up by each step's stable `key` (stored as
// templateStepKey on the real task, see instantiateTemplate below). A step
// that matches gets its title/ducks/size/category/due synced to the
// template (due recomputed from the project's own templateStartDate, so an
// in-progress project's own start date is respected even though "today" has
// moved on). A step newly added to the template since that project was made
// gets created fresh. A step removed from the template is deliberately left
// alone: auto-deleting a real task because a template definition shrank is
// more destructive than this feature should be, especially if she's already
// done work on it.
function propagateTemplateEdit_(template) {
  const projects = getTaskList().filter((t) => t.chip && !t.projectId && t.fromTemplateId === template.id);
  if (!projects.length) return;
  let updatedSteps = 0, addedSteps = 0;

  projects.forEach((project) => {
    const steps = getSteps(project.id);
    const keyToRealId = {};
    steps.forEach((s) => { if (s.templateStepKey) keyToRealId[s.templateStepKey] = s.id; });
    const startDate = project.templateStartDate || null;
    let nextOrder = steps.length;

    template.steps.forEach((stepDef) => {
      const due = (stepDef.hasDue && startDate) ? addDaysToDateStr(startDate, stepDef.dayOffset) : null;
      const realId = keyToRealId[stepDef.key];
      if (realId) {
        const existing = getTask(realId);
        if (existing) {
          saveTask(touchTask(existing, {
            title: stepDef.title, ducks: stepDef.ducks, size: stepDef.size, category: stepDef.category, due
          }));
          updatedSteps++;
        }
      } else {
        const s = newTask({
          title: stepDef.title, projectId: project.id, order: nextOrder++,
          due, ducks: stepDef.ducks, size: stepDef.size, category: stepDef.category,
          fromTemplateId: template.id, templateStepKey: stepDef.key
        });
        saveTask(s);
        logEvent('created', s.id, { step: true, projectId: project.id, propagatedFromTemplate: template.id });
        keyToRealId[stepDef.key] = s.id;
        addedSteps++;
      }
    });

    // Second pass once every step (old and newly-added) has a real id.
    template.steps.forEach((stepDef) => {
      if (!stepDef.dependsOnKeys || !stepDef.dependsOnKeys.length) return;
      const realId = keyToRealId[stepDef.key];
      if (!realId) return;
      const dependsOn = stepDef.dependsOnKeys.map((k) => keyToRealId[k]).filter(Boolean);
      if (!dependsOn.length) return;
      saveTask(touchTask(getTask(realId), { dependsOn }));
    });
  });

  scheduleSync();
  alert(`Applied to ${projects.length} existing project${projects.length > 1 ? 's' : ''}: ${updatedSteps} step${updatedSteps === 1 ? '' : 's'} updated, ${addedSteps} new step${addedSteps === 1 ? '' : 's'} added.`);
  render();
}

export function renderTemplateBuilder_() {
  const titleByKey = {};
  templateDraftSteps.forEach((s) => { titleByKey[s.key] = s.title; });
  const editing = templateDraftSteps[templateEditingStepIdx] || null;

  const rows = templateDraftSteps.map((s, i) => `
    <div class="card ${i === templateEditingStepIdx ? 'step-done' : ''}" style="padding:8px 10px">
      <div class="card-title">#${i + 1} ${esc(s.title)}</div>
      <div class="card-meta">
        <span class="chip">day ${s.dayOffset >= 0 ? '+' : ''}${s.dayOffset}</span>
        ${s.ducks ? `<span class="chip">${duckIcons(s.ducks, 14)}</span>` : ''}
        ${s.size ? `<span class="chip">${sizeLabel(s.size)}</span>` : ''}
        ${s.dependsOnKeys.length ? `<span class="chip blocked">after ${s.dependsOnKeys.map((k) => esc(titleByKey[k] || '?')).join(', ')}</span>` : ''}
      </div>
      <div class="card-actions">
        <button type="button" data-action="moveTemplateDraftStep" data-idx="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>Move up</button>
        <button type="button" data-action="moveTemplateDraftStep" data-idx="${i}" data-dir="1" ${i === templateDraftSteps.length - 1 ? 'disabled' : ''}>Move down</button>
        <button type="button" data-action="editTemplateDraftStep" data-idx="${i}">Edit</button>
        <button type="button" data-action="removeTemplateDraftStep" data-idx="${i}" class="danger">Remove</button>
      </div>
    </div>
  `).join('');

  // Any OTHER step is a valid dependency now, not just ones added earlier:
  // dependencies are matched by key, not position, so there's no reason an
  // earlier step can't depend on one added later (exactly the "forgot an
  // earlier pre-req" case). A step can't depend on itself, so it's left out
  // of its own picker.
  const pickableSteps = templateDraftSteps.filter((s, i) => i !== templateEditingStepIdx);
  const selectedDeps = editing ? editing.dependsOnKeys : [];

  return `
    <label>Template name
      <input id="tplDraftName" value="${esc(templateDraftName)}" placeholder="e.g. Sell a house">
    </label>
    <div class="cards">${rows || '<p class="empty">No steps added yet.</p>'}</div>
    <h3 style="margin-top:12px">${editing ? `Editing step #${templateEditingStepIdx + 1}` : 'Add a step'}</h3>
    <label>Step title
      <input id="tplStepTitle" value="${esc(editing ? editing.title : '')}" placeholder="e.g. List on MLS">
    </label>
    <label>Due, as a day offset from the project's future start date (0 = start day; negative means before it, e.g. prep work)
      <input id="tplStepOffset" type="number" value="${editing ? editing.dayOffset : 0}">
    </label>
    <label>Ducks
      <select id="tplStepDucks">
        <option value="">Not rated</option>
        ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${editing && editing.ducks === n ? 'selected' : ''}>${n} duck${n > 1 ? 's' : ''}</option>`).join('')}
      </select>
    </label>
    <label>Duration
      <select id="tplStepSize">
        <option value="">Not set</option>
        ${SIZES.map((s) => `<option value="${s.id}" ${editing && editing.size === s.id ? 'selected' : ''}>${sizeLabel(s.id)}</option>`).join('')}
      </select>
    </label>
    <label>Category
      <select id="tplStepCategory">
        ${CATEGORIES.map((c) => `<option value="${c.id}" ${(editing ? editing.category === c.id : c.id === 'admin') ? 'selected' : ''}>${c.label}</option>`).join('')}
      </select>
    </label>
    ${pickableSteps.length ? `
      <p class="hint" style="margin-bottom:4px">Depends on (must finish first; any other step is pickable, including one added later than this one)</p>
      <div class="dep-checklist">
        ${pickableSteps.map((s) => `
          <label class="dep-check-row">
            <input type="checkbox" class="tplDepCheck" value="${esc(s.key)}" ${selectedDeps.includes(s.key) ? 'checked' : ''}>
            ${esc(s.title)}
          </label>
        `).join('')}
      </div>
    ` : ''}
    <div class="save-row">
      <button type="button" id="tplAddStep">${editing ? 'Update step' : 'Add step to template'}</button>
      ${editing ? '<button type="button" id="tplCancelStepEdit">Cancel step edit</button>' : ''}
    </div>
    <div class="save-row" style="margin-top:12px">
      <button type="button" id="tplSaveTemplate" class="save-btn">Save template</button>
      <button type="button" id="tplCancelTemplate">Cancel</button>
    </div>
  `;
}

export function wireTemplateBuilder_(wrap) {
  const container = wrap.querySelector('#tplBuilder');
  if (!container) return;

  function refresh_() {
    container.innerHTML = renderTemplateBuilder_();
    wireInner_();
  }

  function readStepFromForm_() {
    const title = container.querySelector('#tplStepTitle').value.trim();
    if (!title) { alert('Give the step a title.'); return null; }
    const dependsOnKeys = Array.from(container.querySelectorAll('.tplDepCheck:checked')).map((cb) => cb.value);
    return {
      title,
      dayOffset: Number(container.querySelector('#tplStepOffset').value) || 0,
      ducks: container.querySelector('#tplStepDucks').value ? Number(container.querySelector('#tplStepDucks').value) : null,
      size: container.querySelector('#tplStepSize').value || null,
      category: container.querySelector('#tplStepCategory').value || 'admin',
      dependsOnKeys
    };
  }

  function wireInner_() {
    container.querySelector('#tplAddStep').addEventListener('click', () => {
      templateDraftName = container.querySelector('#tplDraftName').value;
      const fields = readStepFromForm_();
      if (!fields) return;
      if (templateEditingStepIdx != null && templateDraftSteps[templateEditingStepIdx]) {
        // Keep the existing key: anything that already depends on this step
        // by key stays correctly pointed at it.
        const key = templateDraftSteps[templateEditingStepIdx].key;
        templateDraftSteps[templateEditingStepIdx] = Object.assign({ key }, fields);
        templateEditingStepIdx = null;
      } else {
        templateDraftSteps.push(Object.assign({
          // A stable id for this step that survives edits and reordering
          // (unlike its array position). This is what lets dependencies
          // keep pointing at the right step regardless of where it sits in
          // the list, and what lets "apply this edit to projects I already
          // made from this template" match a template step back to the
          // real task it previously produced.
          key: uuid_()
        }, fields));
      }
      refresh_();
    });
    const cancelStepEditBtn = container.querySelector('#tplCancelStepEdit');
    if (cancelStepEditBtn) {
      cancelStepEditBtn.addEventListener('click', () => {
        templateEditingStepIdx = null;
        refresh_();
      });
    }
    container.querySelectorAll('[data-action="editTemplateDraftStep"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        templateEditingStepIdx = Number(btn.dataset.idx);
        refresh_();
      });
    });
    container.querySelectorAll('[data-action="moveTemplateDraftStep"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const dir = Number(btn.dataset.dir);
        const swapWith = idx + dir;
        if (swapWith < 0 || swapWith >= templateDraftSteps.length) return;
        // Dependencies are stored by key, not position, so swapping two
        // array slots needs no remapping at all, unlike the old
        // position-based scheme. This is the whole reason for that switch.
        [templateDraftSteps[idx], templateDraftSteps[swapWith]] = [templateDraftSteps[swapWith], templateDraftSteps[idx]];
        if (templateEditingStepIdx === idx) templateEditingStepIdx = swapWith;
        else if (templateEditingStepIdx === swapWith) templateEditingStepIdx = idx;
        refresh_();
      });
    });
    container.querySelectorAll('[data-action="removeTemplateDraftStep"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const removedKey = templateDraftSteps[idx].key;
        templateDraftSteps.splice(idx, 1);
        // Anything that depended on the removed step just loses that one
        // reference, no index shifting needed since dependencies are
        // keyed, not positional.
        templateDraftSteps.forEach((s) => {
          s.dependsOnKeys = s.dependsOnKeys.filter((k) => k !== removedKey);
        });
        if (templateEditingStepIdx === idx) templateEditingStepIdx = null;
        else if (templateEditingStepIdx != null && templateEditingStepIdx > idx) templateEditingStepIdx -= 1;
        refresh_();
      });
    });
    container.querySelector('#tplSaveTemplate').addEventListener('click', () => {
      const name = container.querySelector('#tplDraftName').value.trim();
      if (!name) { alert('Give the template a name.'); return; }
      if (!templateDraftSteps.length) { alert('Add at least one step first.'); return; }
      const steps = templateDraftSteps.map((s) => Object.assign({ hasDue: true }, s));
      // Editing keeps the same template id (so it's still the same row in
      // the manage list, not a duplicate) but never touches any project
      // already created from it, those are independent real tasks by now.
      const isEditing = templateDraftEditingId && getTemplates_().some((t) => t.id === templateDraftEditingId);
      const template = { id: isEditing ? templateDraftEditingId : uuid_(), name, steps };
      const templates = isEditing
        ? getTemplates_().map((t) => (t.id === template.id ? template : t))
        : getTemplates_().concat(template);
      saveTemplates_(templates);
      templateDraftName = '';
      templateDraftSteps = [];
      templateDraftEditingId = null;
      templateEditingStepIdx = null;
      if (isEditing) {
        const existingProjectCount = getTaskList().filter((t) => t.chip && !t.projectId && t.fromTemplateId === template.id).length;
        if (existingProjectCount > 0 && confirm(
          `Updated "${name}". Apply this change to the ${existingProjectCount} project${existingProjectCount > 1 ? 's' : ''} ` +
          `already made from this template too? Matching steps get updated (title/ducks/size/category/due), new steps get added. ` +
          `A step you removed from the template is left alone either way, nothing gets auto-deleted.\n\n` +
          `OK = update those projects now. Cancel = only new uses of the template from here on.`
        )) {
          propagateTemplateEdit_(template);
        }
      } else {
        alert(`Saved template "${name}" with ${steps.length} step${steps.length > 1 ? 's' : ''}. Nothing was added to your task list, use "+ New project from template" when you're ready to actually start one.`);
      }
      render();
    });
    container.querySelector('#tplCancelTemplate').addEventListener('click', () => {
      templateDraftName = '';
      templateDraftSteps = [];
      templateDraftEditingId = null;
      templateEditingStepIdx = null;
      render();
    });
  }
  wireInner_();
}

export function renderTemplatePickerBody_() {
  const templates = getTemplates_();
  if (!templates.length) {
    return '<p class="hint">No templates yet. Use "+ New template" below to build one from scratch (nothing gets added to your list), or open an existing project with steps and use "Save as template" there.</p>';
  }
  return `
    <label>Template
      <select id="tplPick">
        ${templates.map((t) => `<option value="${t.id}">${esc(t.name)} (${t.steps.length} step${t.steps.length > 1 ? 's' : ''})</option>`).join('')}
      </select>
    </label>
    <label>New project title
      <input id="tplTitle" placeholder="e.g. Sell 123 Oak Ave">
    </label>
    <label>Short nickname
      <input id="tplNickname" placeholder="e.g. Oak Ave" maxlength="16">
    </label>
    <label>Color</label>
    <div class="color-picker" id="tplColor">
      ${PROJECT_COLORS.map((c, i) => `<button type="button" data-color="${c}" class="${i === 0 ? 'sel' : ''}" style="background:${c}"></button>`).join('')}
    </div>
    <label>Start date (step due dates shift to match)
      <input id="tplStart" type="date">
    </label>
    <button id="tplCreate">Create project from template</button>
  `;
}

// Shown directly on the Projects tab, not tucked inside any collapsed
// section: this is specifically where "Edit" lives for a saved template.
// It was easy to miss buried inside "+ New project from template" (a
// section about USING a template, not managing one), which read as "there's
// no way to edit a template" even though Edit already existed there.
export function renderTemplateManageList_() {
  const templates = getTemplates_();
  if (!templates.length) return '';
  return `
    <h3 style="margin-top:18px">Your templates</h3>
    <div class="cards">
      ${templates.map((t) => `
        <div class="card">
          <div class="card-title">${esc(t.name)}</div>
          <div class="card-meta"><span class="chip">${t.steps.length} step${t.steps.length > 1 ? 's' : ''}</span></div>
          <div class="card-actions">
            <button data-action="editTemplate" data-id="${t.id}">Edit</button>
            <button data-action="deleteTemplate" data-id="${t.id}" class="danger">Delete template</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

export function wireTemplatePicker_(wrap) {
  wrap.querySelectorAll('#tplColor button').forEach((btn) => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('#tplColor button').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
    });
  });
  const createBtn = wrap.querySelector('#tplCreate');
  if (!createBtn) return;
  createBtn.addEventListener('click', () => {
    const templateId = wrap.querySelector('#tplPick').value;
    const template = getTemplates_().find((t) => t.id === templateId);
    const title = wrap.querySelector('#tplTitle').value.trim();
    const nickname = wrap.querySelector('#tplNickname').value.trim();
    const colorBtn = wrap.querySelector('#tplColor button.sel');
    const startDate = wrap.querySelector('#tplStart').value;
    if (!template || !title || !nickname) {
      alert('Pick a template and give the new project a title and nickname.');
      return;
    }
    // fromTemplateId + templateStartDate on the project, and fromTemplateId
    // + templateStepKey on each step, are what later let "update projects
    // already made from this template" (see propagateTemplateEdit_) find
    // its way back to these exact tasks and recompute their due dates from
    // the same start date. They're write-once metadata, never edited again
    // after creation, so they're deliberately NOT in CORE_FIELDS/Code.gs's
    // per-field merge list: a field only needs that protection if two
    // devices might race to change it, and nothing ever changes these.
    const project = newTask({
      title, size: 'XL', chip: { nickname, color: colorBtn.dataset.color },
      fromTemplateId: template.id, templateStartDate: startDate || null
    });
    saveTask(project);
    logEvent('created', project.id, { project: true, fromTemplate: template.id });
    // Create every step first so every one has a real id, THEN go back and
    // wire up dependsOn from the template's dependsOnKeys (keyed, not
    // positional, so a step can depend on one added either before or
    // after it in the template). keyToRealId maps each step's key to the
    // real task id it just got.
    const keyToRealId = {};
    template.steps.forEach((stepDef, order) => {
      const due = (stepDef.hasDue && startDate) ? addDaysToDateStr(startDate, stepDef.dayOffset) : null;
      const step = newTask({
        title: stepDef.title,
        projectId: project.id,
        order,
        due,
        ducks: stepDef.ducks,
        size: stepDef.size,
        category: stepDef.category,
        fromTemplateId: template.id,
        templateStepKey: stepDef.key
      });
      saveTask(step);
      logEvent('created', step.id, { step: true, projectId: project.id });
      keyToRealId[stepDef.key] = step.id;
    });
    template.steps.forEach((stepDef) => {
      if (!stepDef.dependsOnKeys || !stepDef.dependsOnKeys.length) return;
      const dependsOn = stepDef.dependsOnKeys.map((k) => keyToRealId[k]).filter(Boolean);
      if (!dependsOn.length) return;
      const step = getTask(keyToRealId[stepDef.key]);
      saveTask(touchTask(step, { dependsOn }));
    });
    scheduleSync();
    openProject(project.id);
  });
}
