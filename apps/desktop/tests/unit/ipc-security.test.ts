/**
 * Security regression tests against the REAL IPC contract (not a copy of it): who may call what,
 * which payloads are refused, and that the sandboxed preload exposes nothing beyond invoke/on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppOriginConfig } from '../../src/main/app-origin';
import { checkSender, runChannel } from '../../src/main/ipc-core';
import { MAX_CHUNK_BYTES } from '../../src/shared/recorder-ipc';
import {
  IPC_CHANNELS,
  ipcContract,
  type ChannelDef,
  type IpcChannel,
} from '../../src/shared/ipc-contract';
import { MAX_ASSET_BYTES, MAX_PROJECT_ASSETS } from '../../src/shared/project-ipc';
import { MAX_EXPORT_BYTES, MAX_FRAME_PNG_BYTES } from '../../src/shared/shots';
import { ROLES } from '../../src/shared/types';

const origin: AppOriginConfig = {};
const goodUrl = 'app://framecapt/index.html';
const defOf = (channel: IpcChannel): ChannelDef => ipcContract[channel];
const mainSources = path.resolve(__dirname, '..', '..', 'src', 'main');

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ts$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

// --- who may call what ---------------------------------------------------------------------

describe('IPC: every channel is closed to roles the contract does not name', () => {
  for (const channel of IPC_CHANNELS) {
    it(channel, () => {
      const { roles } = defOf(channel);
      for (const role of ROLES) {
        const result = checkSender({ role, frameUrl: goodUrl, isTopFrame: true }, roles, origin);
        if (roles.includes(role)) expect(result, `${role} may call ${channel}`).toBeNull();
        else expect(result?.error.code, `${role} must not call ${channel}`).toBe('FORBIDDEN');
      }
      // Whatever the role: not from a subframe, not from a foreign origin, not unregistered.
      for (const role of roles) {
        const subframe = checkSender({ role, frameUrl: goodUrl, isTopFrame: false }, roles, origin);
        expect(subframe?.ok).toBe(false);
        for (const frameUrl of [
          'https://evil.example/',
          'file:///C:/Windows/win.ini',
          'about:blank',
        ]) {
          expect(checkSender({ role, frameUrl, isTopFrame: true }, roles, origin)?.ok).toBe(false);
        }
      }
      const unregistered = { role: undefined, frameUrl: goodUrl, isTopFrame: true };
      expect(checkSender(unregistered, roles, origin)?.ok).toBe(false);
    });
  }

  it('only two channels are shared by three or more windows, and they are the ones that must be', () => {
    const wide = IPC_CHANNELS.filter((channel) => defOf(channel).roles.length >= 3);
    expect(wide).toEqual(['app:reportError', 'recorder:getState']);
    expect(defOf('recorder:getState').roles).toEqual(['main', 'toolbar', 'recorder', 'countdown']);
  });

  it('the screenshot of a running recording is the toolbar button alone and takes no payload', () => {
    expect(defOf('recorder:screenshot').roles).toEqual(['toolbar']);
    expect(defOf('recorder:screenshot').request.safeParse(undefined).success).toBe(true);
    expect(defOf('recorder:screenshot').request.safeParse({ path: 'x.png' }).success).toBe(false);
  });

  it('privileged actions belong to the main window alone (files, folders, settings, history, export)', () => {
    const mainOnly = IPC_CHANNELS.filter((channel) =>
      /^(history|export|settings|shortcuts|recovery|diagnostics|shot|editor|shell):/.test(channel),
    );
    expect(mainOnly.length).toBeGreaterThan(30);
    for (const channel of mainOnly) expect(defOf(channel).roles, channel).toEqual(['main']);
    // The hidden recorder window may write chunks and nothing that reaches a path.
    for (const channel of ['session:appendChunk', 'session:finish'] as const) {
      expect(defOf(channel).roles).toEqual(['recorder']);
    }
    // The overlay, toolbar and countdown windows can steer the capture they belong to, never touch files.
    for (const channel of IPC_CHANNELS) {
      const { roles } = defOf(channel);
      if (roles.includes('overlay') || roles.includes('toolbar') || roles.includes('countdown')) {
        expect(channel, 'a UI-only window reaches a file or settings channel').toMatch(
          /^(overlay|recorder|toolbar|steps|app:reportError)/,
        );
      }
    }
  });

  it('the handlers registered in main use exactly the roles of the contract, one per channel', () => {
    const found = new Map<string, string[][]>();
    for (const file of sourceFiles(mainSources)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /\bhandle\(\s*'([a-z]+:[A-Za-z0-9]+)'\s*,\s*\{\s*roles:\s*\[([^\]]*)\]/g,
      )) {
        const name = match[1] ?? '';
        const roles = (match[2] ?? '').split(',').map((part) => part.trim().replaceAll("'", ''));
        found.set(name, [...(found.get(name) ?? []), roles.filter(Boolean)]);
      }
    }
    expect([...found.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
    for (const [channel, registrations] of found) {
      expect(registrations, `${channel} registered once`).toHaveLength(1);
      expect(registrations[0], channel).toEqual([...defOf(channel as IpcChannel).roles]);
    }
  });

  it('nothing in main listens on ipcMain directly (that would skip the sender and payload checks)', () => {
    for (const file of sourceFiles(mainSources)) {
      const text = fs.readFileSync(file, 'utf8');
      const uses = text.match(/ipcMain\.(on|once|handle|handleOnce|addListener)\b/g) ?? [];
      if (path.basename(file) === 'ipc.ts') expect(uses).toEqual(['ipcMain.handle']);
      else expect(uses, path.basename(file)).toEqual([]);
    }
  });
});

// --- what may be sent ----------------------------------------------------------------------

const UUID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const bytes = (n: number): ArrayBuffer => new ArrayBuffer(n);

/** One valid payload per representative channel (checked below, so they cannot rot). */
const VALID: Partial<Record<IpcChannel, Record<string, unknown>>> = {
  'app:reportError': { source: 'window-error', message: 'x' },
  'capture:listSources': { types: ['screen'] },
  'capture:grant': { sourceId: 'screen:1:0', systemAudio: false },
  'diagnostics:saveRecording': { ext: 'png', data: bytes(4) },
  'capture:startScreenshot': { target: 'screen' },
  'shot:get': { sessionId: 'abc' },
  'shot:export': { sessionId: 'abc', format: 'png', bytes: bytes(8) },
  'shot:copy': { sessionId: 'abc', bytes: bytes(8) },
  'shot:importImage': { png: bytes(8) },
  'editor:historyImage': { historyId: UUID },
  'editor:setDirty': { dirty: true },
  'shell:showItemInFolder': { path: 'C:\\x.png' },
  'overlay:confirm': { displayId: '1', rect: { x: 0, y: 0, width: 10, height: 10 } },
  'worker:frameError': { requestId: 'r', code: 'c', message: 'm' },
  'recorder:start': {
    target: 'screen',
    options: {
      mic: { enabled: false },
      systemAudio: false,
      quality: '1080p',
      fps: 30,
      countdown: false,
    },
  },
  'recorder:toggleMute': { source: 'mic' },
  'toolbar:resize': { width: 300 },
  'steps:setAuto': { auto: true },
  'flow:get': { historyId: UUID },
  'flow:update': { historyId: UUID, title: 'T', steps: [{ file: 'step-01.png', caption: 'c' }] },
  'flow:openStepInEditor': { historyId: UUID, index: 0 },
  'flow:readStep': { historyId: UUID, index: 0 },
  'flow:export': { historyId: UUID, kind: 'html', frames: [bytes(8)] },
  'recorder:engineEvent': { type: 'paused' },
  'session:appendChunk': { sessionId: 'abc', seq: 0, bytes: bytes(4) },
  'session:finish': { sessionId: 'abc', lastSeq: 0 },
  'recovery:recover': { sessionId: UUID },
  'history:list': {},
  'history:open': { id: UUID },
  'export:mp4': { historyId: UUID },
  'export:cancel': { jobId: 'job' },
  'settings:update': { patch: { general: { theme: 'dark' } } },
  'settings:reset': {},
  'settings:chooseOutputDir': { target: 'screenshots' },
  'shortcuts:validate': { action: 'recordScreen', accelerator: 'Ctrl+Shift+1' },
  'shortcuts:setPaused': { paused: true },
  'app:resolveQuit': { stop: true },
};

