# Ducks: Phase 1 spec (agreed 2026-09-28)

## Decisions from scoping
| Topic | Decision |
|---|---|
| Hosting | GitHub Pages, public repo, no build step |
| Backend + storage | Google Apps Script web app, JSON files in Stephanie's Drive |
| Auth | Owner key per device; kid keys can only add to Inbox |
| Laptop browser | Chrome (install as app) |
| "Start" on past-due | Moves the task into a "Doing now" spot at the top of home. No timer. |
| Stephanie's quick-adds | Go straight to the list with ducks unrated |
| Kid requests | Land in Inbox, tagged with kid's name |
| Kid "needed by" date | Becomes the task's due date (editable) |
| Kid confirmation | Cheesy thank-you ("Quack! Mom got it."). No status updates in Phase 1 |
| Do Next lanes | due-soon = due within 3 days; quick win = Small. Both are settings |
| Snooze "next week" | Next Monday |
| Day boundary | **3:00 AM Eastern** everywhere (five-ducks reset, "today", past-due) |
| Five-ducks surprise | Duck parade animation + double quack (unless muted) |
| Delete | Goes to the "Duck Pond" (restorable) for 30 days, then purged. Event log keeps the record |

## Backlog (not started, don't build without being asked)
Things Stephanie has explicitly flagged for later, intentionally deferred
while the basics get solid. Check this before starting unrelated work in
case something here has quietly become relevant.
- **A more sophisticated recurrence system** (flagged 2026-10-02, after
  fixing the quarterly day-37 bug in Round 20). The current scheme is a
  single day-number per frequency (weekly/biweekly day-of-week, monthly/
  quarterly/annually day-of-month-or-quarter). Not yet scoped: things like
  "the 2nd Tuesday of the month," "last business day," "every N months,"
  or whatever else comes up once more real recurring tasks have been lived
  with. Revisit once asked, not proactively.

## Time rules
- All dates are evaluated in `America/New_York`.
- A "Ducks day" runs 3:00 AM ET to 2:59 AM ET the next calendar day. A task
  due today is not past-due at 12:30 AM; it becomes past-due at 3:00 AM the
  day after its due date.
- Due dates are date-only (`YYYY-MM-DD`). Timestamps are ISO 8601 UTC.

## Data model
Stored in Drive as `ducks-data.json` (tasks + settings) and `ducks-events.json`
(append-only log). Kept separate so the growing log never slows task sync.

### Task
```
id            string   uuid, created on the device
title         string   required
notes         string?  optional
link          string?  optional
ducks         1..5 | null   null = "not rated yet"; ranks as 2 (revised 2026-09-29, was 3)
due           "YYYY-MM-DD" | null
size          "XS" | "S" | "M" | "L" | "XL" | null   null ranks/fills as L,
                                                     excluded from "I have X minutes"
category      "admin" | "conversation" | "meetup" | "deep" | "decision" |
              "errand" | "handson" | "money"   default "admin"
              ("meetup" added 2026-09-29: meetings, lunches, any scheduled
              get-together; "handson" added same day: house/yard/garden
              work, anything manual you actively have to DO)
status        "inbox" | "active" | "done"      (Phase 2 adds "waiting")
doingSince    ISO | null   set by Start; cleared on done/snooze
source        "me" | "angel" | "max" | "brie"
createdAt, updatedAt, completedAt, deletedAt   ISO | null
fieldUpdatedAt  { [field]: ISO }   added 2026-09-29, see Sync protocol below;
                                   one timestamp per mergeable field, used
                                   for per-field conflict resolution, not
                                   shown anywhere in the UI
```
Setting ducks to 0 in the UI offers to delete; 0 is never stored.

**Built ahead of schedule (2026-09-29):** projects/steps and recurring tasks
were originally scoped for Phase 2, but Stephanie asked for both while
working through Phase 1, so they're live now. Waiting-on and process
templates are still genuinely Phase 2/3, not built:
```
projectId     string | null    a step's parent project task's id
order         number | null    a step's position within its project
chip          { nickname, color } | null   set only on a project "head"
              task (projectId null); its presence is what marks a task as
              a project rather than an ordinary to-do
recurrence    { freq: "monthly" | "quarterly", day: 1..31 } | null
              see Recurring tasks below
dependsOn     [id, id, ...]   ids of tasks that must be done first; default []
seq           number | null   permanent #1/#2/#3... reference number,
              assigned by the server on first sync, see below
```
```
waiting       { who, since, followUpBusinessDays } | null   Phase 2, not built
template      { instanceId, stepKey, dependsOn[], anchor, offsetDays,
                critical } | null                    Phase 3, not built
```
A project is itself a Task (usually size XL) with `projectId = null` and a
`chip` set; steps are ordinary tasks with `projectId` pointing at it. A
project head never appears in Do Next, the List tab, or "I have X minutes",
it's a container, not something to do directly (`app/rank.js` and
`renderList` both filter out any task with a `chip`). Its steps show up
everywhere normally, plus a small colored chip (nickname + "3/7" progress)
that jumps to the project's detail view on tap. Deleting a project
(Projects tab) soft-deletes its steps along with it, same 30-day Duck Pond
rule as any other delete. `getProjectList()`, `getSteps(projectId)`, and
`projectProgress(projectId)` in `store.js` are the read helpers; there's no
write helper beyond the normal task save, a step is just a task.

### Recurring tasks
One live instance at a time, no separate "series" record. Completing an
instance spawns the next one, due-date math done in `app/recurrence.js`,
always stepping forward from the *rule*, not from today or from when it
was actually completed, so finishing late or early never drifts the
schedule. Two frequencies, chosen to match what Stephanie actually named
(mortgage deposits, quarterly sales tax):
- `monthly`: a fixed day of every month (`day` clamped to the month's
  actual length, so day 31 in February lands on the 28th/29th).
- `quarterly`: a fixed day counted from each calendar quarter's first day
  as day 1 (quarters are Jan-Mar/Apr-Jun/Jul-Sep/Oct-Dec).
Created from Settings > Recurring tasks. Missed recurring items behave
like any other past-due task (pinned at top, Start/Snooze). "Stop
repeating" clears `recurrence` without touching the task itself.

### Reference numbers and dependencies (added 2026-09-29)
Every task gets a permanent, human-friendly `seq` number (#1, #2, #3...),
shown before its title everywhere. This is purely a reference for people,
`id` (the uuid) is still the real key everything else uses internally,
including `dependsOn` below.

`seq` is deliberately **assigned by the server, not the device**: Code.gs's
`handleSync_` gives the next number (from a `nextSeq` counter stored
alongside the tasks) to any task that doesn't have one yet, on every sync,
including a plain pull. If it were assigned client-side, two devices
creating tasks while offline could hand out the same number; server-side
assignment on first sync rules that out. `seq` is not in `CORE_FIELDS` and
has no `fieldUpdatedAt` entry, it's set once and never edited.

`dependsOn: [id, id, ...]` on a task names other tasks (by `id`, referenced
in the UI by their `#seq`) that must be done first. `isBlocked(task, byId)`
in `app/rank.js` is true when any pre-req exists, isn't deleted, and isn't
done. A blocked task never appears in Do Next or "I have X minutes"
(`rank.js` filters it out of `active` in both), but it still shows in the
List tab with a "waiting on #N ..." chip naming the unmet pre-reqs, rather
than disappearing outright, keeping with the "past data stays visible"
principle elsewhere in this app. Picked from a multi-select in Details
("Depends on"), which lists every other non-project task as `#seq Title`.
No cycle detection beyond what's naturally impossible (a task can't depend
on itself, the picker excludes it), so a longer dependency loop (A needs B
needs C needs A) is possible to create by hand and isn't caught, worth
building real cycle detection before this gets much more use.

