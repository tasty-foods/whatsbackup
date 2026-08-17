# Installing WhatsBackUp

WhatsBackUp keeps a copy of every photo, video and message from your WhatsApp — on your PC, and in a cloud folder if you have one.

You need: a Windows 10 or 11 PC, and the phone your WhatsApp runs on. Nothing else — no Node, no Chrome, no accounts to create.

---

## 1. Run the installer

Double-click **WhatsBackUp-Setup-1.1.0.exe**.

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

## 4. AI sorting (optional)

Left alone, your archive is one long list in date order. AI sorting reads it and groups it: photos land in albums it names itself — *Deliveries*, *Machine repairs*, *Paperwork* — and conversations group under the project or subject they're actually about. Search then finds a photo by what is *in* it, including text it read off the picture.

This is the one part of the app that talks to the outside world, so it is off until you switch it on, and it needs an API key of your own:

1. **⚙︎ Settings → AI sorting → Enable.**
2. **Pick a provider and paste your key.** Anthropic, OpenAI, Google Gemini, OpenRouter and Groq all work. So do **Ollama** and **LM Studio** running on your own PC, which need no key and cost nothing — with those, nothing leaves the machine.
3. **Test connection.** It asks the model three questions and tells you the answers separately: whether the key and model name are real, whether it can follow a strict format, and whether it can actually see images. A model that can't see images will still sort your conversations; it just leaves the photos alone rather than failing hundreds of times over.
4. **Read the notice.** *Show me exactly what leaves my PC* prints the literal data for one photo and one chat. Nothing is sent until you accept it.
5. **Analyse now.** It shows the estimated cost first — for a library of a few hundred photos and a couple of hundred chats, roughly **$1.50** with the default model. Results are cached, so a second run only pays for what's new.

Afterwards it stays out of your way: **Manual** sorts only when you ask, **Manual then automatic** starts sorting new arrivals once you've done the first pass, and **Automatic** handles everything as it lands. A monthly budget cap stops it either way.

Rename an album or drag a photo into a different one and it stays that way — the next sort is told about your corrections and works around them rather than undoing them.

---

## Things worth knowing

**It is not an official WhatsApp app.** It connects the same way WhatsApp Web does, using an open-source library that WhatsApp doesn't endorse. WhatsApp's terms don't permit unofficial clients, and there is a real if small chance an account gets limited or banned for using one. If that risk isn't acceptable to you, don't install it.

**It saves other people's media too.** Everything sent to you in a chat gets archived, and the people who sent it never agreed to that. Keep the copies to yourself.

**Nothing leaves your PC unless you switch on AI sorting.** Media goes to your folders (and your own cloud folder if you set one). Message text stays on the PC. There is no account, no server of ours, and no telemetry.

The single exception is **AI sorting**, which is off until you turn it on. When it is on, it sends your photos and a sample of your message text to the AI provider *you* choose, using *your* own API key — Anthropic, OpenAI, Google, OpenRouter, Groq, or a model running on your own machine via Ollama or LM Studio, in which case nothing leaves the PC at all. Before the first call it shows you the literal data it would send and asks you to accept it, and ⚙︎ Settings → AI sorting → **Show me exactly what leaves my PC** will show you again at any time. Your key is encrypted with Windows' own protection and never appears in logs or the diagnostic report. **Delete all AI labels and albums** removes everything it produced.

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
| AI sorting says the key is wrong | ⚙︎ Settings → AI sorting → **Test connection**. It says which of the three checks failed. |
| Photos didn't get sorted but chats did | The model you picked can't see images. Test connection says so; pick a vision model. |
| You want to hand over details for help | ⚙︎ Settings → App → **Copy diagnostic report**, then paste it into an email. Your API key is never in it. |

Uninstalling leaves your saved photos, videos and messages exactly where they are.
