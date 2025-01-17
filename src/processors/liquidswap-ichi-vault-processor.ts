import { AptosContext } from "@sentio/sdk/aptos";

import {
  LiquidSwapVaultModule,
  LiquidSwapVault,
  LiquidSwapDepositEvent,
  LiquidSwapWithdrawEvent,
  LiquidSwapRebalanceEvent,
  LiquidSwapSnapshotEvent,
  LiquidSwapUser,
  LiquidSwapUserVault,
  LiquidSwapVaultHourlyHistory,
  LiquidSwapVaultDailyHistory,
} from "../schema/schema.ichi-vaults.js";

import { vault as aptos_testnet_vault_base_processor } from "../types/aptos/testnet/ichi-vaults-testnet.js";
import { vault as aptos_mainnet_vault_base_processor } from "../types/aptos/ichi-vaults.js";

import {
  binIdToPriceTokenX64,
  bufferConvert,
  divideU18,
  convertRawToU18,
  getXInY,
  getYInX,
} from "../math/liquidswap-toolbox.js";

export const volOptions = {
  sparse: true,
  aggregationConfig: {
    intervalInMinutes: [60],
  },
};

type updateAction = "add" | "subtract" | "set" | "snapshot";
type updateEvent = {
  total_value_locked_x: bigint;
  total_value_locked_y: bigint;
  total_value_locked_in_y_u18: bigint;
  total_shares: bigint;
  holder_count: number;
  total_fees: bigint;
  x_price_x64: bigint;
};

