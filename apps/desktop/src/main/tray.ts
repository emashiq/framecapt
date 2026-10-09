import type { MenuItemConstructorOptions, NativeImage } from 'electron';
import { formatDuration } from '../shared/recording';
import type { RecorderStatus } from '../shared/recorder-machine';
import type { ShortcutAction, ShortcutStates } from '../shared/shortcuts';

/** The part of Electron's `Tray` the controller uses (a fake in tests). */
export interface TrayLike {
  setToolTip(text: string): void;
  setImage(image: NativeImage): void;
  setContextMenu(menu: unknown): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  on(event: 'click' | 'double-click', listener: () => void): unknown;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface TrayState {
  status: RecorderStatus;
  /** Active recording time in ms (shown in the tooltip while recording or paused). */
  activeMs: number;
  shortcuts: ShortcutStates | null;
  /** A screenshot flow is running (the screenshot items wait). */
  screenshotBusy: boolean;
  /** More than one display is connected ("All screens" is offered). */
  multiDisplay: boolean;
  /** A step guide is being captured (the Steps item finishes it). */
  stepsActive?: boolean;
}

export interface TrayHandlers {
  open: () => void;
  openView: (view: 'history' | 'settings') => void;
  run: (action: ShortcutAction) => void;
  togglePause: () => void;
  stop: () => void;
  quit: () => void;
}

const RECORDING_STATUSES: readonly RecorderStatus[] = [
  'recording',
  'paused',
  'stopping',
  'processing',
];

export function isRecordingState(status: RecorderStatus): boolean {
  return RECORDING_STATUSES.includes(status);
}

export function trayTooltip(state: Pick<TrayState, 'status' | 'activeMs'>): string {
  const time = formatDuration(state.activeMs);
  switch (state.status) {
    case 'recording':
      return `FrameCapt — Recording ${time}`;
    case 'paused':
      return `FrameCapt — Paused ${time}`;
    case 'stopping':
    case 'processing':
      return 'FrameCapt — Saving the recording…';
    default:
      return 'FrameCapt';
  }
}

function acceleratorOf(
  shortcuts: ShortcutStates | null,
  action: ShortcutAction,
): { accelerator: string; registerAccelerator: false } | Record<string, never> {
  const accelerator = shortcuts?.[action]?.accelerator;
  // Shown beside the item only: the global shortcut itself is registered by the ShortcutManager.
  return accelerator ? { accelerator, registerAccelerator: false } : {};
}

/** The tray menu as plain data (so it can be tested): recording controls first while recording. */
export function buildTrayTemplate(
  state: TrayState,
  handlers: TrayHandlers,
): MenuItemConstructorOptions[] {
  const recording = isRecordingState(state.status);
  const live = state.status === 'recording' || state.status === 'paused';
  const preRecording = ['selecting', 'preflight', 'countdown', 'starting'].includes(state.status);
  const items: MenuItemConstructorOptions[] = [];

  if (recording) {
    items.push(
      {
        id: 'pause',
        label: state.status === 'paused' ? 'Resume recording' : 'Pause recording',
        enabled: live,
        ...acceleratorOf(state.shortcuts, 'pauseRecording'),
        click: handlers.togglePause,
      },
      {
        id: 'stop',
        label: 'Stop recording',
        enabled: live,
        ...acceleratorOf(state.shortcuts, 'stopRecording'),
        click: handlers.stop,
      },
      { type: 'separator' },
    );
  }

  // A live recording still allows a screenshot (saved directly); saving it or setting it up does not.
  const screenshotEnabled = (live || (!recording && !preRecording)) && !state.screenshotBusy;
  const recordEnabled = !recording && !state.screenshotBusy;
  const targets = [
    ['Screen', 'screen'],
    ['Window', 'window'],
    ['Region', 'region'],
  ] as const;
  const shotItems: MenuItemConstructorOptions[] = targets.map(([label, target]) => {
    const action = `screenshot${label}` as ShortcutAction;
    return {
      id: `screenshot-${target}`,
      label,
      enabled: screenshotEnabled,
      ...acceleratorOf(state.shortcuts, action),
      click: () => handlers.run(action),
    };
  });
  if (state.multiDisplay) {
    shotItems.push({
      id: 'screenshot-all-screens',
      label: 'All screens',
      enabled: screenshotEnabled,
      ...acceleratorOf(state.shortcuts, 'screenshotAllScreens'),
      click: () => handlers.run('screenshotAllScreens'),
    });
  }
  items.push(
    { id: 'screenshot', label: 'Screenshot', submenu: shotItems },
    {
      id: 'record',
      label: 'Record',
      submenu: targets.map(([label, target]) => {
        const action = `record${label}` as ShortcutAction;
        return {
          id: `record-${target}`,
          label,
          enabled: recordEnabled,
          ...acceleratorOf(state.shortcuts, action),
          click: () => handlers.run(action),
        };
      }),
    },
    {
      id: 'steps',
      label: state.stepsActive ? 'Finish step capture' : 'Capture steps',
      enabled: state.stepsActive === true || (!recording && !preRecording && !state.screenshotBusy),
      ...acceleratorOf(state.shortcuts, 'stepsToggle'),
      click: () => handlers.run('stepsToggle'),
    },
    { type: 'separator' },
    { id: 'open', label: 'Open FrameCapt', click: handlers.open },
    { id: 'history', label: 'Library', click: () => handlers.openView('history') },
    { id: 'settings', label: 'Settings', click: () => handlers.openView('settings') },
    { type: 'separator' },
    { id: 'quit', label: 'Quit FrameCapt', click: handlers.quit },
  );
  return items;
}

export interface TrayControllerDeps {
  /** Makes the real tray (the controller calls it at most once). */
  createTray: (image: NativeImage) => TrayLike;
  buildMenu: (template: MenuItemConstructorOptions[]) => unknown;
  /** Icons: `normal` and `recording` (the red-dot variant). */
  icons: { normal: NativeImage; recording: NativeImage };
  handlers: TrayHandlers;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

/**
 * The one tray icon of the app. `ensure()` is idempotent: a second call (a window being created
 * again, a second code path) never makes a second icon, which would leave a ghost in the tray.
 * Left click opens the main window; the context menu follows the recording state.
 */
export class TrayController {
  private tray: TrayLike | undefined;
  private created = 0;
  private lastState: TrayState = {
    status: 'idle',
    activeMs: 0,
    shortcuts: null,
    screenshotBusy: false,
    multiDisplay: false,
  };
  private lastRecording = false;

