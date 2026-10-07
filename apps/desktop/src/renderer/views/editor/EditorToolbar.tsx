import { memo, useEffect, useRef, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Check,
  ChevronDown,
  Copy,
  FileBox,
  FileImage,
  FolderOpen,
  Images,
  Maximize,
  PanelRight,
  Redo2,
  Save,
  Trash2,
  Undo2,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { ImageFormat } from '../../../shared/shots';
import { acceleratorKeys, type EditorAction } from '../../../shared/shortcuts';
import { Kbd } from '../../components/ui/Kbd';
import { Tooltip } from '../../components/ui/Tooltip';
import { cn } from '../../lib/cn';
import { useSettings } from '../../settings/store';
import {
  BLUR_TIP,
  INSERT_IMAGE,
  REDACT_TIP,
  TOOL_GROUPS,
  TOOLS,
  type ToolDef,
  type ToolId,
} from './tools';

/**
 * Roving tabindex for a role="toolbar": exactly one control is in the tab order, the arrow keys,
 * Home and End move between controls. Tab leaves the toolbar. Applied to the DOM directly so the
 * buttons themselves stay simple.
 */
function useRovingToolbar(containerRef: React.RefObject<HTMLDivElement | null>) {
  const activeRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const items = (): HTMLElement[] =>
      [...container.querySelectorAll<HTMLElement>('[data-roving]')].filter(
        (item) => !item.hasAttribute('disabled'),
      );
    const sync = (): void => {
      const list = items();
      const active =
        activeRef.current && list.includes(activeRef.current) ? activeRef.current : list[0];
      for (const item of container.querySelectorAll<HTMLElement>('[data-roving]')) {
        item.tabIndex = item === active ? 0 : -1;
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-pressed'],
    });
    const onFocusIn = (event: FocusEvent): void => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-roving]');
      if (target) {
        activeRef.current = target;
        sync();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLElement);
      if (index < 0) return;
      let next: number;
      if (event.key === 'ArrowRight') next = (index + 1) % list.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + list.length) % list.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = list.length - 1;
      else return;
      event.preventDefault();
      list[next]?.focus();
    };
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('keydown', onKeyDown);
    };
  }, [containerRef]);
}

interface BarButtonProps {
  label: string;
  /** Shown in the tooltip next to the label. */
  keys?: string[];
  icon: ReactNode;
  text?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId: string;
  variant?: 'ghost' | 'primary' | 'secondary';
  tooltip?: ReactNode;
}

function BarButton({
  label,
  keys,
  icon,
  text,
  pressed,
  disabled,
  onClick,
  testId,
  variant = 'ghost',
  tooltip,
}: BarButtonProps) {
  return (
    <Tooltip
      content={
        tooltip ?? (
          <span className="flex items-center gap-2">
            {label}
            {keys && <Kbd keys={keys} />}
          </span>
        )
      }
      side="bottom"
      passthrough
    >
      <button
        type="button"
        data-roving=""
        data-testid={testId}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg text-[13px] font-medium whitespace-nowrap transition-colors duration-150 disabled:opacity-40',
          text ? 'px-3' : 'w-9',
          variant === 'primary' &&
            'bg-accent-solid text-white shadow-card not-disabled:hover:bg-accent-solid-hover',
          variant === 'secondary' &&
            'border border-line bg-surface text-fg shadow-card not-disabled:hover:border-line-strong not-disabled:hover:bg-surface-2',
          variant === 'ghost' &&
            (pressed
              ? 'bg-accent-soft text-accent-fg ring-1 ring-accent/50'
              : 'text-fg-muted not-disabled:hover:bg-surface-3 not-disabled:hover:text-fg'),
        )}
      >
        {icon}
        {text}
      </button>
    </Tooltip>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />;

export interface EditorToolbarProps {
  tool: ToolId;
  onTool: (tool: ToolId) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** 1 = 100%. */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onActualSize: () => void;
  busy: 'copy' | ImageFormat | null;
  onCopy: () => void;
  /** The format the Save button and Ctrl+S use (a setting). */
  saveFormat: ImageFormat;
  onSave: (format: ImageFormat) => void;
  onDone: () => void;
  onDiscard: () => void;
  /** The properties panel is open. */
  panelOpen: boolean;
  onTogglePanel: () => void;
  /**
   * Editing a screenshot opened from History: Save writes over that item (in its own format) and
   * the menu saves a copy.
   */
  reedit?: { format: ImageFormat } | undefined;
  /** Saves a copy (a new history item) in `format`. */
  onSaveCopy: (format: ImageFormat) => void;
  /** Saves the edits as a `.fcimage` project file (only for an item in history). */
  onSaveProject?: () => void;
  /** Saves over the history item the editor was opened from. */
  onSaveOver: () => void;
  /** Saves into the screenshots folder with no dialog (a new history item). */
  onQuickSave: () => void;
  /** Insert image > From file. */
  onInsertFile: () => void;
  /** Insert image > From History. */
  onInsertHistory: () => void;
}

