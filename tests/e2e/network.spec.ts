/**
 * No unsolicited network traffic. The E2E build (production renderer from app://framecapt, mock
 * capture provider) runs for 60 seconds while the UI is exercised, and three independent views must
 * agree that nothing leaves the machine:
 *   1. the session: no request with an http(s)/ws(s)/ftp scheme ever reaches the network stack
 *      (webRequest.onSendHeaders on every URL) or fails as blocked (onErrorOccurred);
 *   2. the app's own network blocker never had to cancel anything (no "Blocked network request"
 *      line in main.log: nothing even tried);
 *   3. the OS: every TCP connection owned by the app's process tree is loopback-only (sampled with
 *      Get-NetTCPConnection every 5 s).
 * The evidence is docs/evidence/phase10/network-e2e.json when FRAMECAPT_WRITE_EVIDENCE=1.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { evidenceDirFor, writeEvidenceJson } from '../native/evidence';
import { exitApp } from './app-exit';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase10');
const WATCH_MS = 60_000;
const SAMPLE_EVERY_MS = 5_000;

interface TcpRow {
  pid: number;
  state: string;
  local: string;
  remote: string;
  remotePort: number;
}

/** Linux: `ss -tnpH` lines, e.g. `ESTAB 0 0 127.0.0.1:41234 [::1]:9222 users:(("electron",pid=7,fd=3))`. */
function tcpConnectionsLinux(pids: number[]): TcpRow[] {
  const result = spawnSync('ss', ['-tnpH'], { shell: false, encoding: 'utf8' });
  const rows: TcpRow[] = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    const pid = Number(/pid=(\d+)/.exec(line)?.[1]);
    const peer = fields[4] ?? '';
    if (!pids.includes(pid) || !peer) continue;
    const cut = peer.lastIndexOf(':');
    rows.push({
      pid,
      state: fields[0] ?? '',
      local: fields[3] ?? '',
      remote: peer.slice(0, cut).replace(/^\[|\]$/g, ''),
      remotePort: Number(peer.slice(cut + 1)),
    });
  }
  return rows;
}

function tcpConnections(pids: number[]): TcpRow[] {
  if (process.platform !== 'win32') return tcpConnectionsLinux(pids);
  const script = `
    $ids = @(${pids.join(',')})
    Get-NetTCPConnection -ErrorAction SilentlyContinue |
      Where-Object { $ids -contains $_.OwningProcess } |
      ForEach-Object { [pscustomobject]@{ pid = $_.OwningProcess; state = [string]$_.State; local = $_.LocalAddress; remote = $_.RemoteAddress; remotePort = $_.RemotePort } } |
      ConvertTo-Json -Compress`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { shell: false, windowsHide: true, encoding: 'utf8' },
  );
  const text = result.stdout.trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]) as TcpRow[];
}

const isLoopbackOrUnbound = (address: string): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '0.0.0.0' || address === '::';

