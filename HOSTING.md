# Hosting BugSnap on a server

Run the BugSnap server on an always-on machine (for example an Oracle Cloud Always Free VM) so you
don't need to keep it running on your computer. The public player on GitHub Pages stays the same.

What you end up with:

- `https://<your-domain>`: your BugSnap server with automatic HTTPS (Caddy).
- Sign-in for everything: each person has a name, a password (web pages) and a personal
  **access key** (the extension).
- BugSnap runs as a service: it starts on boot and restarts if it stops.

## 1. Create the server

Ubuntu 24.04, 1-2 CPU cores and 1 GB RAM or more is plenty. On Oracle Cloud: an Always Free
`VM.Standard.A1.Flex` (Arm) with Canonical Ubuntu 24.04. Make sure ports **80 and 443** are open
in the cloud firewall (Oracle: VCN → Security List → Ingress rules). The setup script opens them
on the machine itself.

## 2. Pick an address

No domain? Use your server's public IP with [sslip.io](https://sslip.io): IP `129.154.10.20` →
`129-154-10-20.sslip.io`. It points to your server automatically and works with HTTPS.
If you have a domain, point an `A` record at the server's IP and use that name instead.

## 3. Run the setup script

SSH into the server, then:

```bash
curl -fsSL https://raw.githubusercontent.com/rameshlakmal/BugSnap/master/server/deploy/setup.sh -o setup.sh
bash setup.sh 129-154-10-20.sslip.io
```

It installs Node 22, ffmpeg and Caddy, downloads BugSnap to `/opt/bugsnap/app`, keeps data in
`/opt/bugsnap/data`, and starts the `bugsnap` service.

## 4. Bring over your settings and recordings

From your computer (PowerShell), copy your data folder and `.env` values to the server:

```powershell
scp -i <your-ssh-key> -r "server\data" ubuntu@<server-ip>:/tmp/bugsnap-data
```

Then on the server:

```bash
sudo cp -r /tmp/bugsnap-data/. /opt/bugsnap/data/ && sudo chown -R bugsnap:bugsnap /opt/bugsnap/data && rm -rf /tmp/bugsnap-data
sudo -u bugsnap nano /opt/bugsnap/app/server/.env      # fill GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, VIEWER_URL, DRIVE_API_KEY
```

This keeps your Google Drive connection, GitHub token, AI settings and all recordings.

## 5. Add people

```bash
cd /opt/bugsnap/app/server
sudo -u bugsnap npm run user add ramesh        # asks for a password, prints an access key
sudo systemctl restart bugsnap
```

Other commands: `npm run user list`, `npm run user password <name>`, `npm run user key <name>`
(new access key), `npm run user remove <name>`.

## 6. Point the extension at it

BugSnap Settings → **Server**: address `https://<your-domain>`, **Access key** `bsk_…`.
The chip at the top should say *Server connected*.

Signing in on the web pages (`https://<your-domain>`) uses the name and password.

## 7. Things that work differently on a server

- **AI reports:** *Claude Code* runs on your own computer with your Claude plan, so it is not
  available on a server. Pick Anthropic, OpenAI, Google Gemini or OpenRouter with an API key in
  Settings → AI reports.
- **Google Drive:** the connection you copied keeps working. To connect a different Google
  account from the server, create an OAuth client of type **Web application** in Google Cloud
  Console with the redirect URI `https://<your-domain>/auth/google/callback`, put its ID and
  secret in `.env`, add `GOOGLE_REDIRECT_URI=https://<your-domain>/auth/google/callback`, restart,
  then use Settings → Google Drive → Connect.

## Everyday commands

| What | Command |
|---|---|
| Update to the latest code | `bash /opt/bugsnap/app/server/deploy/update.sh` |
| Logs | `sudo journalctl -u bugsnap -f` |
| Restart | `sudo systemctl restart bugsnap` |
| Back up data | `sudo tar czf ~/bugsnap-data-$(date +%F).tgz -C /opt/bugsnap data` |

## Oracle Always Free: keep the VM

Oracle may reclaim Always Free VMs that stay almost idle (very low CPU, network and memory use
over 7 days). BugSnap for one or two people is that light. Upgrading the account to
**Pay As You Go** stops reclamation; Always Free resources stay free on it, but anything beyond
the free limits would be charged, so only create Always Free shapes. Check Oracle's current
Always Free documentation for the exact rules.
