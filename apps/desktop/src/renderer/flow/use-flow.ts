import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlowStep } from '../../shared/flow';
import type { FlowGetResponse } from '../../shared/flow-ipc';
import { notify } from '../lib/notify';

/** Edits are saved this long after the last keystroke. */
const SAVE_DELAY_MS = 700;

export type FlowLoad =
  { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

export interface FlowEditor {
  load: FlowLoad;
  title: string;
  createdAt: number;
  steps: FlowStep[];
  /** The picture URL of each step by file name. */
  urls: Record<string, string>;
  setTitle(title: string): void;
  setCaption(file: string, caption: string): void;
  move(index: number, to: number): void;
  /** Removes a step; returns it with its place, so the caller can offer Undo. */
  remove(index: number): { step: FlowStep; index: number } | undefined;
  restore(step: FlowStep, index: number): void;
  /** Saves pending edits now and resolves when they are on disk. */
  flush(): Promise<void>;
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((file, index) => file === b[index]);

const urlMap = (response: FlowGetResponse): Record<string, string> =>
  Object.fromEntries(
    response.flow.steps.map((step, index) => [step.file, response.stepUrls[index] ?? '']),
  );

/**
 * One guide for the Flow view: loads it, keeps the edits (title, captions, order, deletions) in
 * local state and saves them through `flow:update` a moment after the last change, one request at
 * a time. Picture URLs are replaced only when the order changed (a caption edit never reloads the
 * pictures).
 */
export function useFlow(historyId: string): FlowEditor {
  const [load, setLoad] = useState<FlowLoad>({ status: 'loading' });
  const [title, setTitleState] = useState('');
  const [createdAt, setCreatedAt] = useState(0);
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const draft = useRef({ title: '', steps: [] as FlowStep[] });
  const serverFiles = useRef<string[]>([]);
  const dirty = useRef(false);
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void window.framecapt.invoke('flow:get', { historyId }).then((response) => {
      if (!live) return;
      if (!response.ok) {
        setLoad({
          status: 'error',
          message: response.error.message ?? 'The guide could not be opened.',
        });
        return;
      }
      const { flow } = response.data;
      draft.current = { title: flow.title ?? '', steps: flow.steps };
      serverFiles.current = flow.steps.map((step) => step.file);
      setTitleState(flow.title ?? '');
      setCreatedAt(flow.createdAt);
      setSteps(flow.steps);
      setUrls(urlMap(response.data));
      setLoad({ status: 'ready' });
    });
    return () => {
      live = false;
    };
  }, [historyId]);

  const flush = useCallback(async (): Promise<void> => {
    // One request at a time; edits that arrive while one runs are sent right after it.
    for (;;) {
      clearTimeout(timer.current);
      timer.current = undefined;
      if (inflight.current) await inflight.current;
      if (!dirty.current) return;
      dirty.current = false;
      let failed = false;
      const { title: nextTitle, steps: nextSteps } = draft.current;
      const request = window.framecapt
        .invoke('flow:update', {
          historyId,
          title: nextTitle,
          steps: nextSteps.map((step) => ({ file: step.file, caption: step.caption })),
        })
        .then((response) => {
          if (!response.ok) {
            notify.error(response.error);
            dirty.current = true;
            failed = true;
            return;
          }
          const files = response.data.flow.steps.map((step) => step.file);
          if (!sameOrder(files, serverFiles.current)) setUrls(urlMap(response.data));
          serverFiles.current = files;
        })
        .finally(() => {
          inflight.current = null;
        });
      inflight.current = request;
      await request;
      if (failed || timer.current !== undefined) return;
    }
  }, [historyId]);

  const schedule = useCallback(
    (delay = SAVE_DELAY_MS): void => {
      dirty.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void flush();
      }, delay);
    },
    [flush],
  );

  // Leaving the view saves what is pending.
  useEffect(
    () => () => {
      if (dirty.current) void flush();
    },
    [flush],
  );

  const change = useCallback(
    (next: FlowStep[], delay?: number): void => {
      draft.current = { ...draft.current, steps: next };
      setSteps(next);
      schedule(delay);
    },
    [schedule],
  );

  return {
    load,
    title,
    createdAt,
    steps,
    urls,
    setTitle(next) {
      draft.current = { ...draft.current, title: next };
      setTitleState(next);
      schedule();
    },
    setCaption(file, caption) {
      change(draft.current.steps.map((step) => (step.file === file ? { ...step, caption } : step)));
    },
    move(index, to) {
      const list = [...draft.current.steps];
      const [step] = list.splice(index, 1);
      if (!step || to < 0 || to >= draft.current.steps.length) return;
      list.splice(to, 0, step);
      change(list, 0);
    },
    remove(index) {
      const list = [...draft.current.steps];
      if (list.length <= 1) return undefined;
      const [step] = list.splice(index, 1);
      if (!step) return undefined;
      change(list, 0);
      return { step, index };
    },
    restore(step, index) {
      const list = [...draft.current.steps];
      list.splice(Math.min(index, list.length), 0, step);
      change(list, 0);
    },
    flush,
  };
}
