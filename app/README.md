# LEM-Time

## PHP-FPM / Pelican deployment

The repository's root README documents the upload-ready `lem-time-pelican.zip`.
Use that package for React + PHP-FPM without Node/npm on the hosting server.
Developers can rebuild it with `npm ci` and `npm run build:pelican`; deploy only
the resulting `dist/` contents. The PHP backend requires PHP 8.2+ with PDO SQLite
enabled in PHP-FPM and stores data outside the public web root. It can import
existing JSON saves once into an uninitialized database; see the root README
before switching an existing installation. The Node instructions below remain
available for local development and the original Node deployment.

## Run locally

Use Node.js 22.13+ (includes the built-in SQLite module; no database package or
separate SQLite installation is needed).

```sh
npm ci
npm run server
```

In a second terminal:

```sh
npm start
```

Open the local URL printed by Vite. Vite forwards `/api` requests to the backend
at `127.0.0.1:3001`. Keep both terminals running. The frontend shows connection
errors with a retry button if the backend is unavailable.

## Production

```sh
npm run build
npm run server
```

Open `http://127.0.0.1:3001`. The backend serves the built `dist/` directory and
the SQLite API from the same origin. Static-only hosting is no longer sufficient:
the Node process needs persistent, writable storage. `npm run preview` can still
preview a build while the backend runs separately.

Built asset URLs are relative, so the same `dist/` can be hosted at the domain
root or in a subdirectory such as `/LEM-Time/`. With a reverse proxy, route
`/api/` to the backend as well as serving the frontend.

## Cue modes

**Add Cue → Cue type** supports Countdown (the default for existing saves),
Count-up Timer, and **Local Time**. Local Time shows live
HH:MM:SS using the viewing device's local timezone; select **24 hour** (default)
or **12 hour (AM/PM)** in the cue menu. The saved per-cue `clockFormat`
(`24h`/`12h`) applies to all previews and outputs. It has no timer controls
or persistence writes per tick. Match device timezones/clocks for matching outputs.
Count-up starts at zero by default or a configured starting value, supports
Start/Pause/Reset, and uses a persisted server origin timestamp so elapsed time
survives closed windows and backend restarts. Reset restores its starting value.
Changing an active cue's type/duration or activating a cue resets it to Ready;
name-only edits preserve progress. All output views share the same formatting.
Urgency bars, ±1 minute, and Set remaining time apply only to Countdown.

Show links is below Show cues in the main workspace column. Show deletion is
available only through the dashboard ShowCard menu, with confirmation and the
existing PIN/lock protections. Lock and blackout remain at the timer's top right.
Each dashboard card is a real, full-card link to its timer, accessible with Enter.
The pencil beside the title and the **…** menu remain independent; saving a
title or dismissing the menu does not accidentally open the timer.

## Database and migration

### Shared branding

The **Template** sidebar starts collapsed; its heading collapses/expands the whole panel with click or
Enter/Space, keeping inputs, selections, validation, and uploads mounted. The
message editor stays separate and visible. The unified Font upload follows both
logo slots (default/light and optional/dark).

**+ Add template** in a show's Template panel saves only its selected built-in
design (`templateId`), `logoOn`, `uploadedLogo`, and `logoName`, under a required,
unique case-insensitive name. Snapshots are independent of future show changes.
**Select template** and **Add Show** offer these saved snapshots alongside the
existing built-in designs. Applying a snapshot leaves cues and timer state alone.
The site supports 50 named templates (1–80 characters per name).

Navigation **Settings** edits the site header logo, main header, and sub-header
text (plain text, at most 200 characters per text field). Remove the uploaded
logo to restore the wordmark, or reset all defaults and save. Logos accept PNG,
JPEG, WebP, or SVG up to 512 KiB and 8192 pixels per side. New settings/template
logos are validated bounded data URLs and rendered only as image elements.
The 10 MiB request limit includes every logo copy in all shows/templates.

Site settings/templates are installation-wide, not per-user preferences.
When a PIN is configured, both backends require an authorized operator session for
all state writes (including settings/templates). Reads and display links stay public.
There are no accounts or private-show read permissions. Before first PIN setup,
writes/setup are public: configure the PIN on a trusted network first, and retain
HTTPS/reverse-proxy protection around both frontend and API.

Both backends automatically add `site_settings` and `branding_templates` tables
without replacing existing shows/PINs. They participate in the same transaction,
revision checks, previous-state backups, and three-way client merge as shows.
Old payloads omitting new settings fields/templates leave existing values intact;
refresh old tabs after deploying. Concurrent template additions merge by ID,
but duplicate names or overlapping edits block instead of silently overwriting.
The one-time JSON import accepts the new fields, preserves its revision/source,
and never overrides initialized SQLite.

