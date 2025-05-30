import { AptosContext } from "@sentio/sdk/aptos";
import { Store } from "@sentio/sdk/store";

import {
  MRModule,
  MRStakingPool,
  MRPoolRewardData,
  MRUser,
  MRUserStakedBalance,
  MRUserSubscription,
  MRUserRewardData,
  MRRewardAddedEvent,
  MRRewardClaimedEvent,
  MRRewardNotifiedEvent,
  MRRewardsDurationUpdatedEvent,
  MRStakeEvent,
  MRWithdrawEvent,
  MRSubscriptionEvent,
  MRUnsubscriptionEvent,
  MREmergencyWithdrawEvent,
} from "../schema/schema.rewards.js";

import { multi_rewards as multi_rewards_movement } from "../types/aptos/movement-mainnet/multi_rewards.js";
import { multi_rewards as multi_rewards_testnet } from "../types/aptos/testnet/multi_rewards.js";

import { SupportedAptosChainId } from "../chains.js";

// Constants
const U12_PRECISION = 10n ** 12n;
// const TOLERANCE = 1n; // For reward rate comparison

// Types
type MultiRewardsProcessor = typeof multi_rewards_testnet | typeof multi_rewards_movement;

// Core processor setup
export function multiRewardsProcessor(
  supportedChainId: SupportedAptosChainId,
  startVersion: number,
  baseProcessor: MultiRewardsProcessor,
) {
  baseProcessor
    .bind({ startVersion })
    .onEventStakingPoolCreatedEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());

      const module = await getOrCreateModule(store);

      const pool = new MRStakingPool({
        id: event.data_decoded.pool_address.toLowerCase(),
        moduleID: module.id,
        creation_tx_version: BigInt(ctx.version),
        creator: event.data_decoded.creator,
        staking_token: event.data_decoded.staking_token,
        reward_tokens: [],
        withdrawal_count: 0,
        claim_count: 0,
        subscriber_count: 0,
        total_subscribed: 0n,
        created_at: timestamp,
      });

      await store.upsert(pool);
      await incrementModuleStats(module, store, timestamp, "pool_count");
    })
    .onEventRewardAddedEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());

      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "reward_count");

      const pool = await getStakingPool(event.data_decoded.pool_address, store);
      if (!pool) throw new Error("Pool not found");

      // Verify reward token not already added
      if (pool.reward_tokens.includes(event.data_decoded.reward_token)) {
        throw new Error("Reward token already exists");
      }

      // Create reward data
      const rewardData = new MRPoolRewardData({
        id: `${pool.id}-${event.data_decoded.reward_token}`,
        pool_address: pool.id.toString(),
        poolID: pool.id,
        reward_token: event.data_decoded.reward_token,
        reward_balance: 0n,
        distributor: event.data_decoded.rewards_distributor,
        duration: event.data_decoded.rewards_duration,
        period_finish: 0n,
        last_update_time: timestamp,
        reward_rate_u12: 0n,
        reward_per_token_stored_u12: 0n,
        unallocated_rewards: 0n,
        total_distributed: 0n,
      });

      // Update pool
      pool.reward_tokens = [...pool.reward_tokens, event.data_decoded.reward_token];

      await store.upsert(rewardData);
      await store.upsert(pool);

      // Create event entity
      const addedEvent = new MRRewardAddedEvent({
        id: `${pool.id}-${event.data_decoded.reward_token}-${module.reward_count}`,
        poolID: pool.id,
        transaction_version: BigInt(ctx.version),
        reward_token: event.data_decoded.reward_token,
        distributor: event.data_decoded.rewards_distributor,
        duration: event.data_decoded.rewards_duration,
        timestamp,
      });

      await store.upsert(addedEvent);
    })
    .onEventRewardNotifiedEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());

      // Get and update module first for the notify count
      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "notify_count");

      const pool = await getStakingPool(event.data_decoded.pool_address, store);
      if (!pool) throw new Error("Pool not found");

      const rewardData = await getRewardData(pool.id.toString(), event.data_decoded.reward_token, store);
      if (!rewardData) throw new Error("Reward data not found");

      // Update global reward state
      await updateRewards(pool, "0x0", timestamp, store);

      const period_finish = event.data_decoded.period_finish;
      const reward_amount = event.data_decoded.reward_amount;
      const reward_amount_with_unallocated = reward_amount + rewardData.unallocated_rewards;
      rewardData.unallocated_rewards = 0n; // Reset after using

      if (timestamp >= rewardData.period_finish) {
        rewardData.reward_rate_u12 = (reward_amount_with_unallocated * U12_PRECISION) / rewardData.duration;
      } else {
        const remaining = rewardData.period_finish - timestamp;
        const leftover = remaining * rewardData.reward_rate_u12;
        rewardData.reward_rate_u12 = (reward_amount_with_unallocated * U12_PRECISION + leftover) / rewardData.duration;
      }

      rewardData.reward_balance += reward_amount;
      rewardData.last_update_time = timestamp;
      rewardData.period_finish = period_finish;
      rewardData.total_distributed += reward_amount;

      await store.upsert(rewardData);

      // Create event entity
      const notifiedEvent = new MRRewardNotifiedEvent({
        id: `${pool.id}-${event.data_decoded.reward_token}-${module.notify_count}`,
        poolID: pool.id,
        transaction_version: BigInt(ctx.version),
        reward_token: event.data_decoded.reward_token,
        reward_amount: reward_amount,
        reward_rate_u12: rewardData.reward_rate_u12,
        period_finish: period_finish,
        timestamp,
      });

      await store.upsert(notifiedEvent);
    })
    .onEventRewardsDurationUpdatedEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());

      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "update_duration_count");

      // Get the pool and reward data
      const pool = await getStakingPool(event.data_decoded.pool_address, store);
      if (!pool) {
        throw new Error("Pool not found");
      }

      const rewardData = await getRewardData(pool.id.toString(), event.data_decoded.reward_token, store);
      if (!rewardData) {
        throw new Error("Reward data not found");
      }

      // Verify we're past the current reward period
      // NOTE: this should never occur as it is an onchain constraint and so if an onchain function call
      // executed that violated this constraint it would abort the transaction and RewardsDurationUpdatedEvent would not be emitted
      if (timestamp <= rewardData.period_finish) {
        throw new Error("Cannot update duration before current period ends");
      }

      // Update reward duration
      rewardData.duration = event.data_decoded.new_duration;
      await store.upsert(rewardData);

      // Create event entity
      const durationUpdatedEvent = new MRRewardsDurationUpdatedEvent({
        id: `${pool.id}-${event.data_decoded.reward_token}-${module.update_duration_count}`,
        poolID: pool.id,
        transaction_version: BigInt(ctx.version),
        reward_token: event.data_decoded.reward_token,
        new_duration: event.data_decoded.new_duration,
        timestamp,
      });
      await store.upsert(durationUpdatedEvent);
    })
    .onEventRewardClaimedEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());
      const userAddress = event.data_decoded.user;

      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "claim_count");

      // Get pool
      const pool = await getStakingPool(event.data_decoded.pool_address, store);
      if (!pool) throw new Error("Pool not found");

      // Update rewards before claiming
      await updateRewards(pool, userAddress, timestamp, store);

      // Get reward data
      const rewardData = await getRewardData(pool.id.toString(), event.data_decoded.reward_token, store);
      if (!rewardData) throw new Error("Reward data not found");

      // Get or create user reward data
      const userRewardDataId = `${userAddress}-${pool.id}-${event.data_decoded.reward_token}`;
      let userRewardData = await store.get(MRUserRewardData, userRewardDataId);

      if (!userRewardData) {
        // Get subscription - must exist since rewards can only be claimed while subscribed
        const subscription = await getUserSubscription(userAddress, pool.id.toString(), store);
        if (!subscription) throw new Error("Subscription not found");

        userRewardData = new MRUserRewardData({
          id: userRewardDataId,
          subscriptionID: subscription.id,
          reward_token: event.data_decoded.reward_token,
          reward_per_token_paid_u12: rewardData.reward_per_token_stored_u12, // Match the current stored value
          unclaimed_rewards: 0n,
          total_claimed: 0n,
        });
      }

      // Update reward balances
      const claim_amount = event.data_decoded.reward_amount;
      rewardData.reward_balance -= claim_amount;
      userRewardData.total_claimed += claim_amount;
      userRewardData.unclaimed_rewards = 0n; // Reset unclaimed amount after claiming

      // Update pool stats
      pool.claim_count += 1;

      const user = await getOrCreateUser(userAddress, store, timestamp);

      // Create event entity
      const claimEvent = new MRRewardClaimedEvent({
        id: `${pool.id}-${userAddress}-${event.data_decoded.reward_token}-${module.claim_count}`,
        poolID: pool.id,
        userID: user.id,
        transaction_version: BigInt(ctx.version),
        reward_token: event.data_decoded.reward_token,
        claim_amount,
        timestamp,
      });

      // Persist all updates
      await store.upsert(rewardData);
      await store.upsert(userRewardData);
      await store.upsert(pool);
      await store.upsert(claimEvent);
    })
    .onEventStakeEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestampMicros = ctx.getTimestamp();
      const timestamp = getTimestampInSeconds(timestampMicros);
      const userAddress = event.data_decoded.user;
      const stakeAmount = event.data_decoded.amount;
      const staking_token = event.data_decoded.staking_token;

      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "stake_count");

      // Get or create user
      const user = await getOrCreateUser(userAddress, store, timestamp);

      // Get or create user staked balance
      const userStakedBalance = await getOrCreateUserStakedBalance(userAddress, staking_token, store, timestamp);

      // Get subscriptions by user first
      const userSubscriptions = await store.list(MRUserSubscription, [
        { field: "user_address", op: "=", value: userAddress },
      ]);

      // Then filter for active ones in JavaScript
      const activeSubscriptions = userSubscriptions.filter(
        (subscription) => subscription.is_currently_subscribed === true,
      );

      // Update rewards and total staked for each subscribed pool
      for (const subscription of activeSubscriptions) {
        // TODO: the following validation is only to confirm if the live processor has the same issue
        // as the local/test processor wrt filters: https://github.com/sentioxyz/sentio-sdk/issues/1099
        // these checks effectively serve as invariants
        if (subscription.userID.toString() !== userAddress) {
          throw new Error("filter not working for user_address");
        }

        if (!subscription.is_currently_subscribed) {
          throw new Error("filter not working for is_currently_subscribed");
        }

        const pool = await getStakingPool(subscription.pool_address, store);
        if (!pool) continue;

        // Only update pools for matching staking token
        if (pool.staking_token === event.data_decoded.staking_token) {
          // Update rewards before changing stake
          await updateRewards(pool, userAddress, timestamp, store);

          // Update total subscribed with ONLY the newly staked amount
          pool.total_subscribed += stakeAmount;
          await store.upsert(pool);
        }
      }

      // Update user's staked balance
      userStakedBalance.amount += stakeAmount;

      const stakeEventId = `${userAddress}-${staking_token}-${module.stake_count}`;

      // Create stake event
      const stakeEvent = new MRStakeEvent({
        id: stakeEventId,
        userID: userAddress,
        // user: Promise.resolve(user),
        transaction_version: BigInt(ctx.version),
        staking_token,
        amount: stakeAmount,
        timestamp,
      });

      // Persist updates
      await store.upsert(user);
      await store.upsert(userStakedBalance);
      await store.upsert(stakeEvent);
    })
    .onEventWithdrawEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());
      const userAddress = event.data_decoded.user;
      const withdrawAmount = event.data_decoded.amount;
      const staking_token = event.data_decoded.staking_token;

      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "withdrawal_count");

      // Get subscriptions by user first
      const userSubscriptions = await store.list(MRUserSubscription, [
        { field: "user_address", op: "=", value: userAddress },
      ]);

      // Then filter for active ones in JavaScript
      const activeSubscriptions = userSubscriptions.filter(
        (subscription) => subscription.is_currently_subscribed === true,
      );

      // First update rewards for all affected pools
      for (const subscription of activeSubscriptions) {
        // TODO: the following validation is only to confirm if the live processor has the same issue
        // as the local/test processor wrt filters: https://github.com/sentioxyz/sentio-sdk/issues/1099
        // these checks effectively serve as invariants
        if (subscription.userID.toString() !== userAddress) {
          throw new Error("filter not working for user_address");
        }

        if (!subscription.is_currently_subscribed) {
          throw new Error("filter not working for is_currently_subscribed");
        }

        const pool = await getStakingPool(subscription.pool_address, store);
        if (!pool) continue;

        // Only update pools for matching staking token
        if (pool.staking_token === event.data_decoded.staking_token) {
          // Update rewards before reducing stake
          await updateRewards(pool, userAddress, timestamp, store);
        }
      }

      // Get user and their staked balance
      const userStakedBalance = await getUserStakedBalance(userAddress, staking_token, store);
      if (!userStakedBalance) throw new Error("User staked balance not found");
      const user = await getOrCreateUser(userAddress, store, timestamp);

      // Update user's staked balance
      userStakedBalance.amount -= withdrawAmount;

      // Now update total_subscribed for all affected pools
      for (const subscription of activeSubscriptions) {
        const pool = await getStakingPool(subscription.pool_address, store);
        if (!pool) continue;

        // Only update pools with matching staking token
        if (pool.staking_token === event.data_decoded.staking_token) {
          pool.total_subscribed -= withdrawAmount;
          pool.withdrawal_count += 1; // Analytics only
          await store.upsert(pool);
        }
      }

      // Create withdraw event
      const withdrawEvent = new MRWithdrawEvent({
        id: `${userAddress}-${staking_token}-${module.withdrawal_count}`,
        userID: user.id,
        transaction_version: BigInt(ctx.version),
        staking_token,
        amount: withdrawAmount,
        timestamp,
      });

      // Persist updates
      await store.upsert(user);
      await store.upsert(userStakedBalance);
      await store.upsert(withdrawEvent);
    })
    .onEventSubscriptionEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());
      const userAddress = event.data_decoded.user;
      const poolAddress = event.data_decoded.pool_address;
      const staking_token = event.data_decoded.staking_token;

      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "subscription_count");

      // Get pool and verify it exists
      const pool = await getStakingPool(poolAddress, store);
      if (!pool) {
        throw new Error("Pool not found");
      }

      // Get user staked balance
      const userStakedBalance = await getUserStakedBalance(userAddress, staking_token, store);
      if (!userStakedBalance || userStakedBalance.amount === 0n) {
        throw new Error("User has no staked balance");
      }

      // Get or create user
      const user = await getOrCreateUser(userAddress, store, timestamp);

      // Check if the user has had a previous subscription to this pool
      const existingSubscription = await store.get(MRUserSubscription, `${userAddress}-${poolAddress}`);
      let subscription;

      if (!existingSubscription) {
        // Create new subscription if one doesn't already exist,
        // but mark it as NOT subscribed yet (until after updateRewards)
        subscription = new MRUserSubscription({
          id: `${userAddress}-${poolAddress}`,
          poolID: pool.id,
          userID: user.id,
          user_address: userAddress,
          pool_address: poolAddress,
          staked_balanceID: userStakedBalance.id,
          is_currently_subscribed: false, // Initially false
          subscribed_at: timestamp,
        });
      } else {
        // Use existing subscription but don't change subscription status yet
        subscription = existingSubscription;
      }

      // Save the subscription entity with is_currently_subscribed still false
      await store.upsert(subscription);

      // Call updateRewards when user is still NOT marked as subscribed
      // This ensures earned_amount calculations will be 0
      await updateRewards(pool, userAddress, timestamp, store);

      // Update pool stats too
      if (!existingSubscription || (existingSubscription && !existingSubscription.is_currently_subscribed)) {
        pool.subscriber_count += 1;
        pool.total_subscribed += userStakedBalance.amount;
      }

      // Now update the subscription status and pool stats AFTER updateRewards
      subscription.is_currently_subscribed = true;

      // Save the updated entities
      await store.upsert(subscription);
      await store.upsert(pool);

      // Create subscription event
      const subscriptionEvent = new MRSubscriptionEvent({
        id: `${userAddress}-${poolAddress}-${module.subscription_count}`,
        poolID: pool.id,
        userID: user.id,
        transaction_version: BigInt(ctx.version),
        staking_token,
        timestamp,
      });

      // Persist the subscription event
      await store.upsert(subscriptionEvent);
    })
    .onEventUnsubscriptionEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());
      const userAddress = event.data_decoded.user;
      const poolAddress = event.data_decoded.pool_address;
      const staking_token = event.data_decoded.staking_token;

      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "unsubscription_count");

      // Get pool and verify it exists
      const pool = await getStakingPool(poolAddress, store);
      if (!pool) {
        throw new Error("Pool not found");
      }

      // Get user
      const user = await getOrCreateUser(userAddress, store, timestamp);

      // Get subscription and verify it exists
      const subscription = await store.get(MRUserSubscription, `${userAddress}-${poolAddress}`);
      if (!subscription || !subscription.is_currently_subscribed) {
        throw new Error("Not subscribed");
      }

      // Update rewards before unsubscribing
      await updateRewards(pool, userAddress, timestamp, store);

      // Get user staked balance
      const userStakedBalance = await getUserStakedBalance(userAddress, staking_token, store);
      if (!userStakedBalance) {
        throw new Error("User staked balance not found");
      }

      // Update subscription status
      subscription.is_currently_subscribed = false;

      // Update pool stats
      pool.subscriber_count -= 1;
      pool.total_subscribed -= userStakedBalance.amount;

      // Remove user reward data entries
      for (const reward_token of pool.reward_tokens) {
        const userRewardDataId = `${userAddress}-${poolAddress}-${reward_token}`;
        const userRewardData = await store.get(MRUserRewardData, userRewardDataId);
        if (userRewardData) {
          await store.delete(MRUserRewardData, userRewardDataId);
        }
      }

      // Create unsubscribe event
      const unsubscriptionEvent = new MRUnsubscriptionEvent({
        id: `${userAddress}-${poolAddress}-${module.unsubscription_count}`,
        poolID: pool.id,
        userID: user.id,
        transaction_version: BigInt(ctx.version),
        staking_token,
        timestamp,
      });

      // Persist updates
      await store.upsert(subscription);
      await store.upsert(pool);
      await store.upsert(unsubscriptionEvent);
    })
    .onEventEmergencyWithdrawEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());
      const userAddress = event.data_decoded.user;
      const stakingToken = event.data_decoded.staking_token;
      const withdrawAmount = BigInt(event.data_decoded.amount);

      // Get module for stats tracking
      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "emergency_withdraw_count");

      // Get user's staked balance (ensure it exists)
      const userStakedBalance = await getUserStakedBalance(userAddress, stakingToken, store);
      if (!userStakedBalance) {
        throw new Error("User staked balance not found");
      }

      // Update user's staked balance to 0
      userStakedBalance.amount = 0n;
      userStakedBalance.last_update_time = timestamp;
      await store.upsert(userStakedBalance);

      // Get all subscribed pools for this staking token
      const userSubscriptions = await store.list(MRUserSubscription, [
        { field: "user_address", op: "=", value: userAddress },
      ]);

      // Filter for subscriptions with matching staking token that are currently active
      for (const subscription of userSubscriptions) {
        // Validate subscription belongs to this user
        if (subscription.userID.toString() !== userAddress) {
          continue;
        }

        // Get the pool for this subscription
        const pool = await getStakingPool(subscription.pool_address, store);
        if (!pool) continue;

        // Only update pools for matching staking token
        if (pool.staking_token !== stakingToken) {
          continue;
        }

        // If the user is subscribed to this pool, update the pool's total_subscribed
        if (subscription.is_currently_subscribed) {
          // Reduce pool's total_subscribed by the withdrawn amount
          pool.total_subscribed -= withdrawAmount;
          await store.upsert(pool);
        }
      }

      // Create emergency withdraw event entity
      const emergencyWithdrawEvent = new MREmergencyWithdrawEvent({
        id: `${userAddress}-${stakingToken}-${module.emergency_withdraw_count}`,
        userID: userAddress,
        transaction_version: BigInt(ctx.version),
        staking_token: stakingToken,
        amount: withdrawAmount,
        timestamp,
      });

      // Persist the event
      await store.upsert(emergencyWithdrawEvent);
    });
}

