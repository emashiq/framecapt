import { useEffect, useState } from 'react';
import type { MeetingListItem } from '../../shared/meeting-ipc';

/** The meetings main is watching right now: fetched once, then every `meeting:state` push. */
export function useMeetings(): MeetingListItem[] {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  useEffect(() => {
    let active = true;
    const off = window.framecapt.on('meeting:state', (list) => {
      if (active) setMeetings(list.meetings);
    });
    void window.framecapt.invoke('meeting:list').then((result) => {
      if (active && result.ok)
        setMeetings((current) => (current.length ? current : result.data.meetings));
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  return meetings;
}
