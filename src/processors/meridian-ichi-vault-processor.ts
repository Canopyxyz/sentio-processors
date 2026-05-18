import { AptosContext } from "@sentio/sdk/aptos";
import { Store } from "@sentio/sdk/store";

import {
  ichi_vault_meridian as ichi_vault_meridian_movement,
  ichi_vault_meridian,
} from "../types/aptos/movement-mainnet/ichi_vault_meridian.js";
import { timelocked as timelocked_movement, timelocked } from "../types/aptos/movement-mainnet/timelocked.js";

import {
  MIVModule,
  MIVGlobalConfig,
  MIVVault,
  MIVPosition,
  MIVVaultHourlyHistory,
  MIVVaultDailyHistory,
  MIVVaultCreatedEvent,
  MIVDepositEvent,
  MIVWithdrawEvent,
  MIVRebalanceEvent,
  MIVPositionAddedEvent,
  MIVEmergencyExitEvent,
  MIVCollectFeesEvent,
  MIVAssetRecoveredEvent,
  MIVSetStakingPoolEvent,
  MIVWhitelistedRewardTokenAddedEvent,
  MIVWhitelistedRewardTokenRemovedEvent,
  MIVVaultOwnershipTransferInitiatedEvent,
  MIVVaultOwnershipTransferredEvent,
  MIVSetAmmFeeRecipientEvent,
  MIVSetAffiliateEvent,
  MIVSetMaxDepositAmountEvent,
  MIVSetDepositRoleEvent,
  MIVSetRebalancerRoleEvent,
  MIVRebalancePausedEvent,
  MIVFarmingEnabledEvent,
  MIVGlobalOwnershipTransferInitiatedEvent,
  MIVGlobalOwnershipTransferredEvent,
  MIVSetBaseFeeEvent,
  MIVSetBaseSplitFeeEvent,
  MIVSetFeeRecipientEvent,
  MIVSetAmmFeeEvent,
  MIVTimelockedUpdateProposedEvent,
  MIVTimelockedUpdateExecutedEvent,
} from "../schema/schema.meridian-ichi-vaults.js";

import { SupportedAptosChainId } from "../chains.js";
import { priceU18FromTick, updateVaultFeeMetrics } from "../utils/meridian-math.js";

// Note: Object<T> in Move is generated as a bare MoveAddressType (string) on
// the JS side — there is no { inner: string } wrapper. Same for primitive
// `address` fields. So we treat both the same way.

export const PKG = "0x96cfeae5e78eeb1b6215bb83ed9023106e0df49e6d4380783e0e40aa8e771f83";

// Bound to ichi_vault_meridian on Movement mainnet. JESTNET tests reuse this
// same binding because the generated processor's network is hardcoded into
// DEFAULT_OPTIONS — we pass APTOS_MOVEMENT_MAINNET as the chainId on every
// test DataBinding (see src/tests/utils/processor.ts).
export function meridianIchiVaultsProcessor(
  _chainId: SupportedAptosChainId,
  startVersion: number,
  vaultBaseProcessor: typeof ichi_vault_meridian_movement,
) {
  vaultBaseProcessor
    .bind({ startVersion })
    // Handler IDs are assigned by declaration order. The matching ID map for
    // tests lives in src/tests/meridian-ichi-vaults/common/constants.ts —
    // keep them in sync if you reorder or insert handlers.
    .onEventVaultCreatedEvent(handleVaultCreated)
    .onEventDepositEvent(handleDeposit)
    .onEventWithdrawEvent(handleWithdraw)
    .onEventCollectFeesEvent(handleCollectFees)
    .onEventRebalanceEvent(handleRebalance)
    .onEventPositionAddedEvent(handlePositionAdded)
    .onEventEmergencyExitEvent(handleEmergencyExit)
    .onEventAssetRecoveredEvent(handleAssetRecovered)
    .onEventSetStakingPoolEvent(handleSetStakingPool)
    .onEventWhitelistedRewardTokenAddedEvent(handleWhitelistedRewardTokenAdded)
    .onEventWhitelistedRewardTokenRemovedEvent(handleWhitelistedRewardTokenRemoved)
    .onEventVaultOwnershipTransferInitiatedEvent(handleVaultOwnershipTransferInitiated)
    .onEventVaultOwnershipTransferredEvent(handleVaultOwnershipTransferred)
    .onEventSetAmmFeeRecipientEvent(handleSetAmmFeeRecipient)
    .onEventSetAffiliateEvent(handleSetAffiliate)
    .onEventSetMaxDepositAmountEvent(handleSetMaxDepositAmount)
    .onEventSetDepositRoleEvent(handleSetDepositRole)
    .onEventSetRebalancerRoleEvent(handleSetRebalancerRole)
    .onEventRebalancePausedEvent(handleRebalancePaused)
    .onEventFarmingEnabledEvent(handleFarmingEnabled)
    .onEventGlobalOwnershipTransferInitiatedEvent(handleGlobalOwnershipTransferInitiated)
    .onEventGlobalOwnershipTransferredEvent(handleGlobalOwnershipTransferred)
    .onEventSetBaseFeeEvent(handleSetBaseFee)
    .onEventSetBaseSplitFeeEvent(handleSetBaseSplitFee)
    .onEventSetFeeRecipientEvent(handleSetFeeRecipient)
    .onEventSetAmmFeeEvent(handleSetAmmFee);

  // Timelocked-module events live at the same package address but a different
  // module. Bind a separate base processor for them.
  timelocked_movement
    .bind({ startVersion })
    .onEventTimelockedUpdateProposedEvent(handleTimelockedUpdateProposed)
    .onEventTimelockedUpdateExecutedEvent(handleTimelockedUpdateExecuted);
}

// - - - VAULT LIFECYCLE EVENTS (state-changing) - - -

