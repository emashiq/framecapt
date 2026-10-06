/* global window, document */
// Smoke test of the PACKAGED app (out/FrameCapt-win32-x64/FrameCapt.exe, or on Linux
// out/FrameCapt-linux-x64/framecapt; fuses on): it starts, the
// renderer loads from the asar through the app://framecapt scheme (not file://), the CSP meta tag is there, the bridge exposes only invoke/on, and
// a payload with an extra key is refused. Usage: npm run smoke:packaged (after `npm run package`).
// The app runs with a temporary --user-data-dir and a DevTools port that only listens on loopback.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isLinux = process.platform === 'linux';
const exe = isLinux
  ? path.join(root, 'out', 'FrameCapt-linux-x64', 'framecapt')
  : path.join(root, 'out', 'FrameCapt-win32-x64', 'FrameCapt.exe');
if (!fs.existsSync(exe)) throw new Error(`${exe} not found. Run \`npm run package\` first.`);

const wire = await getCurrentFuseWire(exe);
const fuseOk = (option, state) => wire[option] === state;
const port = await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-smoke-'));
const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
  stdio: 'ignore',
  shell: false,
  detached: isLinux, // own process group, so the whole tree can be ended below
});
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

try {
  check(
    'GrantFileProtocolExtraPrivileges fuse is off',
    fuseOk(FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE),
  );
  let browser;
  for (let attempt = 0; attempt < 40 && !browser; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
  }
  if (!browser) throw new Error('could not attach to the packaged app');
  let page;
  for (let attempt = 0; attempt < 40 && !page; attempt += 1) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().startsWith('app://framecapt/index.html'));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check('the renderer loads from the packaged app via app://framecapt', page !== undefined);
  if (page) {
    await page.waitForSelector('text=Capture', { timeout: 15_000 }).catch(() => undefined);
    const facts = await page.evaluate(() => ({
      title: document.title,
      rendered: document.body.innerText.length > 20,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '',
      api: Object.keys(window.framecapt ?? {}).sort(),
      node: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
    }));
    check('the UI rendered', facts.rendered && facts.title === 'FrameCapt', facts.title);
    check("CSP meta tag with default-src 'none'", facts.csp.startsWith("default-src 'none'"));
    check(
      'the bridge exposes exactly invoke and on',
      JSON.stringify(facts.api) === '["invoke","on"]',
    );
    check('no Node globals in the page', facts.node === false);
    const info = await page.evaluate(() => window.framecapt.invoke('app:getInfo'));
    check('app:getInfo answers, packaged', info.ok && info.data.isPackaged === true);
    check(
      'updates are unconfigured in this build',
      info.ok && info.data.updates.state === 'unconfigured',
    );
    const extra = await page.evaluate(() =>
      window.framecapt.invoke('history:list', { path: 'C:/x' }),
    );
    check('an extra key is refused', !extra.ok && extra.error.code === 'INVALID_PAYLOAD');
    const unknown = await page.evaluate(() => window.framecapt.invoke('shell:openExternal', {}));
    check('an unknown channel is refused', !unknown.ok && unknown.error.code === 'UNKNOWN_CHANNEL');
    const remote = await page.evaluate(() =>
      fetch('https://example.com/', { mode: 'no-cors' }).then(
        () => 'reached',
        () => 'blocked',
      ),
    );
    check('a network request from the page is blocked', remote === 'blocked');
  }
  await browser.close().catch(() => undefined);
} finally {
  if (child.pid && isLinux) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  } else if (child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
if (failures.length > 0) {
  console.error(`smoke:packaged FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('smoke:packaged OK');
