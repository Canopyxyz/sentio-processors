import { Decimal } from "decimal.js";
const ZERO_BIN_ID = 8389742n;
const FP64_ONE = 1n << 64n;
const BASIS_POINT_MAX = 10000n;
const MAX_UINT = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
const FP64 = 2n ** 64n;
const STANDARD_PRECISION = 10n ** 18n; // 1e18 is used for all decimal calculations

export function bufferConvert(str: string): string {
  if (str.startsWith("0x")) {
    str = str.replace("0x", "");
  }
  const hex_buffer = Buffer.from(str, "hex");
  return hex_buffer.toString("utf8");
}

export function binIdToPriceTokenX64(bin_id: bigint, bin_step: bigint): bigint {
  let unsigned_bin_id = bin_id;
  let is_negative = false;
  if (bin_id >= ZERO_BIN_ID) {
    unsigned_bin_id = bin_id - ZERO_BIN_ID;
    is_negative = false;
  } else {
    unsigned_bin_id = ZERO_BIN_ID - bin_id;
    is_negative = true;
  }

  if (unsigned_bin_id === 0n) {
    return FP64_ONE;
  }

  const price_base = FP64_ONE + (bin_step << 64n) / BASIS_POINT_MAX + 1n;
  return fp64Power(price_base, unsigned_bin_id, is_negative);
}

function fp64Power(price_base: bigint, unsigned_bin_id: bigint, is_negative: boolean): bigint {
  if (unsigned_bin_id === 0n) {
    return FP64_ONE;
  } else if (unsigned_bin_id === 1n && is_negative) {
    return price_base;
  }

  let base_fp128 = price_base << 64n;
  let invert = is_negative;
  if (base_fp128 >= MAX_UINT) {
    base_fp128 = MAX_UINT / base_fp128;
    invert = !invert;
  }

  const unsigned_fp128 = unsignedPowerFP128(base_fp128, unsigned_bin_id);

  let result_fp128 = invert ? MAX_UINT / unsigned_fp128 : unsigned_fp128;

  result_fp128 = result_fp128 + 1n;
  const result_fp64 = result_fp128 >> 64n;
  return result_fp64;
}

function unsignedPowerFP128(base_fp128: bigint, y: bigint): bigint {
  if (y <= 0) throw new Error("ERR_ZERO_EXPONENT");
  if (y >= 0x100000) throw new Error("ERR_EXPONENT_OVERFLOW");

  let result = BigInt(1) << 128n; // Equivalent to FP128_ONE
  let pow = base_fp128;

  const shiftRight128 = (value: bigint) => value >> 128n;

  if (y & 0x1n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x2n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x4n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x8n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x10n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x20n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x40n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x80n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x100n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x200n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x400n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x800n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x1000n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x2000n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x4000n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x8000n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x10000n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x20000n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x40000n) {
    result = shiftRight128(result * pow);
  }
  pow = shiftRight128(pow * pow);

  if (y & 0x80000n) {
    result = shiftRight128(result * pow);
  }

  if (result <= 0n) throw new Error("ERR_POWER_RESULT_UNDERFLOW");

  return result;
}

// a and b are both in u18 already. Used to handle precision loss.
export function multiplyU18(a_u18: bigint, b_u18: bigint): bigint {
  return (a_u18 * b_u18) / STANDARD_PRECISION;
}

// a and b are raw coin amounts. Used to handle precision loss.
export function divideU18(a: bigint, b: bigint): bigint {
  if (b == 0n) {
    return 0n;
  }
  return (a * STANDARD_PRECISION) / b;
}

export function convertRawToU18(raw: bigint): bigint {
  return raw * STANDARD_PRECISION;
}

export function getXInY(amount_x: bigint, x_price_x64: bigint): bigint {
  return (amount_x * x_price_x64 * STANDARD_PRECISION) / FP64;
}

export function getYInX(amount_y: bigint, x_price_x64: bigint): bigint {
  return (amount_y * FP64 * STANDARD_PRECISION) / x_price_x64;
}

export function scaleDown(num: number | string, decimals: number): string {
  const n = new Decimal(num);
  const d = new Decimal(10).pow(decimals);
  return n.div(d).toString();
}
