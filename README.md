# BugSnap: internal screen recorder and bug reporter

Record a browser tab or the whole screen, with console logs, network logs, environment details and a readable list of user steps. Share the result as a short link that opens in a player with everything synced to the video.

Plan and phases: see the "Screen Recorder & Bug Reporter: Build Plan" doc.

**Settings:** panel → gear (or right-click the BugSnap icon → Options). One page for your name, server, location, Google Drive, AI reports, GitHub and shortcuts; changes save as you make them.

**Screenshots:** panel → *Capture screenshot* or Alt+Shift+S. Drag to select an area (Enter = whole visible page, Esc = cancel). The editor opens in a new tab: arrow, box, highlight, pen, text, numbered markers and blur, six colours, four thicknesses ([ and ]), undo/redo (Ctrl+Z / Ctrl+Y). Click a mark to select it: drag to move, drag its handles to adjust (arrow ends, box corners), arrow keys to nudge, double-click text to edit, Delete to remove; colour and thickness apply to the selected mark. Ctrl+C or *Copy image* copies the annotated PNG; Download saves it. It is **saved the moment the editor opens** (listed under *Screenshots*, shared on Drive like a recording), and every change saves automatically. *Annotate* on a screenshot in Recordings or the player reopens it with its marks still editable; the unmarked original stays on this computer and is never shared. Screenshots capture the visible page and its details (URL, browser, OS, viewport); console and network logs are only captured in recordings.

**AI bug reports:** in the player's *Report* tab, describe what happened, pick *Bug* or *Suggestion* and click *Write with Claude*. Reports are written by the provider you pick in **BugSnap Settings → AI reports**: Claude Code on this computer (your Claude plan, no key), an API key for Anthropic, OpenAI, Google Gemini or OpenRouter (the model list comes from the provider), or local models through Ollama (free, nothing leaves your PC). It writes the issue in the team template: title `Page - problem` (or `[suggestion] Page - It would be better to …`), Description, Preconditions, Steps to reproduce, Attachments, Actual result, Expected result. Claude Code needs to be installed and signed in (`claude` once in a terminal); an API key is saved only in `server/data/ai.json` (or set `ANTHROPIC_API_KEY`). Optional: `CLAUDE_CODE_PATH`, `AI_MODEL` (Claude Code model, default `sonnet`).

