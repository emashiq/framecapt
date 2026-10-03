import { useEffect, useState } from 'react';
import type { ExportCapabilities } from '../../shared/history-ipc';

let cached: Promise<ExportCapabilities> | null = null;

/** Whether this build can make MP4 (asked once; main detected it at startup). */
export function loadExportCapabilities(): Promise<ExportCapabilities> {
  cached ??= window.framecapt
    .invoke('export:capabilities')
    .then((response) => (response.ok ? response.data : { mp4Available: false }));
  return cached;
}

export function useExportCapabilities(): ExportCapabilities | null {
  const [value, setValue] = useState<ExportCapabilities | null>(null);
  useEffect(() => {
    let live = true;
    void loadExportCapabilities().then((caps) => live && setValue(caps));
    return () => {
      live = false;
    };
  }, []);
  return value;
}
