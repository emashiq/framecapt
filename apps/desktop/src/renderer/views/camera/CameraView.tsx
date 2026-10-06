import { useEffect, useRef, useState } from 'react';
import { Circle, EyeOff, Square, VideoOff } from 'lucide-react';
import {
  nextCameraSize,
  type CameraSetStyleRequest,
  type CameraShape,
  type CameraStyleState,
} from '../../../shared/camera';
import { acquireCameraStream, releaseStream } from '../../capture/stream';
import { cn } from '../../lib/cn';

const controlButton =
  'no-drag flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-xs font-semibold text-white transition-colors duration-150 hover:bg-white/25 focus-visible:bg-white/25';

/**
 * The camera bubble (role 'camera'): a mirrored live preview of the webcam in a frameless
 * always-on-top window. The whole bubble drags the window (main turns its position into the
 * camera's place in the video); the small controls that show on hover opt out of dragging. The
 * recorder composites the camera itself, so this window is only the preview and the handle: it is
 * excluded from capture.
 */
export function CameraView() {
  const [style, setStyle] = useState<CameraStyleState | null>(null);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('overlay-root');
    void window.framecapt.invoke('camera:getStyle').then((result) => {
      if (result.ok) setStyle(result.data);
    });
  }, []);

  const deviceId = style?.deviceId;
  const known = style !== null;
  useEffect(() => {
    if (!known) return;
    let stream: MediaStream | undefined;
    let cancelled = false;
    acquireCameraStream(deviceId)
      .then((opened) => {
        if (cancelled) return releaseStream(opened);
        stream = opened;
        if (videoRef.current) videoRef.current.srcObject = opened;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      releaseStream(stream);
    };
  }, [known, deviceId]);

  const change = (request: CameraSetStyleRequest): void => {
    void window.framecapt.invoke('camera:setStyle', request).then((result) => {
      if (result.ok) setStyle(result.data);
    });
  };

  if (!style) return null;
  const nextShape: CameraShape = style.shape === 'circle' ? 'rounded' : 'circle';
  return (
    <div className="size-full p-1.5 select-none">
      <div
        data-testid="camera-bubble"
        data-shape={style.shape}
        data-size={style.size}
        className={cn(
          'app-drag group relative size-full cursor-grab overflow-hidden bg-neutral-900 shadow-[0_4px_16px_rgba(0,0,0,0.4)] ring-2 ring-white/90',
          style.shape === 'circle' ? 'rounded-full' : 'rounded-[22%]',
        )}
      >
        {failed ? (
          <div
            role="status"
            className="flex size-full flex-col items-center justify-center gap-1 text-xs text-white/80"
          >
            <VideoOff className="size-5" aria-hidden="true" />
            Camera unavailable
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            aria-label="Camera preview"
            className="size-full -scale-x-100 object-cover"
          />
        )}
        <div
          role="toolbar"
          aria-label="Camera controls"
          data-testid="camera-controls"
          className="absolute bottom-[10%] left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/60 p-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <button
            type="button"
            className={controlButton}
            aria-label={`Camera size ${style.size.toUpperCase()}, change`}
            title="Size"
            data-testid="camera-size"
            onClick={() => change({ size: nextCameraSize(style.size) })}
          >
            {style.size.toUpperCase()}
          </button>
          <button
            type="button"
            className={controlButton}
            aria-label={style.shape === 'circle' ? 'Use a rounded square' : 'Use a circle'}
            title="Shape"
            data-testid="camera-shape"
            onClick={() => change({ shape: nextShape })}
          >
            {style.shape === 'circle' ? (
              <Square className="size-3.5" aria-hidden="true" />
            ) : (
              <Circle className="size-3.5" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className={controlButton}
            aria-label="Hide camera"
            title="Hide camera"
            data-testid="camera-hide"
            onClick={() => change({ visible: false })}
          >
            <EyeOff className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
