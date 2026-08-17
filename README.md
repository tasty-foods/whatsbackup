# WhatsBackUp

A Windows desktop app that saves every photo, video and message from your WhatsApp — to a local folder, and to a cloud folder if you point it at one.

For installing and using it, see **[INSTALL.md](INSTALL.md)**. This file is about how it's built.

---

## How it works

```
Electron main process  (electron/main.js)
├── window            → loads http://127.0.0.1:8788, which serves public/
├── tray              → live status, quick actions, quit
├── supervision       → restarts the engine with backoff if it dies
├── updates           → electron-updater against GitHub Releases
└── utilityProcess    → the capture engine, its own crash domain
        │
        └── src/index.js
            ├── src/web.js        Express: dashboard + JSON API
            └── src/whatsapp.js   whatsapp-web.js driving its own bundled Chrome
                    │
                    └── media → images/videos/files folders (+ cloud folder)
                        text  → node:sqlite database
```

Two Chromiums ship in the installer: Electron's, which draws the window, and a
pinned Chrome that whatsapp-web.js drives. That's ~150 MB more than reusing
Electron's own — bought deliberately, because whatsapp-web.js expects to launch
and own its browser, and the linked WhatsApp session *is* that browser's profile.

**The Chrome version is pinned** (`tools/fetch-chrome.js`). The session folder is
a Chromium profile; swapping the browser underneath it risks invalidating the
link and forcing everyone to scan a QR code again.

## Data

Nothing writable lives next to the program. Installed, everything is under
`%LOCALAPPDATA%\WhatsBackUp\`:

| Folder | Contents |
|---|---|
| `data\` | `messages.db` (SQLite), `index.ndjson` (media index), `settings.json` |
| `session\` | the Chromium profile that *is* the WhatsApp link |
| `logs\` | rotating log, capped by the `logMaxMB` setting |
| `media\` | images / videos / files, unless the user chose another folder |

Run from source (`npm run server`) and it all falls back to the project folder,
so development doesn't touch the installed copy. `src/paths.js` is the switch.

`electron/migrate.js` imports an older install: it refuses to run while the old
copy is alive (a live SQLite `-wal` holds writes the `.db` doesn't have yet),
copies rather than moves, and verifies row and file counts before reporting
success.

## Building

```bash
npm install
npm run dist          # icons + Chrome + NSIS installer into dist/
```

`npm run release` does the same and publishes to GitHub Releases (needs `GH_TOKEN`).

- `npm start` — run the desktop app from source
- `npm run server` — run only the capture engine + dashboard (no Electron)
- `npm run icons` — regenerate app and tray icons

## When WhatsApp breaks it

It will. WhatsApp ships changes to its web client without notice, and this app
reaches into that client's internals. In July 2026 they renamed the serialized
field on message ids, and both `getChats()` and `downloadMedia()` in
whatsapp-web.js started throwing a minified `r` — capture died silently for a
month before anyone noticed.

Three things came out of that, and they're the parts to understand before
changing `src/whatsapp.js`:

- **`msgKey(msg)`** resolves a message id by *shape* rather than by field name,
  so the next rename doesn't break it.
- **`downloadMediaByKey()`** replaces the library's `downloadMedia()`, which
  looks messages up by the field that no longer exists.
- **`listChatsTolerant()`** reads the chat list directly and skips chats it
  can't parse, instead of `getChats()` failing whole-hog on one bad chat.

And the safety net: the engine counts consecutive live download failures. Three
in a row and the tray goes amber, a notification fires, and the dashboard shows
a banner. Silent failure was the actual bug — not the missing fix.

To debug the next one, set `WA_DEBUG_PORT=9222` and attach to the WhatsApp page
with any CDP client; `msg.mediaData.mediaStage` and the real (unminified) error
names are usually enough to find what moved.
