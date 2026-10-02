import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, FileImage, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ImageFormat, ShotSessionMeta } from '../../shared/shots';
import { ConfirmDialog } from '../components/ui/Dialog';
import { Button } from '../components/ui/Button';
import { Kbd } from '../components/ui/Kbd';
import { Tooltip } from '../components/ui/Tooltip';
import { pngToJpeg } from '../capture/encode';

export interface ShotResult {
  session: ShotSessionMeta;
  /** The original PNG. Phase 04's editor replaces it with the flattened edit. */
  png: ArrayBuffer;
  /** True once the image was saved or copied (no discard confirmation needed). */
  safe: boolean;
}

const KIND_LABEL: Record<ShotSessionMeta['kind'], string> = {
  screen: 'Screen',
  window: 'Window',
  region: 'Region',
};

/** "…\Framelet\file.png" for a toast: the last two path segments. */
function shortPath(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : file;
}

export interface ResultViewProps {
  shot: ShotResult;
  /** Called after the image was copied or saved. */
  onSafe: () => void;
  /** The session was discarded; go back to the capture view. */
  onDone: () => void;
}

/**
 * Temporary result screen until the phase-04 editor: shows the screenshot on a checkerboard and
 * offers copy / save / discard. Everything goes through `shot:*` channels with image bytes, which
 * is also how the editor will hand over its flattened output.
 */
export function ResultView({ shot, onSafe, onDone }: ResultViewProps) {
  const { session } = shot;
  const [busy, setBusy] = useState<'copy' | ImageFormat | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const url = useMemo(
    () => URL.createObjectURL(new Blob([shot.png], { type: 'image/png' })),
    [shot.png],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const copy = useCallback(async () => {
    setBusy('copy');
    const result = await window.framelet.invoke('shot:copy', {
      sessionId: session.id,
      bytes: shot.png,
    });
    setBusy(null);
    if (result.ok) {
      onSafe();
      toast.success('Copied to clipboard');
    } else toast.error(result.error.message);
  }, [session.id, shot.png, onSafe]);

  const save = useCallback(
    async (format: ImageFormat) => {
      setBusy(format);
      try {
        const bytes = format === 'png' ? shot.png : await pngToJpeg(shot.png);
        const result = await window.framelet.invoke('shot:export', {
          sessionId: session.id,
          format,
          bytes,
        });
        if (!result.ok) {
          toast.error(result.error.message);
        } else if ('path' in result.data) {
          const saved = result.data.path;
          onSafe();
          toast.success(`Saved to ${shortPath(saved)}`, {
            action: {
              label: 'Show in folder',
              onClick: () => void window.framelet.invoke('shell:showItemInFolder', { path: saved }),
            },
          });
        }
      } catch {
        toast.error('Could not save the image.');
      } finally {
        setBusy(null);
      }
    },
    [session.id, shot.png, onSafe],
  );

  const discard = useCallback(async () => {
    setConfirmOpen(false);
    await window.framelet.invoke('shot:discard', { sessionId: session.id });
    onDone();
  }, [session.id, onDone]);

  const requestLeave = useCallback(() => {
    if (shot.safe) void discard();
    else setConfirmOpen(true);
  }, [shot.safe, discard]);

  // Ctrl+C copies and Ctrl+S saves, unless the user is selecting text or a dialog is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || confirmOpen) return;
      const key = event.key.toLowerCase();
      if (key === 'c' && !event.shiftKey && !window.getSelection()?.toString()) {
        event.preventDefault();
        void copy();
      } else if (key === 's' && !event.shiftKey) {
        event.preventDefault();
        void save('png');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [copy, save, confirmOpen]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="result-view">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="mr-auto flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Screenshot</h1>
          <span
            data-testid="result-dimensions"
            className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[13px] font-medium text-fg-muted tabular-nums"
          >
            {session.width} × {session.height} px
          </span>
          <span className="text-[13px] text-fg-subtle">{KIND_LABEL[session.kind]}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip content={<Kbd keys={['Ctrl', 'C']} />}>
            <Button
              variant="primary"
              size="sm"
              icon={<Copy className="size-4" aria-hidden="true" />}
              loading={busy === 'copy'}
              onClick={() => void copy()}
              data-testid="result-copy"
            >
              Copy
            </Button>
          </Tooltip>
          <Tooltip content={<Kbd keys={['Ctrl', 'S']} />}>
            <Button
              size="sm"
              icon={<Save className="size-4 text-fg-subtle" aria-hidden="true" />}
              loading={busy === 'png'}
              onClick={() => void save('png')}
              data-testid="result-save-png"
            >
              Save PNG
            </Button>
          </Tooltip>
          <Button
            size="sm"
            icon={<FileImage className="size-4 text-fg-subtle" aria-hidden="true" />}
            loading={busy === 'jpeg'}
            onClick={() => void save('jpeg')}
            data-testid="result-save-jpeg"
          >
            Save JPEG
          </Button>
          <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 className="size-4" aria-hidden="true" />}
            onClick={requestLeave}
            data-testid="result-discard"
          >
            Discard
          </Button>
          <Button
            size="sm"
            icon={<Plus className="size-4 text-fg-subtle" aria-hidden="true" />}
            onClick={requestLeave}
            data-testid="result-new"
          >
            New capture
          </Button>
        </div>
      </div>

      <div className="checkerboard flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-line p-4">
        <img
          src={url}
          alt={`Screenshot, ${session.width} by ${session.height} pixels`}
          draggable={false}
          data-testid="result-image"
          className="max-h-full max-w-full rounded-sm object-contain shadow-raised"
        />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Discard this screenshot?"
        description="It has not been saved or copied yet. Discarding deletes it for good."
        confirmLabel="Discard"
        onConfirm={() => void discard()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
