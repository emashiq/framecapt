import { randomUUID } from 'node:crypto';
import { GRANT_TTL_MS } from '../../shared/capture-schemas';

export interface Grant {
  grantId: string;
  sourceId: string;
  sourceName: string;
  systemAudio: boolean;
  /** The only webContents allowed to use this grant. */
  webContentsId: number;
  /** Epoch ms. */
  expiresAt: number;
}

export type ConsumeResult =
  { ok: true; grant: Grant } | { ok: false; reason: 'no-grant' | 'expired' | 'other-webcontents' };

const MAX_OUTSTANDING = 16;

/**
 * Main-owned, one-shot capture grants. A grant is created after main validated the source, is
 * bound to one webContents, expires after a few seconds and is consumed by the first matching
 * display-media request. Pure and clock-injectable so it can be unit tested.
 */
export class GrantStore {
  private grants: Grant[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = GRANT_TTL_MS,
  ) {}

  get size(): number {
    this.prune();
    return this.grants.length;
  }

  /** A new grant replaces any earlier grant of the same webContents (only the latest counts). */
  create(input: {
    sourceId: string;
    sourceName: string;
    systemAudio: boolean;
    webContentsId: number;
  }): Grant {
    this.prune();
    this.grants = this.grants.filter((grant) => grant.webContentsId !== input.webContentsId);
    const grant: Grant = {
      grantId: randomUUID(),
      ...input,
      expiresAt: this.now() + this.ttlMs,
    };
    this.grants.push(grant);
    if (this.grants.length > MAX_OUTSTANDING) this.grants.shift();
    return grant;
  }

  /** Removes and returns the grant for `webContentsId`, or explains why there is none. */
  consume(webContentsId: number): ConsumeResult {
    const index = this.grants.findIndex((grant) => grant.webContentsId === webContentsId);
    const grant = index === -1 ? undefined : this.grants[index];
    if (!grant) {
      this.prune();
      return { ok: false, reason: this.grants.length > 0 ? 'other-webcontents' : 'no-grant' };
    }
    this.grants.splice(index, 1);
    if (grant.expiresAt <= this.now()) return { ok: false, reason: 'expired' };
    return { ok: true, grant };
  }

  clearFor(webContentsId: number): void {
    this.grants = this.grants.filter((grant) => grant.webContentsId !== webContentsId);
  }

  private prune(): void {
    const now = this.now();
    this.grants = this.grants.filter((grant) => grant.expiresAt > now);
  }
}
