import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { RecorderSnapshot } from '../../shared/recorder-ipc';
import { Button } from './ui/Button';

export type ChoiceAnswer = 'continue-without' | 'use-default' | 'cancel';

const COPY = {
  'system-audio-unavailable': {
    title: "System audio isn't available",
    description:
      'Windows did not provide system audio for this recording. You can record without it, or cancel.',
    without: 'Record without system audio',
  },
  'mic-missing': {
    title: 'Microphone not found',
    description: "The selected microphone isn't connected.",
    without: 'Record without microphone',
  },
  'mic-denied': {
    title: 'Microphone access is blocked',
    description:
      'Framelet cannot use the microphone. Allow microphone access in Windows Settings (Privacy & security, Microphone), or record without it.',
    without: 'Record without microphone',
  },
  'mic-unavailable': {
    title: 'Microphone unavailable',
    description: 'The microphone could not be opened. Another app may be using it.',
    without: 'Record without microphone',
  },
} as const;

export interface RecorderChoiceDialogProps {
  snapshot: RecorderSnapshot;
  onAnswer: (answer: ChoiceAnswer) => void;
}

/**
 * Preflight found something missing (system audio, a microphone). Recording never silently goes
 * on without audio that was asked for: the user chooses here. Esc and Cancel both cancel.
 */
export function RecorderChoiceDialog({ snapshot, onAnswer }: RecorderChoiceDialogProps) {
  const { choice } = snapshot;
  const copy = choice ? COPY[choice] : null;
  const offerDefault =
    (choice === 'mic-missing' || choice === 'mic-unavailable') && snapshot.choiceCanUseDefault;
  return (
    <AlertDialog.Root open={copy !== null} onOpenChange={(open) => !open && onAnswer('cancel')}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <AlertDialog.Content
          data-testid="choice-dialog"
          data-choice={choice ?? ''}
          className="fixed top-1/2 left-1/2 z-50 w-[min(460px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 text-fg shadow-raised"
        >
          <AlertDialog.Title className="text-lg font-semibold text-fg">
            {copy?.title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-sm text-fg-muted">
            {copy?.description}
          </AlertDialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-2.5">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" data-testid="choice-cancel">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            {offerDefault ? (
              <Button
                variant="secondary"
                onClick={() => onAnswer('use-default')}
                data-testid="choice-default"
              >
                Use default microphone
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={() => onAnswer('continue-without')}
              data-testid="choice-without"
            >
              {copy?.without}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
