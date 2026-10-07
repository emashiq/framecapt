import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { RecordingLayout } from '../../../shared/recording-layout';
import type { VideoCommand, VideoProject } from '../../../shared/video-edit';
import {
  canRedoVideo,
  canUndoVideo,
  commitVideo,
  createVideoHistory,
  endVideoGesture,
  redoVideo,
  undoVideo,
  type VideoHistory,
} from '../../../shared/video-edit-history';

type Action =
  | { type: 'load'; project: VideoProject }
  | { type: 'commit'; command: VideoCommand; gesture?: string }
  | { type: 'endGesture' }
  | { type: 'undo' }
  | { type: 'redo' };

function reducer(state: VideoHistory | null, action: Action): VideoHistory | null {
  if (action.type === 'load') return createVideoHistory(action.project);
  if (!state) return state;
  switch (action.type) {
    case 'commit':
      return commitVideo(state, action.command, action.gesture);
    case 'endGesture':
      return endVideoGesture(state);
    case 'undo':
      return undoVideo(state);
    case 'redo':
      return redoVideo(state);
  }
}

export type LoadState =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'failed';

/** How long after the last change the project is written (a drag is many changes). */
export const AUTOSAVE_MS = 600;

export interface VideoProjectApi {
  load: LoadState;
  fileName: string;
  /** The sources of a multi-source recording (.fcap); null for any other recording. */
  layout: RecordingLayout | null;
  project: VideoProject | null;
  save: SaveState;
  canUndo: boolean;
  canRedo: boolean;
  commit: (command: VideoCommand, gesture?: string) => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  /** Writes pending changes now; resolves false when they could not be saved. */
  flush: () => Promise<boolean>;
}

/**
 * The project of one recording: opened from main, edited through commands with undo/redo, and
 * saved by itself a moment after the last change (and when the editor is left).
 */
export function useVideoProject(historyId: string): VideoProjectApi {
  const [history, dispatch] = useReducer(reducer, null);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [fileName, setFileName] = useState('');
  const [layout, setLayout] = useState<RecordingLayout | null>(null);
  const [save, setSave] = useState<SaveState>('saved');
  const present = history?.present ?? null;
  const savedRef = useRef<VideoProject | null>(null);
  const presentRef = useRef<VideoProject | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    presentRef.current = present;
  }, [present]);

  useEffect(() => {
    // The editor is keyed by the recording, so a new id always starts from "loading".
    let cancelled = false;
    void window.framecapt.invoke('video:open', { historyId }).then((response) => {
      if (cancelled) return;
      if (!response.ok) {
        setLoad({ status: 'error', message: response.error.message });
        return;
      }
      savedRef.current = response.data.project;
      setFileName(response.data.fileName);
      setLayout(response.data.layout);
      dispatch({ type: 'load', project: response.data.project });
      setSave('saved');
      setLoad({ status: 'ready' });
    });
    return () => {
      cancelled = true;
    };
  }, [historyId]);

  const writeNow = useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    const project = presentRef.current;
    if (!project || project === savedRef.current) return inFlight.current ?? Promise.resolve(true);
    setSave('saving');
    const attempt = (inFlight.current ?? Promise.resolve(true)).then(async () => {
      const response = await window.framecapt.invoke('video:save', { historyId, project });
      if (response.ok) {
        savedRef.current = project;
        setSave(presentRef.current === project ? 'saved' : 'unsaved');
        return true;
      }
      setSave('failed');
      return false;
    });
    inFlight.current = attempt;
    void attempt.finally(() => {
      if (inFlight.current === attempt) inFlight.current = null;
    });
    return attempt;
  }, [historyId]);

  // Autosave: schedule a write whenever the project is no longer the saved one.
  useEffect(() => {
    if (!present || present === savedRef.current) return;
    setSave((state) => (state === 'saving' ? state : 'unsaved'));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void writeNow(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer.current);
  }, [present, writeNow]);

  // Leaving the editor, or the window closing or hiding, writes what is pending.
  useEffect(() => {
    const saveNow = (): void => {
      const project = presentRef.current;
      if (project && project !== savedRef.current) {
        savedRef.current = project;
        void window.framecapt.invoke('video:save', { historyId, project });
      }
    };
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', saveNow);
      document.removeEventListener('visibilitychange', onHidden);
      saveNow();
    };
  }, [historyId]);

  return {
    load,
    fileName,
    layout,
    project: present,
    save,
    canUndo: history ? canUndoVideo(history) : false,
    canRedo: history ? canRedoVideo(history) : false,
    commit: useCallback(
      (command, gesture) => dispatch({ type: 'commit', command, ...(gesture && { gesture }) }),
      [],
    ),
    endGesture: useCallback(() => dispatch({ type: 'endGesture' }), []),
    undo: useCallback(() => dispatch({ type: 'undo' }), []),
    redo: useCallback(() => dispatch({ type: 'redo' }), []),
    flush: writeNow,
  };
}
