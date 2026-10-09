import { MEETING_APPS, MEETING_APP_LABELS } from '../../../shared/meeting-signatures';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { updateSettings, useSettings } from '../../settings/store';
import { SectionCard, SettingRow } from './SettingRow';
import type { SectionProps } from './sections';

const SHARE_OPTIONS = [
  { value: 'auto', label: 'Add it to the recording' },
  { value: 'ask', label: 'Ask me' },
  { value: 'off', label: 'Do nothing' },
] as const;

export function MeetingsSection({ onReset }: SectionProps) {
  const { meetings } = useSettings();
  return (
    <SectionCard
      id="meetings"
      title="Meetings"
      description="FrameCapt can notice a meeting on this computer and offer to record it. It only looks at which meeting windows are open, on this computer."
      onReset={onReset}
    >
      <SettingRow
        label="Detect meetings and offer to record them"
        description="Google Meet in Chrome, Edge or Brave, Zoom, Microsoft Teams and Webex (English window titles)."
      >
        {({ labelledBy, describedBy }) => (
          <Switch
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            data-testid="setting-meetings-detect"
            checked={meetings.detect}
            onCheckedChange={(detect) => void updateSettings({ meetings: { detect } })}
          />
        )}
      </SettingRow>
      <SettingRow label="Apps" description="Offer to record meetings in these apps." stacked>
        {({ labelledBy }) => (
          <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-x-6 gap-y-2">
            {MEETING_APPS.map((app) => (
              <label key={app} className="flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  data-testid={`setting-meetings-app-${app}`}
                  checked={meetings.apps[app]}
                  disabled={!meetings.detect}
                  onChange={(event) =>
                    void updateSettings({
                      meetings: { apps: { ...meetings.apps, [app]: event.target.checked } },
                    })
                  }
                  className="size-4 accent-accent-solid"
                />
                {MEETING_APP_LABELS[app]}
              </label>
            ))}
          </div>
        )}
      </SettingRow>
      <SettingRow
        label="When you share your screen in a meeting"
        description="What FrameCapt does with a screen you share while it records the meeting."
      >
        {({ labelledBy }) => (
          <Select
            labelledBy={labelledBy}
            data-testid="setting-meetings-share"
            value={meetings.addSharedScreen}
            options={SHARE_OPTIONS}
            onChange={(addSharedScreen) => void updateSettings({ meetings: { addSharedScreen } })}
            className="w-56"
          />
        )}
      </SettingRow>
      <SettingRow
        label="Apps you chose not to be asked about"
        description={
          meetings.mutedApps.length === 0
            ? 'None. Choose "Don\'t ask for" on a meeting prompt to add an app here.'
            : 'FrameCapt does not offer to record meetings in these apps.'
        }
        stacked
        data-testid="setting-meetings-muted"
      >
        {() =>
          meetings.mutedApps.length === 0 ? null : (
            <ul className="flex flex-col gap-2">
              {meetings.mutedApps.map((app) => (
                <li key={app} className="flex items-center gap-3 text-sm text-fg">
                  <span className="min-w-32">{MEETING_APP_LABELS[app]}</span>
                  <Button
                    size="sm"
                    data-testid={`setting-meetings-ask-again-${app}`}
                    onClick={() =>
                      void updateSettings({
                        meetings: { mutedApps: meetings.mutedApps.filter((m) => m !== app) },
                      })
                    }
                  >
                    Ask again
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </SettingRow>
    </SectionCard>
  );
}
