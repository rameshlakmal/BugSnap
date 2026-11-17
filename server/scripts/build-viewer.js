// Builds the public share player into ../viewer-site (or the folder given as the first
// argument). The player streams shared recordings straight from Google Drive.
//
// Vercel (vercel.json) and the GitHub Pages workflow (.github/workflows/player.yml) run this on
// every push, with DRIVE_API_KEY from their settings. For any other host: npm run build:viewer,
// which uses the key saved on the setup page (or server/.env), then upload the folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '..', 'public');
const out = path.resolve(process.argv[2] || path.resolve(here, '..', '..', 'viewer-site'));
const apiKey = process.env.DRIVE_API_KEY || (await savedKey());

// The key saved on the setup page (server/data/setup.json), for builds on this computer.
async function savedKey() {
  try {
    const dataDir = process.env.DATA_DIR || path.resolve(here, '..', 'data');
    return JSON.parse(await fs.readFile(path.join(dataDir, 'setup.json'), 'utf8')).driveApiKey || '';
  } catch {
    return '';
  }
}

if (!apiKey) {
  console.error('DRIVE_API_KEY is not set. Vercel: Settings, Environment Variables. GitHub Pages: a repository variable. This computer: save the key on the setup page first.');
  process.exit(1);
}

await fs.mkdir(path.join(out, 'fonts'), { recursive: true });

for (const f of ['viewer.js', 'viewer.css', 'tokens.css', 'icons.js', 'tooltip.js', 'logo.svg', 'theme.js', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'site.webmanifest', 'privacy.html']) {
  await fs.copyFile(path.join(pub, f), path.join(out, f));
}
for (const f of await fs.readdir(path.join(pub, 'fonts'))) {
  await fs.copyFile(path.join(pub, 'fonts', f), path.join(out, 'fonts', f));
}

// Speed: connect to Google while the page loads, and fetch the recording's details from Drive
// straight from the <head> instead of after every script has downloaded.
const EARLY = `<link rel="preconnect" href="https://www.googleapis.com" crossorigin />
    <link rel="preconnect" href="https://www.googleapis.com" />
    <script src="config.js"></script>
    <script>
      (function () {
        var c = window.SCREENREC_CONFIG || {}, id = new URLSearchParams(location.search).get('id');
        if (!c.driveApiKey || !id) return;
        window.__bugsnapManifest = fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&key=' + encodeURIComponent(c.driveApiKey), { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      })();
    </script>`;

// Relative asset paths, so the player also works from a sub-folder.
let html = await fs.readFile(path.join(pub, 'viewer.html'), 'utf8');
html = html.replace(/(href|src)="\/(?!\/)/g, '$1="');
const anchor = '<link rel="stylesheet" href="tokens.css" />';
if (!html.includes(anchor)) throw new Error('viewer.html changed: could not insert config.js');
html = html.replace(anchor, `${EARLY}\n    ${anchor}`);
await fs.writeFile(path.join(out, 'index.html'), html);

// The key is public by design (it ships to every viewer). Restrict it in Google Cloud to the
// Drive API and to your player's address.
await fs.writeFile(path.join(out, 'config.js'), `window.SCREENREC_CONFIG = ${JSON.stringify({ driveApiKey: apiKey }, null, 2)};\n`);
await fs.writeFile(path.join(out, '.nojekyll'), '');
await fs.writeFile(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

console.log(`Player built in ${out}`);
console.log('Publish this folder on any static host, then put its address on the setup page.');
