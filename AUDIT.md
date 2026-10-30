# Understanding, search from every angle and finals — 2.0

Reviewed Overview, Library, Conversations, Search & ask, Topics, Finals and the
AI settings pane in the built-in browser against a seeded archive
(`tools/seed-dev.js`, served by `tools/dev-server.js` on port 8799, WhatsApp
link disabled) with the demo provider, and the Electron engine process for
frame extraction, fingerprinting, FTS5 and pdfjs loading. Live providers,
posting, destructive cleanup and installation over the user's running app were
not exercised.

- Every kind is read: photos and video frames as before, documents with their
  extracted facts (title, type, parties, dates, amounts, references), voice
  notes and audio through a speech model when **Transcribe voice notes** is on.
  Every paid reply is booked the moment it arrives, so a crash cannot lose
  spend against the monthly cap.
- Conversations are read stretch by stretch into topics with a cursor per
  chat, so a second run only reads what is new. Topics carry a summary,
  decisions, people and keywords; they appear on the Overview, in the thread
  header, in search and as cited sources for answers.
- Versions of one thing are found by near fingerprint, alike captions or
  labels, within three days, and judged with the chat around them. The
  suggestion is shown; the person decides. Keeping copies the file to
  `Finals` under the media folder and the cloud folder; un-keeping removes the
  copy. Nothing in the archive is deleted or moved.
- One search box asks everything at once: stemmed full-text over messages
  (AND, falling back to any word for questions), AI labels, vectors when a
  provider in the chain can make them, topics, chats and contacts, with
  "last month", "invoices", "sent" and "with Lotte" understood in the query.
  Answers cite their sources; a demo provider says it cannot answer rather
  than inventing one.
- Contacts and chats are persisted; a catch-up pass on connect and every
  twenty minutes fills gaps, edits and revocations are recorded, and a chat
  can be synced by hand. Chats WhatsApp knows but the archive has nothing for
  are listed as such rather than hidden.
- Known limits: themes over topics need at least four topics; finals only
  cluster items of the same kind inside one chat; semantic search needs an
  embedding-capable provider and is skipped silently without one.

# Sources, documents, cloud folders and duplicates — 2.2.0

Added a dedicated Documents & files workspace with file-type filters, Gmail
attachment imports, official Google Photos Picker connection and selected-media
downloads, and an extracted Takeout-folder importer for full-library originals.
Google OAuth uses normal-browser sign-in, PKCE and loopback callbacks. Gmail
and Photos have separate encrypted token stores; settings and diagnostics omit
all credentials. Google clients are supplied by the user, with a setup guide.
Live account authorization was not exercised; local OAuth/API fixtures cover
the callback, tokens, downloads, pagination, stop/resume and failure cases.

The old Google Photos session marker no longer proves a working connection.
Failed state survives restarts and repeated failing browser imports stop
relaunching automatically. Browser sign-in remains explicitly experimental;
the Picker and Takeout are the supported paths. Picker media are Google's
downloads: location metadata is omitted and videos can be transcoded.

Cloud copies now support source / month / file-type folders. Legacy flat copies
remain readable everywhere: serving, thumbnails, indexing, export, location
controls, status selection and cleanup. Existing copies can be previewed,
organized and restored with a recovery journal. Exclusive copies, full content
checks, timestamp preservation, conflict checks and root/junction validation
prevent overwriting unrelated files. No live archive organization was executed.

Duplicate scanning reads complete files in bounded background workers and
covers every file type. Shared physical paths are protected; extra copies are
quarantined with their local/cloud paths, checked before restore or purge, and
cannot remove the last verified independent copy. The older permanent
maintenance dedupe action directs users to this restorable workflow. Active
HTML/SVG attachment responses download under a restrictive sandbox policy.

Validation includes 161 automated checks and browser flows using isolated sample
files: Takeout import and repeat deduplication, Gmail options, document filters,
cloud organization and undo, exact duplicate scan, set-aside and restore. Native
Google sign-in still requires the user's own client setup and authorization.
No real mailbox, cloud archive reorganization or permanent cleanup was used.

---

# File access and clipboard — 2.1.1

The location endpoint called the asynchronous local-path lookup without waiting
for it, causing preview folder actions to fail. It now waits for the lookup,
checks cloud-file presence asynchronously, and returns distinct paths and encoded
file links. A file found only on the cloud drive is not labelled as a separate
PC copy.

