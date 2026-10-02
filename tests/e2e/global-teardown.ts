import path from 'node:path';
import { killOrphanElectron } from './kill-orphans';

export default function globalTeardown(): void {
  const killed = killOrphanElectron(path.resolve(__dirname, '..', '..'));
  if (killed.length > 0) {
    console.warn(`Ended ${killed.length} orphaned Electron process(es) left by a crashed worker.`);
  }
}