export function liquidswapIchiVaultsProcessor(
  chain_id: number,
  startVersion: number,
  vault_base_processor: typeof aptos_testnet_vault_base_processor | typeof aptos_mainnet_vault_base_processor,
) {
  vault_base_processor
    .bind({ startVersion: startVersion })
    .onEventVaultCreatedEvent(async (event, ctx) => {
      const vault_module = await getVaultModule(chain_id, ctx, event.data_decoded.owner);

      const coin_x_address =
        event.data_decoded.x.account_address +
        "::" +
        bufferConvert(event.data_decoded.x.module_name) +
        "::" +
        bufferConvert(event.data_decoded.x.struct_name);

      const coin_y_address =
        event.data_decoded.y.account_address +
        "::" +
        bufferConvert(event.data_decoded.y.module_name) +
        "::" +
        bufferConvert(event.data_decoded.y.struct_name);

      const bin_step = BigInt(bufferConvert(event.data_decoded.bin_step.struct_name).replace("X", ""));

      const vault = new LiquidSwapVault({
        id: event.data_decoded.vault_address,
        vault_address: event.data_decoded.vault_address,
        // vault_module: Promise.resolve(vault_module),
        vault_moduleID: vault_module.id,
        token_id_name: event.data_decoded.token_id.name,
        token_id_creator: event.data_decoded.token_id.creator,
        collection: event.data_decoded.token_id.collection,
        owner_address: event.data_decoded.owner,
        created_timestamp: BigInt(ctx.getTimestamp()),
        transaction_block_height: 0n,
        transaction_version: ctx.version,
        bin_step: bin_step,
        coin_x_address: coin_x_address,
        coin_y_address: coin_y_address,
        is_x_deposit: Boolean(event.data_decoded.allow_token_x),
        deposit_count: 0,
        withdraw_count: 0,
        rebalance_count: 0,
        snapshot_count: 0,
        holder_count: 0,
        total_shares: 0n,
        fee_apr_1_day_u18: 0n,
        fee_apr_3_day_u18: 0n,
        fee_apr_7_day_u18: 0n,
        fee_apr_30_day_u18: 0n,
        lp_apr_1_day_u18: 1n,
        lp_apr_3_day_u18: 1n,
        lp_apr_7_day_u18: 1n,
        lp_apr_30_day_u18: 1n,
        total_fees: 0n,
        total_value_locked_x: 0n,
        total_value_locked_y: 0n,
        total_value_locked_in_y_u18: 0n,
        current_x_price_x64: 0n,
        current_share_price_u18: 0n,
      });
      await ctx.store.upsert(vault);

      vault_module.vault_count += 1;
      await ctx.store.upsert(vault_module);

      const user = await getUser(event.data_decoded.owner, ctx);
      user.vault_count += 1;
      await ctx.store.upsert(user);
    })
    .onEventDepositEvent(async (event, ctx) => {
      const vault = await getVault(event.data_decoded.vault_address, ctx);
      const user = await getUser(event.data_decoded.user_address, ctx);

      const x_price_x64 = binIdToPriceTokenX64(BigInt(event.data_decoded.active_bin_id), vault.bin_step);
      const total_supply = BigInt(vault.total_shares) + event.data_decoded.shares_minted;
      const total_x_after_deposit = vault.total_value_locked_x + event.data_decoded.deposit_x_amount;
      const total_y_after_deposit = vault.total_value_locked_y + event.data_decoded.deposit_y_amount;
      const tvl_u18 = getXInY(total_x_after_deposit, x_price_x64) + convertRawToU18(total_y_after_deposit);

      const current_user_vault_transactions = await getCurrentUserVaultTransactions(user, vault, ctx);
      const is_holder = current_user_vault_transactions > 0;

      const previous_deposit_event_id = await getPreviousDepositEvent(ctx);
      const deposit_event = new LiquidSwapDepositEvent({
        id: (previous_deposit_event_id + 1).toString(),
        vaultID: vault.id,
        // TODO: consider storing the tx hash i.e. ctx.transaction.hash
        transaction_block_height: 0n, // TODO: remove if there's no way to get the block height in sentio
        transaction_version: ctx.version,
        user_address: event.data_decoded.user_address,
        coin_x_value: event.data_decoded.deposit_x_amount,
        coin_y_value: event.data_decoded.deposit_y_amount,
        total_supply: total_supply,
        active_bin_id: BigInt(event.data_decoded.active_bin_id),
        shares_minted: event.data_decoded.shares_minted,
        timestamp: BigInt(ctx.getTimestamp()),
      });
      await ctx.store.upsert(deposit_event);

      vault.deposit_count += 1;
      vault.holder_count += is_holder ? 0 : 1;
      await ctx.store.upsert(vault);

      const vault_module = await getVaultModule(2, ctx, vault.owner_address);
      vault_module.deposit_count += 1;
      await ctx.store.upsert(vault_module);

      await updateUser(event.data_decoded.user_address, vault, ctx);

      const update_event: updateEvent = {
        total_value_locked_x: total_x_after_deposit,
        total_value_locked_y: total_y_after_deposit,
        total_value_locked_in_y_u18: tvl_u18,
        total_shares: total_supply,
        holder_count: is_holder ? 0 : 1,
        total_fees: 0n,
        x_price_x64: x_price_x64,
      };
      await updateVaultHistory(vault, ctx, BigInt(ctx.getTimestamp()), "add", update_event);
    })
    .onEventWithdrawEvent(async (event, ctx) => {
      const vault = await getVault(event.data_decoded.vault_address, ctx);

      const x_price_x64 = binIdToPriceTokenX64(BigInt(event.data_decoded.active_bin_id), vault.bin_step);
      const total_supply = BigInt(vault.total_shares) - event.data_decoded.shares_burned;
      const total_x_after_deposit = vault.total_value_locked_x + event.data_decoded.coin_x_val;
      const total_y_after_deposit = vault.total_value_locked_y + event.data_decoded.coin_y_val;
      const tvl_u18 = getXInY(total_x_after_deposit, x_price_x64) + convertRawToU18(total_y_after_deposit);

      const previous_withdraw_event_id = await getPreviousWithdrawEvent(ctx);
      const withdraw_event = new LiquidSwapWithdrawEvent({
        id: (previous_withdraw_event_id + 1).toString(),
        vaultID: vault.id,
        transaction_block_height: 0n,
        transaction_version: ctx.version,
        user_address: event.data_decoded.user_address,
        coin_x_value: event.data_decoded.coin_x_val,
        coin_y_value: event.data_decoded.coin_y_val,
        total_supply: total_supply,
        active_bin_id: BigInt(event.data_decoded.active_bin_id),
        shares_burned: event.data_decoded.shares_burned,
        timestamp: BigInt(ctx.getTimestamp()),
      });
      await ctx.store.upsert(withdraw_event);

      vault.withdraw_count += 1;
      await ctx.store.upsert(vault);

      const vault_module = await getVaultModule(2, ctx, vault.owner_address);
      vault_module.withdraw_count += 1;
      await ctx.store.upsert(vault_module);

      await updateUser(event.data_decoded.user_address, vault, ctx);

      const update_event: updateEvent = {
        total_value_locked_x: total_x_after_deposit,
        total_value_locked_y: total_y_after_deposit,
        total_value_locked_in_y_u18: tvl_u18,
        total_shares: total_supply,
        holder_count: 0,
        total_fees: 0n,
        x_price_x64: x_price_x64,
      };
      await updateVaultHistory(vault, ctx, BigInt(ctx.getTimestamp()), "subtract", update_event);
    })
    .onEventRebalanceEvent(async (event, ctx) => {
      const vault = await getVault(event.data_decoded.vault_address, ctx);
      const x_price_x64 = binIdToPriceTokenX64(BigInt(event.data_decoded.active_bin_id), vault.bin_step);
      const tvl_u18 = getXInY(vault.total_value_locked_x, x_price_x64) + convertRawToU18(vault.total_value_locked_y);

      const current_fee_window = await getCurrentRunningFee(vault, ctx);
      const previous_rebalance_event_id = await getPreviousRebalanceEvent(ctx);
      const rebalance_event = new LiquidSwapRebalanceEvent({
        id: (previous_rebalance_event_id + 1).toString(),
        vault_address: vault.vault_address,
        transaction_block_height: 0n,
        transaction_version: ctx.version,
        active_bin_id: BigInt(event.data_decoded.active_bin_id),
        leftover_coin_x_value: event.data_decoded.leftover_x_val,
        leftover_coin_y_value: event.data_decoded.leftover_y_val,
        total_supply: BigInt(vault.total_shares),
        base_fees_x: event.data_decoded.fees_x,
        base_fees_y: event.data_decoded.fees_y,
        total_fee: event.data_decoded.total_fee,
        base_lower_bin_id: BigInt(event.data_decoded.base_lower_bin_id),
        base_upper_bin_id: BigInt(event.data_decoded.base_upper_bin_id),
        limit_lower_bin_id: BigInt(event.data_decoded.limit_lower_bin_id),
        limit_upper_bin_id: BigInt(event.data_decoded.limit_upper_bin_id),
        timestamp: BigInt(ctx.getTimestamp()),
      });
      await ctx.store.upsert(rebalance_event);

      vault.rebalance_count += 1;
      await ctx.store.upsert(vault);

      const vault_module = await getVaultModule(2, ctx, vault.owner_address);
      vault_module.rebalance_count += 1;
      await ctx.store.upsert(vault_module);

      const total_fee_window = event.data_decoded.total_fee - current_fee_window;
      const update_event: updateEvent = {
        total_value_locked_x: event.data_decoded.leftover_x_val,
        total_value_locked_y: event.data_decoded.leftover_y_val,
        total_value_locked_in_y_u18: tvl_u18,
        total_shares: BigInt(vault.total_shares),
        holder_count: 0,
        total_fees: total_fee_window,
        x_price_x64: x_price_x64,
      };
      await updateVaultHistory(vault, ctx, BigInt(ctx.getTimestamp()), "set", update_event);
    })
    .onEventSnapshotEvent(async (event, ctx) => {
      const vault = await getVault(event.data_decoded.vault_address, ctx);

      const current_fee_window = await getCurrentRunningFee(vault, ctx);
      const previous_snapshot_event_id = await getPreviousSnapshotEvent(ctx);
      const snapshot_event = new LiquidSwapSnapshotEvent({
        id: (previous_snapshot_event_id + 1).toString(),
        vault_address: vault.vault_address,
        transaction_block_height: 0n,
        transaction_version: ctx.version,
        total_fee: event.data_decoded.total_fee,
        total_x: event.data_decoded.total_x,
        total_y: event.data_decoded.total_y,
        timestamp: BigInt(ctx.getTimestamp()),
      });
      await ctx.store.upsert(snapshot_event);

      vault.snapshot_count += 1;
      await ctx.store.upsert(vault);

      const vault_module = await getVaultModule(2, ctx, vault.owner_address);
      vault_module.snapshot_count += 1;
      await ctx.store.upsert(vault_module);

      const total_fee_window = event.data_decoded.total_fee - current_fee_window;
      const last_price_x64 = await ctx.store.list(LiquidSwapVaultHourlyHistory, [
        { field: "vault_address", op: "=", value: vault.vault_address },
      ]);
      const x_price_x64 = last_price_x64[0].close_x_price_x64;
      const update_event: updateEvent = {
        total_value_locked_x: 0n,
        total_value_locked_y: 0n,
        total_value_locked_in_y_u18: 0n,
        total_shares: 0n,
        holder_count: 0,
        total_fees: total_fee_window,
        x_price_x64: x_price_x64,
      };
      await updateVaultHistory(vault, ctx, BigInt(ctx.getTimestamp()), "snapshot", update_event);
    });
}
async function getVaultModule(
  chain_id: number,
  ctx: AptosContext,
  publisher_address: string,
): Promise<LiquidSwapVaultModule> {
  let vaultModule = await ctx.store.get(LiquidSwapVaultModule, chain_id.toString());
  if (!vaultModule) {
    vaultModule = new LiquidSwapVaultModule({
      id: chain_id.toString(),
      publisher_address,
      vault_count: 0,
      deposit_count: 0,
      withdraw_count: 0,
      rebalance_count: 0,
      snapshot_count: 0,
    });
    await ctx.store.upsert(vaultModule);
  }
  return vaultModule;
}

