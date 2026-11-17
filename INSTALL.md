# Install BugSnap on your computer

A step-by-step guide for a new Windows laptop. About **15 minutes** with share links, **5 minutes** without.

You end up with your own copy of BugSnap: your own Google app, your own Drive, your own share player. Nothing is shared with anyone else, including whoever made the template.

---

## Before you start

| You need | Why |
| --- | --- |
| Windows 10 or 11 | BugSnap runs a small helper program in the background |
| Chrome, Brave or Edge | For the extension |
| A GitHub account | To make your own copy and host your share player (free) |
| A Google account *(optional)* | Only if you want share links. A **personal** account works best: company accounts often block new apps |

You do **not** need to install Node.js, ffmpeg or anything else yourself. Setup does it.

---

## Step 1. Make your own copy

1. Open the BugSnap page on GitHub and click **Use this template → Create a new repository**.
2. Give it a name, for example `bugsnap`.
3. Choose **Public**. Free GitHub Pages (your share player) needs this. Your recordings are never stored in the repository, only the player's code.
4. Click **Create repository**.

## Step 2. Download it

On your new repository, click **Code → Download ZIP**.

1. Right-click the ZIP → **Properties** → tick **Unblock** (if you see it) → **OK**. This stops Windows from warning about every file.
2. Right-click → **Extract All**, and put the folder somewhere permanent, for example `Documents\bugsnap`. **Don't leave it in Downloads**: the browser extension loads from this folder.

> Using git? `git clone https://github.com/<you>/<your-copy>.git` works too.

## Step 3. Run setup

Double-click **`setup.cmd`** in the folder.

- If Windows shows **"Windows protected your PC"**, click **More info → Run anyway**.
- If it asks for permission to install Node.js or ffmpeg, click **Yes**.

Setup has four parts and prints each one:

```
[1/4] Node.js and ffmpeg     installs them if they are missing
[2/4] BugSnap server         downloads its parts, creates its settings file
[3/4] Start in background    starts BugSnap now and every time you log in
[4/4] Open setup page        opens http://localhost:4800/setup in your browser
```

When it finishes, the setup page opens by itself. Leave the black window open until you've read it, then close it. BugSnap keeps running in the background.

## Step 4. Follow the setup page

The page at **http://localhost:4800/setup** walks you through the rest, with a link for every step.

### 4a. Where should recordings go?

- **Google Drive**: you get share links anyone can open. Continue with 4b and 4c.
- **Only this computer**: no setup. Recordings stay on your laptop and links only work on it. Skip to Step 5.

### 4b. Your Google app (about 5 minutes)

BugSnap uses your own Google app to save to your Drive. Each link on the page opens the right Google Cloud screen:

1. **Create a project** named `BugSnap`.
2. **Turn on the Google Drive API**. Check that the BugSnap project is selected at the top of the page.
3. **Set up the sign-in screen**: Get started, app name `BugSnap`, your email, audience **External**, Create.
4. **Add the Drive permission**: Add or remove scopes, paste `https://www.googleapis.com/auth/drive.file` under "Manually add scopes", Update, Save.
5. **Publish the app**: Publish app, Confirm. Don't skip this: an app left in "Testing" signs you out every 7 days.
6. **Create the sign-in client**: type **Desktop app**, name `BugSnap`, Create.

Paste the **client ID** and **client secret** on the setup page and click **Save and connect Drive**. Sign in with Google. If Google says *"Google hasn't verified this app"*, click **Advanced → Go to BugSnap**. It's your own app, so this is expected.

### 4c. Your share player (about 3 minutes)

The player is the web page that opens when someone clicks a share link. It runs free on your GitHub copy.

1. **Create an API key** in Google Cloud: Create credentials → API key. Then edit it: **API restrictions → Restrict key → Google Drive API → Save**.
2. On your GitHub copy: **Settings → Secrets and variables → Actions → Variables tab → New repository variable**.
   Name: `DRIVE_API_KEY`. Value: the key.
3. **Settings → Pages → Source: GitHub Actions.**
4. **Actions tab → Player → Run workflow.** Wait about a minute until it shows a green tick.
5. Back on the setup page, paste the key, check the player address (it's usually filled in for you: `https://<you>.github.io/<your-copy>/`) and click **Save and check**.

## Step 5. Add the extension to your browser

The setup page copies the folder path for you.

1. Open your browser's extensions page:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
2. Turn on **Developer mode** (top right in Chrome and Brave, left side in Edge).
3. Click **Load unpacked** and pick the **`extension`** folder inside your BugSnap folder (paste the copied path into the address bar of the folder picker).
4. Click the puzzle-piece icon in the toolbar and **pin** BugSnap so it's always visible.

## Step 6. Try it

- Click the BugSnap icon on any website → **Record this tab**. Click stop when done, and the recording opens with its link.
- Or press **Alt+Shift+S** for the capture bar: screenshot or recording, of an area or the whole page.

| Shortcut | Does |
| --- | --- |
| Alt+Shift+S | Open the capture bar |
| Alt+Shift+P | Pause or resume a recording |
| Alt+Shift+X | Stop and save a recording |

Change them at `chrome://extensions/shortcuts`.

## Step 7. Connect your tools (optional)

Open the extension's **Settings** (the gear in the BugSnap popup):

- **AI reports**: pick a provider and paste its key, or use Claude Code with no key.
- **GitHub**: a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **Issues: Read and write**.
- **More tools**: **Jira, GitLab, Slack, Notion**. Each card links to the page where you make the token and takes about a minute.

Tokens stay on your computer. They are never sent to the browser or to anyone else.

---

## Updating

1. Get the new files (download the ZIP again, or `git pull`) and copy them over your BugSnap folder. **Keep your `server\data` folder and `server\.env` file**: they hold your recordings and settings.
2. Double-click **`setup.cmd`** again. It restarts BugSnap with the new version.
3. On your extensions page, click the **reload** icon on the BugSnap card.

## Something not working?

| Problem | Fix |
| --- | --- |
| Setup says **winget is not available** | Install "App Installer" from the Microsoft Store, then run `setup.cmd` again. Or install [Node.js LTS](https://nodejs.org) and [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) yourself. |
| Setup says **port 4800 is in use** | Another program uses that port. Close it, or restart the laptop and run setup again. |
| The extension says it **can't reach BugSnap** | Run `setup.cmd` again. It restarts the background helper. The log is in `server\data\server.log`. |
| Google says **access blocked** | Use a personal Google account, and check step 4b.5 (publish the app). |
| A share link shows **"Can't load this recording"** | Check the player variable and Pages setting in step 4c, then run the Player workflow again. |
| Nothing happens on **Alt+Shift+S** | Another app uses the shortcut. Change it at `chrome://extensions/shortcuts`. |

To check everything without changing anything, open a terminal in the folder and run:

```
setup.cmd -Check
```

## Uninstall

1. Remove the extension from your extensions page.
2. Stop the background start: `powershell -ExecutionPolicy Bypass -File server\scripts\windows\install-autostart.ps1 -Uninstall`
3. Delete the BugSnap folder. Recordings already on Google Drive stay in the **BugSnap** folder on your Drive.
