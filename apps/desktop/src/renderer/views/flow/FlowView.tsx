import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  ChevronDown,
  FileCode2,
  Film,
  ImageDown,
  Images,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import { MAX_TITLE_LENGTH, type FlowStep } from '../../../shared/flow';
import type { FLOW_EXPORT_KINDS } from '../../../shared/flow-ipc';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { cancelMp4Export, useExportState } from '../../history/export-store';
import { useExportCapabilities } from '../../history/use-export-capabilities';
import { useFlow } from '../../flow/use-flow';
import { renderStepFrame } from '../../flow/render';
import { notify } from '../../lib/notify';
import { menuItemClass } from '../history/HistoryCard';
import { StepCard } from './StepCard';

export interface FlowViewProps {
  historyId: string;
  /** Back to History. */
  onBack: () => void;
  /** Opens one step in the screenshot editor (the pending edits are saved first). */
  onEditStep: (historyId: string, index: number) => void;
}

type ExportKind = (typeof FLOW_EXPORT_KINDS)[number];

/**
 * A saved step guide: an editable title, one card per step (the picture with its pointer ring, a
 * caption, move, delete and "open in the editor") and the Export menu. Everything is read and
 * saved by history id through main; edits are saved a moment after the last keystroke.
 */
export function FlowView({ historyId, onBack, onEditStep }: FlowViewProps) {
  const flow = useFlow(historyId);
  const caps = useExportCapabilities();
  const exportState = useExportState(historyId);
  const [busy, setBusy] = useState<string | null>(null);

  const videoRunning = exportState?.status === 'running' && exportState.compressing !== true;

  /** Draws every step in the renderer (ring, banner) and hands the pictures to main, which asks where to save. */
  async function exportGuide(kind: ExportKind): Promise<void> {
    if (busy) return;
    setBusy(kind === 'images' ? 'Preparing the pictures…' : 'Preparing the export…');
    try {
      await flow.flush();
      const frames: ArrayBuffer[] = [];
      for (const [index, step] of flow.steps.entries()) {
        const read = await window.framecapt.invoke('flow:readStep', { historyId, index });
        if (!read.ok) {
          notify.error(read.error);
          return;
        }
        // HTML shows its captions as text, so its pictures carry the ring only.
        frames.push(
          await renderStepFrame(read.data.png, step, index + 1, { banner: kind !== 'html' }),
        );
      }
      const response = await window.framecapt.invoke('flow:export', { historyId, kind, frames });
      if (!response.ok) {
        notify.error(response.error);
      } else if ('path' in response.data) {
        const saved = response.data.path;
        notify.success(kind === 'images' ? 'Step pictures saved' : 'Guide saved', {
          action: {
            label: 'Show in folder',
            onClick: () => void window.framecapt.invoke('shell:showItemInFolder', { path: saved }),
          },
        });
      } else if ('jobId' in response.data) {
        notify.info('Making the video… You can keep working.');
      }
    } catch {
      notify.error('The export could not be prepared.');
    } finally {
      setBusy(null);
    }
  }

  function removeStep(index: number): void {
    const removed = flow.remove(index);
    if (!removed) return;
    notify.info(`Step ${index + 1} deleted`, {
      duration: 6000,
      action: { label: 'Undo', onClick: () => flow.restore(removed.step, removed.index) },
    });
  }

  async function editStep(index: number): Promise<void> {
    await flow.flush();
    onEditStep(historyId, index);
  }

  if (flow.load.status === 'loading') {
    return (
      <div
        role="status"
        data-testid="flow-loading"
        className="flex items-center gap-2 text-sm text-fg-muted"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Opening the guide…
      </div>
    );
  }
  if (flow.load.status === 'error') {
    return (
      <div data-testid="flow-error">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft className="size-4" aria-hidden="true" />}
          onClick={onBack}
          className="mb-5"
        >
          All captures
        </Button>
        <EmptyState
          icon={<TriangleAlert className="size-6" />}
          title="This guide can’t be opened"
          description={flow.load.message}
        />
      </div>
    );
  }

  const stepWord = flow.steps.length === 1 ? 'step' : 'steps';

  return (
    <div data-testid="flow-view" data-id={historyId}>
      <div className="mb-5">
        <Button
          variant="ghost"
          size="sm"
          data-testid="flow-back"
          icon={<ArrowLeft className="size-4" aria-hidden="true" />}
          onClick={onBack}
        >
          All captures
        </Button>
      </div>

      <header className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <input
            value={flow.title}
            onChange={(event) => flow.setTitle(event.target.value)}
            maxLength={MAX_TITLE_LENGTH}
            placeholder="Untitled guide"
            aria-label="Guide title"
            data-testid="flow-title"
            className="selectable w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold tracking-tight text-fg outline-none placeholder:text-fg-subtle hover:border-line focus-visible:border-accent-solid"
          />
          <p className="mt-1 px-2 text-sm text-fg-muted" data-testid="flow-count">
            {flow.steps.length} {stepWord}
            {flow.createdAt > 0 ? ` · ${new Date(flow.createdAt).toLocaleDateString()}` : ''}
          </p>
        </div>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button
              variant="primary"
              data-testid="flow-export"
              loading={busy !== null}
              disabled={videoRunning}
              icon={<ImageDown className="size-4" aria-hidden="true" />}
            >
              Export
              <ChevronDown className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-50 min-w-64 rounded-xl border border-line bg-surface p-1.5 text-fg shadow-raised"
            >
              <DropdownMenu.Item
                data-testid="flow-export-images"
                onSelect={() => void exportGuide('images')}
                className={menuItemClass}
              >
                <Images className="size-4 text-fg-subtle" aria-hidden="true" />
                Pictures (PNG)…
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-testid="flow-export-html"
                onSelect={() => void exportGuide('html')}
                className={menuItemClass}
              >
                <FileCode2 className="size-4 text-fg-subtle" aria-hidden="true" />
                Web page (HTML)…
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item
                data-testid="flow-export-mp4"
                disabled={caps !== null && !caps.mp4Available}
                onSelect={() => void exportGuide('mp4')}
                className={menuItemClass}
              >
                <Film className="size-4 text-fg-subtle" aria-hidden="true" />
                Slideshow video (MP4)…
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-testid="flow-export-gif"
                onSelect={() => void exportGuide('gif')}
                className={menuItemClass}
              >
                <Film className="size-4 text-fg-subtle" aria-hidden="true" />
                Slideshow animation (GIF)…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>

      {busy ? (
        <p role="status" className="mb-4 flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {busy}
        </p>
      ) : null}
      {videoRunning ? (
        <div
          role="status"
          data-testid="flow-export-progress"
          className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm"
        >
          <Loader2 className="size-4 animate-spin text-accent" aria-hidden="true" />
          <span className="flex-1">
            Making the video
            {exportState.percent === null ? '…' : ` ${exportState.percent}%`}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void cancelMp4Export(historyId)}>
            Cancel
          </Button>
        </div>
      ) : null}

      <ol className="grid list-none gap-5 p-0 lg:grid-cols-2" data-testid="flow-steps">
        {flow.steps.map((step: FlowStep, index) => (
          <StepCard
            key={step.file}
            step={step}
            url={flow.urls[step.file] ?? ''}
            index={index}
            count={flow.steps.length}
            onCaption={(caption) => flow.setCaption(step.file, caption)}
            onMove={(to) => flow.move(index, to)}
            onDropFrom={(from) => flow.move(from, index)}
            onDelete={() => removeStep(index)}
            onEdit={() => void editStep(index)}
          />
        ))}
      </ol>
    </div>
  );
}