async function handleVaultCreated(
  event: ichi_vault_meridian.VaultCreatedEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vaultAddress = lower(d.vault_address);
  const timestamp = micros2secs(ctx.getTimestamp());

  const client = ctx.getClient();
  const [depositMetaRaw, quoteMetaRaw] = (await client.viewJson({
    payload: {
      function: `${PKG}::ichi_vault_meridian::get_vault_deposit_and_quote_assets`,
      functionArguments: [vaultAddress],
    },
    options: { ledgerVersion: ctx.version },
  })) as [string, string];

  const depositMeta = lower(depositMetaRaw);
  const quoteMeta = lower(quoteMetaRaw);
  const [depositDecimals, quoteDecimals] = await Promise.all([
    fetchFaDecimals(ctx, depositMeta),
    fetchFaDecimals(ctx, quoteMeta),
  ]);

  // Read the real on-chain VaultConfig + farming flag rather than hardcoding
  // the Move defaults. Keeps us correct even if the contract changes its
  // defaults, and avoids drift if a setter event fires before our first read.
  const [vaultConfigRaw, farmingEnabledRaw] = (await Promise.all([
    client.viewJson({
      payload: {
        function: `${PKG}::ichi_vault_meridian::get_vault_config`,
        functionArguments: [vaultAddress],
      },
      options: { ledgerVersion: ctx.version },
    }),
    client.viewJson({
      payload: {
        function: `${PKG}::ichi_vault_meridian::is_farming_enabled`,
        functionArguments: [vaultAddress],
      },
      options: { ledgerVersion: ctx.version },
    }),
  ])) as [
    [
      string,
      string,
      string | number,
      string | number,
      string | number,
      string | number,
      string | number,
      string | number,
      string | number,
      boolean,
    ],
    [boolean],
  ];

  // get_vault_config returns (amm_fee_recipient, affiliate, max_deposit_amount,
  //   deposit_hysteresis_ticks, rebalance_hysteresis_ticks,
  //   deposit_twap_period, aux_deposit_twap_period,
  //   withdraw_fee_bps, rebalance_cooldown, is_rebalance_paused)
  const [
    ammFeeRecipient,
    affiliateAddr,
    maxDepositAmount,
    depositHysteresisTicks,
    rebalanceHysteresisTicks,
    depositTwapPeriod,
    auxDepositTwapPeriod,
    withdrawFeeBps,
    rebalanceCooldown,
    isRebalancePaused,
  ] = vaultConfigRaw;
  const [isFarmingEnabled] = farmingEnabledRaw;

  // token0 = deposit asset when is_asset_0_deposit, else quote asset.
  const [token0Meta, token0Decimals, token1Meta, token1Decimals] = d.is_asset_0_deposit
    ? [depositMeta, depositDecimals, quoteMeta, quoteDecimals]
    : [quoteMeta, quoteDecimals, depositMeta, depositDecimals];

  const sharesMeta = lower(d.vault_shares_metadata);

  const vault = new MIVVault({
    id: vaultAddress,
    vault_address: vaultAddress,
    vault_owner: lower(d.vault_owner),
    pending_owner: undefined,
    underlying_pool: lower(d.underlying_pool),
    is_asset_0_deposit: d.is_asset_0_deposit,
    token0_metadata: token0Meta,
    token1_metadata: token1Meta,
    token0_decimals: token0Decimals,
    token1_decimals: token1Decimals,
    vault_shares_metadata: sharesMeta,
    vault_shares_decimals: 8, // constant per the vault module

    total_amount_0: 0n,
    total_amount_1: 0n,
    total_supply: 0n,
    last_tick: 0n,
    last_sqrt_price: 0n,
    twap_tick: 0n,
    aux_twap_tick: 0n,
    last_price_u18: 0n,
    shares_price_e18: 0n,
    last_price_timestamp: timestamp,

    last_fee_update: timestamp,
    fee_per_second_0_1d_u18: 0n,
    fee_per_second_0_3d_u18: 0n,
    fee_per_second_0_7d_u18: 0n,
    fee_per_second_0_30d_u18: 0n,
    fee_per_second_1_1d_u18: 0n,
    fee_per_second_1_3d_u18: 0n,
    fee_per_second_1_7d_u18: 0n,
    fee_per_second_1_30d_u18: 0n,
    fee_apr_1d_u18: 0n,
    fee_apr_3d_u18: 0n,
    fee_apr_7d_u18: 0n,
    fee_apr_30d_u18: 0n,
    total_fees_0_collected: 0n,
    total_fees_1_collected: 0n,

    last_rebalanced_at: 0n,
    is_rebalance_paused: isRebalancePaused,
    is_farming_enabled: isFarmingEnabled,
    withdraw_fee_bps: BigInt(withdrawFeeBps),
    deposit_hysteresis_ticks: BigInt(depositHysteresisTicks),
    rebalance_hysteresis_ticks: BigInt(rebalanceHysteresisTicks),
    deposit_twap_period: BigInt(depositTwapPeriod),
    aux_deposit_twap_period: BigInt(auxDepositTwapPeriod),
    rebalance_cooldown: BigInt(rebalanceCooldown),
    max_deposit_amount: BigInt(maxDepositAmount),
    amm_fee_recipient: lower(ammFeeRecipient),
    affiliate: lower(affiliateAddr),
    staking_pool: undefined,
    whitelisted_reward_tokens: [],

    position_count: 0,
    deposit_count: 0,
    withdraw_count: 0,
    rebalance_count: 0,
    collect_fees_count: 0,

    created_at_timestamp: timestamp,
    created_at_tx_version: ctx.version,
  });
  await ctx.store.upsert(vault);

  await ctx.store.upsert(
    new MIVVaultCreatedEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vaultAddress,
      vault_owner: lower(d.vault_owner),
      underlying_pool: lower(d.underlying_pool),
      is_asset_0_deposit: d.is_asset_0_deposit,
      vault_shares_metadata: sharesMeta,
      max_deposit_amount: d.max_deposit_amount,
    }),
  );

  const module = await getOrCreateModule(ctx, timestamp);
  module.vault_count += 1;
  module.last_update_timestamp = timestamp;
  await ctx.store.upsert(module);
}

