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
