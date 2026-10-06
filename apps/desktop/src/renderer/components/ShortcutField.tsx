import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeftRight, RotateCcw, TriangleAlert, X } from 'lucide-react';
import {
  EDITOR_LABELS,
  SHORTCUT_LABELS,
  acceleratorFromKeyEvent,
  acceleratorKeys,
  heldModifiers,
  isEditorAction,
  reservedCheck,
  type AnyShortcutAction,
  type ShortcutScope,
  type ShortcutState,
} from '../../shared/shortcuts';
import { announce } from '../lib/announce';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { Kbd } from './ui/Kbd';

export interface ShortcutFieldProps {
  action: AnyShortcutAction;
  /** `global` (registered with the OS) or `app` (the editor's own keys). */
  scope?: ShortcutScope;
  /** What "restore the default" puts back. */
  defaultAccelerator: string;
  /** `process.platform`, for the heads-up about keys the OS may own (global shortcuts only). */
  platform?: string;
  /** What is saved (null = turned off). */
  accelerator: string | null;
  /** How main's registration went (undefined until it answered). */
  state: ShortcutState | undefined;
  /** Saves the new accelerator (null turns the shortcut off). */
  onChange: (accelerator: string | null) => void;
  /** Gives `accelerator` to this action and this action's current one to `other` (one saved change). */
  onSwap: (other: AnyShortcutAction, accelerator: string) => void;
  /** Visible name, also the accessible name of the buttons. */
  label: string;
}

/** Global shortcuts must not fire while a combination is being recorded (they would eat it). */
function setShortcutsPaused(paused: boolean): void {
  void window.framecapt.invoke('shortcuts:setPaused', { paused });
}

/**
 * Records a shortcut: "Change" starts listening, the next combination is shown as key chips and
 * validated by main (modifier rule, duplicates) before it is saved. Esc cancels, Backspace or
 * Delete turns the shortcut off, Tab leaves, and so does clicking elsewhere. While it listens the
 * global shortcuts are released so the pressed keys reach this window.
 */
export function ShortcutField({
  action,
  scope = 'global',
  defaultAccelerator,
  platform,
  accelerator,
  state,
  onChange,
  onSwap,
  label,
}: ShortcutFieldProps) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  /** Another action of this scope holds the combination just pressed: offer to swap. */
  const [swap, setSwap] = useState<{ other: AnyShortcutAction; accelerator: string } | null>(null);
  const problemRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const wasRecording = useRef(false);

  const stop = useCallback(() => {
    setRecording(false);
    setHeld([]);
    setSwap(null);
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
      // Leave: Tab keeps its normal job (and reaches the Swap button while one is offered).
      if (!swap) stop();
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
    const result = acceleratorFromKeyEvent(event.nativeEvent, scope);
    if (result === null) return; // only modifiers so far
    setSwap(null);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    const verdict = await window.framecapt.invoke('shortcuts:validate', {
      action,
      accelerator: result.accelerator,
    });
    if (!verdict.ok) {
      setProblem(verdict.error.message);
      return;
    }
    if (!verdict.data.ok) {
      setProblem(verdict.data.reason);
      if (verdict.data.usedBy) {
        setSwap({
          other: verdict.data.usedBy as AnyShortcutAction,
          accelerator: result.accelerator,
        });
      }
      return;
    }
    stop();
    setProblem(null);
    onChange(verdict.data.accelerator);
    announce(
      `${label} set to ${verdict.data.accelerator ?? 'off'}${verdict.data.warning ? `. ${verdict.data.warning}` : ''}`,
    );
  }

  function onKeyUp(event: KeyboardEvent<HTMLDivElement>): void {
    setHeld(heldModifiers(event.nativeEvent));
  }

  const keys = accelerator ? acceleratorKeys(accelerator) : [];
  const isDefault = accelerator === defaultAccelerator;
  const warning =
    state && (state.status === 'conflict' || state.status === 'invalid') ? state.message : null;
  // Print Screen and the like: allowed, but the OS may answer first.
  const note =
    scope === 'global' && accelerator && platform
      ? (() => {
          const reserved = reservedCheck(accelerator, platform);
          return reserved?.level === 'warning' ? reserved.reason : null;
        })()
      : null;
  const otherLabel = swap
    ? isEditorAction(swap.other)
      ? EDITOR_LABELS[swap.other]
      : SHORTCUT_LABELS[swap.other]
    : '';

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
            onBlur={(event) => {
              // Moving to the Swap button is not leaving.
              if (
                event.relatedTarget instanceof Node &&
                problemRef.current?.contains(event.relatedTarget)
              ) {
                return;
              }
              stop();
            }}
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
                onChange(defaultAccelerator);
              }}
            />
          </>
        )}
      </div>
      {recording && problem ? (
        <div ref={problemRef} className="flex flex-wrap items-center justify-end gap-2">
          <p
            role="alert"
            data-testid={`shortcut-problem-${action}`}
            className="flex items-center gap-1.5 text-right text-xs text-danger"
          >
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            {problem}
          </p>
          {swap ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<ArrowLeftRight className="size-3.5" aria-hidden="true" />}
              data-testid={`shortcut-swap-${action}`}
              aria-label={`Swap: ${label} gets ${swap.accelerator}, ${otherLabel} gets ${accelerator ?? 'no shortcut'}`}
              onBlur={(event) => {
                if (event.relatedTarget !== recorderRef.current) stop();
              }}
              onClick={() => {
                onSwap(swap.other, swap.accelerator);
                announce(
                  `Swapped: ${label} is now ${swap.accelerator}, ${otherLabel} is now ${accelerator ?? 'off'}`,
                );
                stop();
              }}
            >
              Swap
            </Button>
          ) : null}
        </div>
      ) : null}
      {!recording && note ? (
        <p
          role="status"
          data-testid={`shortcut-note-${action}`}
          className="flex max-w-sm items-start gap-1.5 text-right text-xs text-warning"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {note}
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
