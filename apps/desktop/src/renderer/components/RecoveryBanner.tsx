import { useEffect, useState } from 'react';
import { notify } from '../lib/notify';
import { CircleCheck, FolderOpen, LifeBuoy, TriangleAlert } from 'lucide-react';
import { friendlyError } from '../../shared/error-messages';
import { formatBytes, formatDuration } from '../../shared/recording';
import type { RecoveryCandidate, RecoverResponse } from '../../shared/recovery-ipc';
import { Loader } from './Loader';
import { Button } from './ui/Button';
import { AlertConfirm } from './ui/AlertConfirm';

const SOURCE_TEXT: Record<RecoveryCandidate['sourceKind'], string> = {
  screen: 'Screen',
  window: 'Window',
  region: 'Region',
  multi: 'Multiple sources',
  unknown: 'Unknown',
};

const STATE_TEXT: Record<RecoveryCandidate['state'], string> = {
  recording: 'Interrupted while recording',
  stopping: 'Interrupted while stopping',
  stopped: 'Stopped, not yet saved',
  finalizing: 'Interrupted while saving',
  failed: 'Ended with an error',
  unknown: 'Unknown (its record was damaged)',
};

type Outcome =
  | { kind: 'working' }
  | { kind: 'done'; result: Extract<RecoverResponse, { outcome: 'recovered' }> }
  | { kind: 'failed'; keptAt: string };

