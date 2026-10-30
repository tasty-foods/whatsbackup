# Connect Gmail and Google Photos

One Google Desktop OAuth client can serve both connections. Each source asks for
its own permission and stores separate encrypted authorization in Windows.

1. Create or select a project in [Google Cloud](https://console.cloud.google.com/).
   Enable the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   and [Google Photos Picker API](https://console.cloud.google.com/apis/library/photospicker.googleapis.com)
   for the sources you want.
2. Configure the Google OAuth consent screen. If the project is in Testing,
   add your Google account as a test user. Google or your organization may need
   to approve the requested scopes; a shared public client can require verification.
3. Create an OAuth client of type **Desktop app**. In WhatsBackUp, open
   **Settings → Sources → Google connection setup**, paste its client ID and
   optional client secret, and choose **Save Google client**. Credentials are
   encrypted with Windows secure storage and omitted from HTTP settings and diagnostics.
4. Choose **Connect Gmail** or **Connect Google Photos**. Complete sign-in in
   your normal browser. The app receives authorization through a local callback;
   it does not receive your Google password.
5. For Gmail, choose **Import attachments**, with an optional Gmail search and
   schedule. For Photos, choose **Choose photos**, finish selecting items in
   Google, then **Import selection**.

Gmail uses read-only permission. It copies file attachments and embedded media
parts, including documents, photos, videos and other files. It does not modify
mail, follow external image trackers, or download files merely linked from an email.
Completed attachments remain saved when an import is stopped; later passes skip
verified duplicates and retain their message provenance.

Google Photos Picker grants access only to the selected items, with up to 2,000
items per selection. Google's photo downloads omit location metadata; video
downloads are high-quality transcodes. For original files or a whole-library
archive, use [Google Takeout](https://takeout.google.com/), extract all ZIP parts,
then choose **Import an exported Google Photos folder** in Sources. That path
needs no OAuth client. Neither connection deletes originals from Google.

Official references: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Photos API overview](https://developers.google.com/photos/overview/about),
[Photos downloads](https://developers.google.com/photos/picker/guides/media-items),
[Takeout guide](https://support.google.com/accounts/answer/3024190).