const parses = (channel: IpcChannel, payload: unknown): boolean =>
  defOf(channel).request.safeParse(payload).success;
const valid = (channel: IpcChannel): Record<string, unknown> => {
  const payload = VALID[channel];
  if (!payload) throw new Error(`no sample for ${channel}`);
  return payload;
};

describe('IPC: payloads are validated strictly', () => {
  it('the representative payloads are valid (so the rejections below mean something)', () => {
    for (const channel of Object.keys(VALID) as IpcChannel[]) {
      expect(parses(channel, valid(channel)), channel).toBe(true);
    }
  });

  it('an extra key is refused, never silently dropped (a path or command cannot ride along)', () => {
    for (const channel of Object.keys(VALID) as IpcChannel[]) {
      const smuggled = { ...valid(channel), path: 'C:\\Windows\\win.ini', cmd: 'calc' };
      expect(parses(channel, smuggled), channel).toBe(false);
    }
  });

  it('extra keys are refused inside nested objects too', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Mutation = (payload: any) => void;
    const nested: [IpcChannel, Mutation][] = [
      ['recorder:start', (v) => (v.options.mic.extra = 1)],
      ['recorder:start', (v) => (v.options.extra = 1)],
      ['overlay:confirm', (v) => (v.rect.extra = 1)],
      ['settings:update', (v) => (v.patch.general.extra = 1)],
      ['settings:update', (v) => (v.patch.extra = {})],
      ['session:appendChunk', (v) => (v.queued = { chunks: 1, bytes: 1, extra: 1 })],
    ];
    for (const [channel, mutate] of nested) {
      const payload: Record<string, unknown> = { ...valid(channel) };
      if (channel !== 'session:appendChunk')
        Object.assign(payload, structuredClone(valid(channel)));
      expect(parses(channel, payload), `${channel} before`).toBe(true);
      mutate(payload);
      expect(parses(channel, payload), `${channel} after`).toBe(false);
    }
  });

  it('every object anywhere inside a request schema is strict (found by walking the real schemas)', () => {
    const lenient: string[] = [];
    const walk = (schema: unknown, where: string): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const def = (schema as { _zod?: { def?: Record<string, any> } } | undefined)?._zod?.def;
      if (!def) return;
      if (def.type === 'object') {
        if (def.catchall?._zod?.def?.type !== 'never') lenient.push(where);
        for (const [key, inner] of Object.entries(def.shape as Record<string, unknown>)) {
          walk(inner, `${where}.${key}`);
        }
        return;
      }
      for (const inner of [def.innerType, def.element, def.in, def.out, def.left, def.right]) {
        if (inner) walk(inner, where);
      }
      for (const option of (def.options as unknown[] | undefined) ?? []) walk(option, where);
    };
    for (const channel of IPC_CHANNELS) walk(defOf(channel).request, channel);
    expect(lenient, 'request objects that would silently drop unknown keys').toEqual([]);
  });

  it('oversized binary payloads are refused', () => {
    const chunk = (data: unknown) => ({ ...valid('session:appendChunk'), bytes: data });
    expect(parses('session:appendChunk', chunk(bytes(MAX_CHUNK_BYTES)))).toBe(true);
    expect(parses('session:appendChunk', chunk(bytes(MAX_CHUNK_BYTES + 1)))).toBe(false);
    expect(parses('session:appendChunk', chunk(bytes(0)))).toBe(false);
    expect(
      parses('shot:export', { ...valid('shot:export'), bytes: bytes(MAX_EXPORT_BYTES + 1) }),
    ).toBe(false);
    expect(parses('shot:copy', { ...valid('shot:copy'), bytes: bytes(MAX_EXPORT_BYTES + 1) })).toBe(
      false,
    );
    expect(
      parses('shot:importImage', { png: bytes(MAX_FRAME_PNG_BYTES + 1) }),
      'importImage over the frame cap',
    ).toBe(false);
    expect(parses('shot:importImage', { png: bytes(0) })).toBe(false);
    // Typed arrays and strings are not ArrayBuffers: the structured-clone shape is fixed.
    expect(parses('session:appendChunk', chunk(new Uint8Array(4)))).toBe(false);
    expect(parses('session:appendChunk', chunk('AAAA'))).toBe(false);
  });

  it('image-layer pictures sent with a project are bounded and named by a SHA-256', () => {
    const id = 'a'.repeat(64);
    const withAssets = (assets: unknown) => ({
      ...valid('shot:export'),
      project: { doc: { schema: 3 }, assets },
    });
    const sample = { id, png: bytes(8) };
    expect(parses('shot:export', withAssets([sample]))).toBe(true);
    expect(parses('shot:export', withAssets([{ ...sample, id: 'not-a-hash' }]))).toBe(false);
    expect(parses('shot:export', withAssets([{ ...sample, id: id.toUpperCase() }]))).toBe(false);
    expect(parses('shot:export', withAssets([{ ...sample, path: 'C:\\x' }]))).toBe(false);
    expect(parses('shot:export', withAssets([{ id, png: bytes(MAX_ASSET_BYTES + 1) }]))).toBe(
      false,
    );
    expect(parses('shot:export', withAssets([{ id, png: bytes(0) }]))).toBe(false);
    expect(parses('shot:export', withAssets(Array(MAX_PROJECT_ASSETS + 1).fill(sample)))).toBe(
      false,
    );
    // 3 x 30 MB passes the per-picture cap but not the 64 MB total.
    expect(
      parses(
        'shot:export',
        withAssets(Array.from({ length: 3 }, () => ({ id, png: bytes(30 * 1024 * 1024) }))),
      ),
    ).toBe(false);
  });

  it('unbounded strings, numbers and lists are refused', () => {
    expect(parses('shot:get', { sessionId: 'a'.repeat(65) })).toBe(false);
    expect(parses('app:reportError', { source: 'window-error', message: 'a'.repeat(2001) })).toBe(
      false,
    );
    expect(parses('capture:grant', { sourceId: 'screen:1:0\n..\\..', systemAudio: false })).toBe(
      false,
    );
    expect(parses('capture:grant', { sourceId: 'window:abc:0', systemAudio: false })).toBe(false);
    expect(parses('session:appendChunk', { sessionId: 'a', seq: -1, bytes: bytes(1) })).toBe(false);
    expect(parses('session:appendChunk', { sessionId: 'a', seq: 1.5, bytes: bytes(1) })).toBe(
      false,
    );
    expect(parses('session:appendChunk', { sessionId: 'a', seq: 2e9, bytes: bytes(1) })).toBe(
      false,
    );
    expect(parses('toolbar:resize', { width: 5000 })).toBe(false);
    expect(parses('toolbar:resize', { width: Number.NaN })).toBe(false);
    expect(parses('history:list', { limit: 1e9 })).toBe(false);
    expect(parses('history:list', { query: 'a'.repeat(201) })).toBe(false);
    const long = { action: 'recordScreen', accelerator: 'a'.repeat(65) };
    expect(parses('shortcuts:validate', long)).toBe(false);
  });

  it('ids that are not uuids are refused before main looks anything up (no path, no traversal)', () => {
    const bad = [
      '..\\..\\Windows',
      'C:\\x',
      '../x',
      `${UUID}/..`,
      `${UUID} `,
      UUID.toUpperCase(),
      '',
    ];
    for (const id of bad) {
      expect(parses('history:open', { id }), id).toBe(false);
      expect(parses('recovery:recover', { sessionId: id }), id).toBe(false);
      expect(parses('export:mp4', { historyId: id }), id).toBe(false);
    }
  });

  it('channels without a payload accept nothing at all', () => {
    let checked = 0;
    for (const channel of IPC_CHANNELS) {
      const { request } = defOf(channel);
      if (!request.safeParse(undefined).success) continue;
      checked += 1;
      for (const junk of [{}, null, 0, '', [], { path: 'C:\\x' }]) {
        expect(request.safeParse(junk).success, `${channel} ${JSON.stringify(junk)}`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

// --- fuzz ----------------------------------------------------------------------------------

/** A small seeded generator: the same junk on every run. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const STRINGS = ['__proto__', 'constructor', '..\\..\\x', '%2e%2e', '\u0000', 'C:\\Windows'];
const KEYS = [
  'id',
  'sessionId',
  'path',
  'rect',
  'bytes',
  'options',
  'patch',
  'type',
  'source',
  'x',
];

function junk(random: () => number, depth = 0): unknown {
  const pick = Math.floor(random() * (depth > 2 ? 9 : 12));
  switch (pick) {
    case 0:
      return undefined;
    case 1:
      return null;
    case 2:
      return Math.floor(random() * 2000) - 1000;
    case 3:
      return random() < 0.5 ? Number.NaN : Number.POSITIVE_INFINITY;
    case 4:
      return 'x'.repeat(Math.floor(random() * 5000));
    case 5:
      return STRINGS[Math.floor(random() * STRINGS.length)];
    case 6:
      return random() < 0.5;
    case 7:
      return new ArrayBuffer(Math.floor(random() * 64));
    case 8:
      return new Uint8Array(Math.floor(random() * 8));
    case 9:
      return Array.from({ length: Math.floor(random() * 5) }, () => junk(random, depth + 1));
    case 10:
      return JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
      );
    default: {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(random() * 5); i += 1) {
        out[KEYS[Math.floor(random() * KEYS.length)] as string] = junk(random, depth + 1);
      }
      return out;
    }
  }
}

/**
 * An object whose values are all short strings can validly satisfy a channel whose only field is a
 * free-form string id (`shot:get` takes any `sessionId`; main looks it up and refuses unknown
 * ones). The generator makes such an object now and then, depending on the order of the channels.
 */
function isPlainStrings(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 1 &&
    Object.values(payload).every((value) => typeof value === 'string' && value.length < 64)
  );
}

describe('IPC: random junk (seeded)', () => {
  it('never throws in the validator, never passes a channel that needs structure, never pollutes prototypes', () => {
    const random = rng(20261007);
    // Channels whose every field is optional may legitimately accept an empty object.
    const optionalOnly = new Set([
      'history:list',
      'settings:reset',
      'settings:update', // { patch: {} } changes nothing
      'capture:listSources',
    ]);
    let accepted = 0;
    for (let round = 0; round < 400; round += 1) {
      for (const channel of IPC_CHANNELS) {
        const payload = junk(random);
        if (defOf(channel).request.safeParse(payload).success) {
          accepted += 1;
          if (payload !== undefined && !isPlainStrings(payload)) {
            expect(
              optionalOnly.has(channel),
              `${channel} accepted ${JSON.stringify(payload)}`,
            ).toBe(true);
          }
        }
      }
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(accepted).toBeGreaterThan(0); // the payload-less channels did accept `undefined`
  });

  it('through runChannel: junk is answered INVALID_PAYLOAD and the handler never runs', async () => {
    const random = rng(7);
    let ran = 0;
    const channels = [
      'shot:export',
      'session:appendChunk',
      'recorder:start',
      'settings:update',
      'shell:showItemInFolder',
    ] as const;
    for (let round = 0; round < 100; round += 1) {
      for (const channel of channels) {
        const result = await runChannel(
          defOf(channel),
          junk(random),
          () => (ran += 1),
          () => undefined,
        );
        expect(result.ok, channel).toBe(false);
        expect(!result.ok && result.error.code).toBe('INVALID_PAYLOAD');
      }
    }
    expect(ran).toBe(0);
  });
});

// --- the preload ---------------------------------------------------------------------------

describe('preload: the only bridge', () => {
  type Listener = (event: unknown, payload: unknown) => void;
  interface Api {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(event: string, callback: (...args: unknown[]) => void): () => void;
  }

  async function loadPreload() {
    vi.resetModules();
    const exposed: { name: string; api: Api }[] = [];
    const listeners = new Map<string, Set<Listener>>();
    const invoked: unknown[][] = [];
    vi.doMock('electron', () => ({
      contextBridge: {
        exposeInMainWorld: (name: string, api: Api) => exposed.push({ name, api }),
      },
      ipcRenderer: {
        invoke: (...args: unknown[]) => {
          invoked.push(args);
          return Promise.resolve({ ok: true, data: undefined });
        },
        on: (channel: string, listener: Listener) => {
          listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener));
        },
        removeListener: (channel: string, listener: Listener) =>
          listeners.get(channel)?.delete(listener),
      },
    }));
    await import('../../src/preload/index');
    vi.doUnmock('electron');
    return { exposed, listeners, invoked };
  }

  it('exposes one object, `framecapt`, with exactly invoke and on', async () => {
    const { exposed } = await loadPreload();
    expect(exposed).toHaveLength(1);
    expect(exposed[0]?.name).toBe('framecapt');
    expect(Object.keys(exposed[0]?.api ?? {}).sort()).toEqual(['invoke', 'on']);
  });

  it('invoke only reaches channels of the contract, and only with the first argument', async () => {
    const { exposed, invoked } = await loadPreload();
    const api = exposed[0]?.api as Api;
    const unknown = [
      'shell:openExternal',
      'fs:readFile',
      '__proto__',
      'constructor',
      'toString',
      '',
      'app:getInfo ',
    ];
    for (const channel of unknown) {
      expect(await api.invoke(channel, { x: 1 }), channel).toEqual({
        ok: false,
        error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown channel.' },
      });
    }
    expect(invoked).toEqual([]);
    await api.invoke('shot:get', { sessionId: 'a' }, 'second', 'third');
    expect(invoked).toEqual([['shot:get', { sessionId: 'a' }]]);
  });

  it('on only subscribes to contract events and hands the callback the payload, never the event', async () => {
    const { exposed, listeners } = await loadPreload();
    const api = exposed[0]?.api as Api;
    for (const event of ['app:evil', '__proto__', 'constructor', 'uncaughtException']) {
      expect(typeof api.on(event, () => undefined)).toBe('function');
    }
    expect(listeners.size).toBe(0);

    const received: unknown[][] = [];
    const off = api.on('history:changed', (...args: unknown[]) => received.push(args));
    const [listener] = [...(listeners.get('history:changed') ?? [])];
    listener?.({ sender: { id: 1 }, ports: [] }, { a: 1 });
    expect(received).toEqual([[{ a: 1 }]]); // one argument: no IpcRendererEvent, no sender
    off();
    expect(listeners.get('history:changed')?.size).toBe(0);
  });
});
