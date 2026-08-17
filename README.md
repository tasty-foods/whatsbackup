# WhatsApp Media Dashboard

Automatically captures **every image and video you send or receive on WhatsApp**
(works with WhatsApp Business) and gives you a private, scrollable dashboard on
your own PC.

- 📸 **Images** → saved instantly to a local gallery you can scroll, enlarge, and download
  (and mirrored to **pCloud** as a backup).
- 🎥 **Videos** → saved straight to **pCloud** (`P:\WhatsApp Media\Videos`) so they're in the cloud.
- 💬 **Conversations** → optionally captures message **text** too, so you can read and **search** every
  chat in a WhatsApp-style thread view, updated live. Message text stays **only on this PC** (never uploaded).
- 🖥️ **Dashboard** → opens in its own app window — two views: **🖼 Media** (photo-wall, filter by chat /
  Sent / Received, enlarge, download, **Download all images** as a zip) and **💬 Conversations** (chat list →
  thread, with photos/videos inline, full-text search). Only reachable from this PC (bound to localhost).
- ⚙️ **Settings panel** for everything below — no editing code needed.

## The two views

- **🖼 Media** — the scrollable gallery of every image & video.
- **💬 Conversations** — pick a chat on the left to read the thread; media shows inline. Type in the
  search box to full-text search every message across all chats. Text is stored locally in
  `data\messages.db`; you can also **Export full transcript** (Settings) to a local HTML archive.

## Opening it

Double-click **"WhatsApp Media"** on your Desktop. It starts the background service (if it isn't
already running) and opens the dashboard in a clean app window. It also **starts automatically every
time you log in**, so capture is always on.

## Settings (⚙︎ button, top-right)

- **Connection** — shows the linked account and how much has been captured.
- **Import old images & videos** — pulls media already sitting in your chats, as far back as WhatsApp
  lets a linked device see. Safe to run anytime; it skips anything already captured. Set how many
  messages per chat to scan (default 400).
- **Cloud folder for videos (pCloud)** — the folder videos are saved into (default `P:\WhatsApp Media`,
  your pCloud drive). Edit it and press **Check** to confirm it's writable; **Save** then **Restart app**.
  Optional toggle: also back up a copy of every image to pCloud.
- **Where everything lives** — the exact folders/files used (see below).
- **Maintenance** — remove the welcome samples, or restart the app.

## Where things are saved

| What        | Location                                              |
|-------------|-------------------------------------------------------|
| Images      | `media\images\`                                       |
| Videos      | `P:\WhatsApp Media\Videos\` (pCloud → cloud)           |
| **Settings**| `data\settings.json`                                  |
| Media index | `data\index.ndjson` (list of everything captured)     |
| Logs        | `logs\dashboard.log`                                  |
| WhatsApp link | `.wwebjs_auth\` (so you never re-scan)              |

**The application itself** is this folder: `C:\Users\keste\Projects\pcloud whatsapp`.
It runs as a hidden background Node.js process (`src\index.js`) that both serves the dashboard and
listens to WhatsApp.

## Command line (optional)

- `npm start` — run with a visible console (to watch logs).
- `npm run backfill` — import history from a terminal (the ⚙︎ button does the same).
- `npm run reset` — remove welcome samples · `npm run reset -- --all` — clear the whole gallery.

## Start / stop / remove

- **Start (hidden):** double-click `launch-hidden.vbs`, or just open the Desktop app.
- **Stop:** Task Manager → **Node.js** → End task (or reboot). The ⚙︎ panel also has **Restart app**.
- **Turn off auto-start:** delete
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\WhatsApp Media Dashboard.lnk`.
- **Unlink from WhatsApp:** on your phone, WhatsApp → Linked devices → remove this device, and delete
  the `.wwebjs_auth\` folder here.

## Notes

- Everything stays on your machine and your own pCloud. Nothing is sent anywhere else.
- Live capture starts the moment the app is running; **Import history** fills in the past.