function Details({ candidate }: { candidate: RecoveryCandidate }) {
  const rows: [string, string][] = [
    ['Started', new Date(candidate.createdAt).toLocaleString()],
    ['Size on disk', formatBytes(candidate.bytes)],
    ['Source', SOURCE_TEXT[candidate.sourceKind]],
    ['Pieces written', String(candidate.chunks)],
    ['Last state', STATE_TEXT[candidate.state]],
    ...(candidate.errorCode
      ? [['Reason', friendlyError(candidate.errorCode)] as [string, string]]
      : []),
  ];
  return (
    <details className="mt-3 text-[13px] text-fg-muted" data-testid="recovery-details">
      <summary className="cursor-pointer select-none">Details</summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-fg-subtle">{label}</dt>
            <dd className="selectable">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * Unfinished recordings from an earlier run (the app was closed, crashed or ran out of disk). The
 * wording never promises a lossless repair: the card says "what could be saved" and a recovered
 * file is only announced after main probed it (video stream and a real duration).
 */
export function RecoveryBanner({ busy }: { busy: boolean }) {
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [confirming, setConfirming] = useState<string | null>(null);

  // Lists on mount, whenever a capture ends and when the startup scan reports changes (the state
  // is set from the reply, not in the effect body).
  const [refresh, setRefresh] = useState(0);
  useEffect(
    () => window.framecapt.on('recovery:changed', () => setRefresh((count) => count + 1)),
    [],
  );
  useEffect(() => {
    if (busy) return;
    let active = true;
    void window.framecapt.invoke('recovery:list').then((result) => {
      if (active && result.ok) setCandidates(result.data.candidates);
    });
    return () => {
      active = false;
    };
  }, [busy, refresh]);

  const setOutcome = (sessionId: string, outcome: Outcome | null): void =>
    setOutcomes((current) => {
      const next = { ...current };
      if (outcome) next[sessionId] = outcome;
      else delete next[sessionId];
      return next;
    });

  async function recover(sessionId: string): Promise<void> {
    setOutcome(sessionId, { kind: 'working' });
    const result = await window.framecapt.invoke('recovery:recover', { sessionId });
    if (!result.ok) {
      setOutcome(sessionId, null);
      notify.error(result.error);
      return;
    }
    if (result.data.outcome === 'recovered')
      setOutcome(sessionId, { kind: 'done', result: result.data });
    else setOutcome(sessionId, { kind: 'failed', keptAt: result.data.keptAt });
  }

  async function discard(sessionId: string): Promise<void> {
    setConfirming(null);
    const result = await window.framecapt.invoke('recovery:discard', { sessionId });
    if (!result.ok) {
      notify.error(result.error);
      return;
    }
    setOutcome(sessionId, null);
    setCandidates((current) => current.filter((item) => item.sessionId !== sessionId));
  }

  const shown = candidates.filter((candidate) => outcomes[candidate.sessionId]?.kind !== 'done');
  const finished = candidates.filter((candidate) => outcomes[candidate.sessionId]?.kind === 'done');
  if (shown.length === 0 && finished.length === 0) return null;

  return (
    <section
      aria-label="Unfinished recordings"
      data-testid="recovery-banner"
      className="mb-5 flex flex-col gap-3"
    >
      {finished.map((candidate) => {
        const outcome = outcomes[candidate.sessionId];
        if (outcome?.kind !== 'done') return null;
        const { result } = outcome;
        return (
          <div
            key={candidate.sessionId}
            role="status"
            data-testid="recovery-result"
            className="flex flex-wrap items-center gap-3 rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-fg"
          >
            <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              Recovered {formatDuration(result.durationMs)} of video ({formatBytes(result.bytes)}).
              Recovered what could be saved, so the end may be missing.
              <span className="selectable block text-[13px] break-all opacity-80">
                {result.path}
              </span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              icon={<FolderOpen className="size-4" aria-hidden="true" />}
              data-testid="recovery-show"
              onClick={() =>
                void window.framecapt.invoke('recorder:showInFolder', { resultId: result.resultId })
              }
            >
              Show in folder
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="recovery-dismiss"
              onClick={() => {
                setOutcome(candidate.sessionId, null);
                setCandidates((current) =>
                  current.filter((item) => item.sessionId !== candidate.sessionId),
                );
              }}
            >
              Dismiss
            </Button>
          </div>
        );
      })}

      {shown.map((candidate) => {
        const outcome = outcomes[candidate.sessionId];
        const failed = outcome?.kind === 'failed';
        return (
          <div
            key={candidate.sessionId}
            data-testid="recovery-card"
            data-session-id={candidate.sessionId}
            className="rounded-xl border border-line bg-warning-soft px-4 py-3.5 text-sm text-fg"
          >
            <div className="flex flex-wrap items-center gap-3">
              {outcome?.kind === 'working' ? (
                <Loader size="sm" label="Recovering the recording" />
              ) : failed ? (
                <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
              ) : (
                <LifeBuoy className="size-4 shrink-0 text-warning" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                {failed ? (
                  <p data-testid="recovery-failed">
                    This recording couldn&apos;t be repaired. The raw data was kept at{' '}
                    <span className="selectable break-all">{outcome.keptAt}</span> for diagnostics.
                  </p>
                ) : (
                  <p>
                    We found an unfinished recording from{' '}
                    <strong>{new Date(candidate.createdAt).toLocaleString()}</strong> (
                    {formatBytes(candidate.bytes)}).
                  </p>
                )}
              </div>
              {failed ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="recovery-reveal"
                  onClick={() =>
                    void window.framecapt.invoke('recovery:reveal', {
                      sessionId: candidate.sessionId,
                    })
                  }
                >
                  Reveal
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="recovery-recover"
                  loading={outcome?.kind === 'working'}
                  disabled={busy}
                  onClick={() => void recover(candidate.sessionId)}
                >
                  Recover
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                data-testid="recovery-discard"
                disabled={busy || outcome?.kind === 'working'}
                onClick={() => setConfirming(candidate.sessionId)}
              >
                Discard
              </Button>
            </div>
            <Details candidate={candidate} />
          </div>
        );
      })}

      <AlertConfirm
        open={confirming !== null}
        title="Discard this unfinished recording?"
        description="This deletes the unfinished recording data for good. Recordings you already saved are not touched."
        cancelLabel="Keep it"
        confirmLabel="Discard"
        onConfirm={() => confirming && void discard(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </section>
  );
}
