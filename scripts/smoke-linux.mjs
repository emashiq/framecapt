/* global window, document */
// End-to-end check of the INSTALLED Linux build (experimental, docs/building-on-linux.md): installs
// the .deb with apt, starts it as a normal user on a real X server (WSLg, XWayland or Xvfb with a
// window manager), reads its log, drives it over a loopback DevTools port, records 3 s of the real
// screen into the default Videos folder, toggles launch-at-login, then runs the AppImage the same
// way and finally removes the package and proves the user's files stayed.
//
// Usage (Linux x64, after `npm run make`):
//   as a normal user with passwordless sudo:  npm run smoke:linux
//   as root (WSL):                            node scripts/smoke-linux.mjs --user <name>
// Needs DISPLAY (an X server). Everything is spawned with argument arrays (shell: false); the app
// runs with a temporary HOME, so nothing lands in the real home directory.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('smoke:linux runs on Linux x64 only.');
}
const argv = process.argv.slice(2);
const userArg = argv.indexOf('--user');
const isRoot = process.getuid?.() === 0;
const runAs = userArg === -1 ? undefined : argv[userArg + 1];
if (isRoot && !runAs)
  throw new Error('Running as root: pass --user <a normal user> to start the app as.');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

const debDir = path.join(root, 'out', 'make', 'deb', 'x64');
const deb = fs.existsSync(debDir)
  ? fs.readdirSync(debDir).find((name) => /^framecapt_.*_amd64\.deb$/.test(name))
  : undefined;
const appImageDir = path.join(root, 'out', 'make', 'AppImage', 'x64');
const appImage = fs.existsSync(appImageDir)
  ? fs.readdirSync(appImageDir).find((name) => name.endsWith('.AppImage'))
  : undefined;
if (!deb || !appImage)
  throw new Error('No .deb / .AppImage in out/make. Run `npm run make` first.');
const debPath = path.join(debDir, deb);
const appImagePath = path.join(appImageDir, appImage);

/** Commands that need root: direct as root, else through passwordless sudo. */
function privileged(file, args) {
  const result = isRoot
    ? spawnSync(file, args, { shell: false, encoding: 'utf8' })
    : spawnSync('sudo', ['-n', file, ...args], { shell: false, encoding: 'utf8' });
  return result;
}
const probeTool = (name) => path.join(root, 'vendor', 'ffmpeg', 'linux-x64', name); // the same build the package ships

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Starts the app (as the normal user, with a temporary HOME) and returns what is needed to drive it. */
async function startApp(label, file, extraArgs) {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `framecapt-smoke-${label}-`));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    DISPLAY: process.env.DISPLAY ?? ':0',
    // xvfb-run (CI) protects its X server with an authority file.
    ...(process.env.XAUTHORITY && { XAUTHORITY: process.env.XAUTHORITY }),
    ...(process.env.XDG_RUNTIME_DIR && { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
    ...(process.env.WAYLAND_DISPLAY && { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }),
    ...(process.env.PULSE_SERVER && { PULSE_SERVER: process.env.PULSE_SERVER }),
  };
  if (isRoot) fs.chownSync(home, Number(userId(runAs)), Number(groupId(runAs)));
  const args = [...extraArgs, `--remote-debugging-port=${port}`];
  const [cmd, cmdArgs] = isRoot
    ? [
        'runuser',
        [
          '-u',
          runAs,
          '--',
          'env',
          ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
          file,
          ...args,
        ],
      ]
    : [file, args];
  // The app's own stdout/stderr go to a file next to its HOME: printed when the run aborts.
  const out = fs.openSync(path.join(os.tmpdir(), `framecapt-smoke-${label}.out`), 'w');
  const child = spawn(cmd, cmdArgs, {
    stdio: ['ignore', out, out],
    shell: false,
    env: isRoot ? process.env : env,
    detached: true,
  });
  return { child, port, home };
}
const userId = (name) => spawnSync('id', ['-u', name], { encoding: 'utf8' }).stdout.trim();
const groupId = (name) => spawnSync('id', ['-g', name], { encoding: 'utf8' }).stdout.trim();

function stopApp(app) {
  if (app.child.pid) {
    try {
      process.kill(-app.child.pid, 'SIGKILL'); // the whole process group
    } catch {
      /* already gone */
    }
  }
}

async function waitFor(what, predicate, timeoutMs, everyMs = 300) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

const mainLog = (home) => {
  const file = path.join(home, '.config', 'FrameCapt', 'logs', 'main.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

async function attach(port) {
  const browser = await waitFor(
    'the DevTools port',
    () => chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined),
    30_000,
    500,
  );
  const page = await waitFor(
    'the app window',
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith('app://framecapt/index.html')),
    30_000,
    250,
  );
  return { browser, page };
}

