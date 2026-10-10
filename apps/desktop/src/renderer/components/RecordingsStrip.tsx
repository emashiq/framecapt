import { PanelRightOpen, Pause, Play, Square } from 'lucide-react';
import { formatDuration } from '../../shared/recording';
import type { RecorderSessionSummary } from '../../shared/recorder-ipc';
import { useActiveMs } from '../recorder/use-recorder';
import { Button } from './ui/Button';

const SHOWN: readonly RecorderSessionSummary['status'][] = [
  'recording',
  'paused',
  'stopping',
  'processing',
];

/** Recordings that are running or being saved. */
function runningSessions(sessions: readonly RecorderSessionSummary[]) {
  return sessions.filter((session) => SHOWN.includes(session.status));
}

function SessionRow({ session }: { session: RecorderSessionSummary }) {
  const activeMs = useActiveMs(session);
  const live = session.status === 'recording' || session.status === 'paused';
  const paused = session.status === 'paused';
  const command = (channel: 'recorder:pause' | 'recorder:resume' | 'recorder:stop') =>
    void window.framecapt.invoke(channel, { sessionId: session.sessionId });
  return (
    <li
      data-testid={`session-${session.sessionId}`}
      data-status={session.status}
      className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px]"
    >
      <span
        aria-hidden="true"
        className={
          live && !paused
            ? 'size-2 shrink-0 rounded-full bg-danger-solid'
            : 'size-2 shrink-0 rounded-full bg-fg-subtle'
        }
      />
      <span className="font-medium text-fg">{session.label}</span>
      {live ? (
        <span data-testid="session-timer" className="tabular-nums text-fg-muted">
          {formatDuration(activeMs)}
          {paused ? ' · Paused' : ''}
        </span>
      ) : (
        <span className="text-fg-muted">
          Saving…
          {session.progress !== null ? ` ${Math.round(session.progress * 100)}%` : ''}
        </span>
      )}
      <span className="flex-1" />
      {live ? (
        <>
          <Button
            size="sm"
            variant="secondary"
            icon={paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            data-testid="session-pause"
            onClick={() => command(paused ? 'recorder:resume' : 'recorder:pause')}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          {session.target !== 'multi' ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<PanelRightOpen className="size-3.5" />}
              data-testid="session-add-panel"
              title={session.panels > 0 ? `${session.panels} panel(s) added` : undefined}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                void window.framecapt.invoke('recorder:panelMenu', {
                  sessionId: session.sessionId,
                  x: Math.max(0, Math.round(box.left)),
                  y: Math.max(0, Math.round(box.bottom)),
                });
              }}
            >
              Add panel
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            icon={<Square className="size-3.5" />}
            data-testid="session-stop"
            onClick={() => command('recorder:stop')}
          >
            Stop
          </Button>
        </>
      ) : null}
    </li>
  );
}

/** The recordings in progress, each with its timer, Pause/Resume and Stop (Home, while any runs). */
export function RecordingsStrip({ sessions }: { sessions: readonly RecorderSessionSummary[] }) {
  const running = runningSessions(sessions);
  if (running.length === 0) return null;
  return (
    <section aria-label="Recordings in progress" data-testid="recordings-strip" className="mb-4">
      <h2 className="mb-1.5 text-[12px] font-medium tracking-wide text-fg-subtle uppercase">
        Recordings in progress
      </h2>
      <ul className="flex flex-col gap-1.5">
        {running.map((session) => (
          <SessionRow key={session.sessionId} session={session} />
        ))}
      </ul>
    </section>
  );
}
