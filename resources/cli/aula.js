#!/usr/bin/env node
// `aula` — command-line control for AULA Toolkit (like Legion Toolkit's llt.exe).
// Runs as plain Node: the installed aula.cmd (aula on Linux) starts it with the app's own executable in
// ELECTRON_RUN_AS_NODE mode, so no separate Node install is needed. It forwards its arguments to the
// running app over a per-user named pipe (a socket on Linux) and prints the answer. If the app is not running, it starts
// it in the tray and waits for it.
'use strict';
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const user = os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_');
const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\aula-toolkit-${user}` : path.join(os.tmpdir(), `aula-toolkit-${user}.sock`);
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends the arguments once and resolves with the app's { ok, out } reply. */
function request() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PIPE);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ argv })}\n`));
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => {
      try { resolve(JSON.parse(buf.trim())); } catch { reject(new Error('AULA Toolkit sent an unreadable reply.')); }
    });
    sock.on('error', reject);
  });
}

/** Resolves true once the pipe accepts connections; sends nothing, so no command runs. */
function probe() {
  return new Promise((resolve) => {
    const sock = net.connect(PIPE);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
  });
}

/** Starts the installed app hidden in the tray. Only possible when we run inside the app's executable. */
function launchApp() {
  const exe = process.execPath;
  if (!/aula toolkit\.exe$|\/aula-toolkit$/i.test(exe)) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, ['--hidden'], { detached: true, stdio: 'ignore', env }).unref();
  return true;
}

(async () => {
  let res;
  try {
    res = await request();
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') { console.error(e.message); process.exit(1); }
    if (!launchApp()) { console.error('AULA Toolkit is not running. Start it and try again.'); process.exit(1); }
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(250); up = await probe(); }
    if (!up) { console.error('AULA Toolkit did not start in time.'); process.exit(1); }
    // Give the app a moment to attach the devices before running the actual command.
    await sleep(2500);
    try { res = await request(); } catch (err) { console.error(err.message); process.exit(1); }
  }
  (res.ok ? console.log : console.error)(res.out);
  process.exit(res.ok ? 0 : 1);
})();
