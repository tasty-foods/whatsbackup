# Installing WhatsBackUp

WhatsBackUp keeps a copy of every photo, video and message from your WhatsApp — on your PC, and in a cloud folder if you have one.

You need: a Windows 10 or 11 PC, and the phone your WhatsApp runs on. Nothing else — no Node, no Chrome, no accounts to create.

---

## 1. Run the installer

Double-click **WhatsBackUp-Setup-1.0.0.exe**.

**Windows will probably warn you: "Windows protected your PC".** That is expected. The installer isn't signed with a paid certificate, so Windows doesn't recognise the publisher yet — it says nothing about whether the app is safe.

To continue: click **More info**, then **Run anyway**.

Your antivirus may also flag it once. The app carries its own copy of Chrome (that's how it talks to WhatsApp Web), and antivirus software sometimes treats "an app with a browser inside it that reads messages" as suspicious on sight. If it gets quarantined, restore it and allow it.

The app installs for your user only, so it never asks for an administrator password.

## 2. First run

WhatsBackUp asks four short questions:

1. **A short notice to read and accept** — the important part is that this is *not* an official WhatsApp app (see below).
2. **Where to keep your media** — its own folder, or anywhere you like. Pick a drive with room; photos and videos add up.
3. **A cloud folder (optional)** — if you use pCloud, OneDrive, Dropbox or a network drive, point it there and videos are written straight in, so your cloud client syncs them off the PC.
4. **Start with Windows** — recommended, since the app only captures while it's running.

## 3. Link your phone

A QR code appears. On your phone:

**WhatsApp → Settings → Linked devices → Link a device** → scan the code.

That's it. From then on every photo and video you send or receive is saved automatically. To also pull in what's already in your chats, open **⚙︎ Settings → History → Import history now**.

---

## Things worth knowing

**It is not an official WhatsApp app.** It connects the same way WhatsApp Web does, using an open-source library that WhatsApp doesn't endorse. WhatsApp's terms don't permit unofficial clients, and there is a real if small chance an account gets limited or banned for using one. If that risk isn't acceptable to you, don't install it.

**It saves other people's media too.** Everything sent to you in a chat gets archived, and the people who sent it never agreed to that. Keep the copies to yourself.

**Nothing leaves your PC.** Media goes to your folders (and your own cloud folder if you set one). Message text stays on the PC only. There is no server, no account, no telemetry.

**It has to keep running.** WhatsApp only delivers to a connected device. If you quit the app, anything that arrives while it's closed is missed — though **Import history** can often pick it up afterwards.

**WhatsApp changes break it sometimes.** WhatsApp updates its website without warning, and that can stop capture dead. The app watches for this: if downloads start failing it turns the tray icon amber and tells you. Keep automatic updates on so fixes reach you.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| Tray icon is amber, "capture may be broken" | ⚙︎ Settings → App → **Check for updates**. |
| "Device unlinked" | Open the app and scan the QR code again. |
| Videos aren't in the cloud folder | ⚙︎ Settings → Where → **Check**. If the drive is offline, videos are saved locally until it returns. |
| Nothing is being captured | ⚙︎ Settings → Connection → **Reconnect now**, then **Restart capture** on the App tab. |
| You want to hand over details for help | ⚙︎ Settings → App → **Copy diagnostic report**, then paste it into an email. |

Uninstalling leaves your saved photos, videos and messages exactly where they are.
