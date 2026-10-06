import { Camera, ListOrdered, Video, type LucideProps } from 'lucide-react';
import type { HistoryType } from '../../shared/history-ipc';

/** The small icon of a history item's kind. */
export function TypeIcon({ type, ...props }: { type: HistoryType } & LucideProps) {
  if (type === 'screenshot') return <Camera {...props} />;
  if (type === 'flow') return <ListOrdered {...props} />;
  return <Video {...props} />;
}