### Settings (synced, has its own updatedAt)
```
rankSlider        0..100, default 50   (0 = deadline first, 100 = ducks first)
dueSoonDays       3
quickWinSizes     ["XS"]
sizeMinutes       { XS: 15, S: 30, M: 60, L: 180 }   (revised 2026-09-29; XL is
                                                      open-ended 3+ hr, excluded
                                                      from "I have X minutes"
                                                      same as before)
duckFillWeights   { XS: 0.15, S: 0.3, M: 0.5, L: 0.8, XL: 1 }   (revised 2026-09-29)
dayStartHour      3
muted             false   (per device, not synced)
theme             "auto" | "light" | "dark"   (per device)
```
`quickWinSizes`, `sizeMinutes`, and `duckFillWeights` have no Settings-screen
control yet, only Deadline/Ducks slider and mute do. Until that UI exists,
`store.js`'s `getSettings()` always overrides these three from the code
defaults above regardless of what's stored, so an old saved value (e.g. from
before the 2026-09-29 size revision) can't silently keep applying. Building
real controls for these is still open work, not done.

### Event (append-only)
```
id, ts, taskId, type, field?, from?, to?, device
type: created | edited | ducks | due | size | category | snoozed | started |
      completed | reopened | deleted | restored | purged | kid_submitted
```
Export button produces JSON and CSV of this log. No durations are ever
recorded.

## Sync protocol
- Device keeps a local copy (localStorage) and a queue of changed tasks and
  new events.
- Save: debounced ~2 s after a change, POST `{ key, tasks: [changed], events:
  [new] }` to Apps Script.
- Server takes a lock (LockService) and merges **per field, by each field's
  own `fieldUpdatedAt` timestamp** (revised 2026-09-29; the original design
  merged whole tasks by one `updatedAt`, which meant editing any field on a
  device that hadn't yet pulled a newer edit to a *different* field on that
  same task would silently overwrite it, e.g. rate ducks on the phone, then
  change the category on the laptop before it had pulled, and the laptop's
  stale `ducks` value would win). `touchTask()` in `store.js` stamps
  `fieldUpdatedAt[field]` for exactly the fields a patch touches; a field
  is only overwritten by an incoming edit that is newer for that specific
  field. A task synced before this existed has no `fieldUpdatedAt` yet;
  Code.gs falls back to the old whole-task-by-`updatedAt` merge for that one
  record until its next edit gives it real per-field timestamps. Waiting on
  a real edit left old tasks exposed indefinitely, so this is also
  self-healing (added 2026-09-29): `sync.js`'s pull runs every incoming task
  through `backfillFieldUpdatedAt()` (`store.js`), marks anything it touched
  dirty, and pushes it back within half a second. Revised same day:
  the first cut bailed out entirely if a task had fieldUpdatedAt for even
  one field (e.g. a task rated for ducks during earlier troubleshooting,
  before this function existed), leaving every OTHER field on that same
  task, category included, still unprotected. It now fills in only
  whichever fields are actually missing a timestamp, per field, not
  per task. Deleted
  tasks stay as tombstones with `deletedAt` (itself a merged field now) so
  they can't be resurrected by an older device. Events append deduped by
  id, separately from this merge. Server returns the full current task list
  + settings after merging.
- Pull: on app open, on regaining focus, and every 60 s while visible.
- Target latency phone to laptop: under a minute in normal use.

## Kid pages
- URL: `https://msbrooxi.github.io/ducks/kid/?k=<kidKey>`
- Page asks the server for the kid's first name to greet them, then shows a
  text box and an optional "needed by" date. Nothing else.
- Server creates a task: status inbox, source kid slug, due = needed-by,
  ducks null, then logs `kid_submitted`.
- Kid keys can only create. They cannot read tasks.

## Ranking
- Past-due tasks (oldest due first) always fill Do Next slots first and are
  pinned at the top of the main list.
- Score for everything else:
  `score = (1 - s) * urgency + s * importance`, `s = rankSlider / 100`
  - importance = (ducks ?? 2) / 5
  - urgency = 1.0 due today, decaying toward 0 over ~14 days; 0 if no due date
- Do Next (3 slots) after past-due: one **due-soon** (due within
  dueSoonDays), one **high-duck not urgent** (ducks >= 4, not due-soon), one
  **quick win** (size in quickWinSizes). An empty lane is filled from the
  overall ranking. No task appears twice.
- "I have X minutes": active tasks whose size fits; unsized and XL hidden,
  with a note saying how many unsized were hidden.

## Five ducks row
- Sum duckFillWeights of tasks completed since the day started (3 AM ET),
  unsized counting as L. Shown as 5 ducks filling in (partial fills allowed),
  capped at 5. Surprise fires once per day when it hits 5.
- Reopening a task removes its fill.
- Shown on both Home and List (added 2026-09-29, Stephanie wanted it on
  both, not just Home).
- Two real bugs here, both 2026-09-29: (1) the muted/colored overlay trick
  put the grayscale filter on the shared parent `.ducks-row`, and a CSS
  filter on a parent composites its whole subtree as one layer, so the
  colored fill child's own `filter: none` could never cancel it out, both
  layers rendered equally muted and the fill was invisible. Filter moved
  onto the base layer alone. (2) `.ducks-row` had no explicit width, so as
  a block element it stretched to the full width of its container; the
  fill's `width: NN%` is a percentage of ITS OWN element's width, so that
  percentage was being measured against mostly empty space to the right of
  the actual icons rather than against the icons themselves, a small day's
  progress could compute a real nonzero fill and still show near-zero
  visible color. Fixed with `display: inline-block` so the row shrinks to
  the icons' own width.

## Task editor stability (added 2026-09-30)
Every field change re-renders the whole app (see "The workflow" generally
and `render()` in `main.js`), which tears down and rebuilds every input on
the page. Two real bugs came from that once the List tab got sort options:
- **Data loss**: changing due date (a `<select>`/date input, which saves
  immediately) re-rendered the page, which destroyed any text mid-typed
  into title/notes/link that hadn't been blurred yet, so it was never
  saved. Fixed: those three fields now autosave on every keystroke,
  debounced 600ms, WITHOUT triggering a render (so typing doesn't lose
  focus mid-word). `render()` always flushes any pending one first, so
  whatever triggers the next rebuild can never throw away an
  already-typed, not-yet-debounced keystroke. `scheduleFieldSave()` /
  `flushPendingFieldEdits()` in `main.js`.
- **Bouncing**: since List can now sort by date, changing a task's due
  date while its Details panel was open would immediately re-sort and
  visibly relocate the card mid-edit. Fixed: while a task's editor is
  open, `renderList()` reuses last render's order (`frozenListOrder` /
  `frozenListForTaskId` in `main.js`) instead of re-sorting from scratch,
  so editing holds still. Cleared (forcing a fresh sort) when the editor
  closes, a different task is expanded, or a filter/sort control is
  deliberately changed. Deliberately NOT extended to the Past Due
  section: a task whose date edit actually resolves its overdue status
  moving out of Past Due is correct, not a bug.
