# Ducks

Stephanie's personal prioritization and to-do app ("ducks in a row").
The agreed Phase 1 spec and data model live in `docs/SPEC.md`. Read it before
building anything.

## How to work with Stephanie
- Plain talk. No flattery, no buzzwords. Push back when something is wrong, kindly.
- Agree on scope before building each phase. Clarifying questions one at a time.
- She is not a developer but follows step-by-step instructions well. Any setup
  she must do herself (Google, GitHub, phone) gets numbered steps, assuming
  Windows + Chrome on the laptop and an iPhone 16 Pro.
- Verify anything that could be outdated (free-tier limits, iOS behavior,
  Google quotas) before relying on it.
- Everything must be free. No paid tiers, no paid accounts.
- Never ask to connect financial accounts or QuickBooks.
- **Never use em-dashes**, in code comments, UI copy, docs, or chat.
- Security is intentionally light (secret keys, no login), but none of her
  data or keys may ever be committed to this public repo.

## App tone rules
- No red overdue counters, no streaks, no failure or guilt language.
- Past-due items stay at the top because that keeps her organized, not
  because she failed.
- Playful and cheesy: ducks, quacks, puns welcome.
- No timers or time tracking, ever. No AI inside the app.

## Architecture (agreed 2026-09-28)
- Static PWA on **GitHub Pages** (public repo). Plain HTML/CSS/JS ES modules,
  **no build step**, nothing to install on Windows.
- Backend: one **Google Apps Script** web app (execute as Stephanie, access:
  Anyone) that reads/writes JSON files in her Google Drive. Source lives in
  `apps-script/Code.gs`; she pastes it into the Apps Script editor.
- Auth: a long random owner key stored once per device (localStorage); kid
  keys that can only add to the Inbox. Keys live in Apps Script Script
  Properties, never in this repo.
- Requests to Apps Script use `Content-Type: text/plain` to avoid CORS
  preflight.

## Model choice
Sonnet for building from the spec. Opus only for hard design calls (data
model changes, Phase 3 template engine, Phase 4 notification tradeoffs).