**GitHub issues:** in the player, *Send to GitHub* opens a form pre-filled from the report (title and description), with the repository, labels, assignees and milestone. *Create issue* files it and links it to the recording (#12 badge in Recordings, link in the player). Set up once in **BugSnap Settings → GitHub** with a fine-grained token: repository access to your bug repos, permission **Issues: Read and write**. The token is stored only in `server/data/github.json` (or set `GITHUB_TOKEN`).

**Sharing:** finished recordings upload to your Google Drive and get a public link to your player on GitHub Pages. Setup: [SETUP-GOOGLE-DRIVE.md](SETUP-GOOGLE-DRIVE.md). Without it, recordings stay on this computer.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Tab and desktop recording, metadata, console/network/actions capture, readable steps, local storage, viewer with short link and synced timeline, bug report draft (template) | **Built** |
| 1.1 | New design language, in-page control bar (countdown, pause/resume, stop, discard), redesigned screen picker window, reliability and security fixes | **Built** |
| 1.2 | Recordings window, rounded panel, Figtree type, Google Drive sharing with a public GitHub Pages player | **Built** |
| 1.3 | Graphite + red design, Jam-style player (custom controls, DevTools panel), review screen, share link reserved at start, Drive fallback player, tooltips | **Built** |
| 2 | Area screenshots with annotation, AI bug reports (Claude Code or API key), GitHub issues | **Built** |
| 3 | Redaction rules UI, MP4 transcode, instant replay, voice narration, retention, Intune rollout | Later |

## Layout

```
extension/   Chrome/Edge extension (Manifest V3, plain JavaScript, no build step)
  background.js      service worker: start/stop, metadata, navigation tracking, event routing
  page-hook.js       runs in the page: console, errors, fetch, XHR (injected only while recording)
  content.js         isolated world: relays page events, records user actions as sentences
  overlay.js         floating control bar on the recorded page (countdown, timer, pause, stop, discard)
  ui.css             design tokens and components (shared with server/public/tokens.css)
  lib/icons*.js      bundled Phosphor icons (full set for extension pages, small set for pages)
  fonts/             self-hosted Figtree (UI) and Geist Mono (logs)
  recorder-core.js   MediaRecorder, chunked upload, environment details (OS, browser, location)
  offscreen.*        hosts tab recordings (chrome.tabCapture)
  recorder.*         window that hosts the screen/window choice and Chrome's picker (getDisplayMedia)
  popup.*            record, stop, last recording, settings
  panel.js           shows popup.html in a rounded in-page panel on toolbar click
                     (Chrome's own popup is used on chrome://, Web Store and PDF pages)
  snip.js            area selection on the page for screenshots
  snap.*             screenshot editor (annotations, title, save and share)
  library.*          Recordings window: thumbnail grid, hover preview, click to play
                     (same files served by the server as its home page)
server/      Node + Express
  src/index.js       API, local player (/r/:id), settings page, Drive upload queue
  src/github.js      GitHub issues (fine-grained token, repos, labels, assignees, create)
  src/ai.js          AI bug reports: Claude Code (print mode, restricted) or the Claude API (@anthropic-ai/sdk)
  src/drive.js       Google Drive: sign-in, BugSnap folder, resumable upload, "anyone with link" sharing
  src/storage/       local working copies (video, poster, events)
  scripts/build-viewer.js  builds the public player for GitHub Pages into ../viewer-site
  src/media.js       ffmpeg remux so browser WebM becomes seekable, plus poster frame
  public/            player (local and public), recordings grid, settings
  test/smoke.js      end-to-end API test
  test/drive-mock.js Drive publishing against a fake Google (resume, manifest, sharing)
```

## Run it

Requirements: Node 22.9+, Chrome or Edge 116+, ffmpeg on PATH (optional, but needed for smooth seeking and thumbnails).

```bash
cd server
npm install
npm start            # http://localhost:4800
npm run smoke        # in another terminal: end-to-end check
npm run test:drive   # Drive upload logic, offline
```

Settings go in `server/.env` (copy `server/.env.example`); it is loaded automatically.

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4800` | HTTP port |
| `HOST` | `127.0.0.1` | Only this computer can reach the server. `0.0.0.0` to accept other machines (then set `UPLOAD_TOKEN`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Google Drive sign-in (see SETUP-GOOGLE-DRIVE.md) |
| `DRIVE_API_KEY` | empty | Key the public player uses; only needed for `npm run build:viewer` |
| `VIEWER_URL` | empty | Your GitHub Pages player, e.g. `https://you.github.io/bugsnap-viewer` |
| `DRIVE_FOLDER_NAME` | `BugSnap` | Drive folder for uploads |
| `PUBLIC_BASE_URL` | `http://localhost:PORT` | Base for share links, e.g. `https://rec.yourco.com` |
| `UPLOAD_TOKEN` | empty | Shared secret the extension must send to upload. Set it on any shared server. |
| `DATA_DIR` | `server/data` | Where recordings are stored |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary |
| `DISABLE_LIST` | empty | Set to `1` to hide the list of all recordings (it has no sign-in) |

Load the extension:

1. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**.
2. **Load unpacked** → select the `extension` folder.
3. Pin BugSnap, open the popup → gear icon (**Settings**): check the server URL, add the upload token if you set one, and your name.

After pulling changes: restart the server, then press the reload icon on the extension card in `chrome://extensions`.

## Manual test checklist (Phase 1)

- [ ] **Panel:** click the toolbar icon on a website: a rounded panel opens top-right. Clicking the page or pressing Esc closes it. On `chrome://extensions` the plain popup opens instead.
- [ ] **Recordings window:** popup → grid icon or *All recordings*. Thumbnails show, hovering plays a muted preview, clicking opens the player in a browser tab. Opening it twice focuses the same window.
- [ ] **Tab recording:** on any website click *Record this tab*. The panel closes at once and the dark control bar at the bottom shows *Starting…*, then a 3-2-1 countdown, then the timer. Click around, type in a field, trigger a console error (`console.error('test')` in DevTools), stop with the bar, the popup or Alt+Shift+X. The viewer opens.
- [ ] **Control bar:** pause and resume (also Alt+Shift+P); the timer freezes while paused and the paused part is not in the video. Drag the bar by its handle; minimise it to a dot. *Discard* asks once more, then throws the recording away.
- [ ] Steps tab shows sentences like `Clicks the "Pricing" link`, `Navigates to the "Pricing" page`; password fields show `Enters a hidden value`.
- [ ] Console and Network tabs list entries; failed requests and errors are red and appear as red marks on the timeline.
- [ ] Clicking a step seeks the video; playback highlights the current step.
- [ ] Details tab shows OS (Windows 11 is detected correctly), browser, window/viewport size, time zone, location, visited URLs.
- [ ] Report tab has a draft with preconditions, numbered steps and captured errors; *Copy as Markdown* works.
- [ ] **Screen recording:** popup → *Screen* opens a small window sized to its content: pick *Screen*, *Window* or *Tab*, then *Start*. The window grows so Chrome's picker fits, opens on that choice, and shrinks back if you cancel. After the countdown it minimises and the control bar takes over. Tab switches and navigations appear as steps.
- [ ] Cancelling Chrome's picker returns to the choice screen (no error, nothing saved).
- [ ] Stopping via Chrome's own "Stop sharing" bar also saves the recording.
- [ ] **Screenshot:** Alt+Shift+S on a website, drag an area, annotate (arrow, box, blur, number, text), *Save and copy link*. The link opens the image in the player; *Report → Write with Claude* works.
- [ ] **GitHub:** Settings → GitHub → paste token → default repository. In a player: *Send to GitHub* → labels/assignees → *Create issue* → *Open on GitHub*.
- [ ] **After stopping:** no new tab opens. The bar at the bottom shows *Saved · Copy link · Open* for about 10 seconds (hovering keeps it). *Copy link* copies the public link; *Open* opens the player with the review screen (title, description, delete).
- [ ] **DevTools panel:** drag its left edge to resize (double-click resets); the width is remembered.
- [ ] **Drive:** the share link exists from the start. Opened before the upload finishes it shows *Uploading…* and switches to the video by itself. Turning off Wi-Fi mid-upload shows *Retry* in the local player.
- [ ] **Player:** custom controls (Space, J/L, M, F), red dots on the progress bar for errors with a label on hover, *Copy link ▾ → Copy link at 0:07*, DevTools panel (Info, Steps, Console, Network, Report).
- [ ] Share link opens for someone else; *Pop out* opens the player in its own window; `#network`, `#console` etc. on a link open that tab.

## Known limits

- Shared links are "anyone with the link": whoever has a link can watch that recording. Stop sharing one by setting its Drive files to Restricted.
- The server must be running while you record and upload; viewers stream from Drive and don't need it.
- Console and network capture hooks the page's own `console`, `fetch` and `XMLHttpRequest`. Requests from service workers, iframes and the browser itself (images, CSS) are not captured. Headers and cookies are never captured; token-like query parameters are redacted; response bodies are kept only for failed requests (first 2,000 characters).
- Recordings stop automatically after 30 minutes.
- Desktop recordings capture video of anything, but logs and steps only come from browser tabs.
- The control bar is part of the page, so it appears in tab recordings. Minimise it to a dot if it is in the way.
- Chrome's own screen picker dialog cannot be restyled by extensions. The recorder window chooses which pane it opens on and gives it room.