Known remaining rough edge: a render still rebuilds the DOM, so changing
one field while another text field is focused clears that field's focus
(the typed text itself is safe, just the cursor), she'd need to click
back into it to keep typing. A real fix would mean not fully rebuilding
the DOM on every change, a bigger change than this warranted tonight.

**Round 2 (still 2026-09-30):** the date field itself had the same class
of bug even on its own, worse than the general case above. A native
`<input type="date">` fires `input`/`change` on every partial keystroke
once all three segments hold *some* value, not just once a complete date
is actually intended, so typing "10" for October read as day/month "01"
(January) the instant the "1" landed, and that intermediate value was
saving and re-rendering immediately. The due-date input now goes through
the same debounced, no-render autosave as title/notes/link
(`isDebouncedField_()` covers `type="date"` too), so partial keystrokes
never commit. A `blur` listener (capturing phase, since blur doesn't
bubble) flushes immediately once she taps or tabs away, so a completed
edit still shows up right away rather than waiting out the debounce.

**Also 2026-09-30, unrelated but discovered the same night:** the
service worker (`sw.js`) was cache-first (check the cache, only hit the
network if nothing was cached). That meant a device that already had
something cached could keep serving it indefinitely, well past what
"close the app and reopen it" should mean, which is exactly what
happened, the app version shown in Settings stayed on an old build
through multiple close/reopen cycles. Switched to network-first: always
try the real current files first when there's a connection, cache is
purely an offline fallback now, never something that can go stale and
quietly keep being served.

**Round 3 (2026-10-01):** the debounced autosave's real remaining gap
(flagged but not yet closed as of round 2): a 600ms debounce timer sitting
in JS can be suspended by the OS when the phone locks or the app
backgrounds, which never fires it, meaning the edit was never written to
local storage at all, not even delayed, lost. Stephanie hit exactly this
with notes/details that "weren't sticking." Fixed: `visibilitychange`
(hidden) and `pagehide` listeners in `main.js` now flush any pending
field edit immediately and fire a best-effort sync, so whatever was last
typed is safe on this device before it goes to sleep, whether or not a
push to Drive completes in time. Also added, since she asked directly
for it as a trust/safety net on top of autosave: an explicit **Save**
button in the task editor, which flushes, syncs, and shows a "Saved!"
confirmation.

Also round 3: a project's detail view (Projects tab) required
`project.chip` to be truthy to stay open, which is less defensive than
it should be; anything making that field transiently unavailable (not
confirmed as an actual cause, but plausible given other sync edge cases
tonight) would silently bounce back to the project list, which is
exactly what "the project disappeared after I added a step" looks like
from the outside. Relaxed to trust `openProjectId` (only ever set by
actually opening a real project) over requiring `.chip` specifically,
and `renderProjectDetail()` now has a safe fallback if `chip` is ever
missing instead of a hard crash.

Also round 3: **assigning an existing task to a project** (Stephanie
flagged this as a real gap, project creation only let her add brand-new
steps, not move something already on her list into a project). Details
now has a "Project" picker for any non-project task, setting
`projectId` + the next `order` within that project directly.

**Open, unresolved as of round 3:** a report of creating four tasks (same
description, different dates) and only the most recent surviving. No
code path was found that would explain this (each quick-add creates its
own uuid; nothing dedupes by title), but it wasn't reproduced either,
only reasoned about. Needs the exported event log to actually diagnose
rather than guess further.

**Round 4 (2026-10-02): the Save button race.** Reported directly: typed
a note, pressed the new Save button, closed and reopened Details, note
gone. Found a real mechanism, a click on Save fires the textarea's
`blur` first (focus moves away before the click completes), and the
blur handler added in round 3 called `render()`, which tears down and
rebuilds the whole screen, including the Save button itself, before the
browser finishes dispatching the click. On a phone this can make the tap
get swallowed entirely, so the explicit-save logic (and its "Saved!"
confirmation) might never run at all, silently. blur now only flushes
(`flushPendingFieldEdits()`), it no longer calls `render()`, so clicking
anything else right after typing can't have its target destroyed
mid-click. The Save button itself was also rebuilt to not depend on the
autosave plumbing at all: it now reads every `[data-field]` element in
the open editor directly and writes that as one patch, then re-reads the
task from storage and compares, showing "Saved!" only if what's stored
actually matches what was on screen, and a visible error asking to retry
or report it if not. This was reasoned through carefully, not confirmed
against her real data (no Drive access), so it should be verified
against an actual repeat of the failure, not assumed fixed.

**Round 5 (2026-10-02): silent mutation failures, and a stale screen.**
Reported: tapping "Done" in List played the quack but the task never
reached Done, and the five-ducks row never moved. Found the mechanism:
`mutateTask()` already silently did nothing if it couldn't find the task
by id (`if (!t) return;`), but `completeTask()` called `playQuack()`
unconditionally right after calling it, regardless of whether it actually
worked. A failed completion sounded identical to a successful one.
`mutateTask()` now returns true/false, logs to the console, and shows a
plain alert ("that didn't save, closing and reopening should fix it")
instead of failing silently; `completeTask()` only plays the sound and
spawns a recurring task's next instance if it actually succeeded.

The more likely reason it couldn't find the task at all: `sync.js`'s
background syncs (every 60s, and on regaining focus) call
`replaceAllTasks()` directly with no way for the visible screen to know
it should refresh, so what she was looking at could be several syncs
stale relative to the real data. `syncNow()` now fingerprints the task
set before and after a pull (`id:updatedAt` pairs, sorted and joined) and
reports whether anything actually changed; `main.js`'s `onSyncStatus`
handler re-renders when it did, skipped only while she's actively
mid-keystroke in a debounced field (checked via `document.activeElement`
+ `isDebouncedField_()`) so this can never interrupt typing. This closes
the general class of "the screen said one thing, the data said another"
that several of tonight's reports share, not confirmed as the exact
mechanism for every one of them, but a real gap regardless.

**Round 6 (2026-10-02): the backend merge bug, and a batch of direct asks.**
Stephanie came back with 14 specific complaints after an overnight test
pass. The most important one, by far:

