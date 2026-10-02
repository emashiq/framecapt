import fs from 'node:fs';
import path from 'node:path';
import type { UpdateStatus } from '../shared/ipc-contract';

/**
 * Update adapter (ADR-035). Framelet ships as a Squirrel.Windows install; the only supported
 * updater is Electron's built-in `autoUpdater` pointed at a Squirrel feed. The feed URL is a
 * BUILD-TIME constant (`__FRAMELET_UPDATE_URL__`, from FRAMELET_UPDATE_URL when building). With no
 * URL the service is `unconfigured`: it never touches `autoUpdater` and makes no network request.
 *
 * Supported feeds once the owner has one (neither is configured by this repository):
 *  - a static directory (any HTTPS host or object store) holding `RELEASES` and the `.nupkg` files
 *    that `npm run make` produces: FRAMELET_UPDATE_URL=https://updates.example.com/framelet/win32/x64
 *  - update.electronjs.org for a PUBLIC GitHub repository with published releases:
 *    FRAMELET_UPDATE_URL=https://update.electronjs.org/<owner>/<repo>/win32/<version> (the service
 *    takes the URL as written; the version segment must then match the build)
 * Updates are never checked automatically in this build: `checkNow()` is the only entry point and
 * no UI calls it yet, so even a configured build makes no request until the owner wires one.
 */
export type UpdateState = UpdateStatus['state'];

/** The subset of Electron's autoUpdater the service uses (and tests fake). */
export interface AutoUpdaterLike {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(
    event: 'checking-for-update' | 'update-available' | 'update-not-available',
    l: () => void,
  ): unknown;
  on(event: 'update-downloaded', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdateServiceDeps {
  /** `__FRAMELET_UPDATE_URL__`. Empty or whitespace: not configured. */
  feedUrl: string;
  /** Loads Electron's autoUpdater. Only called when updates are configured and a check is requested. */
  getAutoUpdater: () => AutoUpdaterLike;
  /** The running app is a Squirrel install (Update.exe next to the app-x.y.z folder). */
  isSquirrelInstall: () => boolean;
}

/** True for an `https:` feed URL (the only scheme accepted). */
export function isValidFeedUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export class UpdateService {
  private status: UpdateStatus;
  private updater: AutoUpdaterLike | undefined;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();

  constructor(private readonly deps: UpdateServiceDeps) {
    const url = deps.feedUrl.trim();
    if (url === '') this.status = { state: 'unconfigured' };
    else if (!isValidFeedUrl(url)) {
      this.status = { state: 'error', message: 'The update feed URL of this build is not https.' };
    } else this.status = { state: 'idle' };
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  onChange(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Asks the feed whether a newer version exists (Squirrel downloads it automatically). Does
   * nothing, and touches nothing, unless the build is configured and idle (or in error).
   */
  checkNow(): void {
    if (this.status.state !== 'idle' && this.status.state !== 'error') return;
    if (this.deps.feedUrl.trim() === '' || !isValidFeedUrl(this.deps.feedUrl.trim())) return;
    if (!this.deps.isSquirrelInstall()) {
      this.set({ state: 'error', message: 'Updates need the installed version of Framelet.' });
      return;
    }
    try {
      const updater = this.attach();
      this.set({ state: 'checking' });
      updater.checkForUpdates();
    } catch (error) {
      this.set({ state: 'error', message: errorMessage(error) });
    }
  }

  /** Restarts into the downloaded update. Only valid in the `ready` state. */
  installAndRestart(): void {
    if (this.status.state !== 'ready' || !this.updater) return;
    this.updater.quitAndInstall();
  }

  private attach(): AutoUpdaterLike {
    if (this.updater) return this.updater;
    const updater = this.deps.getAutoUpdater();
    updater.setFeedURL({ url: this.deps.feedUrl.trim() });
    updater.on('checking-for-update', () => this.set({ state: 'checking' }));
    // Squirrel.Windows downloads an available update straight away.
    updater.on('update-available', () => {
      this.set({ state: 'available' });
      this.set({ state: 'downloading' });
    });
    updater.on('update-not-available', () => this.set({ state: 'idle' }));
    updater.on('update-downloaded', () => this.set({ state: 'ready' }));
    updater.on('error', (error) => this.set({ state: 'error', message: errorMessage(error) }));
    this.updater = updater;
    return updater;
  }

  private set(status: UpdateStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The update check failed.';
}

/** A Squirrel install keeps Update.exe one level above the versioned app folder. */
export function isSquirrelInstall(execPath: string): boolean {
  return fs.existsSync(path.resolve(path.dirname(execPath), '..', 'Update.exe'));
}