async function handleDeposit(event: ichi_vault_meridian.DepositEventInstance, ctx: AptosContext): Promise<void> {
  const d = event.data_decoded;
  const vaultAddress = lower(d.vault_address);
  const timestamp = micros2secs(ctx.getTimestamp());

  const vault = await requireVault(ctx, vaultAddress);
  const live = await fetchVaultLiveState(ctx, vaultAddress, vault.vault_shares_metadata);
  applyLiveState(vault, live, timestamp);

  // Pre-event totals: deposit asset side is reduced by deposit_amount; the
  // other side is unchanged.
  const total0Before = vault.is_asset_0_deposit ? vault.total_amount_0 - d.deposit_amount : vault.total_amount_0;
  const total1Before = vault.is_asset_0_deposit ? vault.total_amount_1 : vault.total_amount_1 - d.deposit_amount;

  await ctx.store.upsert(
    new MIVDepositEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vaultAddress,
      depositor: lower(d.depositor),
      deposit_amount: d.deposit_amount,
      shares_minted: d.shares_minted,
      tick: live.tick,
      sqrt_price: live.sqrtPrice,
      total_amount_0: vault.total_amount_0,
      total_amount_1: vault.total_amount_1,
      total_supply: vault.total_supply,
      share_price_e18: vault.shares_price_e18,
      total_amount_0_before_event: total0Before,
      total_amount_1_before_event: total1Before,
    }),
  );

  vault.deposit_count += 1;
  await ctx.store.upsert(vault);
  await updateVaultHistory(ctx, vault, timestamp);
  await bumpModule(ctx, "deposit_count", timestamp);
}

async function handleWithdraw(event: ichi_vault_meridian.WithdrawEventInstance, ctx: AptosContext): Promise<void> {
  const d = event.data_decoded;
  const vaultAddress = lower(d.vault_address);
  const timestamp = micros2secs(ctx.getTimestamp());

  const vault = await requireVault(ctx, vaultAddress);
  const live = await fetchVaultLiveState(ctx, vaultAddress, vault.vault_shares_metadata);
  applyLiveState(vault, live, timestamp);

  // Pre-event totals = post-event + amounts the user actually received. The
  // on-chain withdraw flow extracts the fees but then re-deposits them back
  // into the vault (vault.move:530, store_remaining_assets), so withdraw fees
  // do not contribute to the vault's net decrease.
  const total0Before = vault.total_amount_0 + d.amount_0;
  const total1Before = vault.total_amount_1 + d.amount_1;

  // Attribute the withdrawer from tx context. Synthetic test transactions
  // without a payload leave this null.
  const sender = (ctx.transaction as { sender?: string } | undefined)?.sender;
  const withdrawer = sender ? lower(sender) : undefined;

  await ctx.store.upsert(
    new MIVWithdrawEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vaultAddress,
      withdrawer,
      shares_burned: d.shares_burned,
      amount_0: d.amount_0,
      amount_1: d.amount_1,
      withdraw_fee_0: d.withdraw_fee_0,
      withdraw_fee_1: d.withdraw_fee_1,
      tick: live.tick,
      sqrt_price: live.sqrtPrice,
      total_amount_0: vault.total_amount_0,
      total_amount_1: vault.total_amount_1,
      total_supply: vault.total_supply,
      share_price_e18: vault.shares_price_e18,
      total_amount_0_before_event: total0Before,
      total_amount_1_before_event: total1Before,
    }),
  );

  vault.withdraw_count += 1;
  await ctx.store.upsert(vault);
  await updateVaultHistory(ctx, vault, timestamp);
  await bumpModule(ctx, "withdraw_count", timestamp);
}

async function handleCollectFees(
  event: ichi_vault_meridian.CollectFeesEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vaultAddress = lower(d.vault_address);
  const timestamp = micros2secs(ctx.getTimestamp());

  const vault = await requireVault(ctx, vaultAddress);
  const live = await fetchVaultLiveState(ctx, vaultAddress, vault.vault_shares_metadata);
  applyLiveState(vault, live, timestamp);

  updateVaultFeeMetrics(vault, d.fee_0_collected, d.fee_1_collected, timestamp);
  vault.total_fees_0_collected += d.fee_0_collected;
  vault.total_fees_1_collected += d.fee_1_collected;

  await ctx.store.upsert(
    new MIVCollectFeesEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vaultAddress,
      fee_0_collected: d.fee_0_collected,
      fee_1_collected: d.fee_1_collected,
      tick: live.tick,
      sqrt_price: live.sqrtPrice,
      total_amount_0: vault.total_amount_0,
      total_amount_1: vault.total_amount_1,
      total_supply: vault.total_supply,
      share_price_e18: vault.shares_price_e18,
    }),
  );

  vault.collect_fees_count += 1;
  await ctx.store.upsert(vault);
  await updateVaultHistory(ctx, vault, timestamp, {
    fees0Delta: d.fee_0_collected,
    fees1Delta: d.fee_1_collected,
  });
  await bumpModule(ctx, "collect_fees_count", timestamp);
}

async function handleRebalance(event: ichi_vault_meridian.RebalanceEventInstance, ctx: AptosContext): Promise<void> {
  const d = event.data_decoded;
  const vaultAddress = lower(d.vault_address);
  const timestamp = micros2secs(ctx.getTimestamp());

  const vault = await requireVault(ctx, vaultAddress);
  const live = await fetchVaultLiveState(ctx, vaultAddress, vault.vault_shares_metadata);
  applyLiveState(vault, live, timestamp);

  updateVaultFeeMetrics(vault, d.collected_fees_0, d.collected_fees_1, timestamp);
  vault.total_fees_0_collected += d.collected_fees_0;
  vault.total_fees_1_collected += d.collected_fees_1;
  vault.last_rebalanced_at = timestamp;

  // Rebuild MIVPosition rows authoritatively from view calls.
  await rebuildPositions(ctx, vault, timestamp);

  await ctx.store.upsert(
    new MIVRebalanceEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vaultAddress,
      rebalancer: lower(d.rebalancer),
      positions_count: Number(d.positions_count),
      swap_amount: d.swap_amount,
      zero_for_one: d.zero_for_one,
      collected_fees_0: d.collected_fees_0,
      collected_fees_1: d.collected_fees_1,
      total_0_before: d.total_0,
      total_1_before: d.total_1,
      tick: live.tick,
      sqrt_price: live.sqrtPrice,
      total_amount_0: vault.total_amount_0,
      total_amount_1: vault.total_amount_1,
      total_supply: vault.total_supply,
      share_price_e18: vault.shares_price_e18,
    }),
  );

  vault.rebalance_count += 1;
  await ctx.store.upsert(vault);
  await updateVaultHistory(ctx, vault, timestamp, {
    fees0Delta: d.collected_fees_0,
    fees1Delta: d.collected_fees_1,
  });
  await bumpModule(ctx, "rebalance_count", timestamp);
}