// - - - Helper Functions - - -

// AptosContext getTimestamp() returns the transaction timestamp in micro seconds
export function getTimestampInSeconds(timestamp_micros: number | bigint): bigint {
  return BigInt(timestamp_micros) / 1_000_000n;
}

async function getOrCreateModule(store: Store): Promise<MRModule> {
  // TODO: lower priority; use an incrementor for ID
  let module = await store.get(MRModule, "1"); // Assuming single module instance
  if (!module) {
    module = new MRModule({
      id: "1",
      pool_count: 0,
      reward_count: 0,
      notify_count: 0,
      update_duration_count: 0,
      claim_count: 0,
      subscription_count: 0,
      unsubscription_count: 0,
      stake_count: 0,
      withdrawal_count: 0,
      emergency_withdraw_count: 0,
      user_count: 0,
      last_update_time: 0n,
    });

    await store.upsert(module);
  }
  return module;
}

async function getStakingPool(poolAddress: string, store: Store): Promise<MRStakingPool | undefined> {
  return await store.get(MRStakingPool, poolAddress.toLowerCase());
}

async function getRewardData(
  poolId: string,
  reward_token: string,
  store: Store,
): Promise<MRPoolRewardData | undefined> {
  return await store.get(MRPoolRewardData, `${poolId}-${reward_token}`);
}

