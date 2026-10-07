import { useRef, useState, type KeyboardEvent } from 'react';
import { Home, Keyboard, Library, ListOrdered, Settings, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { Tooltip } from './ui/Tooltip';

/** What the rail can show in the pinned tab. Guides is the Library filtered to step guides. */
export type SectionId = 'home' | 'library' | 'guides' | 'settings';

const ITEMS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'guides', label: 'Guides', icon: ListOrdered },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export interface RailProps {
  /** The section the pinned tab shows; highlighted only while that tab is showing. */
  section: SectionId | null;
  onNavigate: (section: SectionId) => void;
  onHelp: () => void;
  /** A recording is running: a dot on Home says so. */
  recording: boolean;
}

interface RailButtonProps {
  label: string;
  hint?: string;
  icon: LucideIcon;
  active?: boolean;
  tabStop: boolean;
  badge?: boolean;
  testId?: string;
  onFocus: () => void;
  onClick: () => void;
}

function RailButton({
  label,
  hint,
  icon: Icon,
  active = false,
  tabStop,
  badge = false,
  testId,
  onFocus,
  onClick,
}: RailButtonProps) {
  return (
    <Tooltip
      side="right"
      content={
        <span className="flex items-center gap-2">
          {label}
          {hint ? (
            <span className="rounded bg-bg/20 px-1 font-mono text-[11px]">{hint}</span>
          ) : null}
        </span>
      }
    >
      <button
        type="button"
        aria-label={badge ? `${label}, recording in progress` : label}
        aria-current={active ? 'page' : undefined}
        data-testid={testId}
        data-rail=""
        tabIndex={tabStop ? 0 : -1}
        onFocus={onFocus}
        onClick={onClick}
        className={cn(
          'relative flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-150',
          active
            ? 'bg-accent-soft text-accent-fg'
            : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
        )}
      >
        {active ? (
          <span
            aria-hidden="true"
            className="absolute top-1/2 -left-2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-solid"
          />
        ) : null}
        <Icon className="size-5" aria-hidden="true" />
        {badge ? (
          <span
            aria-hidden="true"
            data-testid="rail-recording-dot"
            className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger-solid ring-2 ring-rail"
          />
        ) : null}
      </button>
    </Tooltip>
  );
}

/**
 * The icon rail: Home, Library, Guides and Settings (each a section of the pinned Home tab) and,
 * at the bottom, the keyboard shortcuts. Icons only, with tooltips; arrow keys move between them
 * (one tab stop for the whole rail).
 */
export function Rail({ section, onNavigate, onHelp, recording }: RailProps) {
  const navRef = useRef<HTMLElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const activeIndex = ITEMS.findIndex((item) => item.id === section);
  const tabIndex = focusIndex;
  const count = ITEMS.length + 1;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const buttons = [...(navRef.current?.querySelectorAll<HTMLElement>('[data-rail]') ?? [])];
    const at = buttons.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (at + 1) % count;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (at - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <aside className="flex w-14 shrink-0 flex-col border-r border-line bg-rail" data-testid="rail">
      <nav
        ref={navRef}
        aria-label="Primary"
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col items-center gap-1 py-2"
      >
        {ITEMS.map(({ id, label, icon }, index) => (
          <RailButton
            key={id}
            label={label}
            icon={icon}
            testId={`rail-${id}`}
            active={index === activeIndex}
            tabStop={index === tabIndex}
            badge={id === 'home' && recording}
            onFocus={() => setFocusIndex(index)}
            onClick={() => onNavigate(id)}
          />
        ))}
        <div className="mt-auto" />
        <RailButton
          label="Keyboard shortcuts"
          hint="?"
          icon={Keyboard}
          testId="help-button"
          tabStop={tabIndex === ITEMS.length}
          onFocus={() => setFocusIndex(ITEMS.length)}
          onClick={onHelp}
        />
      </nav>
    </aside>
  );
}