async function handlePositionAdded(
  event: ichi_vault_meridian.PositionAddedEventInstance,
  ctx: AptosContext,
): Promise<void> {
  // Audit-only. The event has no vault_address and fires *before* the wrapping
  // RebalanceEvent in the same tx (verified at vault.move:2585 vs :707).
  // Per-position state is rebuilt authoritatively by handleRebalance via view
  // calls — this row is just a per-tx audit entry.
  const d = event.data_decoded;
  const timestamp = micros2secs(ctx.getTimestamp());

  // Best-effort attribution: scan same-tx events for a trailing RebalanceEvent.
  let vaultAddress: string | undefined;
  const events = (ctx.transaction as { events?: { type: string; data: unknown }[] } | undefined)?.events ?? [];
  for (const e of events) {
    if (e.type.endsWith("::ichi_vault_meridian::RebalanceEvent")) {
      const data = e.data as { vault_address?: string };
      if (data?.vault_address) {
        vaultAddress = lower(data.vault_address);
        break;
      }
    }
  }

  await ctx.store.upsert(
    new MIVPositionAddedEvent({
      ...baseEventFields(ctx),
      vault_address: vaultAddress,
      lower_tick: signedTickFromAbs(d.lower, d.lower_is_negative),
      upper_tick: signedTickFromAbs(d.upper, d.upper_is_negative),
      liquidity: d.liquidity,
      amount_0: d.amount_0,
      amount_1: d.amount_1,
    }),
  );

  const module = await getOrCreateModule(ctx, timestamp);
  module.position_added_count += 1;
  module.last_update_timestamp = timestamp;
  await ctx.store.upsert(module);
}

async function handleEmergencyExit(
  event: ichi_vault_meridian.EmergencyExitEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vaultAddress = lower(d.vault_address);
  const timestamp = micros2secs(ctx.getTimestamp());

  const vault = await requireVault(ctx, vaultAddress);
  const live = await fetchVaultLiveState(ctx, vaultAddress, vault.vault_shares_metadata);
  applyLiveState(vault, live, timestamp);

  updateVaultFeeMetrics(vault, d.collected_fees_0, d.collected_fees_1, timestamp);
  vault.total_fees_0_collected += d.collected_fees_0;
  vault.total_fees_1_collected += d.collected_fees_1;

  // All positions are removed on emergency exit — clear MIVPosition rows.
  const existing = await ctx.store.list(MIVPosition, [{ field: "vault", op: "=", value: vault.id.toString() }]);
  for (const p of existing) {
    await ctx.store.delete(MIVPosition, p.id.toString());
  }
  vault.position_count = 0;

  await ctx.store.upsert(
    new MIVEmergencyExitEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vaultAddress,
      executor: lower(d.executor),
      removed_positions_count: Number(d.removed_positions_count),
      collected_fees_0: d.collected_fees_0,
      collected_fees_1: d.collected_fees_1,
      removed_0: d.removed_0,
      removed_1: d.removed_1,
      tick: live.tick,
      sqrt_price: live.sqrtPrice,
      total_amount_0: vault.total_amount_0,
      total_amount_1: vault.total_amount_1,
      total_supply: vault.total_supply,
    }),
  );

  await ctx.store.upsert(vault);
  await updateVaultHistory(ctx, vault, timestamp, {
    fees0Delta: d.collected_fees_0,
    fees1Delta: d.collected_fees_1,
  });
  const module = await getOrCreateModule(ctx, timestamp);
  module.emergency_exit_count += 1;
  module.last_update_timestamp = timestamp;
  await ctx.store.upsert(module);
}

// - - - AUDIT-ONLY ADMIN/CONFIG EVENTS - - -

async function handleAssetRecovered(
  event: ichi_vault_meridian.AssetRecoveredEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  await ctx.store.upsert(
    new MIVAssetRecoveredEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      metadata: lower(d.metadata),
      amount: d.amount,
    }),
  );
}

async function handleSetStakingPool(
  event: ichi_vault_meridian.SetStakingPoolEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  const previousPool = optionString(d.previous_pool);
  const newPool = optionString(d.new_pool);
  vault.staking_pool = newPool ? lower(newPool) : undefined;
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVSetStakingPoolEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      previous_pool: previousPool ? lower(previousPool) : undefined,
      new_pool: newPool ? lower(newPool) : undefined,
    }),
  );
}

async function handleWhitelistedRewardTokenAdded(
  event: ichi_vault_meridian.WhitelistedRewardTokenAddedEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  const token = lower(d.reward_token);
  if (!vault.whitelisted_reward_tokens.includes(token)) {
    vault.whitelisted_reward_tokens = [...vault.whitelisted_reward_tokens, token];
  }
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVWhitelistedRewardTokenAddedEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      reward_token: token,
      total_whitelisted: Number(d.total_whitelisted),
    }),
  );
}

async function handleWhitelistedRewardTokenRemoved(
  event: ichi_vault_meridian.WhitelistedRewardTokenRemovedEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  const token = lower(d.reward_token);
  vault.whitelisted_reward_tokens = vault.whitelisted_reward_tokens.filter((t) => t !== token);
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVWhitelistedRewardTokenRemovedEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      reward_token: token,
      total_whitelisted: Number(d.total_whitelisted),
    }),
  );
}

