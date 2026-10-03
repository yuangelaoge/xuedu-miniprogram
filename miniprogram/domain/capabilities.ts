/** Explicit capabilities: new roles must never inherit management by exclusion. */
export const isManager = (role: unknown): boolean => role === 'admin' || role === 'leader';
export const canCoordinate = (role: unknown): boolean => isManager(role) || role === 'officer';
export const participatesByDefault = (role: unknown): boolean => role === 'member' || role === 'officer';

export const canGeneratePlan = (role: unknown): boolean => role === 'admin' || role === 'officer';
export const canConfirmPlan = (role: unknown): boolean => role === 'admin';
export const canExportFullXlsx = (role: unknown): boolean => role === 'admin';
export const canAdjustTasks = (role: unknown): boolean => role === 'admin';
export const canExportNames = (role: unknown): boolean => role === 'admin';
