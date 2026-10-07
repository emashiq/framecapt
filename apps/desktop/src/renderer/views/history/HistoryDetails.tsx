import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Copy,
  CopyPlus,
  ExternalLink,
  FileBox,
  FileX2,
  FolderOpen,
  Link2,
  Pencil,
  Save,
  Trash2,
} from 'lucide-react';
import type { HistoryItemView } from '../../../shared/history-ipc';
import { formatBytes, formatDuration } from '../../../shared/recording';
import { Mp4Export } from '../../components/Mp4Export';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { fileUrl, newNonce, thumbUrl } from '../../history/media-url';
import { cn } from '../../lib/cn';
import { revealDuration } from '../../lib/reveal-duration';
import { formatExact, formatRelative } from '../../lib/time';
import {
  canDuplicateItem,
  canEditItem,
  canSaveProjectFile,
  editLabel,
  type ItemActions,
} from './actions';
import { dimensionsText, TypeBadge } from './HistoryCard';
import { FcapExtract } from './FcapExtract';
import { FcapPlayer } from './FcapPlayer';
import { SaveAsButton, SaveAsProgress, canSaveAs } from './SaveAs';
import { Thumb } from './Thumb';

export interface HistoryDetailsProps {
  item: HistoryItemView;
  /** The recording this MP4 was made from, when it is still in history. */
  original: HistoryItemView | undefined;
  now: number;
  actions: ItemActions;
  onBack: () => void;
  onSelect: (item: HistoryItemView) => void;
  onAskDelete: (item: HistoryItemView) => void;
  /** Opens a screenshot in the editor again. */
  onEdit?: (item: HistoryItemView) => void;
  /** Asks to delete the editable data (unredacted original and annotations) of a screenshot. */
  onAskDeleteProject?: (item: HistoryItemView) => void;
}

const SOURCE_LABEL: Record<HistoryItemView['source'], string> = {
  screen: 'Whole screen',
  window: 'Window',
  region: 'Region',
  multi: 'Multiple sources',
  unknown: 'Unknown',
};

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[13px]">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="selectable min-w-0 text-right text-fg tabular-nums" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/**
 * The image or the video of an item, served by the main-owned file route. Every mount (a new
 * item, a re-linked file, a re-saved screenshot) uses a URL of its own: the media stack remembers
 * a failed load per URL, and an entry that was removed and restored, or a file that was missing and
 * re-linked, keeps its id.
 */
function Preview({ item }: { item: HistoryItemView }) {
  const [nonce] = useState(newNonce);
  const [failed, setFailed] = useState(false);
  // A guide has no single file to show: its first step (the thumbnail) stands for it.
  const src = item.type === 'flow' ? thumbUrl(item.id, nonce) : fileUrl(item.id, nonce);
  // A multi-source recording plays only here: tabs choose the whole picture or one source.
  if (item.format === 'fcap') {
    return item.layout ? (
      <FcapPlayer item={item} layout={item.layout} />
    ) : (
      <p
        role="alert"
        data-testid="fcap-unreadable"
        className="rounded-lg bg-danger-soft px-3 py-6 text-center text-[13px] text-danger"
      >
        FrameCapt cannot read this recording. The file may be damaged or incomplete.
      </p>
    );
  }
  // A GIF is a recording (it came from one) but an <img> plays it.
  if (item.type === 'recording' && item.format !== 'gif') {
    return failed ? (
      <p
        role="alert"
        data-testid="history-video-unplayable"
        className="rounded-lg bg-surface-2 px-3 py-6 text-center text-[13px] text-fg-muted"
      >
        FrameCapt cannot play this {item.format.toUpperCase()} file here (its video or audio format
        is not one the built-in player supports). Use Open to play it in your video player.
      </p>
    ) : (
      <video
        data-testid="history-video"
        src={src}
        controls
        preload="metadata"
        onLoadedMetadata={(event) => revealDuration(event.currentTarget)}
        onError={() => setFailed(true)}
        className="max-h-[min(58vh,520px)] w-full rounded-lg bg-black"
      />
    );
  }
  return (
    <div className="checkerboard flex items-center justify-center rounded-lg">
      <img
        data-testid="history-image"
        src={src}
        alt={
          item.type === 'flow'
            ? `Step guide ${item.fileName}`
            : `${item.type === 'recording' ? 'Animation' : 'Screenshot'} ${item.fileName}`
        }
        className="max-h-[min(58vh,520px)] w-full object-contain"
      />
    </div>
  );
}