async function incrementModuleStats(
  module: MRModule,
  store: Store,
  last_update_time: bigint,
  stat:
    | "claim_count"
    | "notify_count"
    | "pool_count"
    | "reward_count"
    | "stake_count"
    | "subscription_count"
    | "user_count"
    | "update_duration_count"
    | "unsubscription_count"
    | "withdrawal_count"
    | "emergency_withdraw_count",
) {
  switch (stat) {
    case "claim_count":
      module.claim_count++;
      break;
    case "notify_count":
      module.notify_count++;
      break;
    case "pool_count":
      module.pool_count++;
      break;
    case "reward_count":
      module.reward_count++;
      break;
    case "stake_count":
      module.stake_count++;
      break;
    case "subscription_count":
      module.subscription_count++;
      break;
    case "user_count":
      module.user_count++;
      break;
    case "update_duration_count":
      module.update_duration_count++;
      break;
    case "unsubscription_count":
      module.unsubscription_count++;
      break;
    case "withdrawal_count":
      module.withdrawal_count++;
      break;
    case "emergency_withdraw_count":
      module.emergency_withdraw_count++;
      break;
  }
  module.last_update_time = last_update_time;
  await store.upsert(module);
}

/**
 * Updates reward state for a staking pool and optionally a specific user
 * @param pool Staking pool to update rewards for
 * @param userAddress User address to update rewards for (use "0x0" for global updates)
 * @param timestamp Current timestamp in seconds
 * @param store Data store instance
 */
