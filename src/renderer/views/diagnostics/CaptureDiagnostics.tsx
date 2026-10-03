import { useEffect, useMemo, useState } from 'react';
import { Camera, FolderOpen, RefreshCw, ShieldCheck, Stethoscope } from 'lucide-react';
import { notify } from '../../lib/notify';
import type { DisplayInfo, SourceInfo } from '../../../shared/capture-schemas';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { CaptureError } from '../../capture/errors';
import {
  runDenialProbes,
  runScreenshotTest,
  type DenialProbeResult,
  type ScreenshotTestResult,
} from '../../capture/diagnostics';
import { FRAME_METHODS, type FrameMethodChoice } from '../../capture/frame';
import { detectRecorderFormats } from '../../capture/recorder-probe';
import { getResourceSnapshot, type ResourceSnapshot } from '../../capture/resource-registry';
import { Field, SelectInput, StatusPill } from './form';
import { RecordingTest } from './RecordingTest';
import { useCaptureSources } from './use-capture-sources';

function SubHeading({ children }: { children: string }) {
  return <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-fg-muted">{children}</h3>;
}

function screenSourceFor(display: DisplayInfo, sources: SourceInfo[]): SourceInfo | undefined {
  return sources.find((source) => source.kind === 'screen' && source.displayId === display.id);
}