Shows, cues (including their order), branding, display options, messages, and
the configured installation PIN hash are stored in `lem-time.db` beside `server.mjs`
(PHP defaults to `/home/container/lem-time-data/lem-time.db`, outside `www`).
PINs use salted PBKDF2-SHA256 (210,000 iterations); session tokens are random,
stored hashed server-side, and sent only in HttpOnly/SameSite cookies, Secure over
HTTPS. One browser cookie is combined with the non-secret `X-Operator-ID` to
authorize each document independently, including tabs in the same browser.
Reloads do not accumulate per-document cookies. No credential goes into URLs/localStorage.
Cookie establishment is coordinated across tabs (Web Locks, with a non-secret
IndexedDB mutex fallback on HTTP). Public GETs never set credentials, so a delayed
reader cannot overwrite another operator's newly authorized session.
Sessions expire after 12 hours; a new/reloaded document must authorize again.
Five failed PIN attempts per source address per minute are allowed, persisted in SQLite.
GET never exposes the PIN/hash; state exports contain only an empty legacy `pin` field.
Existing plaintext SQLite and private JSON-import PINs migrate automatically.
The original JSON source and old private backups are not rewritten and may contain
the old PIN; secure them and rotate the PIN after upgrading.
Protect the database and backups as sensitive files. Node listens on loopback by default.

On the first control-window connection to an uninitialized database, the browser imports its
existing `bayer-mock-shows` localStorage values. The obsolete browser-only
`bayer-mock-pin` is removed, not trusted as server authorization. Invalid show
entries are excluded, valid entries retained, and an intentionally empty list
remains empty. If there are no usable saved shows, demo shows initialize the
database. Original browser show values are retained unchanged for recovery; subsequent
connections always use the database, not another browser's localStorage.

The server is the only timer engine: persisted deadlines/origins provide remaining/elapsed time
on GET without writes or revision changes, even if no browser is open. All windows
poll every 250 milliseconds, skipping refreshes while a refresh or save is in
flight; display URLs and display/DSM/chroma windows are read-only,
including on an empty database. No browser counts down or competes for ownership.
**Preview display**, **Open DSM**, and **Open Chroma mode** synchronously request
separate browser windows with no opener, preserving the workspace. Browsers may
choose tabs or block popups; allow popups for the site if no viewer appears.
The `#/display/<show-id>`, `#/dsm-preview/<show-id>`, and `#/chroma/<show-id>`
routes retain the installation path/query and output mode across reloads.
DSM and Chroma previews retain their Expand controls. Actual output messages use
responsive 32–96px text in a bounded upper band, without enlarging workspace
messages or dashboard thumbnails.
The `#/dsm/<show-id>` link opens the clean DSM viewer with real transparent
backgrounds by default, white/black digit controls, and no mock alpha toggle.
Use **Open DSM → DSM output URL** for an alpha-capable capture such as OBS Browser
Source. Ordinary browser windows/window captures are not see-through. Blackout
is intentionally opaque black. See the root README for capture requirements.
Metadata-only PUTs send `timerCommands: []`; the backend preserves stored timer
fields/deadlines. Explicit timer commands replace only the named clocks. Legacy
clients omitting this list retain full-state-write behavior; refresh all old tabs
when deploying. Both backends add the clock table automatically, and PHP's one-time
JSON import and initialized-SQLite precedence remain unchanged.

**Set remaining time**, beside the workspace timer controls, replaces the active
countdown with exact whole minutes and seconds (0–59). The total must be positive
and a safe integer. **Save & start** starts immediately from Ready, Paused,
Running, or Complete without changing the cue duration; Reset restores that
original duration. Saving an unchanged running value explicitly restarts its
server deadline. Cancel is read-only, and missing active cues and locked shows
cannot use this action. A changed/deleted active cue or a competing timer command
invalidates the open draft; ordinary ticks and unrelated show metadata do not.
Pending explicit commands survive polling and in-flight saves and use the same
revision/version conflict protection as other timer controls.

The timer panel’s top-right **Lock/Unlock Show** and **Blackout/Clear blackout**
icon buttons expose their active states and remain available on narrow screens.
With no PIN, the lock icon opens **Set Show PIN**. The compact **Configure PIN lock**
or **Change or remove PIN** link below the title keeps PIN settings accessible.
Configuring a PIN keeps that operator authorized and locks other windows/devices.
There is no dashboard PIN toolbar. Locked show cards still open their timers,
where **Unlock Show** authorizes dashboard edits, deletion, and Settings too.
The PIN remains installation-wide, not per-show. **Add Show → Authorize to add
shows** provides recovery even with no saved shows and keeps the new-show draft;
it does not bypass protected writes.
**Unlock Show** authorizes only this window; **Lock Show** relocks only this window
and discards its queued unsaved edits. It never stops timers or locks other operators.
Changing/removing the installation PIN requires an authorized session and revokes
all old sessions; the configuring window remains authorized.
The same API endpoint accepts JSON POST actions `bootstrap` (cookie only),
`configure`, `unlock`, and `lock`;
PIN changes cannot be made through state PUT. Normal revision/conflict protection
still applies independently to state writes.
Blackout requires confirmation to enable; clearing it is immediate. Blackout
controls are disabled while locked, and timers continue running behind black output.