async function handleVaultOwnershipTransferInitiated(
  event: ichi_vault_meridian.VaultOwnershipTransferInitiatedEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  vault.pending_owner = lower(d.pending_owner);
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVVaultOwnershipTransferInitiatedEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      previous_owner: lower(d.previous_owner),
      pending_owner: lower(d.pending_owner),
    }),
  );
}

async function handleVaultOwnershipTransferred(
  event: ichi_vault_meridian.VaultOwnershipTransferredEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  vault.vault_owner = lower(d.new_owner);
  vault.pending_owner = undefined;
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVVaultOwnershipTransferredEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      previous_owner: lower(d.previous_owner),
      new_owner: lower(d.new_owner),
    }),
  );
}

async function handleSetAmmFeeRecipient(
  event: ichi_vault_meridian.SetAmmFeeRecipientEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  vault.amm_fee_recipient = lower(d.new_recipient);
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVSetAmmFeeRecipientEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      previous_recipient: lower(d.previous_recipient),
      new_recipient: lower(d.new_recipient),
    }),
  );
}

async function handleSetAffiliate(
  event: ichi_vault_meridian.SetAffiliateEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  vault.affiliate = lower(d.new_affiliate);
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVSetAffiliateEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      previous_affiliate: lower(d.previous_affiliate),
      new_affiliate: lower(d.new_affiliate),
    }),
  );
}

async function handleSetMaxDepositAmount(
  event: ichi_vault_meridian.SetMaxDepositAmountEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  vault.max_deposit_amount = d.new_amount;
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVSetMaxDepositAmountEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      previous_amount: d.previous_amount,
      new_amount: d.new_amount,
    }),
  );
}

async function handleSetDepositRole(
  event: ichi_vault_meridian.SetDepositRoleEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  await ctx.store.upsert(
    new MIVSetDepositRoleEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      account: lower(d.account),
      is_granted: d.is_granted,
    }),
  );
}

async function handleSetRebalancerRole(
  event: ichi_vault_meridian.SetRebalancerRoleEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  await ctx.store.upsert(
    new MIVSetRebalancerRoleEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      account: lower(d.account),
      is_granted: d.is_granted,
    }),
  );
}

async function handleRebalancePaused(
  event: ichi_vault_meridian.RebalancePausedEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  vault.is_rebalance_paused = d.new_state;
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVRebalancePausedEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      previous_state: d.previous_state,
      new_state: d.new_state,
    }),
  );
}

async function handleFarmingEnabled(
  event: ichi_vault_meridian.FarmingEnabledEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vault = await requireVault(ctx, lower(d.vault_address));
  vault.is_farming_enabled = d.enabled;
  await ctx.store.upsert(vault);
  await ctx.store.upsert(
    new MIVFarmingEnabledEvent({
      ...baseEventFields(ctx),
      vaultID: vault.id,
      vault_address: vault.vault_address,
      enabled: d.enabled,
    }),
  );
}

// - - - GLOBAL OWNERSHIP / FEE CONFIG EVENTS - - -

async function handleGlobalOwnershipTransferInitiated(
  event: ichi_vault_meridian.GlobalOwnershipTransferInitiatedEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const timestamp = micros2secs(ctx.getTimestamp());
  const cfg = await getOrCreateGlobalConfig(ctx);
  cfg.pending_owner = lower(d.pending_owner);
  cfg.last_update_timestamp = timestamp;
  await ctx.store.upsert(cfg);
  await ctx.store.upsert(
    new MIVGlobalOwnershipTransferInitiatedEvent({
      ...baseEventFields(ctx),
      previous_owner: lower(d.previous_owner),
      pending_owner: lower(d.pending_owner),
    }),
  );
}

async function handleGlobalOwnershipTransferred(
  event: ichi_vault_meridian.GlobalOwnershipTransferredEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const timestamp = micros2secs(ctx.getTimestamp());
  const cfg = await getOrCreateGlobalConfig(ctx);
  cfg.owner = lower(d.new_owner);
  cfg.pending_owner = undefined;
  cfg.last_update_timestamp = timestamp;
  await ctx.store.upsert(cfg);
  await ctx.store.upsert(
    new MIVGlobalOwnershipTransferredEvent({
      ...baseEventFields(ctx),
      previous_owner: lower(d.previous_owner),
      new_owner: lower(d.new_owner),
    }),
  );
}

async function handleSetBaseFee(event: ichi_vault_meridian.SetBaseFeeEventInstance, ctx: AptosContext): Promise<void> {
  const d = event.data_decoded;
  const timestamp = micros2secs(ctx.getTimestamp());
  const cfg = await getOrCreateGlobalConfig(ctx);
  cfg.base_fee_bps = d.new_base_fee_bps;
  cfg.last_update_timestamp = timestamp;
  await ctx.store.upsert(cfg);
  await ctx.store.upsert(
    new MIVSetBaseFeeEvent({
      ...baseEventFields(ctx),
      previous_base_fee_bps: d.previous_base_fee_bps,
      new_base_fee_bps: d.new_base_fee_bps,
    }),
  );
}

async function handleSetBaseSplitFee(
  event: ichi_vault_meridian.SetBaseSplitFeeEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const timestamp = micros2secs(ctx.getTimestamp());
  const cfg = await getOrCreateGlobalConfig(ctx);
  cfg.base_fee_split_bps = d.new_base_fee_split_bps;
  cfg.last_update_timestamp = timestamp;
  await ctx.store.upsert(cfg);
  await ctx.store.upsert(
    new MIVSetBaseSplitFeeEvent({
      ...baseEventFields(ctx),
      previous_base_fee_split_bps: d.previous_base_fee_split_bps,
      new_base_fee_split_bps: d.new_base_fee_split_bps,
    }),
  );
}

async function handleSetFeeRecipient(
  event: ichi_vault_meridian.SetFeeRecipientEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const timestamp = micros2secs(ctx.getTimestamp());
  const cfg = await getOrCreateGlobalConfig(ctx);
  cfg.fee_recipient = lower(d.new_recipient);
  cfg.last_update_timestamp = timestamp;
  await ctx.store.upsert(cfg);
  await ctx.store.upsert(
    new MIVSetFeeRecipientEvent({
      ...baseEventFields(ctx),
      previous_recipient: lower(d.previous_recipient),
      new_recipient: lower(d.new_recipient),
    }),
  );
}

