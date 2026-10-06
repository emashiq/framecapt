import { ROLES, type Role } from '../shared/types';

/**
 * One renderer entry serves every window role, selected by location hash:
 * `#/` main, `#/overlay`, `#/toolbar`, `#/recorder`. Unknown hashes fall back to main.
 */
export function roleFromHash(hash: string): Role {
  const name = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return ROLES.find((role) => role === name && role !== 'main') ?? 'main';
}
