# Install and use WhatsBackUp

WhatsBackUp saves WhatsApp messages and media on Windows. It can also import images from ChatGPT and Gemini and copy media to a folder managed by pCloud, OneDrive, Dropbox or another cloud client.

## Install

1. Download **WhatsBackUp-Setup-1.4.3.exe** from [GitHub Releases](https://github.com/tasty-foods/whatsbackup/releases/latest).
2. Run the installer on Windows 10 or 11. Node and Chrome are included; administrator access is not required. The installer is unsigned, so Windows may show a publisher warning. Verify that your download came from the release above before deciding to run it.
3. Read the unofficial-client notice, choose a media folder, optionally choose a cloud folder, and decide whether to start with Windows.

## Save your first items

The **Overview** shows your next step and the state of each source.

- **WhatsApp:** choose **Link WhatsApp**. On your phone, open WhatsApp → Settings → Linked devices → Link a device and scan the QR code. New messages and selected media are captured while the app runs. Choose **Import older chats** to retrieve available history; expired media cannot always be recovered.
- **ChatGPT or Gemini:** open **Settings → Sources**, connect the account in the sign-in window, then choose **Import now**. ChatGPT reads conversations before downloading their images. Gemini imports generated images from its Library. You can keep browsing during imports. Turn on the schedule if you want periodic imports.

The app depends on these services' web clients. A completed import may still include failed requests; Sources shows failures so you can retry missing items. Previously saved items are skipped.

## Find and organise

**Gallery** searches chats, captions and filenames. Source, type, date and other filters narrow the results; **Clear all** removes the filters. The photo download contains all archived photos, regardless of the current filter. **Conversations** reads and searches saved WhatsApp message text.

AI sorting is optional. In **Settings → Albums & projects**, enable it, choose a provider, enter your own API key, test the connection and review what will be sent before accepting the notice. Review the estimate and monthly budget before starting. Sorting creates albums and conversation projects and adds image descriptions to search. Your edits to names and assignments are retained. Providers may charge for usage; free tiers have limits. Spare providers can keep sorting going when one reaches a limit.

## Understand your backup

The overview counts media files in your configured cloud folder and checks their sizes. **Back up now** checks again and copies missing or incomplete media when a local original is available. The cloud client performs the upload; check that client to confirm remote completion.

**Message text stays on this PC.** To export a readable copy, use **Settings → What to save → Export full transcript (local HTML)** and keep the export somewhere safe. Media-folder copies do not constitute a database backup.

The app stores settings, message databases and browser sessions under `%LOCALAPPDATA%\WhatsBackUp\`. Media uses the folder you chose. Keep browser sessions private: they contain account login state. Uninstalling preserves your archive.

## Clean up or post statuses

**Clean up** suggests possible copies, small images and similar items. Review them: a suggestion is not proof that a file is disposable. **Set aside selected** is reversible; **Delete selected forever** is permanent.

**Status Studio** is optional and separate from archiving. It posts from your WhatsApp account only after you enable it and turn off dry run. Review the audience, schedule and preview before going live.

## If something needs attention

| What you see | Next step |
|---|---|
| WhatsApp not connected | Follow the overview's linking step, or use Settings → Sources → Reconnect now. |
| Downloads failing | Check the connection and Settings → App → Check for updates. |
| Import incomplete | Read the error in Sources, check sign-in if needed, then Import now to retry. |
| Cloud folder offline | Reconnect your drive or cloud client, then Back up now. |
| Items remain local | Check that the originals exist and the cloud folder is writable. |
| Settings could not save | Read the error, correct the field or restore the connection, then save again. |
| AI cannot see photos | Test the selected provider/model and choose one that supports images. |

Closing the app window normally leaves capture running in the tray. **Quit WhatsBackUp** stops capture, imports and scheduled posts until you open it again.