function Resources() {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot>(getResourceSnapshot);
  useEffect(() => {
    const id = setInterval(() => setSnapshot(getResourceSnapshot()), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <p
      className="selectable text-sm text-fg-muted tabular-nums"
      data-testid="diag-resources"
      data-live-tracks={snapshot.liveTracks}
      data-audio-contexts={snapshot.openAudioContexts}
      data-loops={snapshot.activeLoops}
    >
      Live tracks {snapshot.liveTracks} - open audio contexts {snapshot.openAudioContexts} - active
      timers/loops {snapshot.activeLoops}
    </p>
  );
}

export function CaptureDiagnostics() {
  const { state, reload } = useCaptureSources();
  const [busy, setBusy] = useState<string | null>(null);
  const [method, setMethod] = useState<FrameMethodChoice>('auto');
  const [shots, setShots] = useState<Record<string, ScreenshotTestResult>>({});
  const [shotErrors, setShotErrors] = useState<Record<string, string>>({});
  const [probes, setProbes] = useState<DenialProbeResult[]>([]);
  const formats = useMemo(() => detectRecorderFormats(), []);

  const screens = state.sources.filter((source) => source.kind === 'screen');

  async function testScreenshot(display: DisplayInfo): Promise<void> {
    const source = screenSourceFor(display, state.sources);
    if (!source || busy) return;
    setBusy('screenshot');
    setShotErrors(({ [display.id]: _removed, ...rest }) => rest);
    try {
      const result = await runScreenshotTest(display, source.id, method);
      setShots((prev) => ({ ...prev, [display.id]: result }));
    } catch (error) {
      const text =
        error instanceof CaptureError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      setShotErrors((prev) => ({ ...prev, [display.id]: text }));
    } finally {
      setBusy(null);
    }
  }

  async function probe(): Promise<void> {
    if (busy) return;
    setBusy('probe');
    try {
      setProbes(await runDenialProbes(screens[0]?.id));
    } finally {
      setBusy(null);
    }
  }

  async function reveal(): Promise<void> {
    const result = await window.framecapt.invoke('diagnostics:revealFolder');
    if (!result.ok) notify.error(result.error);
  }

  return (
    <section aria-labelledby="diag-heading" data-testid="diagnostics-section">
      <Card padding="lg" className="space-y-6">
        <div className="flex items-center gap-3">
          <div
            className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-fg"
            aria-hidden="true"
          >
            <Stethoscope className="size-[18px]" />
          </div>
          <div className="flex-1">
            <h2 id="diag-heading" className="text-lg font-semibold text-fg">
              Capture diagnostics
            </h2>
            <p className="text-sm text-fg-muted">
              Feasibility checks for capture on this machine. Output stays in a FrameCapt folder.
            </p>
          </div>
          <Button
            size="sm"
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
            data-testid="sources-refresh"
            loading={state.status === 'loading'}
            onClick={reload}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            icon={<FolderOpen className="size-3.5" aria-hidden="true" />}
            data-testid="reveal-folder"
            onClick={() => void reveal()}
          >
            Reveal diagnostics folder
          </Button>
        </div>

        {state.status === 'error' ? (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        ) : null}

        <div>
          <div className="mb-2 flex items-end justify-between gap-4">
            <SubHeading>Displays</SubHeading>
            <Field label="Frame method" className="mb-2">
              <SelectInput
                data-testid="shot-method"
                value={method}
                onChange={(event) => setMethod(event.target.value as FrameMethodChoice)}
              >
                {FRAME_METHODS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          {state.status === 'ready' && state.displays.length === 0 ? (
            <p className="text-sm text-fg-muted">No displays were reported.</p>
          ) : null}
          <ul className="space-y-3" data-testid="diag-displays">
            {state.displays.map((display) => {
              const shot = shots[display.id];
              const shotError = shotErrors[display.id];
              return (
                <li
                  key={display.id}
                  className="selectable rounded-lg border border-line p-3 text-sm"
                  data-testid={`display-row-${display.id}`}
                  data-physical-width={display.physicalSize.width}
                  data-physical-height={display.physicalSize.height}
                  data-primary={display.isPrimary}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-fg">
                        {display.label}
                        {display.isPrimary ? ' (primary)' : ''}
                      </p>
                      <p className="text-fg-muted tabular-nums">
                        DIP bounds {display.bounds.x},{display.bounds.y} {display.bounds.width}x
                        {display.bounds.height} - scale {display.scaleFactor} - rotation{' '}
                        {display.rotation} - physical {display.physicalSize.width}x
                        {display.physicalSize.height}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      icon={<Camera className="size-3.5" aria-hidden="true" />}
                      data-testid={`shot-btn-${display.id}`}
                      unavailable={busy !== null || !screenSourceFor(display, state.sources)}
                      onClick={() => void testScreenshot(display)}
                    >
                      Test screenshot
                    </Button>
                  </div>
                  {shot ? (
                    <p
                      className="mt-2 flex flex-wrap items-center gap-2 text-fg-muted tabular-nums"
                      data-testid={`shot-result-${display.id}`}
                      data-pass={shot.pass}
                      data-result={JSON.stringify(shot)}
                    >
                      <StatusPill pass={shot.pass} />
                      {shot.width}x{shot.height} (expected {shot.expectedWidth}x
                      {shot.expectedHeight}) - {shot.method} - first frame{' '}
                      {shot.firstFrameMs.toFixed(0)} ms - {shot.bytes.toLocaleString()} bytes -{' '}
                      {shot.path}
                    </p>
                  ) : null}
                  {shotError ? (
                    <p
                      role="alert"
                      className="mt-2 text-danger"
                      data-testid={`shot-error-${display.id}`}
                    >
                      {shotError}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <SubHeading>Sources</SubHeading>
          <ul
            className="grid max-h-72 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3"
            data-testid="diag-sources"
          >
            {state.sources.map((source) => (
              <li
                key={source.id}
                className="selectable overflow-hidden rounded-lg border border-line bg-surface-2"
                data-testid="source-item"
                data-kind={source.kind}
                data-id={source.id}
                data-display-id={source.displayId ?? ''}
              >
                {source.thumbnail ? (
                  <img
                    src={source.thumbnail}
                    alt=""
                    className="h-24 w-full bg-surface-3 object-contain"
                  />
                ) : (
                  <div className="h-24 w-full bg-surface-3" />
                )}
                <p className="truncate px-2 py-1.5 text-xs text-fg-muted" title={source.name}>
                  {source.kind}: {source.name}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <SubHeading>Recording test</SubHeading>
          <RecordingTest
            displays={state.displays}
            sources={state.sources}
            busy={busy}
            setBusy={setBusy}
            onFinished={() => setBusy(null)}
          />
        </div>

        <div>
          <SubHeading>Authorization</SubHeading>
          <div className="mb-2 flex items-center gap-3">
            <Button
              size="sm"
              icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}
              data-testid="probe-run"
              unavailable={busy !== null}
              onClick={() => void probe()}
            >
              Test denial paths
            </Button>
          </div>
          <ul className="selectable space-y-1 text-sm text-fg-muted" data-testid="probe-results">
            {probes.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2"
                data-testid={`probe-result-${item.id}`}
                data-pass={item.pass}
              >
                <StatusPill pass={item.pass} />
                {item.id}: {item.detail}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <SubHeading>Recorder formats</SubHeading>
          <ul className="selectable space-y-1 text-sm text-fg-muted" data-testid="diag-formats">
            {Object.entries(formats.supported).map(([mime, supported]) => (
              <li key={mime} className="flex items-center gap-2" data-supported={supported}>
                <StatusPill pass={supported} label={supported ? 'yes' : 'no'} />
                {mime}
                {mime === formats.defaultMime ? ' (default)' : ''}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-sm text-fg-muted" data-testid="format-default">
            Default: {formats.defaultMime ?? 'none supported'}
          </p>
        </div>

        <div>
          <SubHeading>Resources</SubHeading>
          <Resources />
        </div>
      </Card>
    </section>
  );
}
