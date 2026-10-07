import { Images } from 'lucide-react';
import { useHistory } from '../../history/use-history';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Dialog';
import { formatExact } from '../../lib/time';
import { Thumb } from '../history/Thumb';

export interface HistoryImagePickerProps {
  open: boolean;
  onClose: () => void;
  /** The history id of the screenshot to insert. */
  onPick: (id: string) => void;
}

/** Choose one of the saved screenshots to insert into the editor as an image layer. */
export function HistoryImagePicker({ open, onClose, onPick }: HistoryImagePickerProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      label="Insert a screenshot from History"
      className="w-[min(40rem,92vw)]"
      data-testid="history-image-picker"
    >
      <Body onClose={onClose} onPick={onPick} />
    </Modal>
  );
}

function Body({ onClose, onPick }: Pick<HistoryImagePickerProps, 'onClose' | 'onPick'>) {
  const { items, loaded } = useHistory({ filter: 'screenshot', limit: 60 });
  const available = items.filter((item) => item.exists);
  return (
    <div className="flex max-h-[80vh] flex-col">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-base font-semibold text-fg">Insert from History</h2>
        <p className="text-sm text-fg-muted">Pick a saved screenshot to place on this one.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
        {loaded && available.length === 0 ? (
          <EmptyState
            icon={<Images className="size-6" />}
            title="No saved screenshots"
            description="Screenshots you save show up here."
          />
        ) : (
          <ul className="grid grid-cols-3 gap-3">
            {available.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid="history-image-item"
                  data-id={item.id}
                  title={`${item.fileName} · ${formatExact(item.createdAt)}`}
                  aria-label={`Insert ${item.fileName}`}
                  onClick={() => onPick(item.id)}
                  className="block w-full overflow-hidden rounded-xl border border-line bg-surface text-left shadow-card transition-[border-color,box-shadow] duration-150 hover:border-accent hover:shadow-raised"
                >
                  <Thumb item={item} className="aspect-video w-full" />
                  <span className="block truncate px-2.5 py-1.5 text-xs text-fg-muted">
                    {item.fileName}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex justify-end border-t border-line px-5 py-3">
        <Button variant="secondary" onClick={onClose} data-testid="history-image-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}
