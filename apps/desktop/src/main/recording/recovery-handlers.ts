import { shell } from 'electron';
import { handle } from '../ipc';
import { IpcError } from '../ipc-core';
import type { RecorderController } from '../recorder/controller';
import type { MediaRegistry } from './media-protocol';
import type { RecoveryService } from './recovery';

/**
 * Recovery of unfinished recordings. All four channels are for the main window only and take a
 * session id that main verifies; no path ever comes from the renderer. While a capture runs the
 * list is empty and recover/discard are refused, so recovery never competes with a live session.
 */
export function registerRecoveryHandlers(
  recovery: RecoveryService,
  controller: RecorderController,
  media: MediaRegistry,
): void {
  const guard = (): void => {
    if (controller.busy) throw new IpcError('BUSY', 'Finish the current capture first.');
  };

  handle('recovery:list', { roles: ['main'] }, async () => ({
    candidates: controller.busy ? [] : await recovery.list(),
  }));

  handle('recovery:recover', { roles: ['main'] }, async (request) => {
    guard();
    const outcome = await recovery.recover(request.sessionId);
    if (outcome.outcome === 'unrecoverable') return outcome;
    return {
      outcome: 'recovered' as const,
      resultId: media.register(outcome.outputPath),
      fileName: outcome.fileName,
      path: outcome.outputPath,
      durationMs: outcome.durationMs,
      bytes: outcome.bytes,
    };
  });

  handle('recovery:discard', { roles: ['main'] }, async (request) => {
    guard();
    await recovery.discard(request.sessionId);
  });

  handle('recovery:reveal', { roles: ['main'] }, async (request) => {
    shell.showItemInFolder(await recovery.streamPathOf(request.sessionId));
  });
}