async function updateRewards(pool: MRStakingPool, userAddress: string, timestamp: bigint, store: Store): Promise<void> {
  // Process each reward token in the pool
  for (const reward_token of pool.reward_tokens) {
    const rewardData = await getRewardData(pool.id.toString(), reward_token, store);
    if (!rewardData) continue;

    // Calculate new reward per token
    const newRewardPerToken = calculateRewardPerToken(pool.total_subscribed, rewardData, timestamp);

    // Get last applicable reward time
    const lastTimeRewardApplicable = timestamp > rewardData.period_finish ? rewardData.period_finish : timestamp;

    // Calculate time delta since last update
    const timeDelta = lastTimeRewardApplicable - rewardData.last_update_time;

    // Handle zero stake period
    if (pool.total_subscribed === 0n && timeDelta !== 0n) {
      // Accumulate unallocated rewards
      rewardData.unallocated_rewards += (timeDelta * rewardData.reward_rate_u12) / U12_PRECISION;
    }

    // Update reward data state
    rewardData.reward_per_token_stored_u12 = newRewardPerToken;
    rewardData.last_update_time = lastTimeRewardApplicable;
    await store.upsert(rewardData);

    // Update user specific data if this isn't a global update
    if (userAddress !== "0x0") {
      // Check if user is subscribed to this pool
      const subscription = await getUserSubscription(userAddress, pool.id.toString(), store);
      if (!subscription) continue;

      // Get or create user reward data
      const userRewardDataId = `${userAddress}-${pool.id}-${reward_token}`;
      let userData = await store.get(MRUserRewardData, userRewardDataId);

      if (!userData) {
        // Initialize new user reward data with zero values
        userData = new MRUserRewardData({
          id: userRewardDataId,
          subscriptionID: subscription.id,
          reward_token,
          reward_per_token_paid_u12: newRewardPerToken,
          unclaimed_rewards: 0n,
          total_claimed: 0n,
        });
      }

      // Get user's staked balance
      const userBalance = await getUserStakedBalance(userAddress, pool.staking_token, store);
      if (!userBalance) continue;

      // Calculate earned rewards - considering subscription status
      let earnedAmount;
      if (subscription.is_currently_subscribed) {
        // If subscribed, use full balance for calculation
        earnedAmount = (userBalance.amount * (newRewardPerToken - userData.reward_per_token_paid_u12)) / U12_PRECISION;
      } else {
        // If not subscribed, treat as having 0 balance (this path should not occur in our fixed implementation,
        // but included for completeness and to match the Move implementation logic)
        earnedAmount = 0n;
      }

      userData.unclaimed_rewards += earnedAmount;
      userData.reward_per_token_paid_u12 = newRewardPerToken;

      await store.upsert(userData);
    }
  }
}