export const EditorToolbar = memo(function EditorToolbar(props: EditorToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  useRovingToolbar(ref);
  const { tool, busy } = props;
  const { editorShortcuts } = useSettings();
  /** The live key labels of an action (undefined when it is turned off), for the tooltips. */
  const keysOf = (action: EditorAction): string[] | undefined => {
    const accelerator = editorShortcuts[action];
    return accelerator ? acceleratorKeys(accelerator) : undefined;
  };
  const saveKeys = keysOf('save');
  const insertKeys = keysOf(INSERT_IMAGE.action);
  const quickKeys = keysOf('quickSave');
  const percent = `${Math.round(props.zoom * 100)}%`;
  const { reedit } = props;
  const saveLocked = busy !== null;
  const saveLabel = reedit
    ? 'Save changes to this screenshot'
    : `Save as ${props.saveFormat === 'png' ? 'PNG' : 'JPEG'}`;

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Screenshot editor"
      aria-orientation="horizontal"
      data-testid="editor-toolbar"
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Tools">
        {TOOL_GROUPS.map((group, index) => (
          <div
            key={group.label}
            role="group"
            aria-label={group.label}
            className="flex items-center gap-1"
          >
            {index > 0 && <Divider />}
            {group.ids.map((id) => {
              const def = TOOLS.find((candidate) => candidate.id === id) as ToolDef;
              const Icon = def.icon;
              const keys = keysOf(def.action);
              const note = id === 'redact' ? REDACT_TIP : id === 'blur' ? BLUR_TIP : def.hint;
              return (
                <BarButton
                  key={id}
                  testId={`tool-${id}`}
                  label={def.label}
                  keys={keys}
                  tooltip={
                    <span className="flex flex-col gap-1">
                      <span className="flex items-center gap-2">
                        {def.label} {keys ? <Kbd keys={keys} /> : null}
                      </span>
                      <span className="font-normal opacity-80">{note ?? def.hint}</span>
                    </span>
                  }
                  pressed={tool === id}
                  icon={<Icon className="size-[18px]" aria-hidden="true" />}
                  onClick={() => props.onTool(id)}
                />
              );
            })}
          </div>
        ))}
        <div role="group" aria-label="Insert" className="flex items-center gap-1">
          <Divider />
          <DropdownMenu.Root>
            <Tooltip
              content={
                <span className="flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    {INSERT_IMAGE.label} {insertKeys ? <Kbd keys={insertKeys} /> : null}
                  </span>
                  <span className="font-normal opacity-80">{INSERT_IMAGE.hint}</span>
                </span>
              }
              side="bottom"
              passthrough
            >
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  data-roving=""
                  data-testid="editor-insert-image"
                  aria-label={INSERT_IMAGE.label}
                  className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-fg-muted transition-colors duration-150 hover:bg-surface-3 hover:text-fg"
                >
                  <INSERT_IMAGE.icon className="size-[18px]" aria-hidden="true" />
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
            </Tooltip>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                sideOffset={6}
                className="z-50 min-w-60 rounded-xl border border-line bg-surface p-1.5 text-sm text-fg shadow-raised"
              >
                <DropdownMenu.Item
                  data-testid="editor-insert-file"
                  onSelect={() => props.onInsertFile()}
                  className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-fg"
                >
                  <FolderOpen className="size-4 text-fg-subtle" aria-hidden="true" />
                  <span className="flex-1">From file…</span>
                  {insertKeys ? <Kbd keys={insertKeys} /> : null}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  data-testid="editor-insert-history"
                  onSelect={() => props.onInsertHistory()}
                  className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-fg"
                >
                  <Images className="size-4 text-fg-subtle" aria-hidden="true" />
                  <span className="flex-1">From History…</span>
                </DropdownMenu.Item>
                <p className="px-2.5 pt-1.5 pb-1 text-xs text-fg-subtle">
                  You can also paste a picture (Ctrl+V) or drop a file on the canvas.
                </p>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Zoom">
        <BarButton
          testId="zoom-out"
          label="Zoom out"
          keys={keysOf('zoomOut')}
          icon={<ZoomOut className="size-[18px]" aria-hidden="true" />}
          onClick={props.onZoomOut}
        />
        <BarButton
          testId="zoom-actual"
          label={`Zoom ${percent}, click for 100%`}
          keys={keysOf('zoomActual')}
          icon={null}
          text={percent}
          onClick={props.onActualSize}
        />
        <BarButton
          testId="zoom-in"
          label="Zoom in"
          keys={keysOf('zoomIn')}
          icon={<ZoomIn className="size-[18px]" aria-hidden="true" />}
          onClick={props.onZoomIn}
        />
        <BarButton
          testId="zoom-fit"
          label="Fit to window"
          keys={keysOf('zoomFit')}
          icon={<Maximize className="size-[18px]" aria-hidden="true" />}
          onClick={props.onFit}
        />
      </div>

      <div className="flex items-center justify-end gap-1">
        <BarButton
          testId="editor-undo"
          label="Undo"
          keys={keysOf('undo')}
          disabled={!props.canUndo}
          icon={<Undo2 className="size-[18px]" aria-hidden="true" />}
          onClick={props.onUndo}
        />
        <BarButton
          testId="editor-redo"
          label="Redo"
          keys={keysOf('redo')}
          disabled={!props.canRedo}
          icon={<Redo2 className="size-[18px]" aria-hidden="true" />}
          onClick={props.onRedo}
        />
        <Divider />
        <BarButton
          testId="editor-copy"
          label="Copy to clipboard"
          keys={keysOf('copy')}
          variant="primary"
          disabled={busy !== null}
          icon={<Copy className="size-4" aria-hidden="true" />}
          text="Copy"
          onClick={props.onCopy}
        />
        <div className="flex items-center">
          <Tooltip
            content={
              <span className="flex items-center gap-2">
                {saveLabel} {saveKeys ? <Kbd keys={saveKeys} /> : null}
              </span>
            }
            side="bottom"
          >
            <button
              type="button"
              data-roving=""
              data-testid="editor-save"
              aria-label={saveLabel}
              disabled={saveLocked}
              onClick={() => (reedit ? props.onSaveOver() : props.onSave(props.saveFormat))}
              className="inline-flex h-9 items-center gap-2 rounded-l-lg border border-line bg-surface px-3 text-[13px] font-medium text-fg shadow-card transition-colors duration-150 not-disabled:hover:border-line-strong not-disabled:hover:bg-surface-2 disabled:opacity-40"
            >
              <Save className="size-4 text-fg-subtle" aria-hidden="true" />
              {reedit ? 'Save changes' : 'Save'}
            </button>
          </Tooltip>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                data-roving=""
                data-testid="editor-save-menu"
                aria-label={reedit ? 'Save a copy…' : 'Save as…'}
                disabled={saveLocked}
                className="-ml-px inline-flex h-9 w-8 items-center justify-center rounded-r-lg border border-line bg-surface text-fg-subtle shadow-card transition-colors duration-150 not-disabled:hover:border-line-strong not-disabled:hover:bg-surface-2 disabled:opacity-40"
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-50 min-w-60 rounded-xl border border-line bg-surface p-1.5 text-sm text-fg shadow-raised"
              >
                {(['png', 'jpeg'] as const).map((format) => (
                  <DropdownMenu.Item
                    key={format}
                    data-testid={reedit ? `editor-copy-${format}` : `editor-save-${format}`}
                    onSelect={() => (reedit ? props.onSaveCopy(format) : props.onSave(format))}
                    className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-fg"
                  >
                    <FileImage className="size-4 text-fg-subtle" aria-hidden="true" />
                    <span className="flex-1">
                      {reedit ? 'Save a copy as' : 'Save as'} {format === 'png' ? 'PNG' : 'JPEG'}
                    </span>
                    {!reedit && props.saveFormat === format && saveKeys ? (
                      <Kbd keys={saveKeys} />
                    ) : null}
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item
                  data-testid="editor-quick-save"
                  onSelect={() => props.onQuickSave()}
                  className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-fg"
                >
                  <Zap className="size-4 text-fg-subtle" aria-hidden="true" />
                  <span className="flex-1">Quick save (no dialog)</span>
                  {quickKeys ? <Kbd keys={quickKeys} /> : null}
                </DropdownMenu.Item>
                {props.onSaveProject ? (
                  <DropdownMenu.Item
                    data-testid="editor-save-project"
                    onSelect={() => props.onSaveProject?.()}
                    className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-fg"
                  >
                    <FileBox className="size-4 text-fg-subtle" aria-hidden="true" />
                    <span className="flex-1">Save as project file (.fcimage)…</span>
                  </DropdownMenu.Item>
                ) : null}
                <p className="px-2.5 pt-1.5 pb-1 text-xs text-fg-subtle">
                  JPEG pads redactions to its 16 px blocks so they stay solid black.
                </p>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        <Divider />
        <BarButton
          testId="editor-panel-toggle"
          label={props.panelOpen ? 'Hide properties' : 'Show properties'}
          icon={<PanelRight className="size-[18px]" aria-hidden="true" />}
          pressed={props.panelOpen}
          onClick={props.onTogglePanel}
        />
        <BarButton
          testId="editor-discard"
          label="Discard screenshot"
          icon={<Trash2 className="size-4" aria-hidden="true" />}
          text="Discard"
          onClick={props.onDiscard}
        />
        <BarButton
          testId="editor-done"
          label="Done"
          variant="secondary"
          icon={<Check className="size-4 text-fg-subtle" aria-hidden="true" />}
          text="Done"
          onClick={props.onDone}
        />
      </div>
    </div>
  );
});