Autosaves use revisions and three-way merging. Timer progress and disjoint edits
refresh safely, including while a save is in flight; genuine overlapping edits
remain blocked with retry/download/reload recovery. Timer command versions include
the persisted deadline so resets are not mistaken for elapsed time. Connection/save
failures keep edits in memory; closing with pending changes warns. Normal polling
and saves are silent. Back up before upgrading: previously running timers resume
from their saved remaining time on first upgrade, then survive browser/backend
restarts using the server clock.

## Backups and configuration

The backend keeps a rolling `lem-time.db.bak` snapshot of the previous committed
database before replacing data. Backups must succeed before a save is accepted.
Database files and backups are ignored by Git and are not served over HTTP.
Keep separate periodic copies for longer-term history.

To restore, stop the backend, preserve the current database for diagnosis, replace
`lem-time.db` with a copy of `lem-time.db.bak`, then restart. Never replace a live
database file.

Environment variables for the backend:

- `DB_PATH`: path to the database file (default: repository `lem-time.db`).
- `STATE_PATH`: private JSON source for a one-time import, default `lem-time.json`
  beside the database. Initialized SQLite always wins; invalid imports fail closed.
- `PORT`: HTTP port (default: `3001`; update the Vite proxy if changed).
- `HOST`: listen address (default: `127.0.0.1`). Use a trusted authenticated reverse
  proxy and TLS before allowing remote access.
- `APP_ORIGIN`: exact trusted browser origin when using that proxy, for example
  `https://timers.example.com` (no path or trailing slash). Set this explicitly;
  other remote origins are rejected.

Run the backend regression suite with `npm test`. It covers validation, atomic
writes, database restarts, backups and backup failures, concurrent revisions,
origin checks, request limits, and private-file protection.

An optional real-browser regression uses an already installed ChromeDriver, an
isolated **empty** PHP build served over HTTP, and no extra npm packages:
`CHROMEDRIVER_URL=http://127.0.0.1:9515 BROWSER_TEST_URL=http://127.0.0.1:8088 node --test browser.test.mjs`.
Build Pelican first; keep its test database outside the document root. This test
initializes that test store, verifies empty/display GET-only polling, multiple
windows, timer progress without revision writes, metadata saves and separate preview
windows/reloads (with no opener and an untouched workspace), exact remaining-time validation/restarts, original-duration Reset,
show-lock/missing-cue/stale-draft protection, header PIN setup/removal and unlock
validation, blackout confirmation/cancel/clear, narrow-screen light/dark header
controls, queued commands, and recovery without
overwriting genuine concurrent timer or title edits.
Countdown-bar regressions sample intermediate clip positions within a second,
including repeated rounded polls, bounded corrections, pause/reset/adjust/restart,
server-zero-only expiration, reduced motion, and no visual-frame writes.
The blackout warning is checked both active and cleared, with no live/off status.
Mode regressions also cover the Cue type selector/defaults, configured count-up
start/pause/reset, wall-clock updates without autosaves, all display outputs,
links below cues, whole-card pointer/keyboard navigation, title/menu isolation,
mobile title/pencil alignment, dashboard PIN-toolbar absence, timer unlocking,
empty-dashboard authorization recovery, and dashboard-only deletion/confirmation.
Message regressions cover the single Show toggle, live text/format/destination
updates, retained hidden drafts, remote-text safety, blackout indicators, trash,
and locked controls. Set `FONT_TEST_TIMER` and `FONT_TEST_TEXT` to two licensed
font files under 512 KiB to also exercise unified upload/reset, legacy split-font
templates, workspace/output rendering, and upload lifecycle/PIN races, including
uploads completing while Template is collapsed. Template coverage also checks
initially collapsed state, keyboard collapse, retained inputs/selections, message-editor isolation, and
font ordering after both logos.
DSM coverage decodes actual CDP-captured PNGs with the default canvas background
omitted, checking zero-alpha empty pixels and visible opaque white/black digits
in both clean-link and native fullscreen output. It also checks opaque blackout,
corner-only hover controls (including sustained hover), Tab/focus access, Escape,
touch reveal/action/dismissal, Chroma, theme restoration, and read-only server timer polling.
It creates a local `.browser-data/profile` directory; remove it after
stopping ChromeDriver. Without those variables, `npm test` skips the browser test.

## Startup troubleshooting

If “Loading LEM-Time…” remains visible, check the browser Network tab for failed
JavaScript requests and verify that the backend serves the built `dist/` folder.
The source HTML cannot run directly as a static site.

If “Loading saved shows…” fails, start the backend, check its logs, and confirm
that its data directory is writable. Do not delete browser data to troubleshoot
a connection error. Unexpected render failures show a reload message instead of
a white screen.