async function updateUser(user_address: string, vault: LiquidSwapVault, ctx: AptosContext) {
  const user = await getUser(user_address, ctx);
  if (!user) {
    throw new Error(`User ${user_address} not found`);
  }
  const userVault = await getUserVault(user, vault, ctx);
  user.transaction_count += 1;
  userVault.transaction_count += 1;
  await ctx.store.upsert(user);
  await ctx.store.upsert(userVault);
}

async function getUser(user_address: string, ctx: AptosContext): Promise<LiquidSwapUser> {
  let user = await ctx.store.get(LiquidSwapUser, user_address);
  if (!user) {
    try {
      user = new LiquidSwapUser({
        id: user_address,
        user_address,
        vault_count: 1,
        transaction_count: 1,
      });
      await ctx.store.upsert(user);
      return user;
    } catch (e) {
      console.log("ERROR CREATING USER", e);
    }
    throw new Error(`User ${user_address} not found`);
  }
  return user;
}

async function getUserVault(
  user: LiquidSwapUser,
  vault: LiquidSwapVault,
  ctx: AptosContext,
): Promise<LiquidSwapUserVault> {
  const userVault = await ctx.store.list(LiquidSwapUserVault, [
    { field: "user_address", op: "=", value: user.user_address },
    { field: "vault_address", op: "=", value: vault.vault_address },
  ]);
  if (userVault.length === 0) {
    const newUserVault = new LiquidSwapUserVault({
      id: `${user.id}-${vault.id}`,
      user_address: user.user_address,
      vault_address: vault.vault_address,
      transaction_count: 1,
    });
    await ctx.store.upsert(newUserVault);
    return newUserVault;
  }
  return userVault[0];
}

