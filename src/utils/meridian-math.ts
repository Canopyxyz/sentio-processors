// BigInt U18 fixed-point math + fee-rate rolling-window helpers for the
// Meridian Ichi vaults processor. Ports of the EVM ichi-vaults subgraph's
// helpers.ts with BigDecimal replaced by BigInt-as-U18.

import { MIVVault } from "../schema/schema.meridian-ichi-vaults.js";

export const U18 = 1_000_000_000_000_000_000n;
export const U18_SCALE_DIGITS = 18;

// SCALE_FACTOR from the EVM subgraph (1e6). Used to keep per-second fee rates
// numerically stable when timePassed is small. Effectively a precision
// multiplier carried through fee_per_second_{0,1}_{1d,3d,7d,30d} fields and
// divided out only at APR computation time.
export const FEE_RATE_SCALE = 1_000_000n;

export const SECONDS_PER_DAY = 86_400n;
export const SECONDS_PER_YEAR = 365n * SECONDS_PER_DAY; // 31_536_000n

const HUNDRED_U18 = 100n * U18;

/** abs(x) as bigint. */
export function absBigInt(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Convert a raw token amount (u64 with `decimals` decimal places) into a U18
 * fixed-point value. Used to normalize token0/token1 amounts before mixing in
 * USD-equivalent math.
 */
export function tokenToU18(rawAmount: bigint, decimals: number): bigint {
  if (decimals === U18_SCALE_DIGITS) return rawAmount;
  if (decimals < U18_SCALE_DIGITS) {
    return rawAmount * 10n ** BigInt(U18_SCALE_DIGITS - decimals);
  }
  return rawAmount / 10n ** BigInt(decimals - U18_SCALE_DIGITS);
}

/**
 * Compute the price of token0 in token1, in U18 fixed-point.
 *
 * Mirrors the EVM subgraph's sqrtPriceToPriceDecimal but works on signed-tick
 * input rather than sqrtPriceX96. We pick tick because the Meridian vault
 * module already exposes the current tick via get_all_valuation_ticks_raw,
 * which avoids us having to reproduce Meridian's exact sqrtPrice format
 * (Q64.64 vs Q96 etc.).
 *
 * price(tick) = 1.0001^tick, with decimal normalization for token decimals.
 *
 * Implementation uses a U18-accurate 1.0001^tick via repeated multiplication
 * of a fixed pre-computed lookup (powers of two of 1.0001) — same approach
 * used in production Uniswap tick math libs.
 */
export function priceU18FromTick(tick: bigint, decimals0: number, decimals1: number): bigint {
  // price = 1.0001^tick. Compute by walking the bits of |tick| and accumulating
  // the corresponding precomputed power. This is the same algorithm as Uniswap V3's
  // TickMath.getSqrtRatioAtTick (we only need the price, not sqrtPrice, so the
  // exponent is doubled compared to that one — i.e. we use precomputed powers of
  // 1.0001 rather than sqrt(1.0001)).
  //
  // Precomputed in U192 (1 << 192) precision for accuracy; we shift down to U18
  // at the end. The lookup covers tick magnitudes up to 2^20 = 1,048,576, which
  // safely exceeds Meridian's 443636 bound.

  const negative = tick < 0n;
  let absTick = absBigInt(tick);

  // ratio is U192 fixed-point. Start at 1.0 = (1 << 192).
  let ratio = 1n << 192n;

  // bit i corresponds to 1.0001^(2^i) in U192.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  const POWERS_U192: bigint[] = TICK_PRICE_POWERS_U192;
  for (let i = 0; absTick > 0n; i++) {
    if ((absTick & 1n) === 1n) {
      ratio = (ratio * POWERS_U192[i]) >> 192n;
    }
    absTick >>= 1n;
  }

  if (negative) {
    // Invert: (1 << 192)^2 / ratio gives 1/ratio in U192.
    ratio = (1n << 384n) / ratio;
  }

  // Now ratio is price-of-token0-in-token1 in U192. Convert to U18, then apply
  // decimal normalization.
  let priceU18 = (ratio * U18) >> 192n;

  // Decimal normalization (mirrors the EVM subgraph): if decimals0 >= decimals1,
  // multiply by 10^(decimals0-decimals1); else divide by 10^(decimals1-decimals0).
  if (decimals0 >= decimals1) {
    const adj = 10n ** BigInt(decimals0 - decimals1);
    priceU18 = priceU18 * adj;
  } else {
    const adj = 10n ** BigInt(decimals1 - decimals0);
    priceU18 = priceU18 / adj;
  }
  return priceU18;
}

// Precomputed table of 1.0001^(2^i) in U192 fixed-point, for i = 0..23.
// Generated once; covers any tick up to 2^24 in magnitude (Meridian uses up
// to ~443k, so 19 entries would suffice — 24 leaves headroom).
//
// These are equivalent to squaring the corresponding entries in Uniswap V3's
// TickMath.getSqrtRatioAtTick MAGIC constants, then truncating to U192.
const TICK_PRICE_POWERS_U192: bigint[] = computeTickPricePowers();

function computeTickPricePowers(): bigint[] {
  // 1.0001 in U192 = round(1.0001 * 2^192).
  const ONE_U192 = 1n << 192n;
  // Multiplier for 1.0001 with high precision: 10001 / 10000 ratio, applied to U192.
  const RATIO_NUMERATOR = 10001n;
  const RATIO_DENOMINATOR = 10000n;
  const powers: bigint[] = [];
  // i = 0: 1.0001^(2^0) = 1.0001
  let current = (ONE_U192 * RATIO_NUMERATOR) / RATIO_DENOMINATOR;
  powers.push(current);
  for (let i = 1; i < 24; i++) {
    // square in U192: (a * a) >> 192
    current = (current * current) >> 192n;
    powers.push(current);
  }
  return powers;
}

// - - - Rolling fee-rate window helpers - - -
//
// Maintains weighted-average per-second fee rates for 1d/3d/7d/30d windows on
// the vault entity, plus annualized fee APRs derived from those rates and
// current TVL. Driven by CollectFees + Rebalance events which feed in
// (newFee0, newFee1, timestamp).
//
// Algorithm (verbatim from amplifi-vaults-subgraphs-g2/.../helpers.ts):
//   timeSinceLastFee = timestamp - vault.last_fee_update
//   feePerSecondX = newFeeX * FEE_RATE_SCALE / timePassed
//   for each window {1d, 3d, 7d, 30d}:
//     if timeSinceLastFee < windowDuration:
//       rolling = (rolling * (window - timeSince) + new * timeSince) / window
//     else:
//       rolling = new
//   tvl_u18 = total0_u18 * price_u18 / U18 + total1_u18
//   apr_window_u18 = feePerSecondPerTvl * SECONDS_PER_YEAR * 100 / FEE_RATE_SCALE

export function updateVaultFeeMetrics(vault: MIVVault, newFee0: bigint, newFee1: bigint, nowSeconds: bigint): void {
  const timePassed = nowSeconds - vault.last_fee_update;
  if (timePassed <= 0n) {
    // Same-block / out-of-order event; skip to avoid divide-by-zero.
    return;
  }

  const feePerSecond0 = (newFee0 * FEE_RATE_SCALE) / timePassed;
  const feePerSecond1 = (newFee1 * FEE_RATE_SCALE) / timePassed;

  updateHistoricalFeeRates(vault, feePerSecond0, feePerSecond1, timePassed);
  vault.last_fee_update = nowSeconds;

  // TVL in token1 terms, U18.
  const total0U18 = tokenToU18(vault.total_amount_0, vault.token0_decimals);
  const total1U18 = tokenToU18(vault.total_amount_1, vault.token1_decimals);
  const tvlU18 = (total0U18 * vault.last_price_u18) / U18 + total1U18;
  if (tvlU18 === 0n) {
    return;
  }

  vault.fee_apr_1d_u18 = annualizedFeeAprU18(
    vault.fee_per_second_0_1d_u18,
    vault.fee_per_second_1_1d_u18,
    vault.last_price_u18,
    vault.token0_decimals,
    vault.token1_decimals,
    tvlU18,
  );
  vault.fee_apr_3d_u18 = annualizedFeeAprU18(
    vault.fee_per_second_0_3d_u18,
    vault.fee_per_second_1_3d_u18,
    vault.last_price_u18,
    vault.token0_decimals,
    vault.token1_decimals,
    tvlU18,
  );
  vault.fee_apr_7d_u18 = annualizedFeeAprU18(
    vault.fee_per_second_0_7d_u18,
    vault.fee_per_second_1_7d_u18,
    vault.last_price_u18,
    vault.token0_decimals,
    vault.token1_decimals,
    tvlU18,
  );
  vault.fee_apr_30d_u18 = annualizedFeeAprU18(
    vault.fee_per_second_0_30d_u18,
    vault.fee_per_second_1_30d_u18,
    vault.last_price_u18,
    vault.token0_decimals,
    vault.token1_decimals,
    tvlU18,
  );
}

function updateHistoricalFeeRates(
  vault: MIVVault,
  newFeePerSecond0: bigint,
  newFeePerSecond1: bigint,
  timeSinceLastFee: bigint,
): void {
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  for (const [windowDays, fields] of WINDOWS) {
    const windowSeconds = windowDays * SECONDS_PER_DAY;
    if (timeSinceLastFee < windowSeconds) {
      vault[fields.fps0] = weightedAverage(vault[fields.fps0], newFeePerSecond0, timeSinceLastFee, windowSeconds);
      vault[fields.fps1] = weightedAverage(vault[fields.fps1], newFeePerSecond1, timeSinceLastFee, windowSeconds);
    } else {
      vault[fields.fps0] = newFeePerSecond0;
      vault[fields.fps1] = newFeePerSecond1;
    }
  }
}

function weightedAverage(oldValue: bigint, newValue: bigint, newValueTime: bigint, totalTime: bigint): bigint {
  const oldWeight = totalTime - newValueTime;
  return (oldValue * oldWeight + newValue * newValueTime) / totalTime;
}

function annualizedFeeAprU18(
  feePerSecond0: bigint,
  feePerSecond1: bigint,
  priceU18: bigint,
  decimals0: number,
  decimals1: number,
  tvlU18: bigint,
): bigint {
  // feePerSecond{0,1} are raw-token-per-second * FEE_RATE_SCALE.
  // Convert to U18 of (value in token1) per second:
  //   feeValuePerSecondU18 = fps0_u18 * priceU18 / U18 + fps1_u18
  // where fps_u18 is the tokenToU18 of (fps / FEE_RATE_SCALE). To avoid
  // intermediate truncation we keep FEE_RATE_SCALE in the numerator and divide
  // it out at the end.
  const fps0U18 = tokenToU18(feePerSecond0, decimals0);
  const fps1U18 = tokenToU18(feePerSecond1, decimals1);
  const valuePerSecondScaledU18 = (fps0U18 * priceU18) / U18 + fps1U18; // scaled by FEE_RATE_SCALE
  // APR = (valuePerSecond / tvl) * secondsPerYear * 100
  return (valuePerSecondScaledU18 * SECONDS_PER_YEAR * HUNDRED_U18) / tvlU18 / FEE_RATE_SCALE / U18;
}

type WindowFields = {
  fps0: "fee_per_second_0_1d_u18" | "fee_per_second_0_3d_u18" | "fee_per_second_0_7d_u18" | "fee_per_second_0_30d_u18";
  fps1: "fee_per_second_1_1d_u18" | "fee_per_second_1_3d_u18" | "fee_per_second_1_7d_u18" | "fee_per_second_1_30d_u18";
};

const WINDOWS: ReadonlyArray<readonly [bigint, WindowFields]> = [
  [1n, { fps0: "fee_per_second_0_1d_u18", fps1: "fee_per_second_1_1d_u18" }],
  [3n, { fps0: "fee_per_second_0_3d_u18", fps1: "fee_per_second_1_3d_u18" }],
  [7n, { fps0: "fee_per_second_0_7d_u18", fps1: "fee_per_second_1_7d_u18" }],
  [30n, { fps0: "fee_per_second_0_30d_u18", fps1: "fee_per_second_1_30d_u18" }],
];