/**
 * Calculates the current reward per token
 */
function calculateRewardPerToken(total_subscribed: bigint, rewardData: MRPoolRewardData, timestamp: bigint): bigint {
  if (total_subscribed === 0n) {
    return rewardData.reward_per_token_stored_u12;
  }

  const lastTimeRewardApplicable = timestamp > rewardData.period_finish ? rewardData.period_finish : timestamp;

  const timeElapsed = lastTimeRewardApplicable - rewardData.last_update_time;
  const extraRewardPerToken = (timeElapsed * rewardData.reward_rate_u12) / total_subscribed;

  return rewardData.reward_per_token_stored_u12 + extraRewardPerToken;
}

/**
 * Gets a user's subscription to a pool
 */
async function getUserSubscription(
  userAddress: string,
  poolId: string,
  store: Store,
): Promise<MRUserSubscription | undefined> {
  return await store.get(MRUserSubscription, `${userAddress}-${poolId}`);
}

/**
 * Gets a user's staked balance for a token
 */
async function getUserStakedBalance(
  userAddress: string,
  staking_token: string,
  store: Store,
): Promise<MRUserStakedBalance | undefined> {
  return await store.get(MRUserStakedBalance, `${userAddress}-${staking_token}`);
}

/**
 * Gets or creates a user entity
 * @param userAddress The address of the user
 * @param store Data store instance
 * @returns Promise resolving to the user entity
 */