async function getCurrentUserVaultTransactions(
  user: LiquidSwapUser,
  vault: LiquidSwapVault,
  ctx: AptosContext,
): Promise<number> {
  const userVault = await getUserVault(user, vault, ctx);

  return userVault.transaction_count;
}

async function getVault(vault_address: string, ctx: AptosContext): Promise<LiquidSwapVault> {
  const vault = await ctx.store.get(LiquidSwapVault, vault_address);
  if (!vault) {
    throw new Error(`Vault ${vault_address} not found`);
  }
  return vault;
}

async function getPreviousDepositEvent(ctx: AptosContext): Promise<number> {
  const deposit_events = await ctx.store.list(LiquidSwapDepositEvent);
  if (deposit_events.length === 0) {
    return 0;
  }
  deposit_events.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return Number(deposit_events[deposit_events.length - 1].id);
}

async function getPreviousWithdrawEvent(ctx: AptosContext): Promise<number> {
  const withdraw_events = await ctx.store.list(LiquidSwapWithdrawEvent);
  if (withdraw_events.length === 0) {
    return 0;
  }
  withdraw_events.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return Number(withdraw_events[withdraw_events.length - 1].id);
}

async function getPreviousRebalanceEvent(ctx: AptosContext): Promise<number> {
  const rebalance_events = await ctx.store.list(LiquidSwapRebalanceEvent);
  if (rebalance_events.length === 0) {
    return 0;
  }
  rebalance_events.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return Number(rebalance_events[rebalance_events.length - 1].id);
}

