// Builders for nock view-call expectations targeting the ichi_vault_meridian
// module's view functions. Used by tests to install the precise canned
// responses each handler under test will request.
//
// Fixture builders are filled in alongside the handler they support (Phase 4
// / Phase 5). Each helper here corresponds to a `fetchVaultLiveState`-shaped
// bundle in the processor.

import { ViewCallExpectation } from "../../common/mockRpc.js";
import { ICHI_VAULT_MERIDIAN_PACKAGE } from "./constants.js";

const FA = "0x1::fungible_asset";
const MOD = `${ICHI_VAULT_MERIDIAN_PACKAGE}::ichi_vault_meridian`;

/**
 * View calls a VaultCreatedEvent handler issues to resolve token metadata + decimals
 * for the new vault.
 */
export function vaultCreationViewCalls(params: {
  vaultAddress: string;
  // Returned by get_vault_deposit_and_quote_assets. Map to token0/token1 based
  // on is_asset_0_deposit in the test setup.
  depositAssetMetadata: string;
  quoteAssetMetadata: string;
  depositAssetDecimals: number;
  quoteAssetDecimals: number;
}): ViewCallExpectation[] {
  return [
    {
      function: `${MOD}::get_vault_deposit_and_quote_assets`,
      functionArguments: [params.vaultAddress],
      response: [{ inner: params.depositAssetMetadata }, { inner: params.quoteAssetMetadata }],
    },
    {
      function: `${FA}::decimals`,
      typeArguments: [`${FA}::Metadata`],
      functionArguments: [params.depositAssetMetadata],
      response: [params.depositAssetDecimals],
    },
    {
      function: `${FA}::decimals`,
      typeArguments: [`${FA}::Metadata`],
      functionArguments: [params.quoteAssetMetadata],
      response: [params.quoteAssetDecimals],
    },
  ];
}

/**
 * View calls every state-changing handler (Deposit, Withdraw, CollectFees,
 * EmergencyExit, Rebalance) issues to refresh per-vault live state.
 */
export function vaultLiveStateViewCalls(params: {
  vaultAddress: string;
  // get_total_vault_holdings(vault) -> (u64, u64)
  totalAmount0: bigint;
  totalAmount1: bigint;
  // get_all_valuation_ticks_raw(vault)
  //  -> (current_is_neg, current_abs, twap_is_neg, twap_abs, aux_twap_is_neg, aux_twap_abs)
  currentTick: bigint;
  twapTick: bigint;
  auxTwapTick: bigint;
  // get_shares_price_e18(vault) -> u128
  sharesPriceE18: bigint;
  // fungible_asset::supply(shares_metadata) -> Option<u128> (we return as raw u128 here)
  sharesMetadata: string;
  totalSupply: bigint;
}): ViewCallExpectation[] {
  return [
    {
      function: `${MOD}::get_total_vault_holdings`,
      functionArguments: [params.vaultAddress],
      response: [params.totalAmount0.toString(), params.totalAmount1.toString()],
    },
    {
      function: `${MOD}::get_all_valuation_ticks_raw`,
      functionArguments: [params.vaultAddress],
      response: signedTickToRawTriple(params.currentTick, params.twapTick, params.auxTwapTick),
    },
    {
      function: `${MOD}::get_shares_price_e18`,
      functionArguments: [params.vaultAddress],
      response: [params.sharesPriceE18.toString()],
    },
    {
      function: `${FA}::supply`,
      typeArguments: [`${FA}::Metadata`],
      functionArguments: [params.sharesMetadata],
      response: [{ vec: [params.totalSupply.toString()] }],
    },
  ];
}

/**
 * View calls the RebalanceEvent handler issues to rebuild per-position state.
 * Returns the get_position_count expectation plus one get_all_position_info
 * expectation per position.
 */
export type PositionFixture = {
  positionObject: string;
  positionId: bigint;
  liquidity: bigint;
  lowerTick: bigint;
  upperTick: bigint;
  amount0: bigint;
  amount1: bigint;
};

export function positionsViewCalls(params: {
  vaultAddress: string;
  positions: PositionFixture[];
}): ViewCallExpectation[] {
  const calls: ViewCallExpectation[] = [
    {
      function: `${MOD}::get_position_count`,
      functionArguments: [params.vaultAddress],
      response: [params.positions.length],
    },
  ];
  params.positions.forEach((p, i) => {
    // get_all_position_info(vault, i)
    //   -> (amount_0, amount_1, position, position_id, liquidity,
    //       is_neg_lower, abs_lower, is_neg_upper, abs_upper)
    calls.push({
      function: `${MOD}::get_all_position_info`,
      functionArguments: [params.vaultAddress, i],
      response: [
        p.amount0.toString(),
        p.amount1.toString(),
        { inner: p.positionObject },
        p.positionId.toString(),
        p.liquidity.toString(),
        p.lowerTick < 0n,
        absBigInt(p.lowerTick).toString(),
        p.upperTick < 0n,
        absBigInt(p.upperTick).toString(),
      ],
    });
  });
  return calls;
}

// Convert three signed ticks into the (is_neg, abs, is_neg, abs, is_neg, abs)
// tuple that get_all_valuation_ticks_raw returns.
function signedTickToRawTriple(current: bigint, twap: bigint, auxTwap: bigint): unknown[] {
  return [
    current < 0n,
    absBigInt(current).toString(),
    twap < 0n,
    absBigInt(twap).toString(),
    auxTwap < 0n,
    absBigInt(auxTwap).toString(),
  ];
}

function absBigInt(x: bigint): bigint {
  return x < 0n ? -x : x;
}
