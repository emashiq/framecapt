/* global window, document */
// End-to-end check of the INSTALLED app on this Windows host: silent Squirrel install, launch,
// real screenshot and real recording through the global shortcuts, MP4 auto-export, 60 s without a
// network connection, silent uninstall. Usage: npm run smoke:installed [-- --setup <Setup.exe>]
// (after `npm run make`). It changes the machine, so it is careful:
//   - it refuses to run when Framelet is already installed or running (it never touches that);
//   - everything it modifies in the real profile (%APPDATA%\Framelet, the Run key, sentinel files in
//     the default output folders) is backed up first and restored / removed in `finally`;
//   - the capture steps run a SECOND instance with --user-data-dir in a temp folder and the output
//     folders set there, so no capture lands in Pictures\Framelet or Videos\Framelet;
//   - it removes only what it created.
// Real input: Framelet's own global shortcuts are pressed with SendInput (tests/native/fixtures)
// and a display is picked with a real mouse click in the selection overlay.
// Everything is spawned with argument arrays (shell: false). Evidence (redacted: no user name, no
// absolute home paths): docs/evidence/phase10/installed-smoke.json. Needs an interactive desktop.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'native', 'fixtures');
const evidencePath = path.join(root, 'docs', 'evidence', 'phase10', 'installed-smoke.json');
const argv = process.argv.slice(2);
const setupArg = argv.indexOf('--setup');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evidence = {
  date: new Date().toISOString(),
  host: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model?.trim() },
  checks: [],
  notes: [],
};
const failures = [];
function check(name, ok, detail = '') {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${text ? `  (${text})` : ''}`);
  evidence.checks.push({ name, ok, detail });
  if (!ok) failures.push(name);
}

// --- helpers ---------------------------------------------------------------------------------

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });

function run(file, args, options = {}) {
  return spawnSync(file, args, { shell: false, windowsHide: true, encoding: 'utf8', ...options });
}
function powershell(script) {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}
function psFile(file, args) {
  return run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    file,
    ...args,
  ]);
}
function sendKeys(...keys) {
  const result = psFile(path.join(fixtures, 'send-keys.ps1'), keys);
  if (result.status !== 0) throw new Error(`send-keys ${keys.join('+')} failed: ${result.stderr}`);
}
function clickAt(x, y) {
  const result = psFile(path.join(fixtures, 'click-at.ps1'), [String(x), String(y)]);
  if (result.status !== 0) throw new Error(`click-at failed: ${result.stderr}`);
}
function json(text) {
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}
async function waitFor(what, predicate, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const home = os.homedir();
function redact(text) {
  let out = text;
  for (const variant of [home, home.replaceAll('\\', '/'), home.replaceAll('\\', '\\\\')]) {
    out = out.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '~');
  }
  return out;
}
const processes = () =>
  json(
    powershell(
      'Get-Process -Name Framelet,Update -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; path = $_.Path; title = $_.MainWindowTitle } } | ConvertTo-Json -Compress',
    ).out,
  );
const killTree = (pid) => run('taskkill', ['/PID', String(pid), '/T', '/F']);
const folder = (name) => powershell(`[Environment]::GetFolderPath('${name}')`).out;

// --- locations ---------------------------------------------------------------------------------

const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
if (!localAppData || !appData) throw new Error('LOCALAPPDATA/APPDATA are not set.');
const installRoot = path.join(localAppData, 'Framelet');
const userDataReal = path.join(appData, 'Framelet');
const pictures = folder('MyPictures');
const videos = folder('MyVideos');
const defaultShots = path.join(pictures, 'Framelet');
const defaultVideos = path.join(videos, 'Framelet');
const startMenu = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const desktop = folder('DesktopDirectory');
const UNINSTALL_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Framelet';
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** Every value of the per-user Run key (name -> data): where "launch at login" lives. */
const runValues = () =>
  Object.fromEntries(
    json(
      powershell(
        `(Get-Item -Path '${RUN_KEY}').GetValueNames() | ForEach-Object { [pscustomobject]@{ name = $_; data = [string](Get-ItemPropertyValue -Path '${RUN_KEY}' -Name $_) } } | ConvertTo-Json -Compress`,
      ).out,
    ).map((v) => [v.name, v.data]),
  );

const setupExe =
  setupArg === -1
    ? (() => {
        const dir = path.join(root, 'out', 'make', 'squirrel.windows', 'x64');
        const found = fs.existsSync(dir)
          ? fs.readdirSync(dir).find((n) => /^Framelet-Setup-.*\.exe$/.test(n))
          : undefined;
        if (!found) throw new Error(`No Framelet-Setup-*.exe in ${dir}. Run \`npm run make\`.`);
        return path.join(dir, found);
      })()
    : path.resolve(argv[setupArg + 1] ?? '');
if (!fs.existsSync(setupExe)) throw new Error(`${setupExe} not found`);

// --- pre-flight (refuse to disturb an existing install) ------------------------------------

if (processes().length > 0)
  throw new Error('Framelet is running. Close it first; nothing was changed.');