  constructor(private readonly deps: TrayControllerDeps) {}

  /** The handlers the menu uses (E2E hooks build the template with them). */
  get handlersForTest(): TrayHandlers {
    return this.deps.handlers;
  }

  /** How many icons this controller made over its life (always 0 or 1). */
  get instances(): number {
    return this.created;
  }

  get active(): boolean {
    return this.tray !== undefined && !this.tray.isDestroyed();
  }

  bounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.tray || this.tray.isDestroyed()) return null;
    try {
      return this.tray.getBounds();
    } catch {
      return null;
    }
  }

  /** Creates the icon once. Returns false when Windows could not make it (no tray available). */
  ensure(): boolean {
    if (this.tray && !this.tray.isDestroyed()) return true;
    try {
      this.tray = this.deps.createTray(this.deps.icons.normal);
      this.created += 1;
    } catch (error) {
      this.deps.log?.warn(`The tray icon could not be created: ${String(error)}`);
      this.tray = undefined;
      return false;
    }
    this.tray.on('click', () => this.deps.handlers.open());
    this.tray.on('double-click', () => this.deps.handlers.open());
    this.deps.log?.info(`Tray created (instance ${this.created})`);
    this.render(this.lastState);
    return true;
  }

  /** Re-renders icon, tooltip and menu for `state`. Cheap enough to call on every change. */
  update(state: TrayState): void {
    this.lastState = state;
    this.render(state);
  }

  private render(state: TrayState): void {
    const tray = this.tray;
    if (!tray || tray.isDestroyed()) return;
    const recording = isRecordingState(state.status);
    if (recording !== this.lastRecording) {
      tray.setImage(recording ? this.deps.icons.recording : this.deps.icons.normal);
      this.lastRecording = recording;
    }
    tray.setToolTip(trayTooltip(state));
    tray.setContextMenu(this.deps.buildMenu(buildTrayTemplate(state, this.deps.handlers)));
  }

  /** Only the tooltip (the recording clock ticks once a second). */
  updateTooltip(state: Pick<TrayState, 'status' | 'activeMs'>): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.setToolTip(trayTooltip(state));
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = undefined;
  }
}
