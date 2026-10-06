import { CheckCircle2, CircleSlash, XCircle } from 'lucide-react';
import type { BulkExportDone } from '../../../shared/history-ipc';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Dialog';

export interface BulkResultDialogProps {
  summary: BulkExportDone | null;
  /** Names of the items by id (the list as the grid shows it). */
  nameOf: (id: string) => string;
  onClose: () => void;
}

/** What happened to each item of a "Save copies" run that did not go entirely well. */
export function BulkResultDialog({ summary, nameOf, onClose }: BulkResultDialogProps) {
  const open = summary !== null && summary.results.some((result) => result.status !== 'saved');
  return (
    <Modal
      open={open}
      onClose={onClose}
      label="Save copies summary"
      data-testid="bulk-summary"
      className="w-[min(520px,92vw)]"
    >
      {summary ? (
        <div className="flex max-h-[80vh] flex-col p-6">
          <h2 className="text-lg font-semibold text-fg">
            {summary.cancelled ? 'Saving was cancelled' : 'Some copies were not saved'}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {summary.results.filter((result) => result.status === 'saved').length} of{' '}
            {summary.results.length} saved to {summary.folder}. Nothing was overwritten.
          </p>
          <ul className="mt-4 min-h-0 flex-1 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {summary.results.map((result) => (
              <li
                key={result.id}
                data-status={result.status}
                className="flex items-start gap-2.5 px-3 py-2 text-sm"
              >
                {result.status === 'saved' ? (
                  <CheckCircle2
                    className="mt-0.5 size-4 shrink-0 text-success"
                    aria-hidden="true"
                  />
                ) : result.status === 'failed' ? (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                ) : (
                  <CircleSlash
                    className="mt-0.5 size-4 shrink-0 text-fg-subtle"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">
                    {result.fileName ?? nameOf(result.id)}
                  </span>
                  <span className="block text-xs text-fg-muted">
                    {result.status === 'saved'
                      ? 'Saved'
                      : `${result.status === 'failed' ? 'Not saved' : 'Skipped'}${result.message ? `: ${result.message}` : ''}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end">
            <Button variant="primary" data-testid="bulk-summary-close" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
