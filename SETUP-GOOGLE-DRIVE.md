# Google Drive sharing

**The easy way:** run `setup.cmd`, then follow `http://localhost:4800/setup`. It has a link for every step below, checks your values as you go, and saves them for you. This page is the same steps written out, for reference.

```
Extension ──► BugSnap on your computer ──► your Google Drive (BugSnap folder, "anyone with the link")
                                                  ▲
                                                  │ streams video + logs
Share link opens https://<you>.github.io/<your-copy>/?id=…   (your own player, built by your copy)
```

Everything here is yours: your Google app, your Drive, your player. Use a personal Google account (company accounts often block apps they haven't approved).

> **Anyone with a link can watch that recording**, including people it gets forwarded to. Passwords and tokens are kept out of the logs, but the video shows whatever was on screen.

## Your Google app (about 5 minutes)

1. [Create a project](https://console.cloud.google.com/projectcreate) named `BugSnap`.
2. [Turn on the Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) (check the BugSnap project is selected at the top).
3. [Set up the sign-in screen](https://console.cloud.google.com/auth/overview): Get started, app name `BugSnap`, your email, audience **External**, Create.
4. [Add the Drive permission](https://console.cloud.google.com/auth/scopes): Add or remove scopes, paste `https://www.googleapis.com/auth/drive.file` under "Manually add scopes", Update, Save. BugSnap can only see the files it creates.
5. [Publish the app](https://console.cloud.google.com/auth/audience): Publish app, Confirm. **Don't skip this:** an app left in "Testing" is signed out by Google every 7 days. No Google review is needed for this permission.
6. [Create the sign-in client](https://console.cloud.google.com/auth/clients/create): type **Desktop app**, name `BugSnap`, Create. Paste the **client ID** and **client secret** on the setup page and click **Save and connect Drive**.

## Your share player (about 3 minutes)

1. [Create an API key](https://console.cloud.google.com/apis/credentials) (Create credentials, API key). Edit it: API restrictions, Restrict key, tick **Google Drive API**, Save. You can also restrict it to your player's address under Website restrictions.
2. In your copy on GitHub: **Settings → Secrets and variables → Actions → Variables → New repository variable**, name `DRIVE_API_KEY`, value: the key. (The key is public by design: every viewer of a share link receives it.)
3. **Settings → Pages → Source: GitHub Actions.**
4. **Actions → Player → Run workflow.** After about a minute the player is live at `https://<you>.github.io/<your-copy>/`.
5. On the setup page, fill in the key and the player address, then **Save and check**.

The player rebuilds by itself whenever its files change in your copy.

## Without the setup page

The same values can go in `server/.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DRIVE_API_KEY`, `VIEWER_URL`); values saved on the setup page win. Then connect Drive in the extension: Settings → Google Drive → Connect.
