import { describe, expect, it, vi } from 'vitest';
import { createActions, type ActionDeps } from '../../src/main/actions';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { RecorderStatus } from '../../src/shared/recorder-machine';
import { IpcError } from '../../src/main/ipc-core';

function setup(status: RecorderStatus = 'idle', extra: Partial<ActionDeps> = {}) {
  const recorder = {
    status,
    busy: !['idle', 'completed', 'error'].includes(status),
    start: vi.fn(() => Promise.resolve({})),
    stop: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
  };
  const deps: ActionDeps = {
    settings: () => DEFAULT_SETTINGS,
    recorder,
    screenshotBusy: () => false,
    steps: {
      active: false,
      start: vi.fn(() => Promise.resolve()),
      done: vi.fn(() => Promise.resolve({ discarded: true })),
      captureStep: vi.fn(() => Promise.resolve()),
    },
    startScreenshot: vi.fn(() => Promise.resolve()),
    editor: () => ({ open: false, dirty: false }),
    askMain: vi.fn(),
    toast: vi.fn(),
    log: { info: vi.fn() },
    ...extra,
  };
  return { deps, recorder, run: createActions(deps).run };
}

describe('screenshot actions', () => {
  it('start the flow for screen and region', () => {
    const { run, deps } = setup();
    run('screenshotRegion');
    run('screenshotScreen');
    expect(deps.startScreenshot).toHaveBeenNthCalledWith(1, { target: 'region' });
    expect(deps.startScreenshot).toHaveBeenNthCalledWith(2, { target: 'screen' });
  });

  it('a window screenshot needs the picker in the main window', () => {
    const { run, deps } = setup();
    run('screenshotWindow');
    expect(deps.startScreenshot).not.toHaveBeenCalled();
    expect(deps.askMain).toHaveBeenCalledWith({ kind: 'screenshot', target: 'window' });
  });

  it('is ignored with a message while a capture runs (BUSY)', () => {
    const { run, deps } = setup('idle', { screenshotBusy: () => true });
    run('screenshotRegion');
    expect(deps.startScreenshot).not.toHaveBeenCalled();
    expect(deps.toast).toHaveBeenCalledWith({
      level: 'info',
      message: 'A capture is already in progress.',
    });
  });

  it('all screens is a screen capture with the allScreens flag', () => {
    const { run, deps } = setup();
    run('screenshotAllScreens');
    expect(deps.startScreenshot).toHaveBeenCalledWith({ target: 'screen', allScreens: true });
  });

  it('all screens goes through the main window while the editor holds unsaved work', () => {
    const { run, deps } = setup('idle', { editor: () => ({ open: true, dirty: true }) });
    run('screenshotAllScreens');
    expect(deps.askMain).toHaveBeenCalledWith({
      kind: 'screenshot',
      target: 'screen',
      allScreens: true,
    });
  });

  it('is ignored while a recording is being set up or saved', () => {
    for (const status of [
      'selecting',
      'preflight',
      'countdown',
      'starting',
      'stopping',
      'processing',
    ] as const) {
      const { run, deps } = setup(status);
      run('screenshotRegion');
      expect(deps.startScreenshot).not.toHaveBeenCalled();
      expect(deps.toast).toHaveBeenCalled();
    }
  });

  it('works while recording or paused, without touching the main window', () => {
    for (const status of ['recording', 'paused'] as const) {
      const { run, deps } = setup(status, { editor: () => ({ open: true, dirty: true }) });
      run('screenshotRegion');
      run('screenshotAllScreens');
      expect(deps.startScreenshot).toHaveBeenNthCalledWith(1, { target: 'region' });
      expect(deps.startScreenshot).toHaveBeenNthCalledWith(2, {
        target: 'screen',
        allScreens: true,
      });
      expect(deps.askMain).not.toHaveBeenCalled();
    }
  });

  it('refuses a window screenshot while recording (its picker needs the main window)', () => {
    const { run, deps } = setup('recording');
    run('screenshotWindow');
    expect(deps.startScreenshot).not.toHaveBeenCalled();
    expect(deps.askMain).not.toHaveBeenCalled();
    expect(deps.toast).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: expect.stringContaining('recording') }),
    );
  });

  it('goes through the main window while the editor holds unsaved work', () => {
    const { run, deps } = setup('idle', { editor: () => ({ open: true, dirty: true }) });
    run('screenshotRegion');
    expect(deps.startScreenshot).not.toHaveBeenCalled();
    expect(deps.askMain).toHaveBeenCalledWith({ kind: 'screenshot', target: 'region' });
  });

  it('starts directly when the editor is open but everything is saved', () => {
    const { run, deps } = setup('idle', { editor: () => ({ open: true, dirty: false }) });
    run('screenshotRegion');
    expect(deps.startScreenshot).toHaveBeenCalled();
  });

  it('shows a friendly error when the flow refuses', async () => {
    const { run, deps } = setup('idle', {
      startScreenshot: () => Promise.reject(new IpcError('BUSY', 'A recording is in progress.')),
    });
    run('screenshotScreen');
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('already running'),
      }),
    );
  });
});

