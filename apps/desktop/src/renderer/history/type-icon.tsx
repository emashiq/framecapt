import { Camera, FileBox, ListOrdered, Video, type LucideProps } from 'lucide-react';
import type { HistoryType } from '../../shared/history-ipc';

/** The small icon of a history item's kind; an item saved to or opened from a project file shows the project icon. */
export function TypeIcon({
  type,
  project,
  ...props
}: { type: HistoryType; project?: boolean | undefined } & LucideProps) {
  if (project) return <FileBox {...props} />;
  if (type === 'screenshot') return <Camera {...props} />;
  if (type === 'flow') return <ListOrdered {...props} />;
  return <Video {...props} />;
}
