import { useState } from 'react';
import {
  Camera,
  HardDrive,
  Info,
  Keyboard,
  SlidersHorizontal,
  Stethoscope,
  Video,
} from 'lucide-react';
import type { ResetSection } from '../../shared/settings';
import type { SettingsSectionId } from '../../shared/settings-ipc';
import { PageHeader } from '../components/PageHeader';
import { AlertConfirm } from '../components/ui/AlertConfirm';
import { cn } from '../lib/cn';
import { resetSettings } from '../settings/store';
import { SavedIndicator } from './settings/SettingRow';
import {
  AboutSection,
  AdvancedSection,
  GeneralSection,
  RecordingSection,
  ScreenshotsSection,
  ShortcutsSection,
  StorageSection,
} from './settings/sections';

const NAV: {
  id: SettingsSectionId;
  label: string;
  icon: typeof Camera;
  /** What a reset puts back (sections without settings cannot be reset). */
  reset?: ResetSection;
  resetName?: string;
}[] = [
  {
    id: 'general',
    label: 'General',
    icon: SlidersHorizontal,
    reset: 'general',
    resetName: 'General',
  },
  {
    id: 'screenshots',
    label: 'Screenshots',
    icon: Camera,
    reset: 'screenshots',
    resetName: 'Screenshot',
  },
  { id: 'recording', label: 'Recording', icon: Video, reset: 'recording', resetName: 'Recording' },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: Keyboard,
    reset: 'shortcuts',
    resetName: 'Shortcut',
  },
  { id: 'storage', label: 'Storage', icon: HardDrive, reset: 'storage', resetName: 'Storage' },
  { id: 'advanced', label: 'Advanced', icon: Stethoscope },
  { id: 'about', label: 'About', icon: Info },
];

export interface SettingsViewProps {
  section?: SettingsSectionId;
  onSectionChange?: (section: SettingsSectionId) => void;
}

/**
 * Settings in sections (General, Screenshots, Recording, Shortcuts, Storage, Advanced, About), one
 * at a time. Every change is applied and saved at once ("Saved" shows briefly); each section can go
 * back to its defaults after a confirmation.
 */
export function SettingsView({ section, onSectionChange }: SettingsViewProps) {
  // The section lives in the app (the tray menu and the home screen can ask for one).
  const current: SettingsSectionId = section ?? 'general';
  const [resetting, setResetting] = useState<ResetSection | null>(null);
  const select = (next: SettingsSectionId): void => onSectionChange?.(next);
  const resetEntry = NAV.find((item) => item.reset === resetting);

  const ask = (reset: ResetSection) => () => setResetting(reset);

  return (
    <div data-testid="settings-view">
      <div className="mb-7 flex items-start justify-between gap-4">
        <PageHeader
          title="Settings"
          description="Changes are saved as you make them."
          className="mb-0"
        />
        <div className="pt-2">
          <SavedIndicator />
        </div>
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        <nav aria-label="Settings sections" className="md:w-48 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {NAV.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  aria-current={id === current ? 'page' : undefined}
                  data-testid={`settings-nav-${id}`}
                  onClick={() => select(id)}
                  className={cn(
                    'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150',
                    id === current
                      ? 'bg-accent-soft text-accent-fg'
                      : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
                  )}
                >
                  <Icon className="size-[18px]" aria-hidden="true" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          {current === 'general' ? <GeneralSection onReset={ask('general')} /> : null}
          {current === 'screenshots' ? <ScreenshotsSection onReset={ask('screenshots')} /> : null}
          {current === 'recording' ? <RecordingSection onReset={ask('recording')} /> : null}
          {current === 'shortcuts' ? <ShortcutsSection onReset={ask('shortcuts')} /> : null}
          {current === 'storage' ? <StorageSection onReset={ask('storage')} /> : null}
          {current === 'advanced' ? <AdvancedSection /> : null}
          {current === 'about' ? <AboutSection /> : null}
        </div>
      </div>

      <AlertConfirm
        open={resetting !== null}
        title={`Reset ${resetEntry?.resetName?.toLowerCase() ?? ''} settings?`}
        description={
          resetting === 'storage'
            ? 'Both folders go back to Pictures\\FrameCapt and Videos\\FrameCapt. Files you already saved stay where they are.'
            : 'These settings go back to their defaults. Your captures and folders are not touched.'
        }
        cancelLabel="Keep my settings"
        confirmLabel="Reset"
        onConfirm={() => {
          const section = resetting;
          setResetting(null);
          if (section) void resetSettings(section);
        }}
        onCancel={() => setResetting(null)}
      />
    </div>
  );
}
