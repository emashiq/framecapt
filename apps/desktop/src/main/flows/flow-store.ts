import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FLOW_FILE_NAME,
  FLOW_VERSION,
  FlowFileSchema,
  flowFolderName,
  STEP_FILE_PATTERN,
  stepFileName,
  type FlowFile,
} from '../../shared/flow';
import { writeFileAtomic } from '../shots/atomic-write';

/** A guide's `flow.json` is small text; anything bigger is not one of ours. */
const MAX_FLOW_FILE_BYTES = 1024 * 1024;
const SESSION_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads and validates a `flow.json`; null when it is missing, damaged or from another format. */
export async function readFlowFile(file: string): Promise<FlowFile | null> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_FLOW_FILE_BYTES) return null;
    const parsed = FlowFileSchema.safeParse(JSON.parse(await fs.promises.readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeFlowFile(file: string, flow: FlowFile): Promise<void> {
  const body = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`, 'utf8');
  await writeFileAtomic(file, body);
}

/** Total size of the guide's files (flow.json and the step images), for the History entry. */
export async function flowBytes(dir: string, flow: FlowFile): Promise<number> {
  let total = 0;
  for (const name of [FLOW_FILE_NAME, ...flow.steps.map((step) => step.file)]) {
    const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
    if (stat?.isFile()) total += stat.size;
  }
  return total;
}

async function exists(target: string): Promise<boolean> {
  return fs.promises.access(target).then(
    () => true,
    () => false,
  );
}

/** "FrameCapt Steps ... " or the same with " (2)", " (3)": a folder name that is not taken yet. */
async function freeFolder(parent: string, base: string): Promise<string> {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = path.join(parent, attempt === 1 ? base : `${base} (${attempt})`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('No free folder name.');
}

export interface GuideStep {
  /** The captured image in the session folder. */
  source: string;
  width: number;
  height: number;
  cursor: { x: number; y: number } | null;
  at: number;
}

/**
 * Writes the finished guide: a hidden temporary folder next to the destination is filled (the step
 * images copied as `step-NN.png`, then `flow.json`) and renamed to
 * `FrameCapt Steps YYYY-MM-DD at HH.MM.SS` in one step, so the output folder never shows a
 * half-written guide. Only the temporary folder is removed when something fails.
 */
export async function writeGuideFolder(input: {
  parentDir: string;
  createdAt: number;
  steps: readonly GuideStep[];
}): Promise<{ dir: string; file: string; flow: FlowFile }> {
  const { parentDir, createdAt, steps } = input;
  await fs.promises.mkdir(parentDir, { recursive: true });
  const temp = path.join(parentDir, `.framecapt-steps-${randomBytes(6).toString('hex')}.partial`);
  await fs.promises.mkdir(temp);
  try {
    const flow: FlowFile = {
      version: FLOW_VERSION,
      createdAt,
      steps: steps.map((step, index) => ({
        file: stepFileName(index),
        width: step.width,
        height: step.height,
        cursor: step.cursor,
        caption: '',
        at: step.at,
      })),
    };
    for (const [index, step] of steps.entries()) {
      const target = flow.steps[index]?.file;
      if (target) await fs.promises.copyFile(step.source, path.join(temp, target));
    }
    await writeFlowFile(path.join(temp, FLOW_FILE_NAME), flow);
    const dir = await freeFolder(parentDir, flowFolderName(new Date(createdAt)));
    await fs.promises.rename(temp, dir);
    return { dir, file: path.join(dir, FLOW_FILE_NAME), flow };
  } catch (error) {
    await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** The capture sessions: `<userData>/flows/<session id>/step-NN.png` until Done saves them. */
export class FlowSessions {
  constructor(private readonly rootDir: string) {}

  async begin(): Promise<{ id: string; dir: string }> {
    const id = randomUUID();
    const dir = path.join(this.rootDir, id);
    await fs.promises.mkdir(dir, { recursive: true });
    return { id, dir };
  }

  /** Writes step `index` (0-based) of a session and returns its file. */
  async writeStep(dir: string, index: number, png: Uint8Array): Promise<string> {
    const name = stepFileName(index);
    if (!STEP_FILE_PATTERN.test(name)) throw new Error('Too many steps.');
    const file = path.join(dir, name);
    await writeFileAtomic(file, png);
    return file;
  }

  async discard(dir: string): Promise<void> {
    await fs.promises
      .rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      .catch(() => undefined);
  }

  /** Removes session folders older than `maxAgeMs` (a crash left them); nothing else is touched. */
  async sweep(maxAgeMs: number, now: number = Date.now()): Promise<number> {
    const entries = await fs.promises
      .readdir(this.rootDir, { withFileTypes: true })
      .catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_NAME.test(entry.name)) continue;
      const dir = path.join(this.rootDir, entry.name);
      const stat = await fs.promises.stat(dir).catch(() => null);
      if (stat && now - stat.mtimeMs > maxAgeMs) {
        await this.discard(dir);
        removed += 1;
      }
    }
    return removed;
  }
}
