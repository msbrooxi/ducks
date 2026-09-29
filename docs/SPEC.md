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
ducks         1..5 | null   null = "not rated yet"; ranks as 3
due           "YYYY-MM-DD" | null
size          "XS" | "S" | "M" | "L" | "XL" | null   null ranks/fills as L,
                                                     excluded from "I have X minutes"
category      "admin" | "conversation" | "deep" | "decision" | "errand" | "money"
              default "admin"
status        "inbox" | "active" | "done"      (Phase 2 adds "waiting")
doingSince    ISO | null   set by Start; cleared on done/snooze
source        "me" | "angel" | "max" | "brie"
createdAt, updatedAt, completedAt, deletedAt   ISO | null
```
Setting ducks to 0 in the UI offers to delete; 0 is never stored.

**Reserved for later phases (present in the schema, unused in Phase 1):**
```
projectId     string | null    Phase 2: step belongs to project task
order         number | null    Phase 2: step order within project
waiting       { who, since, followUpBusinessDays } | null   Phase 2
recurrence    { rule, anchorDay } | null                   Phase 2
template      { instanceId, stepKey, dependsOn[], anchor, offsetDays,
                critical } | null                          Phase 3
```
A project is itself a Task (usually size XL) with `projectId = null`; steps
point at it. Project nickname and color live on the project task as
`chip: { nickname, color }`.

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
- Server takes a lock (LockService), merges **per task by `updatedAt`**
  (newer wins; deleted tasks stay as tombstones with `deletedAt` so they
  cannot be resurrected by an older device), appends events deduped by id,
  writes, and returns the full current task list + settings.
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
  - importance = (ducks ?? 3) / 5
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