async function handleSetAmmFee(event: ichi_vault_meridian.SetAmmFeeEventInstance, ctx: AptosContext): Promise<void> {
  const d = event.data_decoded;
  const timestamp = micros2secs(ctx.getTimestamp());
  const cfg = await getOrCreateGlobalConfig(ctx);
  cfg.amm_fee_bps = d.new_amm_fee_bps;
  cfg.last_update_timestamp = timestamp;
  await ctx.store.upsert(cfg);
  await ctx.store.upsert(
    new MIVSetAmmFeeEvent({
      ...baseEventFields(ctx),
      previous_amm_fee_bps: d.previous_amm_fee_bps,
      new_amm_fee_bps: d.new_amm_fee_bps,
    }),
  );
}

// - - - TIMELOCKED-MODULE EVENTS - - -

async function handleTimelockedUpdateProposed(
  event: timelocked.TimelockedUpdateProposedEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  // T is u64 in every vault use-case, so current_value / proposed_value parse as bigint.
  await ctx.store.upsert(
    new MIVTimelockedUpdateProposedEvent({
      ...baseEventFields(ctx),
      vault_address: attributeTimelockedVault(ctx),
      tag: d.tag,
      current_value: BigInt(d.current_value as string | number | bigint),
      proposed_value: optionToBigInt(d.proposed_value),
      current_delay: d.current_delay,
      proposed_delay: optionToBigInt(d.proposed_delay),
      execution_time: d.execution_time,
    }),
  );
}

async function handleTimelockedUpdateExecuted(
  event: timelocked.TimelockedUpdateExecutedEventInstance,
  ctx: AptosContext,
): Promise<void> {
  const d = event.data_decoded;
  const vaultAddress = attributeTimelockedVault(ctx);

  // Propagate the executed value into MIVVault if we can attribute the vault.
  if (vaultAddress) {
    const vault = await ctx.store.get(MIVVault, vaultAddress);
    if (vault) {
      const newValue = BigInt(d.new_value as string | number | bigint);
      switch (d.tag) {
        case "deposit_hysteresis_ticks":
          vault.deposit_hysteresis_ticks = newValue;
          break;
        case "rebalance_hysteresis_ticks":
          vault.rebalance_hysteresis_ticks = newValue;
          break;
        case "deposit_twap_period":
          vault.deposit_twap_period = newValue;
          break;
        case "aux_deposit_twap_period":
          vault.aux_deposit_twap_period = newValue;
          break;
        case "withdraw_fee_bps":
          vault.withdraw_fee_bps = newValue;
          break;
        case "rebalance_cooldown":
          vault.rebalance_cooldown = newValue;
          break;
      }
      await ctx.store.upsert(vault);
    }
  }

  await ctx.store.upsert(
    new MIVTimelockedUpdateExecutedEvent({
      ...baseEventFields(ctx),
      vault_address: vaultAddress,
      tag: d.tag,
      previous_value: BigInt(d.previous_value as string | number | bigint),
      new_value: BigInt(d.new_value as string | number | bigint),
      delay: d.delay,
    }),
  );
}

// - - - HELPERS - - -

function lower(addr: string): string {
  return addr.toLowerCase();
}

function micros2secs(micros: number | bigint): bigint {
  return BigInt(micros) / 1_000_000n;
}

function eventId(ctx: AptosContext): string {
  return `${ctx.version}-${ctx.eventIndex}`;
}

function baseEventFields(ctx: AptosContext) {
  return {
    id: eventId(ctx),
    transaction_version: ctx.version,
    event_index: ctx.eventIndex,
    timestamp: micros2secs(ctx.getTimestamp()),
  };
}

function signedTickFromAbs(absVal: bigint, isNegative: boolean): bigint {
  return isNegative ? -absVal : absVal;
}

// Move Option<T> serializes as { vec: T[] } (0 or 1 element).
function optionString(opt: { vec: string[] }): string | undefined {
  return opt.vec.length > 0 ? opt.vec[0] : undefined;
}

function optionToBigInt(opt: unknown): bigint | undefined {
  const o = opt as { vec?: unknown[] } | undefined;
  if (!o?.vec || o.vec.length === 0) return undefined;
  return BigInt(o.vec[0] as string | number | bigint);
}

async function getOrCreateModule(ctx: AptosContext, timestamp: bigint): Promise<MIVModule> {
  let mod = await ctx.store.get(MIVModule, "global");
  if (!mod) {
    mod = new MIVModule({
      id: "global",
      vault_count: 0,
      deposit_count: 0,
      withdraw_count: 0,
      rebalance_count: 0,
      collect_fees_count: 0,
      position_added_count: 0,
      emergency_exit_count: 0,
      last_update_timestamp: timestamp,
    });
    await ctx.store.upsert(mod);
  }
  return mod;
}

async function bumpModule(
  ctx: AptosContext,
  field: "deposit_count" | "withdraw_count" | "rebalance_count" | "collect_fees_count",
  timestamp: bigint,
): Promise<void> {
  const mod = await getOrCreateModule(ctx, timestamp);
  mod[field] += 1;
  mod.last_update_timestamp = timestamp;
  await ctx.store.upsert(mod);
}

async function getOrCreateGlobalConfig(ctx: AptosContext): Promise<MIVGlobalConfig> {
  let cfg = await ctx.store.get(MIVGlobalConfig, "global");
  if (!cfg) {
    cfg = new MIVGlobalConfig({
      id: "global",
      owner: "0x0",
      pending_owner: undefined,
      base_fee_bps: 0n,
      base_fee_split_bps: 0n,
      fee_recipient: "0x0",
      amm_fee_bps: 0n,
      last_update_timestamp: 0n,
    });
    await ctx.store.upsert(cfg);
  }
  return cfg;
}

