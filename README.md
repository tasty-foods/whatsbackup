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
| `data\` | `messages.db` (SQLite, incl. the `ai_*` tables), `index.ndjson` (media index), `settings.json` |
| `session\` | the Chromium profile that *is* the WhatsApp link |
| `logs\` | rotating log, capped by the `logMaxMB` setting |
| `media\` | images / videos / files, unless the user chose another folder |

Run from source (`npm run server`) and it all falls back to the project folder,
so development doesn't touch the installed copy. `src/paths.js` is the switch.

`electron/migrate.js` imports an older install: it refuses to run while the old
copy is alive (a live SQLite `-wal` holds writes the `.db` doesn't have yet),
copies rather than moves, and verifies row and file counts before reporting
success.

## AI sorting (`src/ai/`)

Off by default; needs the user's own key. Two passes:

**label** — one cheap call per item, cached in `ai_labels` by content hash, so
re-running the whole library costs nothing. Images go to a vision model; videos
are labelled from text context only (no vision API takes video) and marked as
such; chats send a digest of 30 newest + 30 sampled messages at 200 chars each.

**arrange** — one text-only call over all the labels. Three things keep the
result stable instead of reshuffled on every run:

- existing groups are sent **with their ids**, and the model is asked to move
  items into them rather than invent a fresh taxonomy;
- the user's own corrections are replayed as house rules, and rows with
  `source = 'user'` are re-attached *after* the AI's, so a correction can never
  be undone by a later sort;
- members are referenced by **ordinal index**, never by record id — echoing 400+
  thirty-character ids costs thousands of output tokens and silently truncates.

An album the user renames keeps its old name in `prev_names`, because a model
proposing "Equipment & repairs" means the album now called "Machine repairs";
without the alias the arrange builds a second album and strands the first.

**Providers** are two adapters: Anthropic via `@anthropic-ai/sdk`, and
OpenAI-compatible via plain `fetch` — which covers OpenAI, Gemini's `/v1beta/openai`
shim, OpenRouter, Groq, Ollama and LM Studio. Presets are data in `presets.js`.

**Capabilities are probed, not tabled** (`probe.js`). A hardcoded `vision: true`
is wrong the moment someone types a model name: Ollama accepts `response_format`
and ignores it, a gateway can route to a text-only model and drop image parts.
Test connection asks three separate questions — reachable, honours JSON, sees an
8×8 red PNG — and the runner remembers a "no" so it skips the photos instead of
failing several hundred charged calls. No `minItems`/`maxItems` in any schema;
OpenAI's strict mode rejects them, so group-size rules live in the prompt and are
enforced in `arrange.validate()`.

The key is encrypted with Electron `safeStorage` (Windows DPAPI), stored as
ciphertext in settings.json, and handed to the engine in memory over `parentPort`.
It is stripped from `/api/settings` and the diagnostic report. The engine's
`utilityProcess` runs with `--use-system-ca` — without it, Node's bundled roots
fail on any machine with TLS inspection and the first call dies as "fetch failed".

`demo` is a real preset: a local fake provider that labels and groups with no key
and no cost, for seeing what sorting looks like before paying for it.

## Building

```bash
npm install
npm run dist          # icons + Chrome + NSIS installer into dist/
```

`npm run release` does the same and publishes to GitHub Releases (needs `GH_TOKEN`).

- `npm start` — run the desktop app from source
- `npm run server` — run only the capture engine + dashboard (no Electron)
- `npm run icons` — regenerate app and tray icons

## Website (`docs/`)

The marketing site, built to be published straight from this repo:
**Settings → Pages → Deploy from a branch → `master` / `/docs`**, which serves it at
`https://tasty-foods.github.io/whatsbackup/`.

Five static pages, one stylesheet, inline SVG. No build step, no framework, no
webfonts, and the only third-party request on the whole site is an optional
`api.github.com` call that upgrades the download button to point at the newest
release asset — the button works without it.

```bash
node tools/serve-site.js     # preview at http://127.0.0.1:4321
npm run og                   # re-render docs/assets/og.png (the social card)
```

Written for search engines *and* for the AI assistants people now ask instead:
`SoftwareApplication` / `FAQPage` / `HowTo` / `Article` JSON-LD, a `sitemap.xml`,
a `robots.txt` that names the AI crawlers explicitly, and an `llms.txt` giving a
model the whole product — including the caveats — in one plain-text file. Every
answer leads with the answer, because that is the sentence that gets quoted.

**Moving to a custom domain** means changing the absolute URLs in one pass —
`canonical`, `og:url`, `og:image`, the JSON-LD `@id`/`url` fields, `sitemap.xml`,
`robots.txt`, `llms.txt` and the three links in `404.html` — then adding a `CNAME`
file to `docs/`. Everything else is relative and moves by itself.

`docs/` is deliberately outside the electron-builder `files` list, so none of it
ships inside the installer.

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
