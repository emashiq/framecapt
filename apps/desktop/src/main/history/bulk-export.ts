import fs from 'node:fs';
import path from 'node:path';
import type { BulkExportResponse, BulkItemResult } from '../../shared/history-ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { freeFileName } from '../shots/free-name';
import { copyFileNoOverwrite } from './files';
import type { HistoryService } from './service';

export interface BulkExportDeps {
  history: Pick<HistoryService, 'get'>;
  /** The folder dialog (main process); null when the user cancels. */
  pickFolder: () => Promise<string | null>;
  /** True when files can be created in the folder. */
  writable: (folder: string) => Promise<boolean>;
  onProgress: (done: number, total: number) => void;
  /** A copy was written (main remembers it so "Show in folder" accepts it). */
  onSaved?: (file: string) => void;
}

const MAX_NAME_RETRIES = 20;

/**
 * "Save copies": copies the files of several history items into one folder. The files come from
 * history in main (never a renderer path), a name
 * that is taken gets "(2)", "(3)"..., and nothing is ever overwritten. One run at a time; a
 * cancel skips the items that were not copied yet and keeps the copies already made.
 */
export class BulkExportService {
  private controller: AbortController | null = null;
  private choosing = false;

  constructor(private readonly deps: BulkExportDeps) {}

  get active(): boolean {
    return this.controller !== null || this.choosing;
  }

  async run(ids: readonly string[]): Promise<BulkExportResponse> {
    if (this.active) throw new IpcError('BUSY', 'Copies are already being saved.');
    const unique = [...new Set(ids)];
    this.choosing = true;
    let folder: string | null;
    try {
      folder = await this.deps.pickFolder();
    } finally {
      this.choosing = false;
    }
    if (folder === null) return { cancelled: true };
    if (!(await this.deps.writable(folder))) {
      throw new IpcError('INVALID_PAYLOAD', 'FrameCapt cannot save files in that folder.');
    }

    const controller = new AbortController();
    this.controller = controller;
    const results: BulkItemResult[] = [];
    try {
      for (const id of unique) {
        if (controller.signal.aborted) {
          results.push({ id, status: 'skipped', message: 'Cancelled' });
        } else {
          results.push(await this.copyOne(id, folder));
          this.deps.onProgress(results.length, unique.length);
        }
      }
    } finally {
      this.controller = null;
    }
    return { folder, cancelled: controller.signal.aborted, results };
  }

  cancel(): void {
    this.controller?.abort();
  }

  private async copyOne(id: string, folder: string): Promise<BulkItemResult> {
    const item = this.deps.history.get(id);
    if (!item) return { id, status: 'failed', message: 'Not in history.' };
    if (item.type === 'flow') {
      return { id, status: 'skipped', message: 'Export a guide from its own page.' };
    }
    const present = await fs.promises.stat(item.path).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (!present) return { id, status: 'failed', message: 'The file was moved or deleted.' };
    // The names of two items can be equal (and the folder may already hold one): never overwrite.
    for (let attempt = 0; attempt < MAX_NAME_RETRIES; attempt += 1) {
      try {
        const target = await freeFileName(folder, path.basename(item.path));
        await copyFileNoOverwrite(item.path, target);
        this.deps.onSaved?.(target);
        return { id, status: 'saved', fileName: path.basename(target), path: target };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; // lost a race: next name
        log.warn(`Save copies: one copy failed (${(error as Error).message})`);
        return { id, status: 'failed', message: 'The copy could not be saved.' };
      }
    }
    return { id, status: 'failed', message: 'No free file name.' };
  }
}