export function HistoryDetails({
  item,
  original,
  now,
  actions,
  onBack,
  onSelect,
  onAskDelete,
  onEdit,
  onAskDeleteProject,
}: HistoryDetailsProps) {
  const headingRef = useRef<HTMLDivElement>(null);
  const missing = !item.exists;
  const isVideo = item.type === 'recording';

  useEffect(() => {
    headingRef.current?.focus();
  }, [item.id]);

  return (
    <div
      data-testid="history-details"
      data-id={item.id}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) onBack();
      }}
    >
      <div className="mb-5 flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          data-testid="history-back"
          icon={<ArrowLeft className="size-4" aria-hidden="true" />}
          onClick={onBack}
        >
          All captures
        </Button>
      </div>
      <div ref={headingRef} tabIndex={-1} className="mb-5 flex items-center gap-3 outline-none">
        <h1 className="selectable min-w-0 truncate text-xl font-semibold tracking-tight text-fg">
          {item.fileName}
        </h1>
        <TypeBadge item={item} />
      </div>

      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card padding="none" className="overflow-hidden p-3">
            {missing ? (
              <div
                data-testid="history-missing-details"
                className="relative flex aspect-video flex-col items-center justify-center gap-2 rounded-lg bg-surface-2 px-6 text-center"
              >
                <Thumb item={item} className="absolute inset-0 rounded-lg" />
                <div className="relative flex flex-col items-center gap-1.5 rounded-xl bg-bg/80 px-5 py-4 backdrop-blur-sm">
                  <FileX2 className="size-6 text-fg-subtle" aria-hidden="true" />
                  <p className="text-sm font-medium text-fg">File moved or deleted</p>
                  <p className="max-w-xs text-[13px] text-fg-muted">
                    FrameCapt can no longer find this file. Nothing else was changed. If you moved
                    it, point FrameCapt to its new place.
                  </p>
                </div>
              </div>
            ) : (
              <Preview key={`${item.id}|${item.path}|${item.createdAt}`} item={item} />
            )}
          </Card>

          {isVideo && item.format === 'webm' && !missing ? (
            <Mp4Export historyId={item.id} className="w-full" />
          ) : null}
          {canSaveAs(item) && !missing ? <SaveAsProgress item={item} /> : null}
          {item.format === 'fcap' && item.layout && !missing ? (
            <p className="text-[13px] text-fg-muted" data-testid="fcap-note">
              This recording opens only in FrameCapt. Use Extract to save one source, or a part of
              it, as an MP4 or WebM video that plays anywhere, or Edit video to cut, crop and export
              it.
            </p>
          ) : null}
          <p className="selectable text-xs break-all text-fg-subtle" data-testid="history-path">
            {item.path}
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <Card padding="md" className="p-4">
            <dl className="divide-y divide-line">
              <Row label="Type">
                {item.type === 'flow'
                  ? `Step guide · ${item.stepCount ?? 0} ${item.stepCount === 1 ? 'step' : 'steps'}`
                  : `${isVideo ? 'Recording' : 'Screenshot'} · ${item.format.toUpperCase()}`}
              </Row>
              <Row label="Created">
                <span title={formatExact(item.createdAt)}>
                  {formatRelative(item.createdAt, now)}
                </span>
              </Row>
              {dimensionsText(item) ? <Row label="Size">{dimensionsText(item)}</Row> : null}
              {item.durationMs !== null ? (
                <Row label="Duration">{formatDuration(item.durationMs)}</Row>
              ) : null}
              <Row label="File size">{formatBytes(item.sizeBytes)}</Row>
              {isVideo && item.hasAudio !== null ? (
                <Row label="Audio">{item.hasAudio ? 'With audio' : 'No audio'}</Row>
              ) : null}
              <Row label="Captured">{SOURCE_LABEL[item.source]}</Row>
              {item.layout ? (
                <Row label="Sources" testId="fcap-sources">
                  {item.layout.sources.map((source) => source.name).join(', ')}
                </Row>
              ) : null}
              {item.derivedFrom ? (
                <Row label="Converted from">
                  {original ? (
                    <button
                      type="button"
                      className="max-w-full truncate text-accent-fg underline-offset-2 hover:underline"
                      onClick={() => onSelect(original)}
                    >
                      {original.fileName}
                    </button>
                  ) : (
                    'a recording no longer in history'
                  )}
                </Row>
              ) : null}
            </dl>
          </Card>

          <div className={cn('flex flex-col gap-2')}>
            {missing ? (
              <>
                <Button
                  variant="primary"
                  data-testid="details-locate"
                  icon={<Link2 className="size-4" aria-hidden="true" />}
                  onClick={() => actions.locate(item)}
                >
                  Locate…
                </Button>
                <Button
                  variant="secondary"
                  data-testid="details-remove"
                  icon={<Trash2 className="size-4" aria-hidden="true" />}
                  onClick={() => {
                    actions.remove(item);
                    onBack();
                  }}
                >
                  Remove from history
                </Button>
              </>
            ) : (
              <>
                {item.format === 'fcap' ? (
                  item.layout ? (
                    <FcapExtract key={item.id} item={item} layout={item.layout} />
                  ) : null
                ) : (
                  <Button
                    variant="primary"
                    data-testid="details-open"
                    icon={<ExternalLink className="size-4" aria-hidden="true" />}
                    onClick={() => actions.open(item)}
                  >
                    {item.type === 'flow' ? 'Open guide' : 'Open'}
                  </Button>
                )}
                {canEditItem(item) && onEdit ? (
                  <Button
                    variant="secondary"
                    data-testid="details-edit"
                    icon={<Pencil className="size-4" aria-hidden="true" />}
                    onClick={() => onEdit(item)}
                  >
                    {editLabel(item)}
                  </Button>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    data-testid="details-reveal"
                    icon={<FolderOpen className="size-4" aria-hidden="true" />}
                    onClick={() => actions.reveal(item)}
                  >
                    Show in folder
                  </Button>
                  <Button
                    variant="secondary"
                    data-testid="details-copy"
                    icon={<Copy className="size-4" aria-hidden="true" />}
                    onClick={() => actions.copy(item)}
                  >
                    {item.type === 'screenshot' ? 'Copy image' : 'Copy path'}
                  </Button>
                </div>
                {canSaveAs(item) ? <SaveAsButton onOpen={() => actions.saveAs(item)} /> : null}
                {isVideo ? (
                  <Button
                    variant="secondary"
                    data-testid="details-save-copy"
                    icon={<Save className="size-4" aria-hidden="true" />}
                    onClick={() => actions.saveCopy(item)}
                  >
                    Save a copy as…
                  </Button>
                ) : null}
                {canDuplicateItem(item) ? (
                  <Button
                    variant="secondary"
                    data-testid="details-duplicate"
                    icon={<CopyPlus className="size-4" aria-hidden="true" />}
                    onClick={() => actions.duplicate(item)}
                  >
                    Duplicate
                  </Button>
                ) : null}
                {canSaveProjectFile(item) ? (
                  <Button
                    variant="secondary"
                    data-testid="details-save-project"
                    icon={<FileBox className="size-4" aria-hidden="true" />}
                    onClick={() => actions.saveProjectFile(item)}
                  >
                    Save as project file…
                  </Button>
                ) : null}
                {item.editable && onAskDeleteProject ? (
                  <div className="flex flex-col gap-1">
                    <Button
                      variant="secondary"
                      data-testid="history-delete-project"
                      icon={<Trash2 className="size-4" aria-hidden="true" />}
                      onClick={() => onAskDeleteProject(item)}
                    >
                      Delete editable data…
                    </Button>
                    <p className="text-xs text-fg-subtle">
                      Keeps the image, but it can no longer be edited with its original annotations.
                    </p>
                  </div>
                ) : null}
                <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
                  <Button
                    variant="ghost"
                    data-testid="details-remove"
                    icon={<Trash2 className="size-4" aria-hidden="true" />}
                    onClick={() => {
                      actions.remove(item);
                      onBack();
                    }}
                  >
                    Remove from history
                  </Button>
                  <Button
                    variant="ghost"
                    data-testid="details-delete"
                    className="text-danger! not-aria-disabled:hover:bg-danger-soft not-aria-disabled:hover:text-danger!"
                    icon={<Trash2 className="size-4" aria-hidden="true" />}
                    onClick={() => onAskDelete(item)}
                  >
                    Delete file…
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