async function requireVault(ctx: AptosContext, vaultAddress: string): Promise<MIVVault> {
  const vault = await ctx.store.get(MIVVault, vaultAddress);
  if (!vault) {
    throw new Error(`MIVVault not found: ${vaultAddress}. VaultCreatedEvent must precede other vault events.`);
  }
  return vault;
}

type LiveState = {
  totalAmount0: bigint;
  totalAmount1: bigint;
  tick: bigint;
  twapTick: bigint;
  auxTwapTick: bigint;
  sqrtPrice: bigint;
  sharesPriceE18: bigint;
  totalSupply: bigint;
};

async function fetchVaultLiveState(
  ctx: AptosContext,
  vaultAddress: string,
  sharesMetadata: string,
): Promise<LiveState> {
  const client = ctx.getClient();

  const [holdings, ticks, sharePrice, supplyRes] = await Promise.all([
    client.viewJson({
      payload: {
        function: `${PKG}::ichi_vault_meridian::get_total_vault_holdings`,
        functionArguments: [vaultAddress],
      },
      options: { ledgerVersion: ctx.version },
    }),
    client.viewJson({
      payload: {
        function: `${PKG}::ichi_vault_meridian::get_all_valuation_ticks_raw`,
        functionArguments: [vaultAddress],
      },
      options: { ledgerVersion: ctx.version },
    }),
    client.viewJson({
      payload: {
        function: `${PKG}::ichi_vault_meridian::get_shares_price_e18`,
        functionArguments: [vaultAddress],
      },
      options: { ledgerVersion: ctx.version },
    }),
    client.viewJson({
      payload: {
        function: "0x1::fungible_asset::supply",
        typeArguments: ["0x1::fungible_asset::Metadata"],
        functionArguments: [sharesMetadata],
      },
      options: { ledgerVersion: ctx.version },
    }),
  ]);

  const [t0, t1] = holdings as [string | number, string | number];
  const [curNeg, curAbs, twapNeg, twapAbs, auxNeg, auxAbs] = ticks as [
    boolean,
    string | number,
    boolean,
    string | number,
    boolean,
    string | number,
  ];
  const [sp] = sharePrice as [string | number];
  const supplyOpt = supplyRes as [{ vec: (string | number)[] }];
  const totalSupply = supplyOpt[0].vec.length > 0 ? BigInt(supplyOpt[0].vec[0]) : 0n;

  return {
    totalAmount0: BigInt(t0),
    totalAmount1: BigInt(t1),
    tick: curNeg ? -BigInt(curAbs) : BigInt(curAbs),
    twapTick: twapNeg ? -BigInt(twapAbs) : BigInt(twapAbs),
    auxTwapTick: auxNeg ? -BigInt(auxAbs) : BigInt(auxAbs),
    sqrtPrice: 0n, // Not exposed as a separate view; price is derived from tick.
    sharesPriceE18: BigInt(sp),
    totalSupply,
  };
}

function applyLiveState(vault: MIVVault, live: LiveState, timestamp: bigint): void {
  vault.total_amount_0 = live.totalAmount0;
  vault.total_amount_1 = live.totalAmount1;
  vault.total_supply = live.totalSupply;
  vault.last_tick = live.tick;
  vault.twap_tick = live.twapTick;
  vault.aux_twap_tick = live.auxTwapTick;
  vault.last_sqrt_price = live.sqrtPrice;
  vault.shares_price_e18 = live.sharesPriceE18;
  vault.last_price_u18 = priceU18FromTick(live.tick, vault.token0_decimals, vault.token1_decimals);
  vault.last_price_timestamp = timestamp;
}

async function fetchFaDecimals(ctx: AptosContext, metadata: string): Promise<number> {
  const res = (await ctx.getClient().viewJson({
    payload: {
      function: "0x1::fungible_asset::decimals",
      typeArguments: ["0x1::fungible_asset::Metadata"],
      functionArguments: [metadata],
    },
    options: { ledgerVersion: ctx.version },
  })) as [number | string];
  return Number(res[0]);
}

async function rebuildPositions(ctx: AptosContext, vault: MIVVault, timestamp: bigint): Promise<void> {
  // Delete existing rows
  const existing = await ctx.store.list(MIVPosition, [{ field: "vault", op: "=", value: vault.id.toString() }]);
  for (const p of existing) {
    await ctx.store.delete(MIVPosition, p.id.toString());
  }

  const client = ctx.getClient();
  const [countRaw] = (await client.viewJson({
    payload: {
      function: `${PKG}::ichi_vault_meridian::get_position_count`,
      functionArguments: [vault.id.toString()],
    },
    options: { ledgerVersion: ctx.version },
  })) as [number | string];
  const count = Number(countRaw);

  for (let i = 0; i < count; i++) {
    const info = (await client.viewJson({
      payload: {
        function: `${PKG}::ichi_vault_meridian::get_all_position_info`,
        functionArguments: [vault.id.toString(), i],
      },
      options: { ledgerVersion: ctx.version },
    })) as [
      string | number,
      string | number,
      string,
      string | number,
      string | number,
      boolean,
      string | number,
      boolean,
      string | number,
    ];
    const [amount0, amount1, positionObj, positionId, liquidity, lowerNeg, lowerAbs, upperNeg, upperAbs] = info;
    await ctx.store.upsert(
      new MIVPosition({
        id: `${vault.id.toString()}-${i}`,
        vaultID: vault.id,
        index: i,
        position_object: lower(positionObj),
        position_id: BigInt(positionId),
        liquidity: BigInt(liquidity),
        lower_tick: lowerNeg ? -BigInt(lowerAbs) : BigInt(lowerAbs),
        upper_tick: upperNeg ? -BigInt(upperAbs) : BigInt(upperAbs),
        amount_0: BigInt(amount0),
        amount_1: BigInt(amount1),
        last_updated_timestamp: timestamp,
      }),
    );
  }

  vault.position_count = count;
}

type HistoryFeesDelta = { fees0Delta: bigint; fees1Delta: bigint };