describe('record actions', () => {
  it('start with the options from the settings', () => {
    const { run, recorder } = setup();
    run('recordRegion');
    expect(recorder.start).toHaveBeenCalledWith({
      target: 'region',
      options: {
        mic: { enabled: false },
        systemAudio: false,
        quality: '1080p',
        fps: 30,
        countdown: true,
      },
    });
  });

  it('a window recording goes through the main window (picker)', () => {
    const { run, recorder, deps } = setup();
    run('recordWindow');
    expect(recorder.start).not.toHaveBeenCalled();
    expect(deps.askMain).toHaveBeenCalledWith({ kind: 'record', target: 'window' });
  });

  it('toggles: a record shortcut while recording or paused stops', () => {
    for (const status of ['recording', 'paused'] as const) {
      const { run, recorder } = setup(status);
      run('recordScreen');
      expect(recorder.stop).toHaveBeenCalledTimes(1);
      expect(recorder.start).not.toHaveBeenCalled();
    }
  });

  it('during the start-up it cancels', () => {
    for (const status of ['selecting', 'preflight', 'countdown', 'starting'] as const) {
      const { run, recorder } = setup(status);
      run('recordRegion');
      expect(recorder.cancel).toHaveBeenCalledTimes(1);
    }
  });

  it('while saving it only says it is busy', () => {
    const { run, recorder, deps } = setup('processing');
    run('recordRegion');
    expect(recorder.start).not.toHaveBeenCalled();
    expect(deps.toast).toHaveBeenCalled();
  });

  it('an open editor sends it through the main window (it closes the editor first)', () => {
    const { run, recorder, deps } = setup('idle', { editor: () => ({ open: true, dirty: false }) });
    run('recordScreen');
    expect(recorder.start).not.toHaveBeenCalled();
    expect(deps.askMain).toHaveBeenCalledWith({ kind: 'record', target: 'screen' });
  });

  it('shows the reason when starting fails', async () => {
    const { run, deps } = setup('idle');
    (deps.recorder.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new IpcError('OUTPUT_DIR_UNWRITABLE', 'x'),
    );
    run('recordScreen');
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.toast).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: expect.stringContaining('Settings') }),
    );
  });
});

describe('stop and pause', () => {
  it('stop works while recording or paused and cancels during start-up', () => {
    const rec = setup('recording');
    rec.run('stopRecording');
    expect(rec.recorder.stop).toHaveBeenCalled();
    const pre = setup('countdown');
    pre.run('stopRecording');
    expect(pre.recorder.cancel).toHaveBeenCalled();
    const idle = setup('idle');
    idle.run('stopRecording');
    expect(idle.recorder.stop).not.toHaveBeenCalled();
    expect(idle.recorder.cancel).not.toHaveBeenCalled();
  });

  it('pause toggles between pause and resume, and does nothing otherwise', () => {
    const rec = setup('recording');
    rec.run('pauseRecording');
    expect(rec.recorder.pause).toHaveBeenCalled();
    const paused = setup('paused');
    paused.run('pauseRecording');
    expect(paused.recorder.resume).toHaveBeenCalled();
    const idle = setup('idle');
    idle.run('pauseRecording');
    expect(idle.recorder.pause).not.toHaveBeenCalled();
    expect(idle.recorder.resume).not.toHaveBeenCalled();
  });
});

describe('step guide actions', () => {
  it('the toggle starts a guide, and finishes it when one is running', () => {
    const { run, deps } = setup();
    run('stepsToggle');
    expect(deps.steps.start).toHaveBeenCalledTimes(1);
    const live = setup('idle', {
      steps: { ...setup().deps.steps, active: true, done: vi.fn(() => Promise.resolve({})) },
    });
    live.run('stepsToggle');
    expect(live.deps.steps.done).toHaveBeenCalledTimes(1);
    expect(live.deps.steps.start).not.toHaveBeenCalled();
  });

  it('does not start while a recording or a screenshot runs', () => {
    const recording = setup('recording');
    recording.run('stepsToggle');
    expect(recording.deps.steps.start).not.toHaveBeenCalled();
    expect(recording.deps.toast).toHaveBeenCalledWith({
      level: 'info',
      message: 'A capture is already in progress.',
    });
    const shot = setup('idle', { screenshotBusy: () => true });
    shot.run('stepsToggle');
    expect(shot.deps.steps.start).not.toHaveBeenCalled();
  });

  it('screenshots and recordings are refused while a guide is captured', () => {
    const base = setup().deps.steps;
    const { run, deps } = setup('idle', { steps: { ...base, active: true } });
    run('screenshotRegion');
    run('recordScreen');
    expect(deps.startScreenshot).not.toHaveBeenCalled();
    expect(deps.askMain).not.toHaveBeenCalled();
    expect(deps.toast).toHaveBeenCalledTimes(2);
  });

  it('the capture-step shortcut takes a step only while a guide runs', () => {
    const idle = setup();
    idle.run('stepsCapture');
    expect(idle.deps.steps.captureStep).not.toHaveBeenCalled();
    expect(idle.deps.toast).toHaveBeenCalledWith({
      level: 'info',
      message: 'Start capturing steps first.',
    });
    const base = setup().deps.steps;
    const live = setup('idle', { steps: { ...base, active: true } });
    live.run('stepsCapture');
    expect(live.deps.steps.captureStep).toHaveBeenCalledTimes(1);
  });

  it('a failed start is told, not thrown', async () => {
    const base = setup().deps.steps;
    const failing = setup('idle', {
      steps: { ...base, start: vi.fn(() => Promise.reject(new IpcError('BUSY', 'Nope.'))) },
    });
    failing.run('stepsToggle');
    await Promise.resolve();
    await Promise.resolve();
    expect(failing.deps.toast).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });
});
