import fs from 'node:fs';
import path from 'node:path';
import type { EditorOpenTabEvent } from '../../shared/editor-ipc';
import { handle } from '../ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import type { Mp4Capability } from '../media/export';
import { FcapError, readFcapHeaderCached } from '../recording/fcap';
import type { ExtractService } from './extract-service';
import type { HistoryService } from './service';

export interface SplitDeps {
  history: Pick<HistoryService, 'get' | 'list'>;
  extracts: Pick<ExtractService, 'startAndWait'>;
  capability: () => Promise<Mp4Capability>;
}

/**
 * "Edit as separate videos": every source of a multi-source `.fcap` recording becomes a video of
 * its own (the whole length, one extract after the other: ffmpeg runs one job at a time), so each
 * can be cut, trimmed, scored, duplicated or deleted independently. Sources that were extracted
 * before are reused, so asking again opens the same videos instead of making copies.
 */
export class SplitService {
  /** Recordings being split right now: a second ask waits for the same run. */
  private readonly running = new Map<string, Promise<string[]>>();

  constructor(private readonly deps: SplitDeps) {}

  /** The history ids of the recording's sources, in the recording's order. */
  split(id: string): Promise<string[]> {
    const active = this.running.get(id);
    if (active) return active;
    const run = this.run(id).finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }

  private async run(id: string): Promise<string[]> {
    const { history, extracts } = this.deps;
    const item = history.get(id);
    if (!item) throw new IpcError('NOT_FOUND', 'That recording is not in history.');
    if (item.type !== 'recording' || item.format !== 'fcap') {
      throw new IpcError('INVALID_PAYLOAD', 'Only multi-source recordings can be split.');
    }
    const present = await fs.promises.stat(item.path).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (!present) throw new IpcError('NOT_FOUND', 'The recording was moved or deleted.');
    let header;
    try {
      header = await readFcapHeaderCached(item.path);
    } catch (error) {
      if (error instanceof FcapError) throw new IpcError('INVALID_PAYLOAD', error.message);
      throw error;
    }
    const endMs = header.durationMs > 0 ? header.durationMs : (item.durationMs ?? 0);
    if (endMs < 100) {
      throw new IpcError('INVALID_PAYLOAD', 'That recording is too short to split.');
    }
    const format = (await this.deps.capability()).available ? ('mp4' as const) : ('webm' as const);

    // The extracts of an earlier run: `<recording> - <source>.mp4|webm` derived from this one.
    const earlier = (await history.list({ filter: 'recording' })).items.filter(
      (candidate) => candidate.derivedFrom === id && candidate.exists,
    );
    const base = path.basename(item.path, path.extname(item.path));
    const ids: string[] = [];
    for (const [index, source] of header.sources.entries()) {
      const prefix = `${base} - ${source.name}`.toLowerCase();
      const found = earlier.find((candidate) => {
        const name = candidate.fileName.toLowerCase();
        return name === `${prefix}.mp4` || name === `${prefix}.webm`;
      });
      if (found) {
        ids.push(found.id);
        continue;
      }
      const outcome = await extracts.startAndWait({
        id,
        sourceIndex: index,
        startMs: 0,
        endMs,
        format,
      });
      if (!outcome.itemId) {
        throw new IpcError('INTERNAL', outcome.error ?? `${source.name} could not be extracted.`);
      }
      ids.push(outcome.itemId);
    }
    return ids;
  }
}

/** The channel of the "Edit as separate videos" button. */
export function registerSplitHandler(service: SplitService): void {
  handle('history:splitSources', { roles: ['main'] }, async (request) => ({
    ids: await service.split(request.id),
  }));
}

/**
 * A multi-source recording was just saved: split it and open every source in the video editor.
 * Failures are logged and toasted by the extract events; the recording itself is untouched.
 */
export async function splitAndOpen(
  service: SplitService,
  history: Pick<HistoryService, 'get'>,
  id: string,
  openTab: (event: EditorOpenTabEvent) => void,
): Promise<void> {
  try {
    for (const sourceId of await service.split(id)) {
      const item = history.get(sourceId);
      if (item) openTab({ kind: 'video', historyId: item.id, title: path.basename(item.path) });
    }
  } catch (error) {
    log.warn(`Splitting a recording into its sources: ${String(error)}`);
  }
}
