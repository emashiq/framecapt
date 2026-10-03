import { webContents, type Session } from 'electron';
import { isAppUrl, type AppOriginConfig } from '../app-origin';
import { handle } from '../ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { GrantStore } from './grants';
import type { CaptureProvider } from './types';

/**
 * Capture authorization. Display capture is not a permission prompt: Chromium asks the
 * display-media request handler which source to hand out. FrameCapt answers only from a main-owned,
 * one-shot grant (created through `capture:grant` after main validated the source id), bound to
 * the requesting webContents and valid for a few seconds. Everything else is denied.
 *
 * `{ useSystemPicker: false }`: the system picker is macOS-only (and experimental); FrameCapt
 * always uses its own source picker.
 */
export function installCaptureAuthorization(
  ses: Session,
  provider: CaptureProvider,
  getConfig: () => AppOriginConfig,
  store: GrantStore = new GrantStore(),
): GrantStore {
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const deny = (reason: string): void => {
        log.warn(`Display capture denied: ${reason}`);
        // An empty Streams object makes getDisplayMedia reject in the renderer.
        callback({});
      };

      const frame = request.frame;
      if (!frame) return deny('requesting frame is gone');
      if (frame.parent !== null) return deny('request from a subframe');
      if (!isAppUrl(frame.url, getConfig())) return deny('request from a non-app page');
      if (!request.videoRequested) return deny('request without video');
      const contents = webContents.fromFrame(frame);
      if (!contents) return deny('requesting webContents not found');

      const result = store.consume(contents.id);
      if (!result.ok) return deny(`no active grant (${result.reason})`);

      const { grant } = result;
      const video = { id: grant.sourceId, name: grant.sourceName };
      const loopback = grant.systemAudio && request.audioRequested;
      log.info(
        `Display capture granted: ${grant.sourceId.split(':')[0]} source, ` +
          `systemAudio=${loopback ? 'loopback' : 'off'}, userGesture=${request.userGesture}`,
      );
      callback(loopback ? { video, audio: 'loopback' } : { video });
    },
    { useSystemPicker: false },
  );

  handle('capture:grant', { roles: ['main', 'recorder'] }, async (request, ctx) => {
    // Validate against a fresh listing: stale or invented ids never get a grant.
    const sources = await provider.listSources({ types: ['screen', 'window'], thumbnailWidth: 0 });
    const source = sources.find((candidate) => candidate.id === request.sourceId);
    if (!source) throw new IpcError('NOT_FOUND', 'That capture source is no longer available.');
    const grant = store.create({
      sourceId: source.id,
      sourceName: source.name,
      systemAudio: request.systemAudio,
      webContentsId: ctx.webContentsId,
    });
    return { grantId: grant.grantId, expiresAt: grant.expiresAt };
  });

  return store;
}
