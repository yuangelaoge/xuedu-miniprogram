/** Explicit capabilities: new roles must never inherit management by exclusion. */
export const isManager = (role: unknown): boolean => role === 'admin' || role === 'leader';
export const canCoordinate = (role: unknown): boolean => isManager(role) || role === 'officer';
export const participatesByDefault = (role: unknown): boolean => role === 'member' || role === 'officer';
