import {
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  checkAccelerator,
  reservedCheck,
  type ShortcutAction,
  type ShortcutStates,
  type ShortcutsMap,
} from '../shared/shortcuts';

/** The part of Electron's `globalShortcut` the manager uses (replaced by a fake in tests). */
export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface ShortcutManagerDeps {
  api: GlobalShortcutApi;
  /** Runs an action: the same flow functions the buttons use (see actions.ts). */
  run: (action: ShortcutAction) => void;
  /** `process.platform` unless a test says otherwise: picks the reserved-combination table. */
  platform?: string;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

function emptyStates(): ShortcutStates {
  return Object.fromEntries(
    SHORTCUT_ACTIONS.map((action) => [action, { accelerator: null, status: 'disabled' as const }]),
  ) as ShortcutStates;
}

/**
 * Registers the configured global shortcuts and remembers exactly which accelerators it
 * registered: a change unregisters only those (never `unregisterAll`, which would also remove
 * the countdown's Esc or any other module's), then registers the new set. `register` returning
 * false (or throwing for a string the OS rejects) is reported per action, never ignored:
 * `conflict` means another app (or another action) already holds the combination.
 */
export class ShortcutManager {
  private readonly registered = new Set<string>();
  private states: ShortcutStates = emptyStates();
  private wanted: ShortcutsMap | null = null;
  private paused = false;
  private readonly listeners = new Set<(states: ShortcutStates) => void>();

  constructor(private readonly deps: ShortcutManagerDeps) {}

  status(): ShortcutStates {
    return this.states;
  }

  /** The accelerators this manager currently holds (tests, diagnostics). */
  get heldAccelerators(): string[] {
    return [...this.registered];
  }

  onStatus(listener: (states: ShortcutStates) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Registers `shortcuts` (replacing what this manager registered before). */
  apply(shortcuts: ShortcutsMap): ShortcutStates {
    this.wanted = { ...shortcuts };
    return this.register();
  }

  /**
   * Releases every shortcut while the settings screen records a new combination (otherwise the
   * pressed keys would go to the global shortcut and never reach the window); `false` registers
   * them again.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.unregisterOwn();
    else if (this.wanted) this.register();
  }

  /** Unregisters everything this manager registered (will-quit). */
  dispose(): void {
    this.wanted = null;
    this.unregisterOwn();
  }

  private unregisterOwn(): void {
    for (const accelerator of this.registered) {
      try {
        this.deps.api.unregister(accelerator);
      } catch {
        // Nothing to release.
      }
    }
    this.registered.clear();
  }

  private register(): ShortcutStates {
    this.unregisterOwn();
    const wanted = this.wanted ?? ({} as ShortcutsMap);
    const states = emptyStates();
    const holders = new Map<string, ShortcutAction>();
    for (const action of SHORTCUT_ACTIONS) {
      const given = wanted[action] ?? null;
      if (given === null) continue;
      const parsed = checkAccelerator(given);
      if (!parsed.ok) {
        states[action] = { accelerator: given, status: 'invalid', message: parsed.reason };
        continue;
      }
      const accelerator = parsed.accelerator;
      // The OS owns it: say so without asking the OS (an old file may still hold such a combination).
      const reserved = reservedCheck(accelerator, this.deps.platform ?? process.platform);
      if (reserved?.level === 'blocked') {
        states[action] = { accelerator, status: 'invalid', message: reserved.reason };
        continue;
      }
      const holder = holders.get(accelerator);
      if (holder) {
        states[action] = {
          accelerator,
          status: 'conflict',
          message: `${accelerator} is already used by “${SHORTCUT_LABELS[holder]}”. Choose a different shortcut.`,
        };
        continue;
      }
      holders.set(accelerator, action);
      if (this.paused) {
        states[action] = { accelerator, status: 'ok' };
        continue;
      }
      let ok: boolean;
      try {
        ok = this.deps.api.register(accelerator, () => this.deps.run(action));
      } catch {
        states[action] = {
          accelerator,
          status: 'invalid',
          message: `${accelerator} is not a shortcut Windows can register. Choose a different one.`,
        };
        continue;
      }
      if (ok) {
        this.registered.add(accelerator);
        states[action] = { accelerator, status: 'ok' };
      } else {
        this.deps.log?.warn(`Shortcut ${accelerator} could not be registered (in use)`);
        states[action] = {
          accelerator,
          status: 'conflict',
          message: `${accelerator} is used by another app — choose a different shortcut.`,
        };
      }
    }
    this.states = states;
    for (const listener of this.listeners) listener(states);
    return states;
  }
}

/** True when any shortcut that is set could not be registered (the startup notice). */
export function hasProblems(states: ShortcutStates): boolean {
  return SHORTCUT_ACTIONS.some(
    (action) => states[action].status === 'conflict' || states[action].status === 'invalid',
  );
}
