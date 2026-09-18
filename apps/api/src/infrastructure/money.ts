// Single conversion seam for DB integer centimes -> shared/API MAD decimal.
// TASK-009/010/012 must reuse this rather than scattering `/ 100` at call sites.
export function centimesToMad(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new Error(`centimesToMad: expected an integer number of cents, got ${cents}`);
  }
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`centimesToMad: cents value is not a safe integer: ${cents}`);
  }
  if (cents < 0) {
    throw new Error(`centimesToMad: cents must be non-negative, got ${cents}`);
  }
  return cents / 100;
}