async function getOrCreateUser(userAddress: string, store: Store, last_update_time: bigint): Promise<MRUser> {
  let user = await store.get(MRUser, userAddress);

  if (!user) {
    user = new MRUser({
      id: userAddress,
      created_at: BigInt(Date.now()) / 1000n,
    });
    await store.upsert(user);

    // Update global module stats for new user
    const module = await getOrCreateModule(store);
    await incrementModuleStats(module, store, last_update_time, "user_count");
  }

  return user;
}

/**
 * Gets or creates user staked balance entity
 */
async function getOrCreateUserStakedBalance(
  userAddress: string,
  staking_token: string,
  store: Store,
  last_update_time: bigint,
): Promise<MRUserStakedBalance> {
  const id = `${userAddress}-${staking_token}`;
  let balance = await store.get(MRUserStakedBalance, id);

  if (!balance) {
    const user = await getOrCreateUser(userAddress, store, last_update_time);

    balance = new MRUserStakedBalance({
      id,
      userID: user.id,
      staking_token,
      amount: 0n,
      last_update_time: 0n,
    });
    await store.upsert(balance);

    // UPDATE: Instead of using the relationship method directly,
    // manually update the staked_balancesIDs array
    await store.upsert(user);
  }

  return balance;
}

// - - - TEST ONLY HELPERS - - -