let installed = false;
const apps = [];
try {
  // --- install the .deb -----------------------------------------------------------------------
  const info = spawnSync('dpkg-deb', ['-f', debPath], { encoding: 'utf8' }).stdout;
  check(
    'the .deb is package framecapt, amd64',
    /^Package: framecapt$/m.test(info) && /^Architecture: amd64$/m.test(info),
  );
  const install = privileged('apt-get', ['install', '-y', debPath]);
  installed = install.status === 0;
  check('apt installs the .deb', installed, install.status === 0 ? '' : install.stderr.slice(-300));
  if (!installed) throw new Error('install failed');
  const libDir = '/usr/lib/framecapt';
  const mode = fs.statSync(`${libDir}/chrome-sandbox`);
  check(
    'chrome-sandbox is root-owned and setuid (4755)',
    mode.uid === 0 && (mode.mode & 0o7777) === 0o4755,
  );
  check(
    '/usr/bin/framecapt is the app',
    fs.realpathSync('/usr/bin/framecapt') === `${libDir}/framecapt`,
  );
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const file = `${libDir}/resources/ffmpeg/linux-x64/${tool}`;
    let executable = false;
    try {
      fs.accessSync(file, fs.constants.X_OK);
      executable = true;
    } catch {
      /* missing or not executable */
    }
    check(`resources/ffmpeg/linux-x64/${tool} is present and executable`, executable);
  }
  check(
    'no Windows binary shipped',
    !fs.existsSync(`${libDir}/resources/ffmpeg/win32-x64`) &&
      !fs.existsSync(`${libDir}/FrameCapt.exe`),
  );
  check(
    'LICENSE, THIRD_PARTY_NOTICES.md and the FFmpeg PROVENANCE ship',
    ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'ffmpeg/linux-x64/PROVENANCE.json'].every((name) =>
      fs.existsSync(`${libDir}/resources/${name}`),
    ),
  );
  const desktop = fs.readFileSync('/usr/share/applications/framecapt.desktop', 'utf8');
  check(
    'the desktop entry has a name, categories and an icon',
    /^Name=FrameCapt$/m.test(desktop) &&
      /^Categories=.*Graphics/m.test(desktop) &&
      /^Icon=framecapt$/m.test(desktop),
  );

  // --- run the installed app ------------------------------------------------------------------
  const app = await startApp('deb', '/usr/bin/framecapt', []);
  apps.push(app);
  await waitFor('"ffmpeg ok" in main.log', () => mainLog(app.home).includes('ffmpeg ok'), 45_000);
  const log = mainLog(app.home);
  check(
    'main.log: starting + ffmpeg ok (bundled linux ffmpeg)',
    /FrameCapt .* starting/.test(log) && /ffmpeg ok ffmpeg version n9\.0/.test(log),
  );
  const { browser, page } = await attach(app.port);
  await page.waitForSelector('text=Capture', { timeout: 20_000 }).catch(() => undefined);
  const facts = await page.evaluate(() => ({
    title: document.title,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '',
    api: Object.keys(window.framecapt ?? {}).sort(),
  }));
  check(
    'the UI loads from app://framecapt, strict CSP, bridge = invoke + on',
    facts.title === 'FrameCapt' &&
      facts.csp.startsWith("default-src 'none'") &&
      JSON.stringify(facts.api) === '["invoke","on"]',
  );
  const appInfo = await page.evaluate(() => window.framecapt.invoke('app:getInfo'));
  check(
    'app:getInfo: linux, x64, packaged',
    appInfo.ok && appInfo.data.platform === 'linux' && appInfo.data.isPackaged === true,
  );
  check(
    'system audio switch is disabled with the reason',
    (await page.getByTestId('opt-system').isDisabled()) &&
      (await page.getByTestId('record-options').innerText()).includes('Not available on Linux yet'),
  );

  // launch at login = an XDG autostart entry
  const autostart = path.join(app.home, '.config', 'autostart', 'framecapt.desktop');
  await page.evaluate(() =>
    window.framecapt.invoke('settings:update', { patch: { general: { launchAtLogin: true } } }),
  );
  await waitFor('the autostart file', () => fs.existsSync(autostart), 10_000);
  const entry = fs.readFileSync(autostart, 'utf8');
  check(
    'launch at login writes ~/.config/autostart/framecapt.desktop (Exec ... --hidden)',
    /^Exec=\/usr\/lib\/framecapt\/framecapt --hidden$/m.test(entry),
  );
  await page.evaluate(() =>
    window.framecapt.invoke('settings:update', { patch: { general: { launchAtLogin: false } } }),
  );
  await waitFor('the autostart file to go', () => !fs.existsSync(autostart), 10_000);
  check('turning it off removes the file', !fs.existsSync(autostart));

  // a real recording into the default Videos folder (HOME is temporary: Videos/FrameCapt is created)
  const displays = await page.evaluate(() => window.framecapt.invoke('capture:listDisplays'));
  const display = displays.ok
    ? (displays.data.find((d) => d.isPrimary) ?? displays.data[0])
    : undefined;
  check(
    'capture:listDisplays lists a display',
    display !== undefined,
    display ? `${display.physicalSize.width}x${display.physicalSize.height}` : '',
  );
  const snapshot = async () => {
    const state = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
    return state.ok ? state.data : { status: 'error' };
  };
  const started = await page.evaluate(
    (id) =>
      window.framecapt.invoke('recorder:start', {
        target: 'screen',
        displayId: id,
        options: {
          mic: { enabled: false },
          systemAudio: true,
          quality: '1080p',
          fps: 30,
          countdown: false,
        },
      }),
    display.id,
  );
  check('recorder:start (system audio requested) is accepted', started.ok === true);
  await waitFor('recording', async () => (await snapshot()).status === 'recording', 30_000);
  await sleep(3000);
  await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
  const done = await waitFor(
    'the result',
    async () => {
      const state = await snapshot();
      return state.status === 'completed' ? state : state.status === 'error' ? 'error' : undefined;
    },
    60_000,
  );
  check('the recording completes', done !== 'error' && done?.result?.path !== undefined);
  const file = done?.result?.path ?? '';
  const videosDir = path.join(app.home, 'Videos', 'FrameCapt');
  check(
    'it was saved in ~/Videos/FrameCapt (created on demand)',
    file.startsWith(videosDir) && fs.existsSync(file),
    path.relative(app.home, file),
  );
  const probe = spawnSync(
    probeTool('ffprobe'),
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  const parsed = probe.status === 0 ? JSON.parse(probe.stdout) : { streams: [], format: {} };
  const video = parsed.streams.find((s) => s.codec_type === 'video');
  check(
    'VP9 WebM video, no audio track, about 3 s',
    video?.codec_name === 'vp9' &&
      !parsed.streams.some((s) => s.codec_type === 'audio') &&
      Number(parsed.format.duration) > 2.4 &&
      Number(parsed.format.duration) < 4.5,
    `${video?.width}x${video?.height} ${parsed.format.duration}s`,
  );
  const decode = spawnSync(
    probeTool('ffmpeg'),
    ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'rawvideo', '-y', '/dev/null'],
    { encoding: 'utf8' },
  );
  check(
    'it decodes without errors',
    decode.status === 0 && decode.stderr.trim() === '',
    decode.stderr.trim().slice(0, 200),
  );
  await browser.close().catch(() => undefined);
  stopApp(app);
  await sleep(1000);
  const userHome = app.home;

  // --- the AppImage ---------------------------------------------------------------------------
  if (isRoot) fs.chmodSync(appImagePath, 0o755);
  const image = await startApp('appimage', appImagePath, ['--appimage-extract-and-run']);
  apps.push(image);
  const imageReady = await waitFor(
    '"ffmpeg ok" from the AppImage',
    () => mainLog(image.home).includes('ffmpeg ok'),
    90_000,
  ).then(
    () => true,
    () => false,
  );
  check('the AppImage starts (--appimage-extract-and-run) and logs ffmpeg ok', imageReady);
  stopApp(image);
  await sleep(1000);

  // --- uninstall ------------------------------------------------------------------------------
  const remove = privileged('apt-get', ['remove', '-y', 'framecapt']);
  installed = remove.status !== 0;
  check('apt remove succeeds', remove.status === 0);
  check(
    'the package files are gone',
    !fs.existsSync('/usr/lib/framecapt') && !fs.existsSync('/usr/bin/framecapt'),
  );
  check(
    'the user recording and settings are still there',
    fs.existsSync(file) && fs.existsSync(path.join(userHome, '.config', 'FrameCapt')),
  );
} catch (error) {
  console.error(error);
  for (const app of apps) {
    console.error(`--- ${app.home}: main.log ---
${mainLog(app.home)}`);
    const out = path.join(
      os.tmpdir(),
      `framecapt-smoke-${path.basename(app.home).split('-')[2]}.out`,
    );
    if (fs.existsSync(out))
      console.error(`--- app output ---
${fs.readFileSync(out, 'utf8').slice(-4000)}`);
  }
  failures.push(`aborted: ${error instanceof Error ? error.message : error}`);
} finally {
  for (const app of apps) {
    stopApp(app);
    fs.rmSync(app.home, { recursive: true, force: true, maxRetries: 3 });
  }
  if (installed) privileged('apt-get', ['remove', '-y', 'framecapt']);
}
if (failures.length > 0) {
  console.error(`smoke:linux FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('smoke:linux OK');
