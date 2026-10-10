import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { MeetingPromptAction, MeetingPromptEvent } from '../../../shared/meeting-ipc';
import { Logo } from '../../components/Logo';
import { Button } from '../../components/ui/Button';

/**
 * The meeting prompt (role 'meeting-prompt'): a small card in the corner of the screen that offers
 * to record the meeting main just detected. It owns no state beyond what main pushed: the answer
 * goes back through `meeting:respond` and main closes the window. It is shown without focus, so
 * the keyboard stays with the meeting until the user tabs in; Escape then dismisses it.
 */
export function MeetingPromptView() {
  const [prompt, setPrompt] = useState<MeetingPromptEvent | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('overlay-root');
    const off = window.framecapt.on('meeting:prompt', (event) => setPrompt(event));
    // The event may have been sent before this view listened: ask for the current one too.
    void window.framecapt.invoke('meeting:getPrompt').then((response) => {
      if (response.ok && response.data) setPrompt(response.data);
    });
    return off;
  }, []);

  const respond = useCallback(
    (action: MeetingPromptAction) => {
      if (!prompt) return;
      void window.framecapt.invoke('meeting:respond', { meetingId: prompt.meetingId, action });
    },
    [prompt],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') respond('dismiss');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [respond]);

  if (!prompt) return null;
  const { appLabel, recordingLive } = prompt;
  return (
    <div
      role="alertdialog"
      aria-labelledby="meeting-prompt-title"
      aria-describedby="meeting-prompt-question"
      data-testid="meeting-prompt"
      data-app={prompt.app}
      className="flex size-full flex-col gap-3 rounded-2xl border border-line-strong bg-surface p-4 text-fg shadow-raised select-none"
    >
      <div className="flex items-start gap-3">
        <Logo size={28} />
        <div className="min-w-0 flex-1">
          <p id="meeting-prompt-title" className="truncate text-sm font-semibold">
            {appLabel} meeting detected
          </p>
          <p id="meeting-prompt-question" className="text-[13px] text-fg-muted">
            Record it with FrameCapt?
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          data-testid="meeting-prompt-close"
          onClick={() => respond('dismiss')}
          className="-mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {recordingLive ? (
          <Button
            size="sm"
            variant="primary"
            data-testid="meeting-add"
            onClick={() => respond('add-to-recording')}
          >
            Add to current recording
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={recordingLive ? 'secondary' : 'primary'}
          data-testid="meeting-record"
          onClick={() => respond('record')}
        >
          Record meeting
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="meeting-record-screen"
          onClick={() => respond('record-with-screen')}
        >
          Meeting + my screen
        </Button>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          data-testid="meeting-not-now"
          onClick={() => respond('dismiss')}
        >
          Not now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="meeting-mute"
          onClick={() => respond('mute-app')}
        >
          Don&apos;t ask for {appLabel}
        </Button>
      </div>
    </div>
  );
}
