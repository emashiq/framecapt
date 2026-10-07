import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useSettings } from '../settings/store';
import { setCaptureFolder } from './actions';
import { FolderPickerDialog } from './FolderPickerDialog';
import { folderLabel } from './tree';
import { useLibrary } from './use-library';

/**
 * "Saving to: Clients / Acme" with a link to change it: where new screenshots, recordings and step
 * guides go. The folders are real folders inside the capture folders (see History's folder pane).
 */
export function SavingTo() {
  const folder = useSettings().general.captureFolder;
  const { tree } = useLibrary();
  const [picking, setPicking] = useState(false);
  return (
    <div
      data-testid="saving-to"
      className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-muted"
    >
      <FolderOpen className="size-4 text-fg-subtle" aria-hidden="true" />
      <span>
        Saving to:{' '}
        <strong data-testid="saving-to-folder" className="font-medium text-fg">
          {folder === null ? 'Main capture folders' : folderLabel(folder)}
        </strong>
      </span>
      <button
        type="button"
        data-testid="saving-to-change"
        onClick={() => setPicking(true)}
        className="rounded text-accent-fg underline-offset-2 hover:underline"
      >
        Change
      </button>
      <FolderPickerDialog
        open={picking}
        title="Save new captures to"
        confirmLabel="Save here"
        rootLabel="Main capture folders"
        tree={tree}
        initial={folder}
        onClose={() => setPicking(false)}
        onConfirm={(chosen) => {
          setPicking(false);
          void setCaptureFolder(chosen);
        }}
      />
    </div>
  );
}