test('60 seconds of use make no request to the network', async () => {
  test.setTimeout(WATCH_MS + 90_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-net-'));
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMECAPT_USER_DATA_DIR: userData },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    // Observe every request the default session sends, from the start of the watch.
    await app.evaluate(({ session }) => {
      const seen: { url: string; scheme: string; failed?: string }[] = [];
      (globalThis as unknown as { __netSeen: typeof seen }).__netSeen = seen;
      const filter = { urls: ['<all_urls>'] };
      const schemeOf = (url: string): string => url.slice(0, url.indexOf(':'));
      session.defaultSession.webRequest.onSendHeaders(filter, (details) => {
        seen.push({ url: details.url.split(/[?#]/)[0] ?? '', scheme: schemeOf(details.url) });
      });
      session.defaultSession.webRequest.onErrorOccurred(filter, (details) => {
        seen.push({
          url: details.url.split(/[?#]/)[0] ?? '',
          scheme: schemeOf(details.url),
          failed: details.error,
        });
      });
    });

    const pids = await app.evaluate(({ app: electronApp }) => [
      process.pid,
      ...electronApp.getAppMetrics().map((metric) => metric.pid),
    ]);

    const nav = page.getByRole('navigation', { name: 'Primary' });
    const samples: { atMs: number; connections: number; nonLoopback: number }[] = [];
    const nonLoopbackRows: TcpRow[] = [];
    const started = Date.now();
    let step = 0;
    while (Date.now() - started < WATCH_MS) {
      // Walk through the main views: each one loads its own code and data.
      const view = ['History', 'Settings', 'Capture'][step % 3] ?? 'Capture';
      await nav.getByRole('button', { name: view }).click();
      if (view === 'Settings') {
        await page.getByTestId('settings-nav-about').click();
        await expect(page.getByTestId('about-updates')).toHaveText('Not configured for this build');
      }
      step += 1;
      const rows = tcpConnections(pids);
      const bad = rows.filter((row) => !isLoopbackOrUnbound(row.remote));
      nonLoopbackRows.push(...bad);
      samples.push({
        atMs: Date.now() - started,
        connections: rows.length,
        nonLoopback: bad.length,
      });
      await page.waitForTimeout(SAMPLE_EVERY_MS);
    }

    const seen = await app.evaluate(
      () =>
        (globalThis as unknown as { __netSeen: { url: string; scheme: string; failed?: string }[] })
          .__netSeen,
    );
    const external = seen.filter(
      (entry) =>
        ![
          'app',
          'framecapt-media',
          'blob',
          'data',
          'devtools',
          'chrome-extension',
          'file',
        ].includes(entry.scheme),
    );
    const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
    const blocked = log.split('\n').filter((line) => line.includes('Blocked network request'));

    // Positive control, after the watch: the same observer DOES see (and the app's blocker cancels)
    // a request made to a network address, so "0 requests" above is a real measurement.
    // (A page's own fetch never gets this far: the CSP, connect-src 'self', refuses it first.)
    await app.evaluate(({ net }) => net.fetch('https://example.invalid/').catch(() => 'blocked'));
    await page.waitForTimeout(500);
    const afterControl = await app.evaluate(
      () =>
        (globalThis as unknown as { __netSeen: { scheme: string; failed?: string }[] }).__netSeen,
    );
    const control = afterControl.slice(seen.length);
    const controlLog = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');

    writeEvidenceJson(evidenceDir, 'network-e2e.json', {
      date: new Date().toISOString(),
      build: 'e2e (production renderer from app://framecapt, mock capture)',
      watchedSeconds: Math.round((Date.now() - started) / 1000),
      requestsSeenBySession: seen.length,
      requestsBySchemeCounts: Object.fromEntries(
        [...new Set(seen.map((entry) => entry.scheme))].map((scheme) => [
          scheme,
          seen.filter((entry) => entry.scheme === scheme).length,
        ]),
      ),
      externalRequests: external.length,
      blockedByTheAppBlocker: blocked.length,
      tcpSamples: samples,
      tcpNonLoopbackConnections: nonLoopbackRows.length,
      processTreePids: pids.length,
      positiveControl: {
        request: 'https://example.invalid/ (cancelled by the app, never sent)',
        observed: control.length > 0,
        failure: control.find((entry) => entry.failed)?.failed ?? null,
        loggedAsBlocked: controlLog.includes('Blocked network request'),
      },
    });

    expect(external, JSON.stringify(external)).toEqual([]);
    expect(blocked, blocked.join('\n')).toEqual([]);
    expect(nonLoopbackRows, JSON.stringify(nonLoopbackRows)).toEqual([]);
    expect(samples.length).toBeGreaterThanOrEqual(5);
    expect(control.some((entry) => entry.scheme === 'https')).toBe(true);
    expect(controlLog).toContain('Blocked network request');
  } finally {
    await exitApp(app);
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