async function updateVaultHistory(
  ctx: AptosContext,
  vault: MIVVault,
  timestamp: bigint,
  feesDelta?: HistoryFeesDelta,
): Promise<void> {
  const hourStart = (timestamp / 3600n) * 3600n;
  const dayStart = (timestamp / 86400n) * 86400n;

  await upsertHourly(ctx, vault, hourStart, feesDelta);
  await upsertDaily(ctx, vault, dayStart, feesDelta);
}

async function upsertHourly(
  ctx: AptosContext,
  vault: MIVVault,
  bucketStart: bigint,
  feesDelta?: HistoryFeesDelta,
): Promise<void> {
  const id = `${vault.id.toString()}-${bucketStart.toString()}`;
  const existing = await ctx.store.get(MIVVaultHourlyHistory, id);
  if (!existing) {
    await ctx.store.upsert(
      new MIVVaultHourlyHistory({
        ...baseHistoryRow(vault, id, bucketStart, feesDelta),
      }),
    );
    return;
  }
  applyHistoryUpdate(existing, vault, feesDelta);
  await ctx.store.upsert(existing);
}

async function upsertDaily(
  ctx: AptosContext,
  vault: MIVVault,
  bucketStart: bigint,
  feesDelta?: HistoryFeesDelta,
): Promise<void> {
  const id = `${vault.id.toString()}-${bucketStart.toString()}`;
  const existing = await ctx.store.get(MIVVaultDailyHistory, id);
  if (!existing) {
    await ctx.store.upsert(
      new MIVVaultDailyHistory({
        ...baseHistoryRow(vault, id, bucketStart, feesDelta),
      }),
    );
    return;
  }
  applyHistoryUpdate(existing, vault, feesDelta);
  await ctx.store.upsert(existing);
}

function baseHistoryRow(vault: MIVVault, id: string, bucketStart: bigint, feesDelta?: HistoryFeesDelta) {
  return {
    id,
    vaultID: vault.id,
    vault_address: vault.vault_address,
    date: bucketStart,
    total_amount_0: vault.total_amount_0,
    total_amount_1: vault.total_amount_1,
    total_supply: vault.total_supply,
    fees_0_delta: feesDelta?.fees0Delta ?? 0n,
    fees_1_delta: feesDelta?.fees1Delta ?? 0n,
    total_fees_0_collected: vault.total_fees_0_collected,
    total_fees_1_collected: vault.total_fees_1_collected,
    transaction_count: 1,
    open_tick: vault.last_tick,
    close_tick: vault.last_tick,
    low_tick: vault.last_tick,
    high_tick: vault.last_tick,
    open_share_price_e18: vault.shares_price_e18,
    close_share_price_e18: vault.shares_price_e18,
    low_share_price_e18: vault.shares_price_e18,
    high_share_price_e18: vault.shares_price_e18,
  };
}

function applyHistoryUpdate(
  row: MIVVaultHourlyHistory | MIVVaultDailyHistory,
  vault: MIVVault,
  feesDelta?: HistoryFeesDelta,
): void {
  row.total_amount_0 = vault.total_amount_0;
  row.total_amount_1 = vault.total_amount_1;
  row.total_supply = vault.total_supply;
  row.total_fees_0_collected = vault.total_fees_0_collected;
  row.total_fees_1_collected = vault.total_fees_1_collected;
  row.fees_0_delta = row.fees_0_delta + (feesDelta?.fees0Delta ?? 0n);
  row.fees_1_delta = row.fees_1_delta + (feesDelta?.fees1Delta ?? 0n);
  row.transaction_count += 1;
  row.close_tick = vault.last_tick;
  if (vault.last_tick < row.low_tick) row.low_tick = vault.last_tick;
  if (vault.last_tick > row.high_tick) row.high_tick = vault.last_tick;
  row.close_share_price_e18 = vault.shares_price_e18;
  if (vault.shares_price_e18 < row.low_share_price_e18) row.low_share_price_e18 = vault.shares_price_e18;
  if (vault.shares_price_e18 > row.high_share_price_e18) row.high_share_price_e18 = vault.shares_price_e18;
}

// Best-effort: timelocked events carry no vault address. The on-chain entry
// function takes `vault: Object<Vault>` as its first arg, which appears in
// ctx.transaction.payload.arguments[0] for entry-function calls. May be null
// on tests that build a synthetic tx without a payload.
function attributeTimelockedVault(ctx: AptosContext): string | undefined {
  const payload = (ctx.transaction as { payload?: { arguments?: unknown[] } } | undefined)?.payload;
  const args = payload?.arguments;
  if (!args || args.length === 0) return undefined;
  const candidate = args[0];
  if (typeof candidate === "string" && candidate.startsWith("0x")) {
    return lower(candidate);
  }
  if (typeof candidate === "object" && candidate !== null && "inner" in candidate) {
    const inner = (candidate as { inner: unknown }).inner;
    if (typeof inner === "string") return lower(inner);
  }
  return undefined;
}

// - - - TEST READER - - -

export class MIVTestReader {
  constructor(private store: Store) {}

  async getModule(): Promise<MIVModule | undefined> {
    return this.store.get(MIVModule, "global");
  }

  async getGlobalConfig(): Promise<MIVGlobalConfig | undefined> {
    return this.store.get(MIVGlobalConfig, "global");
  }

  async getVault(vaultAddress: string): Promise<MIVVault | undefined> {
    return this.store.get(MIVVault, lower(vaultAddress));
  }

  async getPositions(vaultAddress: string): Promise<MIVPosition[]> {
    return this.store.list(MIVPosition, [{ field: "vault", op: "=", value: lower(vaultAddress) }]);
  }

  async getHourlyHistory(vaultAddress: string): Promise<MIVVaultHourlyHistory[]> {
    return this.store.list(MIVVaultHourlyHistory, [{ field: "vault_address", op: "=", value: lower(vaultAddress) }]);
  }

  async getDailyHistory(vaultAddress: string): Promise<MIVVaultDailyHistory[]> {
    return this.store.list(MIVVaultDailyHistory, [{ field: "vault_address", op: "=", value: lower(vaultAddress) }]);
  }
}
