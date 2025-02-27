import assert from "assert";

export function assertApproxEqualBigInt(actual: bigint, expected: bigint, tolerance: bigint = 1n, message?: string) {
  const diff = actual > expected ? actual - expected : expected - actual;
  const stdMessage = `Expected ${expected} but got ${actual}, which differs by ${diff} (tolerance: ${tolerance})`;
  assert(diff <= tolerance, `${message} - ${stdMessage}` || stdMessage);
}