Selected files and the preview now expose Open folder, Copy path, Copy for
attachment, and Copy file link. Windows attachment copying writes a native
FileDropList through the system PowerShell runtime, without decoding media or
interpolating paths into executable code. Clipboard operations validate every
file against archive roots and resolve symlinks before copying; an invalid
selection is rejected before changing the clipboard. Local file links do not
create public shares. Preview paths are selectable and show separate copy
locations; selection controls preserve their busy/disabled state during work.

Validation: 104 automated checks pass, including location lookup awaiting,
cloud-only files, missing drives, file-link encoding, clipboard payloads, unsafe
paths, symlink escapes, atomic selection validation, IPC wiring and HTTP error
handling. Browser checks verify single/multiple selection, copied path/link
values, and preview storage paths. Attachment clipboard calls and Explorer are
mocked in automated tests; no live message or file upload is sent during testing.

---

# Content search and responsiveness — 1.6.0

Reviewed Overview, Library, Conversations, Status Studio, Clean up and all eight
Settings panes in the built-in browser, using cloned archive metadata and the
existing media folders. Live source unlinking, posting, destructive cleanup and
installation over the user's running app were not exercised.

- Photos now have detailed visual descriptions and visible text; videos use
  sampled frames with timestamp evidence; PDF, Office and text files expose
  searchable contents. Document extraction is local, with optional AI reading
  of scanned pages. Search can exclude filenames, interpret natural-language
  queries with AI, and show the matching page or scene.
- Added content coverage, per-file indexing, persistent pause/resume, local-only
  document reading, failure details, workload controls and document/video detail
  limits. The single-file action processes only that file. Monthly accounting
  records completed provider calls even when a later step fails.
- Removed blocking cloud status/copy/cleanup work from the event loop. Images,
  documents and video frames are processed in bounded worker threads; thumbnails
  are cached and hover video previews are opt-in. A large archive cost estimate
  fell from approximately 4.4 seconds to 14 ms. During a 1.7-second storage scan,
  state requests completed in 3–19 ms on the test PC. These measurements do not
  rule out unrelated Windows or source-browser problems.
- Fixed media-viewer overflow, conversation search opening the wrong message,
  raw image data appearing as chat text, the AI-settings shortcut, saved-search
  scope, and immediate saving of the workload menu. Status Studio previews now
  work while WhatsApp is disconnected. A single-instance guard avoids duplicate
  desktop processes, and reconnect handling no longer reuses a stale web cache.

49 automated checks pass, including actual image/PDF/Office/video workers,
search evidence, malformed AI replies, queue isolation, pause and spending,
asynchronous backup, exports, settings and desktop updates. A packaged Electron
utility-process smoke test verifies native image/PDF rendering, Office reading,
FFmpeg frame extraction and video posters. Browser checks verify content-only
photo/document/video results, video seeking, saved views, layouts, conversation
message highlighting, settings persistence and an offline status dry run.

Existing files need a new content-index pass. Video search does not transcribe
audio and cannot guarantee detection between sampled frames. Scanned documents
remain partial when their configured limits are reached. Tests used a small
AI sample; the user's complete archive was not sent for indexing. Live WhatsApp
reconnection needs confirmation in the installed app. Runtime dependencies were
updated within compatible ranges; unresolved transitive audit findings remain.

---

# Desktop updates — 1.5.1

The installed app and public feed were still 1.4.9 while the workspace redesign
existed only as a local 1.5.0 installer. Installed clients cannot discover an
unpublished installer. Release validation now checks the version, installer
size and SHA-512, blockmap, and packaged GitHub feed configuration together.

The updater now handles initialization failures, rejected requests, unavailable
updaters and download errors as visible retryable failures. Checks are deduplicated;
ready downloads cannot be overwritten by another check. Automatic checks repeat
every four hours, with 15-minute retries after errors. Both update buttons show
the same state, Settings shows the last successful check, and the header button
stays visible at the desktop app's minimum window size. Desktop update logs are
retained separately from capture logs. Explicit installs wait for the capture
engine to stop; an installer failure resumes capture. Older published versions
are displayed without falsely claiming they are being downloaded.

35 automated checks pass, including the actual main-process/preload IPC contract,
updater failures, retry, concurrent checks, download progress, install recovery
and recurring checks. Installer execution
on the user's existing installation is not part of the isolated updater test.

