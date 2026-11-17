# Google Drive sharing

**The easy way:** run `setup.cmd`, then follow `http://localhost:4800/setup`. It has a link for every step below, checks your values as you go, and saves them for you. This page is the same steps written out, for reference.

```
Extension ──► BugSnap on your computer ──► your Google Drive (BugSnap folder, "anyone with the link")
                                                  ▲
                                                  │ streams video + logs
Share link opens https://<your-player>/?id=…   (your own player: Vercel, GitHub Pages or any host)
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

1. [Create an API key](https://console.cloud.google.com/apis/credentials) (Create credentials, API key). Edit it: API restrictions, Restrict key, tick **Google Drive API**, Save. You can also restrict it to your player's address under Website restrictions. (The key is public by design: every viewer of a share link receives it.)
2. Host the player where you prefer:
   - **Vercel** (copy can be private): [import your copy](https://vercel.com/new), leave the build settings as they are (`vercel.json` sets them), add the environment variable `DRIVE_API_KEY`, Deploy. Use the short address under **Domains**, like `https://your-project.vercel.app`; the long deployment addresses ask viewers to log in. After changing the key: **Deployments → ⋯ → Redeploy**.
   - **GitHub Pages** (copy must be public): **Settings → Secrets and variables → Actions → Variables**, add `DRIVE_API_KEY`. **Settings → Pages → Source: GitHub Actions.** **Actions → Player → Run workflow.** The address is `https://<you>.github.io/<your-copy>`.
   - **Anywhere else**: save the key on the setup page, run `npm run build:viewer` in `server`, upload the `viewer-site` folder (for example to [Netlify Drop](https://app.netlify.com/drop)).
3. On the setup page, pick the same host, fill in the key and the player address, then **Save and check**.

Vercel and GitHub Pages rebuild the player whenever you push to your copy.

## Without the setup page

The same values can go in `server/.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DRIVE_API_KEY`, `VIEWER_URL`); values saved on the setup page win. Then connect Drive in the extension: Settings → Google Drive → Connect.