async function getPreviousSnapshotEvent(ctx: AptosContext): Promise<number> {
  const snapshot_events = await ctx.store.list(LiquidSwapSnapshotEvent);
  if (snapshot_events.length === 0) {
    return 0;
  }
  snapshot_events.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return Number(snapshot_events[snapshot_events.length - 1].id);
}

async function getCurrentRunningFee(vault: LiquidSwapVault, ctx: AptosContext): Promise<bigint> {
  const rebalance_events = await ctx.store.list(LiquidSwapRebalanceEvent, [
    { field: "vault_address", op: "=", value: vault.vault_address },
  ]);
  const latest_rebalance_event = rebalance_events.sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0];

  const snapshot_events = await ctx.store.list(LiquidSwapSnapshotEvent, [
    { field: "vault_address", op: "=", value: vault.vault_address },
  ]);
  const latest_snapshot_event = snapshot_events.sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0];

  if (!latest_snapshot_event) {
    return 0n;
  } else if (!latest_rebalance_event) {
    return latest_snapshot_event.total_fee;
  }
  return latest_snapshot_event.timestamp > latest_rebalance_event.timestamp ? latest_snapshot_event.total_fee : 0n;
}

async function getFeeAPR(vault: LiquidSwapVault, ctx: AptosContext, days: number, timestamp: bigint): Promise<bigint> {
  const days_in_unix = days * 86400;
  const current_timestamp = new Date(Number(timestamp));
  const current_event_day = BigInt(current_timestamp.setHours(0, 0, 0, 0)) / 1000000n;
  const vault_history = await ctx.store.list(LiquidSwapVaultDailyHistory, [
    { field: "vault_address", op: "=", value: vault.vault_address },
    {
      field: "date",
      op: ">=",
      value: BigInt(current_event_day) - BigInt(days_in_unix),
    },
    { field: "date", op: "<=", value: current_event_day },
  ]);
  if (vault_history.length === 0) {
    return 0n;
  }

  const total_fees = vault_history.reduce((acc, curr) => acc + curr.total_fees, 0n);
  const tvl_u18 = BigInt(vault_history[0].total_value_locked_in_y_u18);

  const periods_u18 = divideU18(365n, BigInt(days));
  const normalized_yearly_fees_u18 = total_fees * periods_u18;
  const fee_apr_u18 = divideU18(normalized_yearly_fees_u18, tvl_u18);

  return fee_apr_u18;
}

async function getLPAPR(
  vault: LiquidSwapVault,
  ctx: AptosContext,
  x_price_x64: bigint,
  days: number,
  timestamp: bigint,
): Promise<bigint> {
  const seconds_timestamp = timestamp / 1000n;
  const days_in_unix = BigInt(days * 86400000);
  const diff = seconds_timestamp - days_in_unix;
  const diff_date = new Date(Number(diff));
  const previous_vault_history_date = diff_date.setHours(0, 0, 0, 0) / 1000;

  const vault_history = await ctx.store.list(LiquidSwapVaultDailyHistory, [
    { field: "vault_address", op: "=", value: vault.vault_address },
    { field: "date", op: ">=", value: BigInt(previous_vault_history_date) },
    // { field: "date", op: "<=", value: BigInt(round_utc) + BigInt(86399) },
  ]);

  if (vault_history.length === 0) {
    return 0n;
  }

  const previous_share_exchange = calculateVaultSharePrice(
    vault,
    BigInt(vault_history[0].close_x_price_x64),
    BigInt(vault_history[0].total_value_locked_x),
    BigInt(vault_history[0].total_value_locked_y),
    BigInt(vault_history[0].total_shares),
  );

  const current_share_exchange = calculateVaultSharePrice(
    vault,
    x_price_x64,
    BigInt(vault.total_value_locked_x),
    BigInt(vault.total_value_locked_y),
    BigInt(vault.total_shares),
  );

  if (previous_share_exchange === 0n) {
    return 1n;
  }

  return divideU18(current_share_exchange, previous_share_exchange);
}

