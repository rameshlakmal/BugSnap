# Set up Google Drive sharing

When this is set up, every finished recording is uploaded to a **BugSnap** folder in your Google Drive, made viewable by anyone with the link, and gets a public link to your own player on GitHub Pages:

```
Extension ──► local server (http://localhost:4800) ──► Google Drive (BugSnap folder, "anyone with the link")
                 fixes seeking, makes thumbnail              ▲
                                                             │ streams video + logs
Viewer opens https://<you>.github.io/bugsnap-viewer/?id=… ─┘
```

Takes about 20 minutes. You need a Google account (use a personal one: company Google accounts often block unverified apps) and a GitHub account.

> **Anyone with a link can watch that recording**, including people it gets forwarded to. Passwords and tokens are kept out of the logs, but the video shows whatever was on screen.

---

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in.
2. Project picker (top left) → **New project** → name it `BugSnap` → **Create**. Make sure it is selected afterwards.

## 2. Turn on the Google Drive API

1. Go to **APIs & Services → Library** (or <https://console.cloud.google.com/apis/library/drive.googleapis.com>).
2. Open **Google Drive API** → **Enable**.

## 3. Set up the sign-in screen

Google calls this the **OAuth consent screen**. In the current console it lives under **Google Auth Platform**.

1. Go to **APIs & Services → OAuth consent screen**, then click **Get started**.
2. **App information:** app name `BugSnap`, your email as support email → **Next**.
3. **Audience:** **External** → **Next**.
4. **Contact information:** your email → **Next** → agree → **Create**.
5. Open **Data Access** → **Add or remove scopes**.
   - Tick `.../auth/drive.file` ("See, edit, create, and delete only the specific Google Drive files you use with this app").
   - **Update** → **Save**.
   - This scope lets BugSnap see only the files it creates, never the rest of your Drive.
6. Open **Audience** → **Publish app** → **Confirm**.
   - Do this. While the app is in "Testing", Google ends the sign-in every 7 days.
   - With only the `drive.file` scope, publishing doesn't need a review by Google.
   - If you'd rather stay in Testing: add yourself under **Test users** and reconnect weekly.

## 4. Create the sign-in client for the server

1. Go to **Google Auth Platform → Clients** (or **APIs & Services → Credentials**).
2. Click **Create client**.
3. **Application type: Desktop app**, name `BugSnap server` → **Create**.
   - It must be **Desktop app**. That type lets the server sign in through `http://127.0.0.1:4800`. A "Web application" client gives a `redirect_uri_mismatch` error.
4. Copy the **Client ID** and **Client secret**.

## 5. Create the API key for the player

The public player uses this key to stream shared files from Drive.

1. **APIs & Services → Credentials → Create credentials → API key**. Copy the key.
2. Click the key to edit it.
   - **API restrictions:** **Restrict key** → choose **Google Drive API**.
   - **Application restrictions:** **Websites**, add `https://<your-github-name>.github.io/*`. You can add this after step 6.
   - **Save**.

The key is visible to anyone who opens the player; that is normal for this setup. The restrictions mean it only works for reading Drive files from your player.

## 6. Publish the player on GitHub Pages

1. Fill in the server settings first, so the build can find the API key:

   ```bash
   cd server
   cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
   ```

   Open `server/.env` and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `DRIVE_API_KEY`. Leave `VIEWER_URL` for now.

2. Build the player:

   ```bash
   npm run build:viewer        # writes ../viewer-site
   ```

3. On GitHub, create a new **public** repository named `bugsnap-viewer`. Leave it empty: no README, no license.
   - GitHub Pages on a private repo needs a paid plan.
   - The repo only holds the player, never any recordings.

4. Push the built folder:

   ```bash
   cd ../viewer-site
   git init -b main
   git add .
   git commit -m "BugSnap player"
   git remote add origin https://github.com/<your-github-name>/bugsnap-viewer.git
   git push -u origin main
   ```

5. On GitHub: repo **Settings → Pages** → **Source: Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**. After a minute the page is live at `https://<your-github-name>.github.io/bugsnap-viewer/`.

6. Put that address in `server/.env`, without a trailing slash:

   ```
   VIEWER_URL=https://<your-github-name>.github.io/bugsnap-viewer
   ```

   If you skipped the website restriction in step 5, add it now.

## 7. Connect your Drive

1. Restart the server: `npm start` in `server/`. It should print `Google Drive: not connected. Connect it in BugSnap Settings (click the extension icon, then the gear).`
2. Open **BugSnap Settings → Google Drive** (panel → gear) and click **Connect Google Drive**.
3. Choose your Google account and allow access.
   - If Google shows "Google hasn't verified this app": click **Advanced → Go to BugSnap**. It is your own app.
4. You land back on Settings showing **Connected**. Already have recordings? Click **Upload older recordings**.

## 8. Try it

1. Record a tab with the extension and stop.
2. The local player opens with **"Uploading to Google Drive…"**. When the message goes away, **Copy link** copies the public link. The popup's copy button does the same once the upload is done.
3. Open the link in a private window, or send it to someone. It plays with the steps, console and network tabs.
4. Files are in **My Drive → BugSnap**. Each recording has three files: the video (`.webm`), the thumbnail (`.jpg`) and the logs and details (`.json`).

---

## Everyday notes

- **Keep the server running** while you record (`npm start`). Viewers don't need it: they stream from Drive.
- **Stop sharing one recording:** in Drive, open its files and set sharing to **Restricted**, or delete them. The link stops working.
- **Disconnect:** Settings → **Disconnect**. Links you already shared keep working.
- **After updating BugSnap:** run `npm run build:viewer` again and push `viewer-site` so the public player matches.
- **Local copies** stay in `server/data`. Delete old recording folders there to free space; the Drive copies are not affected.

## Troubleshooting

| What you see | Fix |
|---|---|
| `redirect_uri_mismatch` when connecting | The OAuth client must be type **Desktop app** (step 4). |
| "Access blocked" / "This app is blocked" | You signed in with a company account that blocks outside apps. Use a personal Google account. |
| Settings says "Not set up" | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` missing in `server/.env`, or the server wasn't restarted. |
| "Google Drive access expired" | The app is still in Testing (7-day limit) or access was removed. Publish the app (step 3.6) and connect again. |
| Player says "Recording not found" | Check the API key: Drive API enabled in the same project, key restricted to **Google Drive API**, website restriction matches `https://<name>.github.io/*`. |
| Upload failed: storage quota | Your Drive is full. Free space, then click **Retry** in the local player. |
| Video stops loading after many views | Google limits downloads of very popular files for 24 hours. It recovers on its own. |
| Links point to `drive.google.com` instead of your player | `VIEWER_URL` isn't set. Set it and restart. Recordings uploaded before that keep their Drive link; use **Upload** in their player to republish. |