---

# Desktop workspace redesign — 1.5.0

The desktop app now separates navigation from the archive: a persistent sidebar, global media search, a dedicated Library toolbar and expandable albums/tags. Overview, Conversations, Status Studio, Clean up, setup and Settings use the same light/dark workspace styles. Settings has a vertical task list and a dedicated Appearance pane.

New functions:

- Favourites and named saved views persist beside the archive, independently of AI labels.
- File selection supports all matching items, bulk favourites, and selected or filtered ZIP export. Downloads stream from disk; missing or quarantined items reject the selection before a ZIP starts. Names are flattened and deduplicated. Download tickets expire after two minutes and are single use.
- Persistent theme, density, layout, starting screen, reduced motion, captions and muted hover-preview preferences.
- Search includes actual archive filenames. Hidden galleries no longer materialise thousands of tiles. Conversation rows and status templates support the keyboard. Dialogs trap focus and restore it on close.
- Public settings omit both legacy and provider-specific encrypted API keys.

Verification covers persistence, invalid settings, corrupt preference files, export names, missing files, single-use downloads, expired tickets and large selection request bodies. Browser checks use an isolated preference store while reading the existing archive. Live posting, paid AI calls, source unlinking and media deletion are outside this UI test. The capture engines and pinned Chrome remain unchanged.

---

# Usability audit — 1.4.1

Reviewed as a new user: setup, overview, source connections and imports, gallery filtering, conversations, AI sorting, cloud copies, cleanup, status posting, settings, installation instructions and the download site.

## Changes made

- **Make the next step visible.** The overview now explains the archive, guides phone linking and first history import, and surfaces each source's connection, schedule, errors and import progress.
- **Separate imports from cloud copies.** ChatGPT and Gemini use “Import now”. Cloud status describes media in the configured folder and explains that the cloud client handles uploads; message text stays local. The interface no longer assumes everyone uses pCloud.
- **Make backup status trustworthy.** Positive checks expire; file sizes must match; manual checks bypass caches. Copy via a temporary file before replacing the destination, report missing originals, and include all missing IDs in large libraries.
- **Keep feedback truthful.** Import summaries survive restarts, failed imports remain visible, scan phases explain why downloads have not started, and failed or rejected settings do not show “Saved”.
- **Make browsing predictable.** Source filters also filter overview albums and projects. Opening an album clears unrelated gallery filters. Empty galleries offer direct actions; Gemini is discoverable before its first import.
- **Improve keyboard and small-window use.** Label icon controls, make switches keyboard accessible, announce save results, trap focus in Settings and return it on close, show keyboard focus, and stack the overview on narrow screens. Setup stays on the current step if saving fails.
- **Avoid overstating cleanup certainty.** Matching size and initial bytes are labelled possible copies, not byte-identical files. Small images are optional suggestions, and generated images without prompt text are not grouped as earlier attempts.
- **Clarify the public introduction and installation guide.** Describe what the app does directly and align documentation and download links with the release.

## Product limits and follow-up opportunities

- Cloud-folder presence and matching sizes do not prove remote upload completion or cryptographic integrity. A future provider integration could report remote verification.
- Conversation databases remain local. A dedicated database backup/restore flow would make recovery more complete.
- WhatsApp, ChatGPT and Gemini depend on changing web clients. This audit does not guarantee that every historical item is available from those services.
- The large Settings surface would benefit from a dedicated Sources page and a shorter AI setup flow in a future release.
- A dependency audit still reports eight production findings (five high, three moderate) through the browser-download and HTTP parsing dependencies after updating `js-yaml`. Browser/library upgrades need a separate session-compatibility check; this release retains the pinned Chrome build.
- Real posting, account unlinking, deleting archived media and paid AI calls are excluded from live UI testing. Status Studio keeps its existing consent and dry-run defaults.

## Verification

Seven regression tests cover partial copies, cache expiry, forced rechecks, missing originals, large libraries, unavailable folders, persisted import summaries and throttled ChatGPT reads. Syntax checks cover changed JavaScript. Browser review uses a read-only preview so settings tests cannot alter the live archive. Normal, empty, offline, setup-failure, keyboard and narrow-width flows were checked. Release verification includes matching packaged source files, the installer checksum and GitHub Pages deployment.
