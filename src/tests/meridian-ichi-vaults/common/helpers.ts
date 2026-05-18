// Assertion helpers for MIV tests. Inspired by tests/multi-rewards/common/helpers.ts
// but adapted to the Meridian Ichi vaults schema.

import assert from "assert";

import { MIVTestReader } from "../../../processors/meridian-ichi-vault-processor.js";
import { MIVVault, MIVPosition, MIVVaultHourlyHistory } from "../../../schema/schema.meridian-ichi-vaults.js";

/** Assert a subset of fields on the MIVVault for a given vault address. */
export async function verifyVaultState(
  reader: MIVTestReader,
  vaultAddress: string,
  expected: Partial<{
    vault_owner: string;
    underlying_pool: string;
    is_asset_0_deposit: boolean;
    token0_metadata: string;
    token1_metadata: string;
    token0_decimals: number;
    token1_decimals: number;
    vault_shares_metadata: string;
    total_amount_0: bigint;
    total_amount_1: bigint;
    total_supply: bigint;
    last_tick: bigint;
    shares_price_e18: bigint;
    is_rebalance_paused: boolean;
    is_farming_enabled: boolean;
    withdraw_fee_bps: bigint;
    deposit_hysteresis_ticks: bigint;
    rebalance_hysteresis_ticks: bigint;
    deposit_twap_period: bigint;
    aux_deposit_twap_period: bigint;
    rebalance_cooldown: bigint;
    max_deposit_amount: bigint;
    amm_fee_recipient: string;
    affiliate: string;
    staking_pool: string | undefined;
    whitelisted_reward_tokens: string[];
    position_count: number;
    deposit_count: number;
    withdraw_count: number;
    rebalance_count: number;
    collect_fees_count: number;
    total_fees_0_collected: bigint;
    total_fees_1_collected: bigint;
  }>,
): Promise<MIVVault> {
  const vault = await reader.getVault(vaultAddress);
  assert(vault, `MIVVault should exist for ${vaultAddress}`);
  for (const [k, v] of Object.entries(expected)) {
    if (v === undefined) {
      assert.strictEqual((vault as unknown as Record<string, unknown>)[k], undefined, `vault.${k} mismatch`);
      continue;
    }
    if (Array.isArray(v)) {
      assert.deepStrictEqual((vault as unknown as Record<string, unknown>)[k], v, `vault.${k} mismatch`);
      continue;
    }
    assert.strictEqual((vault as unknown as Record<string, unknown>)[k], v, `vault.${k} mismatch`);
  }
  return vault;
}

/**
 * Assert the per-position rows match the expected set. Positions are compared
 * by index (so caller controls ordering); each expected entry is treated as a
 * partial match.
 */
export async function verifyPositions(
  reader: MIVTestReader,
  vaultAddress: string,
  expected: Array<
    Partial<{
      index: number;
      position_object: string;
      position_id: bigint;
      liquidity: bigint;
      lower_tick: bigint;
      upper_tick: bigint;
      amount_0: bigint;
      amount_1: bigint;
    }>
  >,
): Promise<MIVPosition[]> {
  const rows = (await reader.getPositions(vaultAddress)).sort((a, b) => a.index - b.index);
  assert.strictEqual(rows.length, expected.length, `expected ${expected.length} positions, got ${rows.length}`);
  rows.forEach((row, i) => {
    const want = expected[i];
    for (const [k, v] of Object.entries(want)) {
      assert.strictEqual(
        (row as unknown as Record<string, unknown>)[k],
        v,
        `position[${i}].${k} mismatch (got ${String((row as unknown as Record<string, unknown>)[k])}, want ${String(v)})`,
      );
    }
  });
  return rows;
}

/**
 * Assert that exactly N hourly history rows exist for the given vault, and
 * (optionally) check fields on the most recent (highest `date`) row.
 */
export async function verifyHourlyHistory(
  reader: MIVTestReader,
  vaultAddress: string,
  expectedCount: number,
  latestExpected?: Partial<{
    total_amount_0: bigint;
    total_amount_1: bigint;
    total_supply: bigint;
    fees_0_delta: bigint;
    fees_1_delta: bigint;
    transaction_count: number;
    open_tick: bigint;
    close_tick: bigint;
    low_tick: bigint;
    high_tick: bigint;
  }>,
): Promise<MIVVaultHourlyHistory[]> {
  const rows = (await reader.getHourlyHistory(vaultAddress)).sort((a, b) => Number(a.date - b.date));
  assert.strictEqual(rows.length, expectedCount, `expected ${expectedCount} hourly rows, got ${rows.length}`);
  if (latestExpected && rows.length > 0) {
    const latest = rows[rows.length - 1];
    for (const [k, v] of Object.entries(latestExpected)) {
      assert.strictEqual((latest as unknown as Record<string, unknown>)[k], v, `latest hourly.${k} mismatch`);
    }
  }
  return rows;
}

/** Convert seconds to microseconds (Sentio's getTimestamp() returns micros). */
export function secsToMicros(seconds: number | bigint): bigint {
  return BigInt(seconds) * 1_000_000n;
}

/**
 * Synthesize a 32-byte (64-hex-char) address. Sufficient as a synthetic
 * fixture address — the mock RPC server intercepts every view call, so the
 * address never has to correspond to anything real.
 */
export function makeAddress(seed: string): string {
  // pad seed to 64 hex chars
  const hex = seed.toLowerCase().replace(/^0x/, "");
  return `0x${hex.padStart(64, "0")}`;
}
