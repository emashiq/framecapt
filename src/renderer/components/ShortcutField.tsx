import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { RotateCcw, TriangleAlert, X } from 'lucide-react';
import {
  DEFAULT_SHORTCUTS,
  acceleratorFromKeyEvent,
  acceleratorKeys,
  heldModifiers,
  type ShortcutAction,
  type ShortcutState,
} from '../../shared/shortcuts';
import { announce } from '../lib/announce';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { Kbd } from './ui/Kbd';

export interface ShortcutFieldProps {
  action: ShortcutAction;
  /** What is saved (null = turned off). */
  accelerator: string | null;
  /** How main's registration went (undefined until it answered). */
  state: ShortcutState | undefined;
  /** Saves the new accelerator (null turns the shortcut off). */
  onChange: (accelerator: string | null) => void;
  /** Visible name, also the accessible name of the buttons. */
  label: string;
}

/** Global shortcuts must not fire while a combination is being recorded (they would eat it). */
function setShortcutsPaused(paused: boolean): void {
  void window.framelet.invoke('shortcuts:setPaused', { paused });
}

/**
 * Records a shortcut: "Change" starts listening, the next combination is shown as key chips and
 * validated by main (modifier rule, duplicates) before it is saved. Esc cancels, Backspace or
 * Delete turns the shortcut off, Tab leaves, and so does clicking elsewhere. While it listens the
 * global shortcuts are released so the pressed keys reach this window.
 */
export function ShortcutField({ action, accelerator, state, onChange, label }: ShortcutFieldProps) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const recorderRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const wasRecording = useRef(false);

  const stop = useCallback(() => {
    setRecording(false);
    setHeld([]);
  }, []);

  // Release the global shortcuts while listening; always give them back.
  useEffect(() => {
    if (!recording) return;
    setShortcutsPaused(true);
    recorderRef.current?.focus();
    return () => setShortcutsPaused(false);
  }, [recording]);

  // After a recording ends, focus returns to the Change button.
  useEffect(() => {
    if (wasRecording.current && !recording) changeRef.current?.focus();
    wasRecording.current = recording;
  }, [recording]);

  async function onKeyDown(event: KeyboardEvent<HTMLDivElement>): Promise<void> {
    const modifiers = heldModifiers(event.nativeEvent);
    const bare = modifiers.length === 0;
    if (bare && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stop();
      return;
    }
    if (bare && event.key === 'Tab') {
      stop(); // leave: Tab keeps its normal job
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (bare && (event.key === 'Backspace' || event.key === 'Delete')) {
      stop();
      setProblem(null);
      onChange(null);
      announce(`${label} turned off`);
      return;
    }
    setHeld(modifiers);
    const result = acceleratorFromKeyEvent(event.nativeEvent);
    if (result === null) return; // only modifiers so far
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    const verdict = await window.framelet.invoke('shortcuts:validate', {
      action,
      accelerator: result.accelerator,
    });
    if (!verdict.ok) {
      setProblem(verdict.error.message);
      return;
    }
    if (!verdict.data.ok) {
      setProblem(verdict.data.reason);
      return;
    }
    stop();
    setProblem(null);
    onChange(verdict.data.accelerator);
    announce(`${label} set to ${verdict.data.accelerator ?? 'off'}`);
  }

  function onKeyUp(event: KeyboardEvent<HTMLDivElement>): void {
    setHeld(heldModifiers(event.nativeEvent));
  }

  const keys = accelerator ? acceleratorKeys(accelerator) : [];
  const isDefault = accelerator === DEFAULT_SHORTCUTS[action];
  const warning =
    state && (state.status === 'conflict' || state.status === 'invalid') ? state.message : null;

  return (
    <div className="flex min-w-0 flex-col items-end gap-1.5" data-testid={`shortcut-${action}`}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {recording ? (
          <div
            ref={recorderRef}
            tabIndex={0}
            role="group"
            aria-label={`Press the new shortcut for ${label}. Escape cancels, Backspace turns it off.`}
            data-testid={`shortcut-recorder-${action}`}
            onKeyDown={(event) => void onKeyDown(event)}
            onKeyUp={onKeyUp}
            onBlur={stop}
            className="flex h-9 min-w-52 items-center justify-center gap-2 rounded-lg border border-accent bg-accent-soft px-3 text-[13px] text-accent-fg"
          >
            {held.length > 0 ? <Kbd keys={held} /> : <span>Press the new shortcut…</span>}
          </div>
        ) : (
          <>
            <span
              className="flex h-9 min-w-28 items-center justify-end"
              data-testid={`shortcut-value-${action}`}
            >
              {accelerator ? (
                <Kbd keys={keys} />
              ) : (
                <span className="text-[13px] text-fg-muted">Not set</span>
              )}
            </span>
            <Button
              ref={changeRef}
              size="sm"
              variant="secondary"
              data-testid={`shortcut-change-${action}`}
              aria-label={`Change shortcut for ${label}`}
              onClick={() => {
                setProblem(null);
                setRecording(true);
              }}
            >
              Change
            </Button>
            <IconButton
              size="sm"
              disabled={accelerator === null}
              icon={<X className="size-4" aria-hidden="true" />}
              aria-label={`Turn off the shortcut for ${label}`}
              data-testid={`shortcut-clear-${action}`}
              onClick={() => {
                onChange(null);
                announce(`${label} turned off`);
              }}
            />
            <IconButton
              size="sm"
              disabled={isDefault}
              icon={<RotateCcw className="size-4" aria-hidden="true" />}
              aria-label={`Restore the default shortcut for ${label}`}
              data-testid={`shortcut-default-${action}`}
              onClick={() => {
                setProblem(null);
                onChange(DEFAULT_SHORTCUTS[action]);
              }}
            />
          </>
        )}
      </div>
      {recording && problem ? (
        <p
          role="alert"
          data-testid={`shortcut-problem-${action}`}
          className="flex items-center gap-1.5 text-xs text-danger"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {problem}
        </p>
      ) : null}
      {!recording && warning ? (
        <p
          role="status"
          data-testid={`shortcut-warning-${action}`}
          className="flex items-center gap-1.5 text-right text-xs text-warning"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {warning}
        </p>
      ) : null}
    </div>
  );
}