if (fs.existsSync(installRoot)) {
  throw new Error(`${installRoot} exists. Uninstall it first; nothing was changed.`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-installed-'));
const backupDir = path.join(tempRoot, 'userdata-backup');
const state = {
  appDataExisted: fs.existsSync(userDataReal),
  appDataSnapshot: new Map(), // relative path -> `${size}:${mtimeMs}`
  companyFolderExisted: fs.existsSync(path.join(startMenu, 'Framelet contributors')),
  picturesExisted: fs.existsSync(defaultShots),
  videosExisted: fs.existsSync(defaultVideos),
  sentinels: [],
  runBefore: {},
  appProc: undefined,
};

function snapshot(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const stat = fs.statSync(full);
    map.set(path.relative(dir, full), `${stat.size}:${stat.mtimeMs}`);
  }
  return map;
}

/** Puts %APPDATA%\Framelet back to the snapshot: restores changed/removed files, removes new ones. */
function restoreUserData() {
  if (!state.appDataExisted) {
    fs.rmSync(userDataReal, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return 'removed (it did not exist before the test)';
  }
  let restored = 0;
  let removed = 0;
  const now = snapshot(userDataReal);
  for (const [rel] of now) {
    if (!state.appDataSnapshot.has(rel)) {
      fs.rmSync(path.join(userDataReal, rel), { force: true, maxRetries: 5, retryDelay: 300 });
      removed += 1;
    }
  }
  for (const [rel, stamp] of state.appDataSnapshot) {
    if (now.get(rel) !== stamp) {
      const target = path.join(userDataReal, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(backupDir, rel), target);
      restored += 1;
    }
  }
  // Directories the test created and left empty.
  for (const entry of fs
    .readdirSync(userDataReal, { recursive: true, withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => b.parentPath.length + b.name.length - (a.parentPath.length + a.name.length))) {
    const dir = path.join(entry.parentPath, entry.name);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  return `${restored} file(s) restored, ${removed} new file(s) removed`;
}

const cleanupNotes = [];
function cleanup() {
  for (const proc of processes()) {
    if (proc.path?.toLowerCase().startsWith(installRoot.toLowerCase())) killTree(proc.pid);
  }
  if (state.appProc?.pid) killTree(state.appProc.pid);
  try {
    cleanupNotes.push(`user data: ${restoreUserData()}`);
  } catch (error) {
    cleanupNotes.push(`user data restore FAILED: ${String(error)}`);
  }
  for (const sentinel of state.sentinels) fs.rmSync(sentinel, { force: true });
  if (!state.picturesExisted) fs.rmSync(defaultShots, { recursive: true, force: true });
  if (!state.videosExisted) fs.rmSync(defaultVideos, { recursive: true, force: true });
  // The Run key: remove what the test added, restore what it changed.
  try {
    const now = runValues();
    for (const name of Object.keys(now)) {
      if (!(name in state.runBefore)) {
        powershell(
          `Remove-ItemProperty -Path '${RUN_KEY}' -Name '${name.replaceAll("'", "''")}' -ErrorAction SilentlyContinue`,
        );
        cleanupNotes.push(`removed Run value "${name}" made by the test`);
      }
    }
    for (const [name, data] of Object.entries(state.runBefore)) {
      if (now[name] !== data) {
        powershell(
          `Set-ItemProperty -Path '${RUN_KEY}' -Name '${name.replaceAll("'", "''")}' -Value '${data.replaceAll("'", "''")}'`,
        );
        cleanupNotes.push(`restored Run value "${name}"`);
      }
    }
  } catch (error) {
    cleanupNotes.push(`Run key restore FAILED: ${String(error)}`);
  }
  // A failed uninstall must not leave the test install behind (this script created it).
  if (fs.existsSync(installRoot)) {
    const update = path.join(installRoot, 'Update.exe');
    if (fs.existsSync(update)) run(update, ['--uninstall', '-s'], { timeout: 60_000 });
    fs.rmSync(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    cleanupNotes.push('install dir removed by cleanup (uninstall had left it)');
  }
  // Squirrel makes a Start Menu folder named after the publisher and leaves it, empty, behind.
  const companyFolder = path.join(startMenu, 'Framelet contributors');
  if (
    !state.companyFolderExisted &&
    fs.existsSync(companyFolder) &&
    fs.readdirSync(companyFolder).length === 0
  ) {
    fs.rmdirSync(companyFolder);
    cleanupNotes.push('removed the empty Start Menu folder Squirrel left');
  }
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

async function main() {
  // --- back up what the test will touch --------------------------------------------------------
  state.appDataSnapshot = snapshot(userDataReal);
  if (state.appDataExisted) fs.cpSync(userDataReal, backupDir, { recursive: true });
  state.runBefore = runValues();
  evidence.backup = {
    userDataExisted: state.appDataExisted,
    userDataFiles: state.appDataSnapshot.size,
    picturesFolderExisted: state.picturesExisted,
    videosFolderExisted: state.videosExisted,
    runKeyValues: Object.keys(state.runBefore).length,
  };
  // Sentinels in the DEFAULT output folders: they must survive the uninstall unchanged.
  fs.mkdirSync(defaultShots, { recursive: true });
  fs.mkdirSync(defaultVideos, { recursive: true });
  const sentinelPictures = path.join(defaultShots, 'framelet-uninstall-sentinel.txt');
  const sentinelVideos = path.join(defaultVideos, 'framelet-uninstall-sentinel.txt');
  fs.writeFileSync(sentinelPictures, `sentinel ${evidence.date}\n`);
  fs.writeFileSync(sentinelVideos, `sentinel ${evidence.date}\n`);
  state.sentinels.push(sentinelPictures, sentinelVideos);
  const sentinelHashes = [sha256(sentinelPictures), sha256(sentinelVideos)];

  const displays = json(
    powershell(
      'Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class D { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }\'; [void][D]::SetProcessDPIAware(); [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; primary = $_.Primary } } | ConvertTo-Json -Compress',
    ).out,
  );
  evidence.displays = displays;
  check('displays found', displays.length > 0, `${displays.length}`);
  const primary = displays.find((d) => d.primary) ?? displays[0];

  // --- install ---------------------------------------------------------------------------------
  const setupStat = fs.statSync(setupExe);
  evidence.setup = {
    file: path.basename(setupExe),
    bytes: setupStat.size,
    sha256: sha256(setupExe),
  };
  const sig = powershell(`(Get-AuthenticodeSignature -LiteralPath '${setupExe}').Status`).out;
  evidence.setup.authenticode = sig;
  check(
    'the installer is honestly UNSIGNED (no certificate was configured)',
    sig === 'NotSigned',
    sig,
  );

  const installStarted = Date.now();
  const install = run(setupExe, ['--silent'], { timeout: 180_000 });
  evidence.install = { exitCode: install.status, seconds: (Date.now() - installStarted) / 1000 };
  check('Setup.exe --silent exits 0', install.status === 0, `exit ${install.status}`);

  const updateExe = path.join(installRoot, 'Update.exe');
  const appDir = await waitFor(
    'the app folder',
    () =>
      fs.existsSync(installRoot) &&
      fs
        .readdirSync(installRoot)
        .find((n) => /^app-\d/.test(n) && fs.existsSync(path.join(installRoot, n, 'Framelet.exe'))),
    60_000,
  ).then((n) => path.join(installRoot, n));
  const exe = path.join(appDir, 'Framelet.exe');
  check(
    'installed to %LOCALAPPDATA%\\Framelet (Update.exe + app-<version>\\Framelet.exe)',
    fs.existsSync(updateExe) && fs.existsSync(exe),
    redact(appDir),
  );
  evidence.installDir = redact(installRoot);
  evidence.installedFiles = {
    exeBytes: fs.statSync(exe).size,
    asarBytes: fs.statSync(path.join(appDir, 'resources', 'app.asar')).size,
  };

  // Packaged resources (extraResource copies vendor/ffmpeg by name).
  const ffDir = path.join(appDir, 'resources', 'ffmpeg', 'win32-x64');
  const wanted = ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE', 'PROVENANCE.json'];
  const missing = wanted.filter((n) => !fs.existsSync(path.join(ffDir, n)));
  check(
    'resources/ffmpeg/win32-x64 has ffmpeg.exe, ffprobe.exe, LICENSE, PROVENANCE.json',
    missing.length === 0,
    missing.join(',') || 'all present',
  );
  check(
    'app.asar is present, resources are not unpacked',
    fs.existsSync(path.join(appDir, 'resources', 'app.asar')),
  );

  // Version resource and fuses of the installed exe.
  const info = json(
    powershell(
      `$v = (Get-Item -LiteralPath '${exe}').VersionInfo; [pscustomobject]@{ product = $v.ProductName; company = $v.CompanyName; description = $v.FileDescription; version = $v.ProductVersion } | ConvertTo-Json -Compress`,
    ).out,
  )[0];
  evidence.exeVersionInfo = info;
  check(
    'the exe carries the provisional product name',
    info?.product === 'Framelet',
    JSON.stringify(info),
  );
  try {
    const { getCurrentFuseWire, FuseV1Options, FuseState } = await import('@electron/fuses');
    const wire = await getCurrentFuseWire(exe);
    const name = (index) => FuseV1Options[index];
    evidence.fuses = Object.fromEntries(
      Object.entries(wire)
        .filter(([key]) => /^\d+$/.test(key))
        .map(([key, value]) => [
          name(Number(key)),
          value === FuseState.ENABLE
            ? 'enabled'
            : value === FuseState.DISABLE
              ? 'disabled'
              : 'removed',
        ]),
    );
    check(
      'GrantFileProtocolExtraPrivileges fuse is OFF in the installed exe',
      wire[FuseV1Options.GrantFileProtocolExtraPrivileges] === FuseState.DISABLE,
      JSON.stringify(evidence.fuses),
    );
  } catch (error) {
    check('read the installed exe fuses', false, String(error));
  }

  // --silent installs without launching the app (Squirrel starts it only after an interactive
  // install). Record it, and make sure the install did not stall on the network.
  await sleep(3000);
  const launchedBySetup = processes().some((p) => p.name === 'Framelet');
  evidence.silentInstallLaunchesApp = launchedBySetup;
  evidence.notes.push(
    'Setup.exe --silent does not start the app afterwards (Squirrel launches it, with --squirrel-firstrun, only for an interactive install).',
  );
  check(
    'the silent install finished quickly without any network wait (no iconUrl download)',
    evidence.install.seconds < 60,
    `${evidence.install.seconds} s`,
  );
  for (const proc of processes())
    if (proc.path?.toLowerCase().startsWith(installRoot.toLowerCase())) killTree(proc.pid);

  // --- the first run, as Squirrel starts it after an interactive install --------------------
  // Framelet.exe --squirrel-firstrun must start the app normally (it is not a quit-early hook).
  const firstData = path.join(tempRoot, 'userdata-firstrun');
  fs.mkdirSync(firstData, { recursive: true });
  const firstPort = await freePort();
  const firstRun = spawn(
    exe,
    ['--squirrel-firstrun', `--remote-debugging-port=${firstPort}`, `--user-data-dir=${firstData}`],
    {
      stdio: 'ignore',
      shell: false,
    },
  );
  state.appProc = firstRun;
  const titled = await waitFor(
    'the first-run window',
    () => processes().find((p) => p.name === 'Framelet' && p.title)?.title,
    40_000,
  ).catch(() => undefined);
  check(
    '--squirrel-firstrun starts the app and shows its window',
    titled !== undefined,
    titled ?? 'no window',
  );
  check('the main window title is "Framelet"', titled === 'Framelet', titled ?? 'none');
  const firstLog = path.join(firstData, 'logs', 'main.log');
  const logText = await waitFor(
    'the startup self-check in main.log',
    () =>
      fs.existsSync(firstLog) && /ffmpeg ok /.test(fs.readFileSync(firstLog, 'utf8'))
        ? fs.readFileSync(firstLog, 'utf8')
        : undefined,
    20_000,
  ).catch(() => (fs.existsSync(firstLog) ? fs.readFileSync(firstLog, 'utf8') : ''));
  const logLines = logText.split(/\r?\n/);
  const starting = logLines.find((line) => /Framelet \d+\.\d+\.\d+ starting/.test(line));
  const ffok = logLines.find((line) => /ffmpeg ok /.test(line));
  check(
    'main.log shows the startup line',
    Boolean(starting),
    starting ? redact(starting).slice(0, 120) : 'missing',
  );
  check(
    'main.log shows the FFmpeg self-check ("ffmpeg ok <version>")',
    Boolean(ffok),
    ffok ? redact(ffok).slice(0, 120) : 'missing',
  );
  evidence.firstRunLog = {
    starting: starting ? redact(starting) : null,
    ffmpeg: ffok ? redact(ffok) : null,
  };
  // Launch at login, switched on in the real app (Settings). It must write the Squirrel form of the
  // Run entry, and that entry must really start the app: the command line is run exactly as Windows
  // runs a Run value (CreateProcess on the stored string).
  let firstBrowser;
  for (let attempt = 0; attempt < 40 && !firstBrowser; attempt += 1) {
    await sleep(500);
    firstBrowser = await chromium
      .connectOverCDP(`http://127.0.0.1:${firstPort}`)
      .catch(() => undefined);
  }
  const firstPage =
    firstBrowser &&
    (await waitFor(
      'the first-run page',
      () =>
        firstBrowser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().startsWith('app://framelet/index.html')),
      20_000,
    ).catch(() => undefined));
  const enable =
    firstPage &&
    (await firstPage.evaluate(() =>
      window.framelet.invoke('settings:update', { patch: { general: { launchAtLogin: true } } }),
    ));
  check(
    'Settings: launch at login can be switched on in the installed app',
    Boolean(enable?.ok),
    enable?.ok ? '' : (enable?.error?.message ?? 'no page'),
  );
  const loginEntry = await waitFor(
    'the Run entry',
    () => Object.entries(runValues()).find(([name]) => !(name in state.runBefore)),
    15_000,
  ).catch(() => undefined);
  evidence.launchAtLogin = loginEntry ? { name: loginEntry[0], data: redact(loginEntry[1]) } : null;
  const loginParts = loginEntry ? /^"([^"]+)"\s*(.*)$/.exec(loginEntry[1]) : null;
  check(
    'the Run entry starts Update.exe --processStart Framelet.exe --process-start-args --hidden (no stray quote characters)',
    Boolean(loginParts) &&
      loginParts[1].toLowerCase() === updateExe.toLowerCase() &&
      loginParts[2] === '--processStart Framelet.exe --process-start-args --hidden',
    loginEntry ? redact(loginEntry[1]) : 'no entry',
  );
  await firstBrowser?.close().catch(() => undefined);
  killTree(firstRun.pid);
  await waitFor(
    'the first run to end',
    () => processes().filter((p) => p.name === 'Framelet').length === 0,
    20_000,
  );
  if (loginParts) {
    // Run it as Windows runs a Run value: CreateProcess on the stored command line, verbatim.
    const loginRun = spawn(loginParts[1], [loginParts[2]], {
      windowsVerbatimArguments: true,
      stdio: 'ignore',
      shell: false,
    });
    void loginRun;
    const mainCommandLine = () =>
      json(
        powershell(
          `Get-CimInstance Win32_Process -Filter "Name='Framelet.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.CommandLine } | ConvertTo-Json -Compress`,
        ).out,
      )[0];
    const started = await waitFor(
      'the app started from the Run entry',
      mainCommandLine,
      30_000,
    ).catch(() => undefined);
    check(
      'the Run entry really starts the installed app, with --hidden',
      Boolean(started) && started.includes('--hidden'),
      started ? redact(started) : 'nothing started',
    );
    await sleep(3000);
    check(
      'a start at login stays in the tray (no window)',
      !processes().some((p) => p.name === 'Framelet' && p.title),
    );
    for (const proc of processes())
      if (proc.path?.toLowerCase().startsWith(installRoot.toLowerCase())) killTree(proc.pid);
    await waitFor(
      'the login-started app to end',
      () => processes().filter((p) => p.name === 'Framelet').length === 0,
      20_000,
    );
  }
  state.appProc = undefined;

  // Shortcuts (Start Menu, Desktop) and the AppUserModelID Windows knows.
  const lnks = json(
    powershell(
      `Get-ChildItem -LiteralPath '${startMenu}' -Recurse -Filter 'Framelet*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | ConvertTo-Json -Compress`,
    ).out,
  );
  const desktopLnks = json(
    powershell(
      `Get-ChildItem -LiteralPath '${desktop}' -Filter 'Framelet*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | ConvertTo-Json -Compress`,
    ).out,
  );
  evidence.shortcuts = { startMenu: lnks.map(redact), desktop: desktopLnks.map(redact) };
  check(
    'a Start Menu shortcut exists',
    lnks.length > 0,
    lnks.map((l) => path.relative(startMenu, l)).join(', '),
  );
  const startApp = json(
    powershell(
      "Get-StartApps | Where-Object { $_.Name -like 'Framelet*' } | ForEach-Object { [pscustomobject]@{ name = $_.Name; appId = $_.AppID } } | ConvertTo-Json -Compress",
    ).out,
  )[0];
  evidence.startApp = startApp ?? null;
  check(
    'the Start Menu entry carries the Squirrel AppUserModelID the app uses for notifications',
    startApp?.appId === 'com.squirrel.Framelet.Framelet',
    startApp?.appId ?? 'none',
  );

  // Programs and Features: Squirrel registers an uninstall entry that runs Update.exe --uninstall.
  const uninstallEntry = () =>
    powershell(
      `$p = Get-ItemProperty -Path '${UNINSTALL_KEY}' -ErrorAction SilentlyContinue; if ($p) { $p.DisplayName + '|' + $p.UninstallString }`,
    ).out;
  const registered = uninstallEntry();
  evidence.uninstallEntry = redact(registered);
  check(
    'Programs and Features lists Framelet with an Update.exe --uninstall command',
    registered.startsWith('Framelet|') &&
      registered.includes('Update.exe') &&
      registered.includes('--uninstall'),
    redact(registered),
  );

  // --- a real run on a temp profile: UI, screenshot, recording, 60 s without network -------------
  const userData = path.join(tempRoot, 'userdata');
  const shotsDir = path.join(tempRoot, 'screenshots');
  const videosDir = path.join(tempRoot, 'videos');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      version: 1,
      general: { closeToTray: false, showNotifications: false },
      screenshots: { afterCapture: 'save-and-editor', outputDir: shotsDir, format: 'png' },
      recording: {
        outputDir: videosDir,
        countdown: false,
        autoExportMp4: true,
        micEnabled: false,
        systemAudio: false,
      },
      notices: { trayHintShown: true, homeTipDismissed: true },
    }),
  );
  const port = await freePort();
  // Start it the way the Start Menu shortcut does: through Update.exe --processStart.
  const starter = spawn(
    updateExe,
    [
      '--processStart',
      'Framelet.exe',
      '--process-start-args',
      `--remote-debugging-port=${port} --user-data-dir=${userData}`,
    ],
    { stdio: 'ignore', shell: false },
  );
  void starter;
  const mainPid = () =>
    json(
      powershell(
        `Get-CimInstance Win32_Process -Filter "Name='Framelet.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId } | ConvertTo-Json -Compress`,
      ).out,
    )[0];
  const app = { pid: await waitFor('the Framelet main process', mainPid, 30_000) };
  check(
    'Update.exe --processStart (the shortcut path) starts the versioned exe',
    Boolean(app.pid),
    `pid ${app.pid}`,
  );
  state.appProc = app;
  const launchedAt = Date.now();
  let browser;
  for (let attempt = 0; attempt < 60 && !browser; attempt += 1) {
    await sleep(500);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
  }
  check('attached to the installed app', browser !== undefined);
  if (!browser) throw new Error('could not attach to the installed app');
  const pagesOf = () => browser.contexts().flatMap((c) => c.pages());
  const main = await waitFor(
    'the main window',
    () =>
      pagesOf().find(
        (p) =>
          p.url().startsWith('app://framelet/index.html') &&
          !/#\/(overlay|toolbar|recorder|countdown)/.test(p.url()),
      ),
    30_000,
  );
  check(
    'the renderer loads from app://framelet (installed build, no file://)',
    main.url().startsWith('app://framelet/'),
    main.url(),
  );
  await main.waitForSelector('text=Capture', { timeout: 20_000 }).catch(() => undefined);
  const facts = await main.evaluate(() => ({
    title: document.title,
    rendered: document.body.innerText.length > 20,
    api: Object.keys(window.framelet ?? {}).sort(),
  }));
  check(
    'the UI rendered with the secure bridge',
    facts.rendered && facts.title === 'Framelet' && JSON.stringify(facts.api) === '["invoke","on"]',
  );
  const appInfo = await main.evaluate(() => window.framelet.invoke('app:getInfo'));
  check(
    'app:getInfo: packaged, updates "unconfigured"',
    appInfo.ok && appInfo.data.isPackaged === true && appInfo.data.updates.state === 'unconfigured',
    appInfo.ok
      ? JSON.stringify({ v: appInfo.data.version, updates: appInfo.data.updates })
      : 'failed',
  );
  evidence.appInfo = appInfo.ok
    ? {
        version: appInfo.data.version,
        electron: appInfo.data.electron,
        isPackaged: appInfo.data.isPackaged,
        updates: appInfo.data.updates,
      }
    : null;

  // Network: every TCP connection of the app's process tree must be loopback only, all along.
  const tree = () => {
    const pids = json(
      powershell(
        `$root = ${app.pid}; $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId; $ids = @($root); do { $n = @($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }); $ids += $n } while ($n.Count -gt 0); $ids | ConvertTo-Json -Compress`,
      ).out,
    );
    return pids;
  };
  const tcpSamples = [];
  const nonLoopback = [];
  const sampleTcp = () => {
    const pids = tree();
    const rows = json(
      powershell(
        `$ids = @(${pids.join(',')}); Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { [pscustomobject]@{ pid = $_.OwningProcess; state = [string]$_.State; remote = $_.RemoteAddress; port = $_.RemotePort } } | ConvertTo-Json -Compress`,
      ).out,
    );
    const bad = rows.filter((r) => !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(r.remote));
    nonLoopback.push(...bad);
    tcpSamples.push({
      atS: Math.round((Date.now() - launchedAt) / 1000),
      processes: pids.length,
      connections: rows.length,
      nonLoopback: bad.length,
    });
  };
  sampleTcp();

  // Shortcuts registered?
  const states = await waitFor(
    'global shortcuts',
    async () => {
      const result = await main.evaluate(() => window.framelet.invoke('shortcuts:status'));
      return result.ok &&
        result.data.screenshotScreen.status === 'ok' &&
        result.data.recordScreen.status === 'ok'
        ? result.data
        : undefined;
    },
    20_000,
  ).catch(() => undefined);
  check('Ctrl+Shift+1 and Ctrl+Shift+5 are registered by the installed app', states !== undefined);
  if (!states) throw new Error('shortcuts are not registered (is another app holding them?)');

  const overlayPages = () => pagesOf().filter((p) => p.url().includes('#/overlay'));
  const readyOverlays = async (count) =>
    waitFor(
      'the selection overlays',
      async () => {
        const ready = [];
        for (const page of overlayPages()) {
          const attr = await page
            .locator('[data-ready]')
            .first()
            .getAttribute('data-ready')
            .catch(() => null);
          if (attr === 'true') ready.push(page);
        }
        return ready.length >= count ? ready : undefined;
      },
      20_000,
    );
  const centerOf = (d) => [Math.round(d.x + d.width / 2), Math.round(d.y + d.height / 2)];

  // Screenshot: Ctrl+Shift+1 -> overlay on every display -> click the primary display.
  sendKeys('ctrl', 'shift', '1');
  await readyOverlays(displays.length);
  check(
    'the screen-screenshot shortcut opens a selection overlay per display',
    true,
    `${displays.length}`,
  );
  const shotStarted = Date.now();
  clickAt(...centerOf(primary));
  const shotFile = await waitFor(
    'the saved screenshot',
    () =>
      fs.existsSync(shotsDir) &&
      fs.readdirSync(shotsDir).find((n) => /\.png$/i.test(n) && !n.startsWith('.')),
    30_000,
  ).catch(() => undefined);
  check('a PNG was saved by the installed app', shotFile !== undefined, shotFile ?? 'none');
  if (shotFile) {
    const full = path.join(shotsDir, shotFile);
    await sleep(500);
    const bytes = fs.readFileSync(full);
    const isPng = bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const match = displays.find((d) => d.width === width && d.height === height);
    evidence.screenshot = {
      bytes: bytes.length,
      width,
      height,
      matchesDisplay: Boolean(match),
      ms: Date.now() - shotStarted,
    };
    check(
      'the screenshot is a PNG with the exact physical size of a display',
      isPng && Boolean(match),
      `${width}x${height}`,
    );
    const listed = await main.evaluate(() => window.framelet.invoke('history:list', {}));
    check(
      'the screenshot is in history',
      listed.ok && listed.data.total >= 1,
      listed.ok ? `${listed.data.total}` : 'failed',
    );
  }
  // The editor is open on the screenshot now (save-and-editor): give the UI a moment.
  await sleep(1500);

  // Recording: Ctrl+Shift+5 -> pick the primary display -> record ~5 s -> Ctrl+Shift+0.
  sendKeys('ctrl', 'shift', '5');
  await readyOverlays(displays.length);
  clickAt(...centerOf(primary));
  const toolbar = await waitFor(
    'the recording toolbar',
    () => pagesOf().find((p) => p.url().includes('#/toolbar')),
    30_000,
  ).catch(() => undefined);
  check('the recording started (floating toolbar is up)', toolbar !== undefined);
  await sleep(5000);
  sampleTcp();
  sendKeys('ctrl', 'shift', '0');
  const webm = await waitFor(
    'the finalized recording',
    () =>
      fs.existsSync(videosDir) &&
      fs.readdirSync(videosDir).find((n) => /\.webm$/i.test(n) && !/partial|tmp/i.test(n)),
    60_000,
  ).catch(() => undefined);
  check(
    'the recording was finalized to a .webm in the chosen folder',
    webm !== undefined,
    webm ?? 'none',
  );
  const ffprobe = path.join(ffDir, 'ffprobe.exe');
  const ffmpeg = path.join(ffDir, 'ffmpeg.exe');
  const probe = (file) => {
    const out = run(ffprobe, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ]);
    return out.status === 0 ? JSON.parse(out.stdout) : undefined;
  };
  const decodes = (file) =>
    run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']).status === 0;
  if (webm) {
    const file = path.join(videosDir, webm);
    await sleep(1000);
    const p = probe(file);
    const v = p?.streams.find((s) => s.codec_type === 'video');
    const duration = Number(p?.format.duration);
    evidence.recording = {
      bytes: fs.statSync(file).size,
      container: p?.format.format_name,
      codec: v?.codec_name,
      width: v?.width,
      height: v?.height,
      durationS: duration,
      decodesClean: decodes(file),
    };
    check(
      'the WebM is a playable VP9 video of about 5 s (probed with the INSTALLED ffprobe)',
      v?.codec_name === 'vp9' && duration > 3 && duration < 9 && evidence.recording.decodesClean,
      JSON.stringify(evidence.recording),
    );
  }
  const mp4 = await waitFor(
    'the MP4 auto-export',
    () =>
      fs.existsSync(videosDir) &&
      fs.readdirSync(videosDir).find((n) => /\.mp4$/i.test(n) && !/partial|tmp/i.test(n)),
    60_000,
  ).catch(() => undefined);
  check(
    'the MP4 auto-export finished (installed FFmpeg encodes H.264)',
    mp4 !== undefined,
    mp4 ?? 'none',
  );
  if (mp4) {
    const file = path.join(videosDir, mp4);
    const p = probe(file);
    const v = p?.streams.find((s) => s.codec_type === 'video');
    evidence.mp4 = {
      bytes: fs.statSync(file).size,
      codec: v?.codec_name,
      pixFmt: v?.pix_fmt,
      durationS: Number(p?.format.duration),
      decodesClean: decodes(file),
    };
    check(
      'the MP4 is H.264 yuv420p and decodes cleanly',
      v?.codec_name === 'h264' && v?.pix_fmt === 'yuv420p' && evidence.mp4.decodesClean,
      JSON.stringify(evidence.mp4),
    );
  }

  // Keep watching until the app has been up for 60 s in total.
  while (Date.now() - launchedAt < 62_000) {
    await sleep(4000);
    sampleTcp();
  }
  const log = fs.existsSync(path.join(userData, 'logs', 'main.log'))
    ? fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8')
    : '';
  const blocked = log.split('\n').filter((l) => l.includes('Blocked network request')).length;
  const errors = log
    .split('\n')
    .filter((l) => /\[error\]/i.test(l))
    .map(redact);
  evidence.network = {
    watchedSeconds: Math.round((Date.now() - launchedAt) / 1000),
    tcpSamples,
    nonLoopbackConnections: nonLoopback.length,
    blockedRequestsInLog: blocked,
  };
  evidence.errorLines = errors.slice(0, 10);
  check(
    'no TCP connection to a non-loopback address for 60 s of use (whole process tree)',
    nonLoopback.length === 0,
    `${tcpSamples.length} samples`,
  );
  check(
    'the app never even tried a network request (nothing for its blocker to cancel)',
    blocked === 0,
    `${blocked}`,
  );
  await browser.close().catch(() => undefined);
  killTree(app.pid);
  await waitFor(
    'the app to end',
    () => processes().filter((p) => p.name === 'Framelet').length === 0,
    20_000,
  ).catch(() => undefined);
  state.appProc = undefined;

  // --- uninstall ---------------------------------------------------------------------------------
  fs.mkdirSync(userDataReal, { recursive: true });
  const userSentinel = path.join(userDataReal, 'framelet-uninstall-sentinel.txt');
  fs.writeFileSync(
    userSentinel,
    `sentinel ${evidence.date}
`,
  );
  const uninstallStarted = Date.now();
  const un = run(updateExe, ['--uninstall', '-s'], { timeout: 180_000 });
  evidence.uninstall = {
    exitCode: un.status,
    seconds: (Date.now() - uninstallStarted) / 1000,
    command: 'Update.exe --uninstall -s',
  };
  check('Update.exe --uninstall -s exits 0', un.status === 0, `exit ${un.status}`);
  await sleep(5000);
  const leftovers = fs.existsSync(installRoot)
    ? fs.readdirSync(installRoot, { recursive: true, withFileTypes: true }).map((e) => ({
        name: path.relative(installRoot, path.join(e.parentPath, e.name)),
        bytes: e.isFile() ? fs.statSync(path.join(e.parentPath, e.name)).size : 0,
      }))
    : [];
  const leftoverBytes = leftovers.reduce((sum, e) => sum + e.bytes, 0);
  const appFilesLeft = leftovers.filter((e) =>
    /(^|[\\/])(Framelet\.exe|app\.asar|ffmpeg\.exe|ffprobe\.exe)$/i.test(e.name),
  );
  evidence.uninstall.installDirFullyRemoved = leftovers.length === 0;
  evidence.uninstall.leftovers = leftovers;
  evidence.uninstall.leftoverBytes = leftoverBytes;
  check(
    'the app files are removed (no Framelet.exe, app.asar or FFmpeg left in the install folder)',
    appFilesLeft.length === 0 && leftoverBytes < 6 * 1024 * 1024,
    leftovers.length === 0
      ? 'folder removed'
      : `Squirrel's own stub remains: ${leftovers.map((e) => e.name).join(', ')} (${leftoverBytes} bytes)`,
  );
  await sleep(1500);
  const lnksAfter = json(
    powershell(
      `Get-ChildItem -LiteralPath '${startMenu}' -Recurse -Filter 'Framelet*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | ConvertTo-Json -Compress`,
    ).out,
  );
  const desktopAfter = json(
    powershell(
      `Get-ChildItem -LiteralPath '${desktop}' -Filter 'Framelet*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } | ConvertTo-Json -Compress`,
    ).out,
  );
  check(
    'the Start Menu and Desktop shortcuts are gone',
    lnksAfter.length === 0 && desktopAfter.length === 0,
    `${lnksAfter.length}+${desktopAfter.length} left`,
  );
  check(
    'the Programs and Features entry is gone',
    uninstallEntry() === '',
    uninstallEntry() || 'removed',
  );
  const runLeft = Object.keys(runValues()).filter((name) => !(name in state.runBefore));
  check(
    'the launch-at-login entry was removed by the uninstall hook',
    runLeft.length === 0,
    runLeft.length ? `still set: ${runLeft.join(', ')}` : 'removed',
  );
  check('no Framelet process is left running', processes().length === 0);
  check(
    'the sentinel files in Pictures\\Framelet and Videos\\Framelet are untouched',
    fs.existsSync(sentinelPictures) &&
      fs.existsSync(sentinelVideos) &&
      sha256(sentinelPictures) === sentinelHashes[0] &&
      sha256(sentinelVideos) === sentinelHashes[1],
  );
  check(
    'the captures made during the test are still there (output folders survive)',
    Boolean(shotFile) &&
      fs.existsSync(path.join(shotsDir, shotFile)) &&
      Boolean(webm) &&
      fs.existsSync(path.join(videosDir, webm)),
  );
  check(
    'user data (%APPDATA%\\Framelet) is kept by the uninstall, by design (sentinel survives)',
    fs.existsSync(userSentinel),
  );
  evidence.userDataKeptAfterUninstall = fs.existsSync(userDataReal);
}

try {
  await main();
} catch (error) {
  check('the smoke test ran to the end', false, String(error?.stack ?? error));
} finally {
  cleanup();
  evidence.cleanup = cleanupNotes;
  evidence.result = failures.length === 0 ? 'PASS' : `FAIL: ${failures.join('; ')}`;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, redact(`${JSON.stringify(evidence, null, 2)}\n`));
  console.log(`evidence: ${path.relative(root, evidencePath)}`);
  console.log(`cleanup: ${cleanupNotes.join('; ')}`);
}
if (failures.length > 0) {
  console.error(`smoke:installed FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('smoke:installed OK');
