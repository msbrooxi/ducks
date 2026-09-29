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
              "errand" | "money"   default "admin" ("meetup" added
              2026-09-29: meetings, lunches, any scheduled get-together)
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
  through `backfillFieldUpdatedAt()` (`store.js`), which stamps a baseline
  fieldUpdatedAt (that task's own `updatedAt`) onto any task missing one,
  marks it dirty, and pushes it back within half a second, upgrading that
  record to per-field merge without waiting for a human to touch it. Deleted
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
