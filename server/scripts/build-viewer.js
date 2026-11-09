// Builds the public player for GitHub Pages into ../viewer-site (or the folder given as
// the first argument). The player streams shared recordings straight from Google Drive.
//
//   npm run build:viewer            (reads DRIVE_API_KEY from server/.env)
//
// Then push the folder to your GitHub Pages repo (see SETUP-GOOGLE-DRIVE.md).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '..', 'public');
const out = path.resolve(process.argv[2] || path.resolve(here, '..', '..', 'viewer-site'));
const apiKey = process.env.DRIVE_API_KEY || '';

if (!apiKey) {
  console.error('DRIVE_API_KEY is not set. Add it to server/.env (see SETUP-GOOGLE-DRIVE.md).');
  process.exit(1);
}

await fs.mkdir(path.join(out, 'fonts'), { recursive: true });

for (const f of ['viewer.js', 'viewer.css', 'tokens.css', 'icons.js', 'tooltip.js', 'logo.svg', 'theme.js', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'site.webmanifest']) {
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

// GitHub project pages live under /<repo>/, so make every asset path relative.
let html = await fs.readFile(path.join(pub, 'viewer.html'), 'utf8');
html = html.replace(/(href|src)="\/(?!\/)/g, '$1="');
const anchor = '<link rel="stylesheet" href="tokens.css" />';
if (!html.includes(anchor)) throw new Error('viewer.html changed: could not insert config.js');
html = html.replace(anchor, `${EARLY}\n    ${anchor}`);
await fs.writeFile(path.join(out, 'index.html'), html);

// The key is public by design (it ships to every viewer). Restrict it in Google Cloud to the
// Drive API and to your GitHub Pages address.
await fs.writeFile(path.join(out, 'config.js'), `window.SCREENREC_CONFIG = ${JSON.stringify({ driveApiKey: apiKey }, null, 2)};\n`);
await fs.writeFile(path.join(out, '.nojekyll'), '');
await fs.writeFile(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

console.log(`Player built in ${out}`);
console.log('Push this folder to your GitHub Pages repo, then set VIEWER_URL in server/.env to its address.');