function getStore(chain_id: SupportedAptosChainId, ctx: AptosContext): Store {
  return ctx.store;
}

export class MultiRewardsTestReader {
  constructor(private store: Store) {}

  async getModule(): Promise<MRModule | undefined> {
    return this.store.get(MRModule, "1");
  }

  // Pool related getters

  async getStakingPool(poolAddress: string): Promise<MRStakingPool | undefined> {
    return getStakingPool(poolAddress, this.store);
  }

  async getPoolRewardData(poolId: string, rewardToken: string): Promise<MRPoolRewardData | undefined> {
    return getRewardData(poolId, rewardToken, this.store);
  }

  // User related getters

  async getUser(userAddress: string): Promise<MRUser | undefined> {
    return this.store.get(MRUser, userAddress);
  }

  async getUserSubscription(userAddress: string, poolId: string): Promise<MRUserSubscription | undefined> {
    return getUserSubscription(userAddress, poolId, this.store);
  }

  async getUserStakedBalance(userAddress: string, stakingToken: string): Promise<MRUserStakedBalance | undefined> {
    return getUserStakedBalance(userAddress, stakingToken, this.store);
  }

  async getUserRewardData(
    userAddress: string,
    poolAddress: string,
    rewardToken: string,
  ): Promise<MRUserRewardData | undefined> {
    const userRewardDataId = `${userAddress}-${poolAddress}-${rewardToken}`;
    return this.store.get(MRUserRewardData, userRewardDataId);
  }

  // Event getters

  async getStakeEvent(user: string, stakingToken: string, stakeCount: number): Promise<MRStakeEvent | undefined> {
    const stakeEventId = `${user}-${stakingToken}-${stakeCount}`;
    return this.store.get(MRStakeEvent, stakeEventId);
  }

  async getSubscriptionEvent(
    user: string,
    poolAddress: string,
    subscriptionCount: number,
  ): Promise<MRSubscriptionEvent | undefined> {
    const subscriptionEventId = `${user}-${poolAddress}-${subscriptionCount}`;
    return this.store.get(MRSubscriptionEvent, subscriptionEventId);
  }

  async getUnsubscriptionEvent(
    user: string,
    poolAddress: string,
    unsubscriptionCount: number,
  ): Promise<MRUnsubscriptionEvent | undefined> {
    const unsubscriptionEventId = `${user}-${poolAddress}-${unsubscriptionCount}`;
    return this.store.get(MRUnsubscriptionEvent, unsubscriptionEventId);
  }

  // Count getters

  async getStakeCount(): Promise<number> {
    const module = await this.getModule();
    return module?.stake_count ?? 0;
  }

  // Add any other getters that may be required for tests
}
