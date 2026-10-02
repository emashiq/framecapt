import { Clock } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';

export function HistoryView() {
  return (
    <>
      <PageHeader title="History" description="Everything you capture is listed here." />
      <EmptyState
        icon={<Clock className="size-6" />}
        title="Nothing here yet"
        description="Once you take a screenshot or record your screen, it will appear here so you can find it again, copy it or open its folder."
      />
    </>
  );
}
