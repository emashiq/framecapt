import { handle } from '../ipc';
import type { StepsController } from './controller';
import type { FlowService } from './service';

/**
 * Step-guide channels. The capture commands (the pill, the main window) go to the one controller
 * in main; the Flow view reads and edits a saved guide by history id only. Paths, folders and
 * file names never come from a renderer: step images are named by the guide's own file list.
 */
export function registerFlowHandlers(steps: StepsController, flows: FlowService): void {
  handle('steps:start', { roles: ['main'] }, () => steps.start());
  handle('steps:getState', { roles: ['main', 'toolbar'] }, () => steps.snapshot());
  handle('steps:captureStep', { roles: ['main', 'toolbar'] }, () => steps.captureStep());
  handle('steps:pause', { roles: ['main', 'toolbar'] }, () => steps.pause());
  handle('steps:resume', { roles: ['main', 'toolbar'] }, () => steps.resume());
  handle('steps:setAuto', { roles: ['main', 'toolbar'] }, (request) => steps.setAuto(request.auto));
  handle('steps:done', { roles: ['main', 'toolbar'] }, () => steps.done());
  handle('steps:cancel', { roles: ['main', 'toolbar'] }, () => steps.cancel());

  handle('flow:get', { roles: ['main'] }, (request) => flows.get(request.historyId));
  handle('flow:update', { roles: ['main'] }, (request) => flows.update(request));
  handle('flow:readStep', { roles: ['main'] }, async (request) => {
    const { png } = await flows.readStep(request.historyId, request.index);
    return {
      png: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
    };
  });
  handle('flow:export', { roles: ['main'] }, (request) => flows.export(request));
}
