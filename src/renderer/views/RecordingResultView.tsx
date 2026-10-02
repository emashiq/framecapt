import { useEffect, useRef, type ReactNode } from 'react';
import { notify } from '../lib/notify';
import {
  AudioLines,
  Clock,
  Copy,
  FolderOpen,
  HardDrive,
  History,
  Maximize2,
  Plus,
  TriangleAlert,
  VolumeX,
} from 'lucide-react';
import type { RecorderSnapshot, RecordingResult } from '../../shared/recorder-ipc';
import { formatBytes, formatDuration } from '../../shared/recording';
import { Mp4Export } from '../components/Mp4Export';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { revealDuration } from '../lib/reveal-duration';
import { PageHeader } from '../components/PageHeader';

function Badge({
  icon,
  children,
  testId,
}: {
  icon: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[13px] font-medium text-fg-muted tabular-nums"
    >
      <span aria-hidden="true" className="text-fg-subtle">
        {icon}
      </span>
      {children}
    </span>
  );
}

/** Why a recording ended early, in words, or null for a normal stop. */
function earlyStopNotice(snapshot: RecorderSnapshot): string | null {
  if (snapshot.error) return `The recording stopped early. ${snapshot.error.message}`;
  if (snapshot.stopReason === 'source-lost') {
    return 'The recorded screen or window went away, so the recording ended there. Everything up to that point was saved.';
  }
  if (snapshot.stopReason === 'engine-closed') {
    return 'The recorder closed unexpectedly. The recording may be missing its last moments.';
  }
  return null;
}

export interface RecordingResultViewProps {
  snapshot: RecorderSnapshot;
  result: RecordingResult;
  onNewRecording: () => void;
  /** Opens History: the recording is listed there with every action. */
  onOpenHistory: () => void;
}

/**
 * Shown in the Capture tab after a recording is finished and saved: a player for the file (served
 * by the main-owned `framelet-media:` protocol), its facts, and what to do next.
 */
export function RecordingResultView({
  snapshot,
  result,
  onNewRecording,
  onOpenHistory,
}: RecordingResultViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const notice = earlyStopNotice(snapshot);
  const unindexedNotice = result.unindexed
    ? 'Saved without a seeking index: the video plays, but jumping to a time may not work. The original data was kept; Framelet will offer to repair it the next time it starts.'
    : null;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const run = (
    promise: Promise<{ ok: boolean; error?: { message: string } }>,
    done?: string,
  ): void => {
    void promise.then((response) => {
      if (!response.ok) notify.error(response.error ?? 'That did not work.');
      else if (done) notify.success(done);
    });
  };

  return (
    <div data-testid="recording-result">
      <div ref={headingRef} tabIndex={-1} className="outline-none">
        <PageHeader
          title={notice ? 'Recording saved (stopped early)' : 'Recording saved'}
          description={
            <span className="selectable" data-testid="result-file">
              {result.fileName}
            </span>
          }
        />
      </div>

      {notice ? (
        <div
          role="status"
          data-testid="result-notice"
          className="mb-4 flex items-start gap-2.5 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {notice}
        </div>
      ) : null}

      {unindexedNotice ? (
        <div
          role="status"
          data-testid="result-unindexed"
          className="mb-4 flex items-start gap-2.5 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {unindexedNotice}
        </div>
      ) : null}

      <Card padding="md">
        <video
          ref={videoRef}
          data-testid="result-video"
          src={`framelet-media://${result.id}`}
          controls
          preload="metadata"
          onLoadedMetadata={(event) => revealDuration(event.currentTarget)}
          className="h-[min(42vh,380px)] w-full rounded-lg bg-black"
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge icon={<Clock className="size-3.5" />} testId="badge-duration">
            {formatDuration(result.durationMs)}
          </Badge>
          <Badge icon={<HardDrive className="size-3.5" />} testId="badge-size">
            {formatBytes(result.bytes)}
          </Badge>
          <Badge icon={<Maximize2 className="size-3.5" />} testId="badge-dimensions">
            {result.width} × {result.height}
          </Badge>
          <Badge
            icon={
              result.hasAudio ? (
                <AudioLines className="size-3.5" />
              ) : (
                <VolumeX className="size-3.5" />
              )
            }
            testId="badge-audio"
          >
            {result.hasAudio ? 'With audio' : 'No audio'}
          </Badge>
        </div>
        <p
          className="selectable mt-3 text-[13px] break-all text-fg-subtle"
          data-testid="result-path"
        >
          {result.path}
        </p>
      </Card>

      {result.historyId ? (
        <Mp4Export historyId={result.historyId} className="mt-4 max-w-sm" />
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <Button
          variant="secondary"
          icon={<FolderOpen className="size-4" aria-hidden="true" />}
          data-testid="result-show"
          onClick={() =>
            run(window.framelet.invoke('recorder:showInFolder', { resultId: result.id }))
          }
        >
          Show in folder
        </Button>
        <Button
          variant="secondary"
          icon={<Copy className="size-4" aria-hidden="true" />}
          data-testid="result-copy-path"
          onClick={() =>
            run(window.framelet.invoke('recorder:copyPath', { resultId: result.id }), 'Path copied')
          }
        >
          Copy path
        </Button>
        <Button
          variant="ghost"
          icon={<History className="size-4" aria-hidden="true" />}
          data-testid="result-history"
          onClick={onOpenHistory}
        >
          Open history
        </Button>
        <Button
          variant="primary"
          className="ml-auto"
          icon={<Plus className="size-4" aria-hidden="true" />}
          data-testid="result-new"
          onClick={onNewRecording}
        >
          New recording
        </Button>
      </div>
    </div>
  );
}
