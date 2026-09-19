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

// TASK-036: the inverse conversion seam — a customer-stated MAD amount ->
// integer centimes, rounded to the nearest centime (never truncated/left
// floating) before it ever reaches a price-authorization function.
export function madToCentimes(mad: number): number {
  if (!Number.isFinite(mad)) {
    throw new Error(`madToCentimes: expected a finite number of MAD, got ${mad}`);
  }
  if (mad <= 0) {
    throw new Error(`madToCentimes: mad must be positive, got ${mad}`);
  }
  const cents = Math.round(mad * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`madToCentimes: resulting cents value is not a safe integer: ${cents}`);
  }
  return cents;
}