function calculateVaultSharePrice(
  vault: LiquidSwapVault,
  x_price_x64: bigint,
  tvl_x: bigint,
  tvl_y: bigint,
  total_shares: bigint,
): bigint {
  if (total_shares == 0n) {
    return 0n;
  }

  if (vault.is_x_deposit) {
    const y_amount_in_x = getYInX(tvl_y, x_price_x64);
    const tvl_x_u18 = convertRawToU18(tvl_x);
    const share_price_u18 = (tvl_x_u18 + y_amount_in_x) / total_shares;
    return share_price_u18;
  }

  const x_amount_in_y = getXInY(tvl_x, x_price_x64);
  const tvl_y_u18 = convertRawToU18(tvl_y);
  const share_price_u18 = (tvl_y_u18 + x_amount_in_y) / total_shares;
  return share_price_u18;
}

async function updateVaultHistory(
  vault: LiquidSwapVault,
  ctx: AptosContext,
  timestamp: bigint,
  action: updateAction,
  event: updateEvent,
) {
  const currentTimestamp = new Date(Number(timestamp / 1000n));
  const eventHour = currentTimestamp.setMinutes(0, 0, 0) / 1000;
  const eventDay = currentTimestamp.setHours(0, 0, 0, 0) / 1000;

  const vault_hourly_history_list = await ctx.store.list(LiquidSwapVaultHourlyHistory, [
    { field: "vault_address", op: "=", value: vault.vault_address },
    { field: "date", op: "=", value: BigInt(eventHour) },
  ]);
  if (vault_hourly_history_list.length === 0) {
    const last_vault_history = await getLastVaultHistory(vault, ctx);
    const newVaultHourlyHistory = new LiquidSwapVaultHourlyHistory({
      id: (last_vault_history + 1).toString(),
      vault_address: vault.vault_address,
      date: BigInt(eventHour),
      total_value_locked_x: vault.total_value_locked_x,
      total_value_locked_y: vault.total_value_locked_y,
      total_value_locked_in_y_u18: vault.total_value_locked_in_y_u18,
      total_fees: vault.total_fees,
      total_shares: BigInt(vault.total_shares),
      transaction_count: 1,
      holder_count: 1,
      open_x_price_x64: event.x_price_x64,
      open_dt_share_price_u18: 1n,
      close_x_price_x64: event.x_price_x64,
      close_dt_share_price_u18: 1n,
      low_x_price_x64: event.x_price_x64,
      low_dt_share_price_u18: 1n,
      high_x_price_x64: event.x_price_x64,
      high_dt_share_price_u18: 1n,
    });
    vault_hourly_history_list.push(newVaultHourlyHistory);
  }

  const vault_daily_history_list = await ctx.store.list(LiquidSwapVaultDailyHistory, [
    { field: "vault_address", op: "=", value: vault.vault_address },
    { field: "date", op: "=", value: BigInt(eventDay) },
  ]);
  if (vault_daily_history_list.length === 0) {
    const last_vault_daily_history = await getLastVaultDailyHistory(vault, ctx);
    const newVaultDailyHistory = new LiquidSwapVaultDailyHistory({
      id: (last_vault_daily_history + 1).toString(),
      vault_address: vault.vault_address,
      date: BigInt(eventDay),
      total_value_locked_x: vault.total_value_locked_x,
      total_value_locked_y: vault.total_value_locked_y,
      total_value_locked_in_y_u18: vault.total_value_locked_in_y_u18,
      total_fees: vault.total_fees,
      transaction_count: 1,
      holder_count: 1,
      total_shares: BigInt(vault.total_shares),
      open_x_price_x64: event.x_price_x64,
      open_dt_share_price_u18: 1n,
      close_x_price_x64: event.x_price_x64,
      close_dt_share_price_u18: 1n,
      low_x_price_x64: event.x_price_x64,
      low_dt_share_price_u18: 1n,
      high_x_price_x64: event.x_price_x64,
      high_dt_share_price_u18: 1n,
    });
    vault_daily_history_list.push(newVaultDailyHistory);
  }

  const vaultHourlyHistory = vault_hourly_history_list[0];
  const vaultDailyHistory = vault_daily_history_list[0];

  if (action !== "snapshot") {
    vaultHourlyHistory.total_value_locked_x = event.total_value_locked_x;
    vaultHourlyHistory.total_value_locked_y = event.total_value_locked_y;
    vaultHourlyHistory.total_value_locked_in_y_u18 = event.total_value_locked_in_y_u18;

    vaultDailyHistory.total_value_locked_x = event.total_value_locked_x;
    vaultDailyHistory.total_value_locked_y = event.total_value_locked_y;
    vaultDailyHistory.total_value_locked_in_y_u18 = event.total_value_locked_in_y_u18;

    vault.total_value_locked_x = event.total_value_locked_x;
    vault.total_value_locked_y = event.total_value_locked_y;
    vault.total_value_locked_in_y_u18 = event.total_value_locked_in_y_u18;

    vault.current_x_price_x64 = event.x_price_x64;
  }

  vault.total_fees = BigInt(vault.total_fees) + BigInt(event.total_fees);

  vaultHourlyHistory.total_fees = BigInt(vaultHourlyHistory.total_fees) + BigInt(event.total_fees);
  vaultHourlyHistory.transaction_count++;
  vaultHourlyHistory.holder_count += event.holder_count;

  vaultDailyHistory.total_fees = BigInt(vaultDailyHistory.total_fees) + BigInt(event.total_fees);
  vaultDailyHistory.transaction_count++;
  vaultDailyHistory.holder_count += event.holder_count;

  switch (action) {
    case "add":
      vaultHourlyHistory.total_shares = event.total_shares;
      vaultDailyHistory.total_shares = event.total_shares;
      vault.total_shares = event.total_shares;
      vault.holder_count += event.holder_count;
      break;
    case "subtract":
      vaultHourlyHistory.total_shares = event.total_shares;
      vaultDailyHistory.total_shares = event.total_shares;
      vault.total_shares = event.total_shares;
      break;
    case "snapshot":
      break;
    case "set":
      break;
  }

  if (action !== "snapshot") {
    if (BigInt(vaultHourlyHistory.open_x_price_x64) === 0n) {
      vaultHourlyHistory.open_x_price_x64 = event.x_price_x64;
    }
    if (event.x_price_x64 < BigInt(vaultHourlyHistory.low_x_price_x64)) {
      vaultHourlyHistory.low_x_price_x64 = event.x_price_x64;
    }
    if (event.x_price_x64 > BigInt(vaultHourlyHistory.high_x_price_x64)) {
      vaultHourlyHistory.high_x_price_x64 = event.x_price_x64;
    }
    vaultHourlyHistory.close_x_price_x64 = event.x_price_x64;

    if (BigInt(vaultDailyHistory.open_x_price_x64) === 0n) {
      vaultDailyHistory.open_x_price_x64 = event.x_price_x64;
    }
    if (event.x_price_x64 < BigInt(vaultDailyHistory.low_x_price_x64)) {
      vaultDailyHistory.low_x_price_x64 = event.x_price_x64;
    }
    if (event.x_price_x64 > BigInt(vaultDailyHistory.high_x_price_x64)) {
      vaultDailyHistory.high_x_price_x64 = event.x_price_x64;
    }
    vaultDailyHistory.close_x_price_x64 = event.x_price_x64;

    const current_share_exchange_u18 = calculateVaultSharePrice(
      vault,
      BigInt(event.x_price_x64),
      BigInt(vault.total_value_locked_x),
      BigInt(vault.total_value_locked_y),
      BigInt(vault.total_shares),
    );

    if (vaultHourlyHistory.open_dt_share_price_u18 == 0n) {
      vaultHourlyHistory.open_dt_share_price_u18 = current_share_exchange_u18;
    }
    if (
      BigInt(current_share_exchange_u18) <
      BigInt(vaultHourlyHistory.low_dt_share_price_u18 || vaultHourlyHistory.low_dt_share_price_u18 == 0n)
    ) {
      vaultHourlyHistory.low_dt_share_price_u18 = current_share_exchange_u18;
    }
    if (BigInt(current_share_exchange_u18) > BigInt(vaultHourlyHistory.high_dt_share_price_u18)) {
      vaultHourlyHistory.high_dt_share_price_u18 = current_share_exchange_u18;
    }
    vaultHourlyHistory.close_dt_share_price_u18 = current_share_exchange_u18;

    if (vaultDailyHistory.open_dt_share_price_u18 == 0n) {
      vaultDailyHistory.open_dt_share_price_u18 = current_share_exchange_u18;
    }
    if (
      BigInt(current_share_exchange_u18) < BigInt(vaultDailyHistory.low_dt_share_price_u18) ||
      vaultDailyHistory.low_dt_share_price_u18 == 0n
    ) {
      vaultDailyHistory.low_dt_share_price_u18 = current_share_exchange_u18;
    }
    if (BigInt(current_share_exchange_u18) > BigInt(vaultDailyHistory.high_dt_share_price_u18)) {
      vaultDailyHistory.high_dt_share_price_u18 = current_share_exchange_u18;
    }
    vaultDailyHistory.close_dt_share_price_u18 = current_share_exchange_u18;
  }

  await ctx.store.upsert(vaultHourlyHistory);
  await ctx.store.upsert(vaultDailyHistory);

  if (action == "snapshot" || action == "set") {
    vault.fee_apr_1_day_u18 = await getFeeAPR(vault, ctx, 1, timestamp);
    vault.fee_apr_3_day_u18 = await getFeeAPR(vault, ctx, 3, timestamp);
    vault.fee_apr_7_day_u18 = await getFeeAPR(vault, ctx, 7, timestamp);
    vault.fee_apr_30_day_u18 = await getFeeAPR(vault, ctx, 30, timestamp);

    vault.lp_apr_1_day_u18 = await getLPAPR(vault, ctx, event.x_price_x64, 1, timestamp);
    vault.lp_apr_3_day_u18 = await getLPAPR(vault, ctx, event.x_price_x64, 3, timestamp);
    vault.lp_apr_7_day_u18 = await getLPAPR(vault, ctx, event.x_price_x64, 7, timestamp);
    vault.lp_apr_30_day_u18 = await getLPAPR(vault, ctx, event.x_price_x64, 30, timestamp);
  }
  if (action != "set") {
    vault.current_share_price_u18 = await calculateVaultSharePrice(
      vault,
      BigInt(event.x_price_x64),
      BigInt(event.total_value_locked_x),
      BigInt(event.total_value_locked_y),
      BigInt(event.total_shares),
    );
  }
  await ctx.store.upsert(vault);
}

async function getLastVaultHistory(vault: LiquidSwapVault, ctx: AptosContext): Promise<number> {
  const vault_hourly_history_list = await ctx.store.list(LiquidSwapVaultHourlyHistory, [
    { field: "vault_address", op: "=", value: vault.vault_address },
  ]);
  if (vault_hourly_history_list.length === 0) {
    return 0;
  }
  vault_hourly_history_list.sort((a, b) => Number(a.date) - Number(b.date));
  return Number(vault_hourly_history_list[vault_hourly_history_list.length - 1].id);
}

async function getLastVaultDailyHistory(vault: LiquidSwapVault, ctx: AptosContext): Promise<number> {
  const vault_daily_history_list = await ctx.store.list(LiquidSwapVaultDailyHistory, [
    { field: "vault_address", op: "=", value: vault.vault_address },
  ]);
  if (vault_daily_history_list.length === 0) {
    return 0;
  }
  vault_daily_history_list.sort((a, b) => Number(a.date) - Number(b.date));
  return Number(vault_daily_history_list[vault_daily_history_list.length - 1].id);
}
