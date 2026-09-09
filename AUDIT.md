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
