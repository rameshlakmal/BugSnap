// Manage the people who can use a hosted BugSnap server.
//
//   npm run user add <name>       add someone (asks for a password, prints their access key)
//   npm run user password <name>  set a new password
//   npm run user key <name>       make a new access key (the old one stops working)
//   npm run user list             who has access
//   npm run user remove <name>    take access away
//
// Restart the server after changes (sudo systemctl restart bugsnap).
import readline from 'node:readline';
import { config } from '../src/config.js';
import { Auth } from '../src/auth.js';

const [cmd, name] = process.argv.slice(2);
const auth = new Auth({ dataDir: config.dataDir });
await auth.load();

/** Read a password without showing it. BUGSNAP_PASSWORD works too (for scripts). */
function askHidden(question) {
  if (process.env.BUGSNAP_PASSWORD) return Promise.resolve(process.env.BUGSNAP_PASSWORD);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function newPassword() {
  const first = await askHidden('Password (10+ characters): ');
  if (!process.env.BUGSNAP_PASSWORD && first !== (await askHidden('Same password again: '))) throw new Error('The passwords did not match.');
  return first;
}

const showKey = (key) => {
  console.log(`\nAccess key for ${name}:\n\n  ${key}\n`);
  console.log('Paste it in BugSnap Settings → Server → Access key on their computer. Keep it private.');
};

try {
  if (cmd === 'add') {
    if (!name) throw new Error('Usage: npm run user add <name>');
    if (auth.find(name)) throw new Error(`${name} already exists. Use "password" or "key" instead.`);
    showKey(await auth.setUser(name, await newPassword()));
  } else if (cmd === 'password') {
    if (!auth.find(name)) throw new Error(`No user called ${name}`);
    await auth.setUser(name, await newPassword());
    console.log(`New password saved for ${name}.`);
  } else if (cmd === 'key') {
    showKey(await auth.newKeyFor(name));
  } else if (cmd === 'remove') {
    await auth.remove(name);
    console.log(`${name} can no longer use BugSnap.`);
  } else if (cmd === 'list') {
    if (!auth.users.length) console.log('No users yet. Add one: npm run user add <name>');
    for (const u of auth.users) console.log(`${u.name}  (added ${u.createdAt.slice(0, 10)})`);
  } else {
    console.log('Usage: npm run user add|password|key|remove <name>, or npm run user list');
    process.exit(1);
  }
  if (cmd !== 'list') console.log('Restart the server to apply: sudo systemctl restart bugsnap');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
