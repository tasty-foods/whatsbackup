# WhatsBackUp

A Windows desktop app that saves every photo, video and message from your WhatsApp — to a local folder, and to a cloud folder if you point it at one.

The 2.0 release makes the archive understood rather than just stored. The AI reads photos, documents and (optionally) voice notes, follows each conversation into **Topics** with decisions and keywords, finds the versions of one thing that were sent and suggests the **Final** to keep (keeping copies the file into a `Finals` folder, nothing is deleted), and answers questions over the whole archive with cited sources in **Search & ask**. Search runs from every angle at once: full-text over messages with stemming and date/kind/direction filters, AI labels, vectors for search by meaning, topics, chats and people. Contacts and chats are now persisted and kept in sync with a catch-up pass on connect and every twenty minutes. The 1.6.0 workspace underneath is kept whole: photo details, document text, sampled video scenes, favourites, saved searches, selected-file ZIP exports and persistent appearance preferences. Personal organisation lives in `data/library.json`; display choices live in `data/settings.json`.

For installing and using it, see **[INSTALL.md](INSTALL.md)**. This file is about how it's built.

In 2.1.1, selected files and previews offer **Open folder**, **Copy path**,
**Copy for attachment** and **Copy file link**. Attachment copying uses the
Windows file clipboard, so Ctrl+V can attach the original in an app that accepts
files. File links use the existing storage path; they are not public pCloud share
links. The preview lists separate archive and cloud-drive copies. Files stored
only on the mounted cloud drive are identified explicitly.

The [desktop audit](AUDIT.md) records the reviewed flows, shipped changes and remaining product limits. Other features include ChatGPT and Gemini image imports (`src/chatgpt/`, `src/gemini/`), Google Photos imports (`src/google-photos/`), media copy verification (`src/backup.js`), reversible cleanup (`src/cleanup/`), and opt-in status scheduling (`src/status/`). Import summaries are persisted in `data/*-import.json`. Run `npm test` for regression checks.

### Google Photos

**Settings → Sources → Google Photos** connects a separate browser profile in
`<appHome>/google-photos-session`. The person signs in themselves. Import now
walks the main timeline, collecting each viewport before the virtual grid
recycles it, and downloads photos and videos using the website's Download
action. Stable photo IDs and SHA-256 file hashes avoid repeat imports; duplicate
aliases live in `data/googlephotos-seen.json`. Originals enter the existing
media index, AI queue and cloud-copy sweep. Videos are kept in the local video
folder and served through the existing fallback, even when cloud storage is
configured. Automatic scans are off by default; intervals are 1–168 hours.

Stop import closes the scan browser and retains completed downloads. A later
scan starts at the top and skips saved items. Every attempt, including stops
and failures, persists an import summary. Google photo-label dates are used
when readable; otherwise the gallery uses the import date. Original file bytes
and embedded metadata are preserved. Archive, Locked Folder, trash and media
only in shared albums are outside the main timeline and are not imported.

