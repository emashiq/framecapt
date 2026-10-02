import { useRef, useState } from 'react';
import { Square, Video } from 'lucide-react';
import type { DisplayInfo, SourceInfo } from '../../../shared/capture-schemas';
import { Button } from '../../components/ui/Button';
import { CaptureError } from '../../capture/errors';
import { useMicrophones } from '../../recorder/use-microphones';
import {
  RECORDING_LIMITS,
  runRecordingTest,
  type RecordingTestResult,
} from '../../capture/diagnostics';
import type { CanvasDriver, CropMethod } from '../../capture/region-crop';
import { CheckboxField, Field, NumberInput, SelectInput } from './form';

interface Props {
  displays: DisplayInfo[];
  sources: SourceInfo[];
  busy: string | null;
  setBusy: (value: string | null) => void;
  onFinished: () => void;
}

export function RecordingTest({ displays, sources, busy, setBusy, onFinished }: Props) {
  const microphones = useMicrophones();
  const [sourceId, setSourceId] = useState('');
  const [useRegion, setUseRegion] = useState(false);
  const [region, setRegion] = useState({ x: 100, y: 100, width: 1280, height: 720 });
  const [cropMethod, setCropMethod] = useState<CropMethod>('canvas');
  const [driver, setDriver] = useState<CanvasDriver>('rvfc');
  const [systemAudio, setSystemAudio] = useState(false);
  const [mic, setMic] = useState('off');
  const [duration, setDuration] = useState(4);
  const [tone, setTone] = useState(false);
  const [result, setResult] = useState<RecordingTestResult | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selected = sources.find((source) => source.id === sourceId) ?? sources[0];
  const display = displays.find((candidate) => candidate.id === selected?.displayId);
  const regionPossible = selected?.kind === 'screen' && display !== undefined;
  const running = busy === 'recording';

  async function start(): Promise<void> {
    if (!selected || busy) return;
    setBusy('recording');
    setResult(null);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const outcome = await runRecordingTest(
        {
          sourceId: selected.id,
          region: useRegion && regionPossible ? region : undefined,
          displaySize: display?.physicalSize,
          cropMethod,
          canvasDriver: driver,
          systemAudio,
          micDeviceId: mic === 'off' ? undefined : mic === 'default' ? '' : mic,
          durationSec: duration,
          playTestTone: tone,
          fps: 30,
        },
        controller.signal,
      );
      setResult(outcome);
    } catch (caught) {
      const failure =
        caught instanceof CaptureError
          ? { code: caught.code, message: caught.message }
          : { code: 'unknown', message: caught instanceof Error ? caught.message : String(caught) };
      setError(failure);
    } finally {
      abortRef.current = null;
      setBusy(null);
      onFinished();
    }
  }

  return (
    <div className="space-y-4" data-testid="recording-test">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Source">
          <SelectInput
            data-testid="rec-source"
            value={selected?.id ?? ''}
            onChange={(event) => setSourceId(event.target.value)}
            disabled={running}
          >
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.kind === 'screen' ? 'Screen' : 'Window'}: {source.name}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Microphone">
          <SelectInput
            data-testid="rec-mic"
            value={mic}
            onChange={(event) => setMic(event.target.value)}
            disabled={running}
          >
            <option value="off">Off</option>
            <option value="default">Default device</option>
            {microphones.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Microphone ${index + 1}`}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <CheckboxField
          label="System audio"
          data-testid="rec-system-audio"
          checked={systemAudio}
          onChange={(event) => setSystemAudio(event.target.checked)}
          disabled={running}
        />
        <CheckboxField
          label="Play test tone (440 Hz)"
          data-testid="rec-tone"
          checked={tone}
          onChange={(event) => setTone(event.target.checked)}
          disabled={running}
        />
        <Field label={`Duration (${RECORDING_LIMITS.minSec}-${RECORDING_LIMITS.maxSec} s)`}>
          <NumberInput
            data-testid="rec-duration"
            min={RECORDING_LIMITS.minSec}
            max={RECORDING_LIMITS.maxSec}
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
            disabled={running}
          />
        </Field>
      </div>

      <fieldset className="rounded-lg border border-line p-3" disabled={running || !regionPossible}>
        <legend className="px-1 text-[13px] font-medium text-fg-muted">
          Region (pixels of the selected screen)
        </legend>
        <div className="flex flex-wrap items-end gap-3">
          <CheckboxField
            label="Record a region"
            data-testid="rec-use-region"
            checked={useRegion && regionPossible}
            onChange={(event) => setUseRegion(event.target.checked)}
          />
          {(['x', 'y', 'width', 'height'] as const).map((key) => (
            <Field key={key} label={key === 'width' ? 'w' : key === 'height' ? 'h' : key}>
              <NumberInput
                data-testid={`rec-region-${key}`}
                value={region[key]}
                onChange={(event) =>
                  setRegion((prev) => ({ ...prev, [key]: Number(event.target.value) }))
                }
              />
            </Field>
          ))}
          <Field label="Crop method">
            <SelectInput
              data-testid="rec-crop-method"
              value={cropMethod}
              onChange={(event) => setCropMethod(event.target.value as CropMethod)}
            >
              <option value="canvas">Canvas</option>
              <option value="track-processor">Track processor</option>
            </SelectInput>
          </Field>
          <Field label="Canvas driver">
            <SelectInput
              data-testid="rec-driver"
              value={driver}
              onChange={(event) => setDriver(event.target.value as CanvasDriver)}
            >
              <option value="rvfc">Video frame callback</option>
              <option value="timer">Timer</option>
            </SelectInput>
          </Field>
        </div>
        {!regionPossible ? (
          <p className="mt-2 text-xs text-fg-subtle">
            Pick a screen source to record a region of it.
          </p>
        ) : null}
      </fieldset>

      <div className="flex items-center gap-3">
        {running ? (
          <Button
            variant="danger"
            icon={<Square className="size-4" aria-hidden="true" />}
            data-testid="rec-cancel"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Video className="size-4" aria-hidden="true" />}
            data-testid="rec-start"
            unavailable={busy !== null || !selected}
            onClick={() => void start()}
          >
            Test recording
          </Button>
        )}
        {running ? (
          <span role="status" className="text-sm text-fg-muted">
            Recording...
          </span>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
          data-testid="rec-error"
          data-code={error.code}
        >
          {error.code}: {error.message}
        </p>
      ) : null}

      {result ? <RecordingResult result={result} /> : null}
    </div>
  );
}

function RecordingResult({ result }: { result: RecordingTestResult }) {
  const rows: [string, string][] = [
    ['MIME type', result.mimeType],
    ['Size', `${result.bytes.toLocaleString()} bytes`],
    ['Video', `${result.videoWidth ?? '?'} x ${result.videoHeight ?? '?'}`],
    [
      'Frames delivered',
      `${result.framesDelivered} in ${(result.wallMs / 1000).toFixed(2)} s = ${result.measuredFps.toFixed(1)} fps (requested ${result.requestedFps})`,
    ],
    [
      'Crop',
      result.cropMethod === 'none'
        ? 'none'
        : `${result.cropMethod} (${result.cropFramesOut} frames out)`,
    ],
    ['Audio', result.hasAudio ? result.audioSources.join(' + ') : 'none'],
    [
      'Peak levels',
      Object.entries(result.peakLevels)
        .map(([source, level]) => `${source} ${level.toFixed(3)}`)
        .join(', ') || '-',
    ],
    [
      'Tracks at stop',
      result.tracksAtStop.map((t) => `${t.where}/${t.kind}:${t.readyState}`).join(', '),
    ],
    [
      'Tracks after release',
      result.tracksAfterRelease.map((t) => `${t.where}/${t.kind}:${t.readyState}`).join(', '),
    ],
    ['Ended early', result.endedEarly.join(', ') || 'none'],
    ['Saved to', result.path],
  ];
  return (
    <dl
      className="selectable divide-y divide-line rounded-lg border border-line text-sm"
      data-testid="rec-result"
      data-result={JSON.stringify(result)}
    >
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 px-3 py-2">
          <dt className="shrink-0 text-fg-muted">{label}</dt>
          <dd className="break-all text-right font-medium text-fg tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