- **Completed tasks reverting to open/past-due days later.** Found a real
  bug in `apps-script/Code.gs`'s `mergeTask_`: the per-field merge added in
  Round 1 had an escape hatch for any task missing `fieldUpdatedAt`
  entirely on either side (any task older than 2026-09-29, or one that
  hadn't had a touched field since) that fell back to comparing whole-task
  `updatedAt` and replacing the ENTIRE record if the incoming one was
  "newer". That's the original whole-task-overwrite bug, still alive for
  exactly the older tasks most likely to have a completion history worth
  protecting: complete a task on the phone, then make any unrelated edit
  on a laptop that still has a stale pre-completion copy of that same old
  task (it hadn't pulled the completion yet), and the laptop's newer
  `updatedAt` would blow away the phone's completion, status and all, the
  next time it synced. Fixed by adding `ensureFieldUpdatedAt_()`, which
  backfills any missing per-field timestamp from the task's own
  `updatedAt`/`createdAt` (mirroring the client's `backfillFieldUpdatedAt`
  in store.js) before every merge, so the per-field comparison is always
  what actually runs and the whole-record fallback is gone entirely.
  **This requires redeploying Code.gs** (paste the new version into the
  Apps Script editor and redeploy), unlike recent rounds.

Other fixes this round:
- **Quack still sounded wrong** ("awful", "computerized rubber duckie").
  Rewrote `quack.js` from scratch (v3): a buzzy sawtooth source with a fast
  downward pitch glide (the piece that actually reads as a quack rather
  than a tone), split through two parallel bandpass filters tuned to
  duck-like formants (~700Hz, ~2200Hz), a ~135Hz tremolo for the rough
  buzzy texture, and a short noise "chuff" at the onset for the breathy
  attack.
- **Recurring tasks seeming to vanish / one overwriting another.** No bug
  found in the creation path itself (each gets its own uuid, there's no
  code path that overwrites one with another), but the merge bug above is
  a plausible contributor for any pre-existing recurring task, and the
  "+ New recurring task" form didn't reset after creating, which read as
  "did that even save?" Now clears itself and shows a confirmation naming
  the first due date, so a save is never ambiguous.
- **Duck-meter.** `fiveDucksFill()` used to weight each completed task by
  t-shirt size (an XS task barely moved it, an XL task nearly filled it
  alone) rather than count tasks, which didn't match the plain
  expectation of "one duck per completed task" stated directly. Changed to
  a flat count of today's completions, capped at 5. **Judgment call:**
  this is a real design change, not just a bug fix, flagged here in case
  the weighted version was actually wanted once explained.
- **Bottom nav order:** Home, List, Done, Inbox, Projects, Settings
  (was Home, Inbox, List, Projects, Done, Settings).
- **Date field calendar icon invisible in dark mode:** the browser's
  built-in icon on `<input type="date">` has no color property of its own;
  `::-webkit-calendar-picker-indicator { filter: invert(...) }` now
  lightens it in dark mode and keeps it readable in light mode.
- **Project colors:** expanded from 6 to 16 (8 primaries + 8 pastel
  versions of the same hues), with `.color-picker` now wrapping instead of
  overflowing.
- **Project setup now asks for due date, ducks, and category up front**
  (title/nickname/color already did), so a project doesn't have to be
  edited immediately after creating it just to fill in what could have
  been asked at setup.
- **Project templates:** new feature. A project's steps can be saved as a
  reusable template (`createTemplateFromProject`) that records each step's
  title plus a day-offset from the earliest dated step, rather than fixed
  dates. "+ New project from template" on the Projects tab asks for a new
  title/nickname/color/start date and recreates every step with its due
  date shifted to match, for the realtor's "same ten steps, different
  house" case. Templates live in settings (`settings.templates`), synced
  like any other setting, not stored as tasks.
- **Home's "Do next" list: 3 slots to 5.** `doNextList()` took a `count`
  parameter (default 5, was hardcoded 3); no caller needed to change.
- **Past-due date edits not visibly sticking.** The actual save was
  already landing (confirmed by tracing `scheduleFieldSave`), but nothing
  re-rendered the screen once the debounce settled unless something
  unrelated happened to trigger a render afterward, so a card could sit
  showing its old past-due state indefinitely even though the new date
  was already saved, reading as "it reverted." Due-date saves (not
  title/notes/link, which could still be mid-typing elsewhere) now trigger
  a render once their 600ms debounce actually commits.
- **"Start" / "doing now" showing only sometimes, project view
  disappearing after adding a step, the project not showing up in a task's
  project dropdown:** traced through the current code for each and found
  it should already work correctly (the project-view fix from Round 4 is
  in place, the dropdown reads live data, doing-now is unconditional once
  `doingSince` is set). Most likely explanation is the same stale-screen
  class of bug fixed in Round 5, combined with the backend merge bug above
  for anything involving two devices. Noted here rather than guessed at
  further; worth a direct retest on this build before assuming anything
  new is wrong.

**Round 7 (2026-10-02): a crash on the Projects tab, plus follow-ups.**
After redeploying Round 6's Code.gs, the Projects tab came back completely
blank, nav bar and all. Found it immediately: `renderProjects()` referenced
`wrap` inside the template literal still being used to build `wrap` itself,
a `const` temporal-dead-zone `ReferenceError`. That throws synchronously
partway through `render()`, before the nav bar ever gets appended, which is
exactly why the whole screen (not just the Projects content) went blank.
Fixed by not passing `wrap` into `renderTemplatePickerBody_()`, which never
needed it. This was introduced in Round 6 by the templates feature and
never actually worked.

Also this round:
- **Duck meter now keeps extending.** Once the first 5 duck slots are all
  filled for the day, 5 more empty ones appear, and again every time the
  current group fills, so a big day has somewhere to go instead of the
  meter just capping out. `fiveDucksRow()` computes `slots =
  5 * ceil((fill + 1) / 5)` instead of a hardcoded 5.
- **New List sort: "Recently added"**, newest first by default, so what
  was just typed in is a glance away without hunting for it by date or
  ducks.
- **Every List sort now has a direction toggle** (a button next to the
  sort dropdown, flips between e.g. "Soonest first" / "Latest first",
  "Fewest first" / "Most first"). `sortForList()` in rank.js takes a
  `direction` argument now; each mode's comparator is written in its own
  plain ascending sense and `direction` just chooses whether to use it as
  written or reversed. A task with no value for the active sort field
  (no due date, no ducks, no size) always sinks to the bottom regardless
  of direction, there's no meaningful "last" for a blank.
- **Done tab lag, answered rather than changed:** completing a task
  updates local storage and re-renders synchronously, so on the same
  device it should be instant, not laggy. The only real lag is getting a
  change to show up on a DIFFERENT device, which is poll-based (every 60
  seconds while that device's tab is open and visible, or immediately
  if you switch back to the tab/app, which triggers a sync on focus).
  There's no push notification between devices, so a laptop sitting
  untouched in the background won't see a phone's completion until you
  look at it again.

**Round 8 (2026-10-02): more recurring frequencies, cleaner dependency
picker.** GitHub Pages/the CDN in front of it can take a few minutes to
roll out a push even after a hard refresh in a brand-new browser; this
round needed no Code.gs redeploy, just that normal propagation delay.

- **Dependency picker no longer lists already-done tasks.** It never made
  sense to pick a finished task as a pre-req you're still waiting on;
  `isBlocked()` already ignored done dependencies for ranking purposes, the
  picker just hadn't caught up. One filter added in `taskEditor()`.
- **Weekly, Every 2 weeks, and Annually added to recurring tasks**,
  alongside the existing Monthly and Quarterly, listed in that increasing-
  duration order. `recurrence.js`'s `FREQUENCIES` now carries a `kind`
  (`weekday` / `dayOfMonth` / `monthDay`) that tells the Settings form
  which fields to show: weekly/biweekly get a day-of-week picker (Sunday
  through Saturday), annually gets a month picker plus a day-of-month
  number, monthly/quarterly keep the existing single day number. Weekly
  steps the due date forward 7 days at a time from whatever date was just
  completed, biweekly 14; annually keeps the same month/day each year,
  clamping Feb 29 to the 28th in a non-leap year the same way monthly
  already clamps short months. Verified with direct node tests (weekly/
  biweekly stepping, annual rollover, Feb 29 clamping) before shipping.

**Round 9 (2026-10-02): making the CDN delay a non-issue, and a manual
sync button.** Stephanie asked whether there was anything she could trigger
on her end to force past a stale CDN response after a push (there isn't:
it's cached in front of her browser, not in it, so a hard refresh or a
fresh browser can't reach past it). Rather than leave that as a wait-it-
out situation every round, fixed it at the root: `index.html`'s script tag
and every relative `import` across the app modules now carry a
`?v=<build>` query string tied to the current build. A query string makes
it a genuinely different URL, which is a different cache entry at every
layer (browser and CDN alike), so a new release is never capable of
being confused with the stale one still cached under the old URL. This
needs updating in every file's imports each time APP_BUILD changes (a
handful of `sed` replacements), not automatic, noted here so it isn't
forgotten on a future round.

Also added an explicit **Sync now** button in Settings, next to the
connection fields: flushes any pending edit, runs a sync immediately
rather than waiting for the 60-second check-in or a tab switch, and
always re-renders when it's done (the background `onSyncStatus` handler
only re-renders when its fingerprint check finds something actually
changed; a button she just pressed needs to visibly do something either
way, so this bypasses that check).

**Round 10 (2026-10-02): a real Drive-resolution bug, a render-while-typing
bug, and project/intake polish.**

- **"Everything looked wiped, then came back a minute later."** Found a
  real structural weak point in Code.gs: `getFolder_`/`readJsonFile_`/
  `writeJsonFile_` all resolved the "Ducks" folder and the data file BY
  NAME, on every call, via `getFoldersByName`/`getFilesByName().next()`.
  Google doesn't promise that returns the same object on two separate
  calls if more than one match ever existed (easy to end up with by
  accident: re-running setup, a test deployment). Two calls a moment apart
  resolving to two different file objects would look exactly like data
  randomly vanishing and reappearing. Added `pickStable_()`, which sorts
  all matches by file id and always picks the same one, so every call
  resolves identically regardless of how many duplicates exist. Also
  hardened `readJsonFile_` to throw (failing the sync, touching nothing)
  instead of silently returning an empty store on a parse failure: the old
  behavior would make `handleSync_` treat a bad read as "no tasks exist
  yet" and write back a store containing only whatever that one request
  happened to be pushing, discarding everything else. **Needs a Code.gs
  redeploy.**
- **Project steps typed and then lost after adding several in a row.**
  Found the mechanism: the "don't interrupt while typing" check before a
  background-sync re-render (`onSyncStatus` in main.js) only covered the
  task-editor's specific debounced fields (`isDebouncedField_`), not the
  "Add a step..." box in a project or the main quick-add bar. A background
  sync landing while she was mid-typing a step's title she hadn't
  submitted yet would tear down and rebuild the whole screen, wiping out
  that unsent draft. Replaced with `isTypingAnywhere_()`, which protects
  any focused text-like input or textarea on screen, not just the ones
  main.js already knew to treat specially.
- **Duck meter now grows one at a time** instead of jumping by groups of
  5: `fiveDucksRow()` uses `slots = Math.max(5, fill + 1)`, always exactly
  one empty duck ahead of however many are actually done.
- **Project step intake now has due date, ducks, size, and category**,
  matching the main quick-add bar, with ducks pre-selected to the
  project's own ducks rating (editable) and category pre-selected to the
  project's category. Goal is nothing has to be edited after the fact
  unless she wants to change it.
- **Dependency ("waiting on") chip was missing from project step cards.**
  `renderProjectDetail()` has always used its own simplified card markup
  rather than the shared `taskCard()`, and that markup never included the
  blocked-by chip `taskCard()` has had since dependencies shipped. Added.
- **The generic quick-add bar can now assign a new task directly to a
  project** via a new "Project" dropdown, instead of only being able to
  add steps from inside a project's own page.

**Round 11 (2026-10-02): the duck meter's actual bug.** "6 done today still
shows only 5 lit ducks" turned out to be real, not a stale build: Round 10
changed `fiveDucksRow()` to grow one slot at a time past 5, but
`fiveDucksFill()` still had `Math.min(5, count)` left over from before that
change even existed, silently truncating any count above 5 back down to 5
before the row ever saw it. Removed the cap: 5 is the floor the row never
drops below, not a ceiling on what gets counted. Verified directly: 6
completed tasks now produces `fill: 6`, `slots: 7`, 6 lit + 1 grey, matching
what was asked for exactly.

**Round 12 (2026-10-02): templates can now be built from scratch, with
dependencies, and edited later.** Two real gaps, not bugs: the only way to
make a template was to first build a real, live project (real tasks,
really numbered, really on the List tab) and save it after the fact, which
she didn't want for a template that's genuinely hypothetical until used;
and there was no way to express a critical path (steps that must happen in
order) vs. parallel tracks within a template at all.

Added a "+ New template" builder on the Projects tab that exists entirely
in memory (`templateDraftName`/`templateDraftSteps` in main.js) until
"Save template" is clicked: nothing is written anywhere, let alone to the
task list, before that. Each drafted step takes a title, a day offset from
the eventual start date, ducks/size/category, and a "depends on" picker
listing only the steps already added above it in the same draft (so
ordering steps critical-path-first is how you express the dependency
graph, there's no forward-reference). Stored as `dependsOnIdx`, positions
within the template's own steps array, since real task ids don't exist
until the template is actually used.

On instantiation (`wireTemplatePicker_`'s create handler), every step is
created first so each has a real id, then a second pass walks
`dependsOnIdx` and writes real `dependsOn` arrays pointing at the right
new tasks. `createTemplateFromProject` (the original save-an-existing-
project-as-a-template path, kept for whoever already has a real example
project handy) now captures the same `dependsOnIdx` shape from the real
project's existing `dependsOn`, dropping any dependency that points
outside the project (meaningless once reinstantiated elsewhere).

Also added **editing a saved template**: "Edit" next to "Delete template"
in the manage-templates list loads it back into the same builder
(`editTemplate()`), and saving from an edit replaces that template in
place by id rather than creating a duplicate; projects already made from
it before the edit are untouched, they're independent real tasks by then.

**Round 13 (2026-10-02): template edit propagation, and cloning a task.**

**Propagate a template edit to existing projects, or not.** Each template
step now carries a stable `key` (assigned once, never regenerated, even
across edits, via `editTemplate()`'s deep copy), and instantiating a
template (`wireTemplatePicker_`) tags the project with `fromTemplateId` +
`templateStartDate` and each step with `fromTemplateId` + `templateStepKey`.
These are deliberately NOT added to CORE_FIELDS/Code.gs's per-field merge
list: they're write-once at creation and never edited again, so they don't
need that protection, and skipping it avoids a Code.gs redeploy for this
round. Saving an edit to a template she's editing (not creating fresh) now
asks, via `confirm()`, whether to apply the change to every project already
made from it. Yes runs `propagateTemplateEdit_()`: for each such project,
every template step is matched to its real task by `templateStepKey`; a
match gets title/ducks/size/category/due synced to the template (due
recomputed from that PROJECT's own `templateStartDate`, not today, so an
in-progress project's actual start date is respected); a step with no match
(added to the template since) gets created fresh; a step removed from the
template is left alone, never auto-deleted. Dependencies propagate too, in
a second pass once every step (old and newly-added) has a real id. Verified
the whole matching/update/add/dependency-rewire algorithm with a standalone
node simulation before wiring it into the UI.

**Cloning a task.** "Clone this task" in the task editor, next to Delete.
Copies title/notes/link/due/ducks/size/category and its project slot if
it's a step, for the "one task, tweaked per kid" case (three similar tasks,
one per child, instead of writing each from scratch). Deliberately does NOT
carry over status, doingSince, completedAt, dependsOn, or recurrence: a
clone is a new, independent, active task, not a second copy of whatever
state the original was in. Opens the clone's own editor immediately since
the point of cloning is to go tweak it.

**Round 14 (2026-10-02): editing/reordering drafted template steps, and
dependencies on a step added later.** The "forgot an earlier pre-req"
report (added a step partway through drafting, with a negative day offset
to put it before the start, but couldn't go back and mark an earlier step
as depending on it) exposed a real design limitation, not a bug: template
dependencies were stored as `dependsOnIdx`, a position within the steps
array, and the picker only offered steps already added above the one being
edited, specifically to avoid a forward reference a position-based scheme
can't express cleanly.

Fixed at the root by switching template dependencies from position
(`dependsOnIdx`) to a stable per-step `key` (`dependsOnKeys`), both in the
draft builder and in the saved template shape (`createTemplateFromProject`,
`propagateTemplateEdit_`, and the instantiation handler in
`wireTemplatePicker_` all updated to match). A key doesn't shift when steps
are added, removed, or reordered, so a step can depend on any OTHER step in
the draft regardless of which was added first, and the "depends on" picker
now simply excludes the step currently being edited rather than filtering
by position. Verified with a standalone simulation: step A set to depend on
step C, then C moved to the end of the array, dependency still resolved
correctly after instantiation.

This also made two other asks straightforward to add to the same builder:
**editing a drafted step** ("Edit" on its card loads it back into the
add-step form, keeping its same key) and **reordering** ("Move up"/"Move
down", a plain array swap with no index remapping needed now that
dependencies are keyed, not positional).

Note for next session: template drafts live only in memory
(`templateDraftSteps`) until "Save template" is clicked, so an in-progress
draft does not survive a page reload. If a draft was open when this build
shipped, it needs to be re-entered (or finished and saved) rather than
picked back up.

**Round 15 (2026-10-02): template "Edit" was findable only by accident.**
The Edit button for a saved template already existed (since Round 12), but
it lived inside "+ New project from template," a section about USING a
template, under a "Manage templates" sub-heading that only showed once
that section was expanded. Reported as "the projects screen only has 'New
Template', not 'edit template'," i.e. not found at all. Pulled the
template list (with Edit/Delete) out into its own always-visible
`renderTemplateManageList_()`, shown directly on the Projects tab between
"+ New project from template" and "+ New template," no expanding
anything required to find it.

**Round 16 (2026-10-02): dependency picks in the template builder silently
reverting.** Reported: picking different pre-reqs for a step shows the
right titles in the dropdown, but whatever actually gets saved always
turned out to be the same one wrong step, repeated if more than one was
picked. Traced it to a real gap: the "don't let a background sync's
re-render interrupt what she's doing" check (`isTypingAnywhere_()`, used
by `onSyncStatus` before deciding whether to re-render) covered text
inputs and textareas but not `<select>` elements. Clicking an option in a
`<select multiple>` IS the interaction, with no separate "commit" step
until the surrounding form's button is clicked, so a background sync
landing in that window would silently revert the dropdown back to
whatever was last saved, and clicking "Update step" right after would
submit that reverted (old) value without any visible sign it had happened.
Fixed by having `isTypingAnywhere_()` also treat any focused `<select>` as
an in-progress interaction. Not confirmed against a live repro (can't
click her browser), but it's a real, previously-missed gap that fits every
part of what was reported: correct dropdown, wrong and sometimes-repeated
saved result.

**Round 17 (2026-10-02): the dependency bug persisted after Round 16, on
laptop (not a touch/mobile issue).** Confirmed on the specific example
"Enter listing into SkySlope" repeating N times for N picks, any pick,
every time. Two changes, since the exact root cause couldn't be directly
observed (no access to her browser):
1. Replaced the "Depends on" `<select multiple>` with a checkbox per
   pickable step (`.tplDepCheck`). A native multi-select's "value" and
   "selected" semantics are easy to get subtly wrong across browsers, and
   a checkbox list removes all ambiguity: each one's checked state is
   directly what gets read (`readStepFromForm_()` now reads
   `.tplDepCheck:checked` instead of `selectedOptions`). `isTypingAnywhere_()`
   extended to cover checkbox inputs for the same reason `<select>` needed
   it in Round 16: checking several boxes before clicking "Update step" is
   still an in-progress, not-yet-submitted interaction.
2. Added a defensive backfill in `editTemplate()`: any step missing its
   `key` now gets a fresh one the moment the template is opened for
   editing (`key: s.key || uuid_()`). The theory this covers: if two or
   more steps ever ended up with `key: undefined` (from any source, old or
   new), every one of them would collide on the literal object property
   name "undefined" the moment their keys are used to build `titleByKey`
   or `keyToRealId`, making every dependency pointing at ANY of them
   resolve to whichever one was read last in the loop, i.e., exactly "the
   same wrong step, repeated." Backfilling a real key the moment the
   template is next opened self-heals this regardless of how it happened,
   and the checkbox rewrite makes a NEW instance of the same failure mode
   much harder to introduce going forward.

**Round 18 (2026-10-02): the actual bug, finally confirmed working, but the
new checkbox UI rendered badly.** A screenshot showed the dependency fix
working (checkboxes toggling correctly), but tiny text, tiny checkboxes,
and huge gaps between rows, the checkbox stranded at the far right edge of
a full-width row instead of sitting next to its label. Root cause: `index.html`'s
`<link rel="stylesheet">` for `app/styles.css` had NO cache-busting `?v=`
query string, unlike every script tag and JS import (added back in Round 9),
meaning the CSS itself could still be served stale from GitHub Pages'
CDN even though the JS carrying the new checkbox markup was fresh. An old
cached stylesheet with no `.dep-checklist`/`.dep-check-row` rules at all
would leave those elements styled only by the generic `details.new-project
label` rule (full width, column-flex-ish spacing), which matches exactly
what the screenshot showed. Fixed the stylesheet link the same way the
scripts already were. Also hardened the checkbox row CSS itself: scoped to
`.dep-checklist .dep-check-row` specifically (not relying on overriding
only `flex-direction` against a more generic rule), with explicit sizing
(18px checkboxes, tighter row padding, no stray margins) so this can't
drift the same way again even under a future caching hiccup.

**Round 19 (2026-10-02): refactor pass.** Requested directly: make the
codebase more efficient, elegant, and build-upon-able. Scope was
deliberately conservative given this is a production app with no way for
Stephanie to debug it herself: real cleanups with a clean, low-risk
boundary, not a speculative rewrite, and everything verified by actually
running the app in a browser afterward rather than just reading the diff.

- **Extracted `app/templates.js`** from `main.js`: the entire project-
  template system (draft-building state, the from-scratch builder UI,
  instantiating a template into a real project, propagating a template edit
  back onto projects already made from it). This was the single largest,
  most self-contained chunk in `main.js` (~500 of its then-1900 lines) and
  the whole source of Rounds 12-18's dependency bugs, so it earns being
  somewhere a future session can find and reason about on its own rather
  than scrolling through everything else to get to it. `main.js` exports
  the handful of shared helpers templates.js needs back
  (`esc`/`duckIcons`/`sizeLabel`/`fmtDue`/`PROJECT_COLORS`/
  `addDaysToDateStr`/`render`/`openProject`); templates.js exports its
  public surface (`createTemplateFromProject`, `editTemplate`,
  `deleteTemplate`, the three render/wire function pairs, and two small
  getters, `templateDraftIsOpen()`/`templateBuilderSummary()`, so main.js
  can decide how to render the "+ New template" section without reaching
  into templates.js's private mutable state directly). This is a circular
  import (each module imports from the other), which native ES modules
  handle fine as long as neither side touches the other's bindings at the
  top level, only from inside functions that run later, which is the case
  here. `main.js` is down to ~1400 lines.
- **Extracted a shared `openProject(id)`** in main.js (switch to Projects
  tab with a specific project open), replacing three separate copies of the
  same three-line sequence (the click dispatcher's "openProject" action,
  the "+ New project" create handler, and templates.js's template-
  instantiation handler all needed it).
- **Removed a genuine dead function**, `bindCardActions`: it computed a
  local variable and did nothing else, called via `.forEach(bindCardActions)`
  in two places purely as an artifact of an earlier design. All card button
  clicks have gone through the single delegated listener on `#app`
  (`attachGlobalDelegation`) for a long time; this never did anything.
- **Code.gs**: `handleKidSubmit_` had its own locally-duplicated copy of
  the `CORE_FIELDS` list (kept manually in sync with the module-level one
  by a comment, not the compiler). Now just reads the module-level
  `CORE_FIELDS`.
- **Verified with Playwright**, not just read: spun up a local static
  server, drove real Chromium through quick-add, duck rating, cloning,
  completing a task, the Done tab, creating a project and adding steps,
  building a template from scratch with a step depending on one added
  later, editing an existing step, reordering steps (including moving the
  depended-on step to a different position), removing a step, saving and
  instantiating the template, and the recurring-task form's weekly/
  annually field swapping. Zero console or page errors across both runs,
  and the dependency chip resolved correctly in every case, confirming the
  module split didn't regress the exact bug class Rounds 16-18 fixed.
- No Code.gs behavior changed beyond the CORE_FIELDS dedup (still needs a
  redeploy for that one line, though it has no user-visible effect; safe to
  batch into whenever the next real Code.gs change happens rather than
  redeploying just for this).

**Round 20 (2026-10-02): quarterly recurrence capped at day 31.** Entering
"day 37 of the quarter" (e.g. a tax filing deadline) was rejected by the day
input's `max="31"`, hardcoded once for the "dayOfMonth" `kind` and reused
unchanged for quarterly, which can legitimately run up to 92 days. The
underlying date math (`quarterlyOccurrence_` in recurrence.js) already
handled day 37 correctly, it was purely a UI validation ceiling. Fixed by
giving each `FREQUENCIES` entry its own `maxDay` (31 for monthly/annually,
92 for quarterly) and using it for both the `<input max>` and the
create-handler's validation instead of a shared hardcoded 31. Also noticed
and fixed a related latent bug while in there: `quarterlyOccurrence_` had no
clamping at all (unlike `monthlyOccurrence_`, which clamps day 31 down to
the 28th/29th/30th in a short month), so a day past a given quarter's
actual length (Q1 is only 90 or 91 days) would have silently overflowed
into the next quarter with no warning. Added `daysInQuarter_` and clamping
to match. Verified with direct date-math tests (day 37 lands correctly in
both Q1 and the next quarter it rolls to) and a live Playwright run
confirming the UI now accepts and saves day 37 for a quarterly task.

Noted for later: Stephanie flagged that recurrence needs a more
sophisticated way to specify itself eventually (this round just widens the
existing day-number scheme to the range it should always have allowed, it
doesn't add new recurrence shapes).

**Round 21 (2026-10-02): a project filter on the List tab.** Added
`listFilters.projects` (an array) alongside the existing category/size/
ducks filters, with a new `#fProjects` multi-select next to them listing
every project's nickname plus a `'none'` sentinel option labeled "No
project" (no real project id can ever collide with that literal string).
Picking one or more projects shows tasks belonging to ANY of them;
including "No project" in the selection adds tasks with no `projectId` to
that same OR, so "Alpha project or unassigned" is one selection, not an
impossible intersection. Applied the same way the existing filters are:
only to the non-past-due section of the list, past-due items stay visible
regardless of any filter, matching the established "never hide something
that's overdue" behavior. Verified with Playwright: filtering to a project
alone, to "No project" alone, and to both together all produced the
correct task set.

**Round 22 (2026-10-02): a real quack sample, finally.** Three rounds of
synthesizing the quack from raw oscillators and filtered noise never landed
("awful," "a computerized rubber duckie") because there was never a way to
actually listen to the result, only reason about it acoustically and tune
from her verbal description, a genuinely lossy feedback loop. Stephanie
supplied a real recording instead: `442820__qubodup__duck-quack.wav`, a
CC-BY 3.0 remix (by Freesound user qubodup) of `20130403_duck.04.wav`
(by Freesound user dobroide, also CC-BY 3.0). The source file actually
contained three distinct quacks back to back (confirmed by plotting the
amplitude envelope in 20ms windows: clear quack/silence/quack/silence/quack
pattern at roughly 0-0.38s, 0.42-0.78s, 0.88-1.08s); per "let's use the
first part of this," trimmed to just 0-0.40s (`audio/quack.wav`, the first
quack plus its natural decay into near-silence, no artificial fade needed).

`app/quack.js` now fetches and decodes that file once (kicked off at module
load so it's ready before the first tap, not fetched on demand) and plays
it via an `AudioBufferSourceNode` instead of synthesizing anything.
`playParade()` plays the same sample three times with slightly different
`playbackRate` values (close enough to a pitch-varied chorus from one
source) followed by the same tonal flourish as before, that part was never
what anyone complained about. Verified in a real browser: the fetch
succeeds, `decodeAudioData` succeeds, both `playQuack()` and `playParade()`
resolve without throwing, and completing a task through the actual UI
triggers it cleanly.

**CC-BY 3.0 requires attribution**, unlike the synthesized version's "no
licensing question" (see v3's now-outdated comment in quack.js, corrected).
Added a Credits section to `README.md` with both sounds' authors and
Freesound links. `audio/quack.wav` added to `sw.js`'s offline precache list
alongside everything else.

**Round 23 (2026-10-03): the real quack produced no sound at all.** Round
22's Playwright tests checked that `fetch`/`decodeAudioData`/`playQuack()`/
`playParade()` all resolved without throwing, and reported clean, but
"resolves without an error" and "is actually audible" are different claims,
and the gap between them is a well-known Web Audio trap: eagerly fetching
and decoding the clip at module load (so it's ready before the first tap)
also eagerly created the `AudioContext` at that same moment, before any
click ever happened. Browsers start an `AudioContext` created outside a
user gesture in `"suspended"` state and never un-suspend it on their own; a
buffer source scheduled on a suspended context runs through its whole
fetch/decode/schedule pipeline without ever throwing, it simply never
produces sound. Confirmed directly this time (not just "no errors"): a
Playwright test that wraps `window.AudioContext` to capture every instance
created and inspects `.state` showed `"suspended"` right after page load,
every time.

Fixed two ways, since iOS Safari (one of her actual devices) is stricter
about this than desktop Chrome:
1. `playQuack()`/`playParade()` now call `ctx.resume()` first if the
   context is suspended, before scheduling anything.
2. A one-time `pointerdown`/`keydown` listener on `document` (added at
   module load, removed after it fires once) resumes the context
   synchronously inside that trusted event's own call stack, the moment she
   taps or clicks ANYWHERE in the app for the first time, not only when a
   quack specifically needs to play. This is the more broadly-compatible
   pattern across browsers; a resume() called from deep inside an awaited
   promise chain a few microtasks after the triggering click works in
   desktop Chrome but is the kind of thing iOS Safari has historically been
   pickier about.

Verified with the state-capturing Playwright test: `suspended` right after
load, `running` after the first click anywhere (before ever touching
"Done"), still `running` after actually completing a task.

### Round 24: the real silent-quack cause (fixed 2026-10-03)

Round 23's fix was real but incomplete: the suspended-context bug existed
and the fix for it was correct, but Stephanie still heard nothing after it
shipped. DevTools Network tab on her actual laptop showed the real cause:
`audio/quack.wav` was 404ing at `https://msbrooxi.github.io/audio/quack.wav`,
missing the `/ducks/` project-page path segment entirely.

Root cause: `fetch('../audio/quack.wav')` resolves a bare relative string
against the **page's** URL, not the file it's written in, unlike `import`
statements (which do resolve against the importing module's own URL).
Ducks lives one path segment deeper than the domain root on GitHub Pages
(`.../ducks/`), so that mismatch overshot by one directory and landed the
request at the domain root instead of `.../ducks/audio/`. Every local
Playwright test up to this point passed cleanly, including one specifically
written to catch audio bugs (Round 23's `AudioContext.state` inspection),
because the local test server had no such subpath nesting: serving the
repo straight from its root meant the wrong math happened to produce the
right answer there by pure coincidence.

Fixed by resolving explicitly against the module's own URL instead of
relying on fetch()'s default relative-to-page behavior:
`new URL('../audio/quack.wav', import.meta.url)`. This is spec-guaranteed
to use the importing module's URL as the base regardless of how deep the
app is nested under the page's own path, so it isn't sensitive to
deployment layout the way a bare relative string passed to `fetch()` is.

**Lesson for future local testing**: any test that serves the app from a
flat local root will never catch a page-relative-vs-module-relative path
bug, since GitHub Pages project sites always add one extra path segment
(`/<repo-name>/`) that a flat local server doesn't have. Round 24's
verification used a symlinked directory one level up
(`pages-sim/ducks -> /home/user/ducks`, served from `pages-sim/`) so the
local server actually reproduces that extra nesting. Reuse that pattern
for any future test touching a relative `fetch()`, `new Worker()`, or
`new URL()` call, since those (unlike `import`) don't automatically
resolve against the calling module.

### Round 25: sync-pull race condition (fixed 2026-10-04)

Stephanie reported completing a task (heard the quack, saw it vanish from
the list) only to find it still active later, missing from Done. Root
cause: `sync.js`'s pull response was a blind full overwrite
(`replaceAllTasks(incomingTasks)`) of local storage. A sync round trip takes
real time (the fetch, server-side processing); any local edit made in that
window, such as completing a task a moment after an unrelated sync kicked
off (any edit schedules one 2s later, plus the 60s background poll, plus
one on every focus/visibility change, so an in-flight request at any given
moment isn't rare), was invisible to that request's response, since the
response reflects server state from before the edit happened. The blind
overwrite then silently reverted it. The same hole could also delete a
brand new task created mid-flight outright, since the server wouldn't know
to echo back a task it had never heard of.

Fixed with a client-side mirror of the per-field merge Code.gs already does
for two different *devices* (see Sync protocol above): `mergeIncoming_()` in
sync.js merges each incoming task against whatever is in local storage at
the moment the response actually lands (not the stale pre-request
snapshot), field by field, keeping whichever side has the newer
`fieldUpdatedAt`. Tasks created locally mid-flight (absent from the
response entirely) are kept rather than dropped. The dirty flag is also now
only cleared for a task whose `updatedAt` still matches what it was when
the request went out; one touched again mid-flight stays dirty so the next
sync actually pushes the change, instead of the flag being cleared by
coincidence (same id, stale snapshot) while the real edit silently never
reaches the server. This likely also explains why "Start" seemed to not
persist: `doingSince` is itself a CORE_FIELDS value subject to the exact
same race.

Verified directly (not through the UI, which needs a live Apps Script
backend to exercise a real round trip): a Node script
(`sync-race-test.mjs`, not checked in) fakes `fetch` to hang until released,
starts a sync, completes a task and creates a new one while it's "in
flight," then lets the fake server respond with its pre-race snapshot.
Confirms the completion and the new task both survive, and that the
completed task correctly stays marked dirty afterward (so a follow-up sync
still pushes it, rather than the local view quietly being right forever
while the server never finds out).

### Round 25: List tab additions and recurring task editing (2026-10-04)

- **Search**: `#fSearch` filters the List tab's non-past-due section by a
  case-insensitive substring match on title or notes, same scope as the
  existing category/size/ducks/project filters (past-due items are never
  hidden by any filter). Debounced (250ms) like the task editor's own text
  fields, since a render on every keystroke would tear down and recreate
  the input mid-word; refocuses the box and restores cursor position after
  the debounced render actually runs.
- **Project filter can't be cleared**: a native multi-select only clears
  with Ctrl/Cmd-click on every selected option, which isn't discoverable,
  and a plain click just swaps the single selection rather than clearing
  it. Added an explicit Clear button next to `#fProjects`.
- **Hide blocked**: `#fHideBlocked` checkbox filters out any task where
  `isBlocked()` (rank.js, already used for the "waiting on" chip) is true,
  same non-past-due scope as the other filters.
- **Recurring task editing**: a recurring task is a regular task under the
  hood (just one with a `recurrence` field), so its "Details" editor
  already has every field a normal task does, Project assignment included,
  it just wasn't reachable: Settings' "Recurring tasks" card only offered
  "Stop repeating," no way to open Details. Added a Details button there
  (same `expandedTaskId`/`taskEditor()` machinery as everywhere else).
  Fixed a trap this would otherwise spring: `completeTask()`'s respawn of
  the next occurrence didn't carry `projectId`/`order` forward, so
  assigning a recurring task to a project would have silently stopped
  applying the very next time it completed and respawned. Fixed to carry
  both forward, matching how `addQuickTask`/`cloneTask` already compute a
  step's `order` when adding into a project.

## Build order
0. **Test first:** throwaway Apps Script + Pages page. Stephanie tests from
   iPhone and a Samsung: write, read, kid submit. Stop and rethink if it fails.
1. Data model, local store, sync + merge, event log, export.
2. Quick add, main list, Inbox, filters (category, size, ducks), task editor.
3. Past-due pinning, Start / Snooze, Do Next with slider, "I have X minutes".
4. Check-off, quack + mute, Done list, five-ducks row + surprise, Duck Pond.
5. Kid pages + kid key setup.
6. Duck theme, gentle dark mode, icons, manifest, service worker, install
   steps for iPhone and Chrome.
7. `docs/setup.md`: numbered Windows/iPhone steps for everything she does.

## Phase 1 acceptance test
Capture a task by typing on the iPhone; a kid submits from a Samsung and it
appears tagged in the Inbox; rate and sort it; see it in the top three;
check it off with a quack; see the same state on the laptop within a couple
of minutes.