Google removed full-library access from its Library API in its
[2025 API changes](https://developers.googleblog.com/google-photos-picker-api-launch-and-library-api-updates/); the Picker
requires manual selections. This connector depends on the Google Photos web
interface, so sign-in restrictions or website changes can interrupt it. It does
not upload or propagate deletions. ZIP/motion-photo bundle downloads and unknown
file types are reported as failures, rather than saved as thumbnail substitutes.
For a complete bulk export, Google Takeout remains Google's supported route.

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
| `data\` | `messages.db` (SQLite, incl. the `ai_*` tables), `index.ndjson` (media index), `settings.json`, `library.json` (favourites and saved views) |
| `session\` | the Chromium profile that *is* the WhatsApp link |
| `logs\` | rotating log, capped by the `logMaxMB` setting |
| `media\` | images / videos / files, unless the user chose another folder |

Run only the server (`npm run server`) without `WB_HOME` and data falls back to the project folder. The Electron shell (`npm start`) sets `WB_HOME` to the installed app's data folder even in development, so it shares that archive. Use a separate `WB_HOME` with the server for isolated testing. `src/paths.js` is the switch.

`electron/migrate.js` imports an older install: it refuses to run while the old
copy is alive (a live SQLite `-wal` holds writes the `.db` doesn't have yet),
copies rather than moves, and verifies row and file counts before reporting
success.

## Content search and AI sorting (`src/content/`, `src/ai/`)

Off by default; needs the user's own key. Two passes:

**label** — detailed descriptions, object states and visible text are cached in
`ai_labels`. Photos are resized before a vision request; identical photo bytes
reuse a current label. FFmpeg samples video frames with timestamps for a vision
request. Video audio is not transcribed, and sampling can miss brief scenes.
PDF, Office and text document contents are extracted locally; scanned pages can
be transcribed by the chosen AI provider. Chats send a digest of 30 newest +
30 sampled messages at 200 chars each. Old labels or changed detail settings
may require fresh indexing and additional provider usage.

**search** — typing searches the saved index locally. “Interpret search with AI”
expands the query and verifies candidate excerpts against it. The provider sees
the query and short matching excerpts. Results identify their document page or
video timestamp. Names/captions can be included or excluded. Saved views retain
that scope. Existing archives need **Library → Manage index → Build content
index** to add the new detail; **Read document text locally** needs no AI key.

Expensive decoding runs in bounded worker threads, with one thumbnail lane and
one indexing lane. Quiet/Balanced/Faster controls limit concurrent AI requests.
Indexing can pause and resume across restarts. Paid responses are recorded even
when a later operation fails; the monthly budget stops new batches once reached
(an already-running batch may finish). Changing detail limits invalidates only
the corresponding content profile.

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
and no cost, for seeing what sorting looks like before paying for it. In 2.0 it
also fakes transcripts, topics, vectors and finals judgements, so every screen
can be exercised offline (`tools/seed-dev.js` builds an archive for exactly that).

### Understanding, topics, finals and search from every angle (2.0)

The runner (`src/ai/index.js`) now drains one queue of typed jobs — image,
video, document, audio, chat, topic, finals, embed — picking the provider in
the chain that can do each one (`capabilities()`: vision, audio, embeddings are
probed per preset) and booking every paid reply through `onUsage` the moment it
arrives. A second pass ten minutes after a kick judges the version sets and
makes the vectors, so the first pass stays cheap.

- **Transcribe** (`provider.transcribe`, `label.labelAudio`) — voice notes and
  audio go to `/audio/transcriptions` (Groq's whisper is free, OpenAI's is not);
  off by default, `aiTranscribeAudio`. The transcript is indexed and shown under
  the bubble.
- **Documents** (`src/ai/extract.js` for tests; the content worker in the app) —
  text comes out locally, scanned pages through vision; the label carries
  *facts*: title, type, parties, dates, amounts, references.
- **Topics** (`src/ai/topics.js`) — each chat is read in windows from a cursor
  (`ai_topic_cursor`), so a rerun only reads what is new. Topics are bounded to
  the messages the model was shown (`validate`), then arranged into themes
  (`ai_groups.kind = 'topic'`) once there are enough of them.
- **Finals** (`src/ai/finals.js`) — candidate sets are clustered without AI:
  dHash fingerprints (`src/imaging.js`, or the shell's `nativeImage`), alike
  captions or labels, same chat and kind, 72 hours. The model judges the set
  with the chat around it; the suggestion is stored in `finals_sets`, the
  person's decision in `finals_marks`. Keep copies the file to `Finals` under the
  media and cloud roots with a readable name; nothing is ever deleted or moved.
- **Vectors** (`src/ai/embed.js`) — labels, transcripts, topics and chat
  summaries are embedded (`ai_embeddings`) when a provider can; search by
  meaning is a cosine scan in memory and is skipped silently without a key.
- **Search** (`src/search.js`) — one query is parsed for dates ("last month",
  "in March"), kinds ("invoices", "voice notes"), direction ("sent") and chat
  ("with Lotte"); the rest hits FTS5 over messages with stemming (AND, with an
  any-word fallback for questions), the label index, the vectors, topics, chats
  and contacts, and comes back as one ranked answer per group.
- **Ask** (`src/ai/ask.js`) — the same retrieval, then one text call with the
  sources numbered; the answer cites them and the UI opens each one in place.

**Sync** (`src/whatsapp.js`, `src/contacts.js`, `src/messages.js`) — contacts
and chats are persisted tables, not a cache; lid→phone pairs are learned from
the client so group authors resolve to names; a catch-up pass on connect and
every 20 minutes walks each chat from its last synced message, and edits and
revocations are recorded rather than lost. The dashboard offers a catch-up and
a per-chat sync by hand.

## Building

```bash
npm install
npm run dist          # icons + Chrome + NSIS installer into dist/
```

`npm run release` does the same and publishes to GitHub Releases (needs `GH_TOKEN`).

For a manually published release, run `npm run verify-release` after building.
Publish the installer, its `.exe.blockmap`, and `latest.yml` together in a stable
GitHub release. Keep it as a draft until all three uploads finish, then mark it
as latest. A locally built installer alone does not update the public feed.

Installed copies check on startup and every four hours when automatic checks
are enabled, retry network failures after 15 minutes, and also support manual
checks from the header, Settings → App, or the tray. A ready update can be
installed immediately or on a full quit; closing to the tray is not quitting.
Desktop updater diagnostics are saved under `<appHome>/logs/updates.log`.

- `npm start` — run the desktop app from source
- `npm run server` — run only the capture engine + dashboard (no Electron)
- `npm run icons` — regenerate app and tray icons
- `node tools/seed-dev.js && node tools/dev-server.js` — a throwaway archive
  under `.dev-home/` (photos with three versions of one advert, a PDF, a Word
  file, a voice note, a group chat) served on port 8799 with the WhatsApp link
  disabled and the `demo` provider on, for working on the dashboard and the AI
  passes without touching a real archive. The `dev` entry in
  `.claude/launch.json` starts the same thing.

## Website (`docs/`)

The marketing site, built to be published straight from this repo:
**Settings → Pages → Deploy from a branch → `master` / `/docs`**, which serves it at
`https://tasty-foods.github.io/whatsbackup/`.

Five static pages, one stylesheet, inline SVG. No build step, no framework, no
webfonts, and the only third-party request on the whole site is an optional
`api.github.com` call that upgrades the download button to point at the newest
release asset — the button works without it.

**The design is an archive, because the product is one.** Paper and ink rather
than a dark gradient; a system serif doing the talking with mono reserved for
labels, catalogue references and figures; hairline rules instead of cards;
numbered `§` sections in the margin like a finding aid; the disclosure block set
as a rubber stamp. One vermilion accent, used sparingly. Deliberately *not* a
messaging app's green, and no WhatsApp mark anywhere.

The hero carries the argument on its own: a contact sheet of twelve frames with
two already empty and marked *no longer available*. That is the product's whole
case in one glance, and it is reused as the social card, the favicon and the 404.

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
