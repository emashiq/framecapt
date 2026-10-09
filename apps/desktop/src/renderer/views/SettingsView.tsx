import { useLayoutEffect, useRef, useState } from 'react';
import {
  Camera,
  HardDrive,
  Info,
  Keyboard,
  Search,
  SearchX,
  X,
  SlidersHorizontal,
  Stethoscope,
  Users,
  Video,
} from 'lucide-react';
import type { ResetSection } from '../../shared/settings';
import type { SettingsSectionId } from '../../shared/settings-ipc';
import { PageHeader } from '../components/PageHeader';
import { AlertConfirm } from '../components/ui/AlertConfirm';
import { EmptyState } from '../components/ui/EmptyState';
import { cn } from '../lib/cn';
import { resetSettings } from '../settings/store';
import { MeetingsSection } from './settings/MeetingsSection';
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
  { id: 'meetings', label: 'Meetings', icon: Users, reset: 'meetings', resetName: 'Meetings' },
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

/**
 * The settings search filters what is already on the page, by text: every section is shown, rows
 * that do not match are hidden, and a section whose title matches keeps all its rows. A section
 * with nothing left is hidden. Returns how many sections stay visible.
 */
function filterSettings(root: HTMLElement, query: string): number {
  const needle = query.trim().toLowerCase();
  let visible = 0;
  for (const block of Array.from(root.children) as HTMLElement[]) {
    const title = block.querySelector('h2')?.textContent?.toLowerCase() ?? '';
    const rows = Array.from(block.querySelectorAll<HTMLElement>('[data-setting-row]'));
    const titleMatch = needle === '' || title.includes(needle);
    let any = titleMatch;
    for (const row of rows) {
      const match = titleMatch || (row.textContent ?? '').toLowerCase().includes(needle);
      row.style.display = match ? '' : 'none';
      any ||= match;
    }
    block.style.display = any ? '' : 'none';
    if (any) visible += 1;
  }
  return visible;
}

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
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState(NAV.length);
  const resultsRef = useRef<HTMLDivElement>(null);
  const searching = search.trim() !== '';
  useLayoutEffect(() => {
    if (searching && resultsRef.current) setMatches(filterSettings(resultsRef.current, search));
  }, [search, searching]);
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

      <label className="relative mb-5 block max-w-sm">
        <span className="sr-only">Search settings</span>
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden="true"
        />
        <input
          type="search"
          data-testid="settings-search"
          aria-label="Search settings"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && search) {
              event.preventDefault();
              setSearch('');
            }
          }}
          placeholder="Search settings"
          className="selectable h-9 w-full rounded-lg border border-control bg-surface pr-8 pl-8 text-[13px] text-fg shadow-card placeholder:text-fg-subtle focus-visible:border-accent [&::-webkit-search-cancel-button]:hidden"
        />
        {search ? (
          <button
            type="button"
            aria-label="Clear search"
            data-testid="settings-search-clear"
            onClick={() => setSearch('')}
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </label>

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

        {searching ? (
          <div className="min-w-0 flex-1">
            <p className="sr-only" role="status" data-testid="settings-search-status">
              {matches === 0 ? 'No settings match' : `${matches} sections match`}
            </p>
            <div ref={resultsRef} className="flex flex-col gap-6" data-testid="settings-results">
              <GeneralSection onReset={ask('general')} />
              <ScreenshotsSection onReset={ask('screenshots')} />
              <RecordingSection onReset={ask('recording')} />
              <MeetingsSection onReset={ask('meetings')} />
              <ShortcutsSection onReset={ask('shortcuts')} />
              <StorageSection onReset={ask('storage')} />
              <AdvancedSection />
              <AboutSection />
            </div>
            {matches === 0 ? (
              <EmptyState
                icon={<SearchX className="size-6" />}
                title="No settings match"
                description="Try another word, such as folder, shortcut or microphone."
              />
            ) : null}
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            {current === 'general' ? <GeneralSection onReset={ask('general')} /> : null}
            {current === 'screenshots' ? <ScreenshotsSection onReset={ask('screenshots')} /> : null}
            {current === 'recording' ? <RecordingSection onReset={ask('recording')} /> : null}
            {current === 'meetings' ? <MeetingsSection onReset={ask('meetings')} /> : null}
            {current === 'shortcuts' ? <ShortcutsSection onReset={ask('shortcuts')} /> : null}
            {current === 'storage' ? <StorageSection onReset={ask('storage')} /> : null}
            {current === 'advanced' ? <AdvancedSection /> : null}
            {current === 'about' ? <AboutSection /> : null}
          </div>
        )}
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
