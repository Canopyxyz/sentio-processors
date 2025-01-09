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
  SubscriptionEvent,
  MRUnsubscriptionEvent,
} from "../schema/schema.rewards.js";

import { multi_rewards as multi_rewards_movement } from "../types/aptos/movement-porto/multi-rewards-movement.js";
import { multi_rewards as multi_rewards_testnet } from "../types/aptos/testnet/multi-rewards-testnet.js";

import { SupportedAptosChainId } from "../chains.js";

import { createStore, resetDb } from "../tests/utils/store.js";

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
        module: Promise.resolve(module),
        creation_tx_version: BigInt(ctx.version),
        creator: event.data_decoded.creator,
        staking_token: event.data_decoded.staking_token.inner,
        reward_tokens: [],
        reward_datas: Promise.resolve([]),
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
      if (pool.reward_tokens.includes(event.data_decoded.reward_token.inner)) {
        throw new Error("Reward token already exists");
      }

      // Create reward data
      const rewardData = new MRPoolRewardData({
        id: `${pool.id}-${event.data_decoded.reward_token.inner}`,
        pool_address: pool.id.toString(),
        pool: Promise.resolve(pool),
        reward_token: event.data_decoded.reward_token.inner,
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
      pool.reward_tokens = [...pool.reward_tokens, event.data_decoded.reward_token.inner];

      await store.upsert(rewardData);
      await store.upsert(pool);

      // Create event entity
      const addedEvent = new MRRewardAddedEvent({
        id: `${pool.id}-${event.data_decoded.reward_token.inner}-${module.reward_count}`,
        pool: Promise.resolve(pool),
        transaction_version: BigInt(ctx.version),
        reward_token: event.data_decoded.reward_token.inner,
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

      const rewardData = await getRewardData(pool.id.toString(), event.data_decoded.reward_token.inner, store);
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
        id: `${pool.id}-${event.data_decoded.reward_token.inner}-${module.notify_count}`,
        pool: Promise.resolve(pool),
        transaction_version: BigInt(ctx.version),
        reward_token: event.data_decoded.reward_token.inner,
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

      const rewardData = await getRewardData(pool.id.toString(), event.data_decoded.reward_token.inner, store);
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
        id: `${pool.id}-${event.data_decoded.reward_token.inner}-${module.update_duration_count}`,
        pool: Promise.resolve(pool),
        transaction_version: BigInt(ctx.version),
        reward_token: event.data_decoded.reward_token.inner,
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
      const rewardData = await getRewardData(pool.id.toString(), event.data_decoded.reward_token.inner, store);
      if (!rewardData) throw new Error("Reward data not found");

      // Get or create user reward data
      const userRewardDataId = `${userAddress}-${pool.id}-${event.data_decoded.reward_token.inner}`;
      let userRewardData = await store.get(MRUserRewardData, userRewardDataId);

      if (!userRewardData) {
        // Get subscription - must exist since rewards can only be claimed while subscribed
        const subscription = await getUserSubscription(userAddress, pool.id.toString(), store);
        if (!subscription) throw new Error("Subscription not found");

        userRewardData = new MRUserRewardData({
          id: userRewardDataId,
          subscription: Promise.resolve(subscription),
          reward_token: event.data_decoded.reward_token.inner,
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

      // Create event entity
      const claimEvent = new MRRewardClaimedEvent({
        id: `${pool.id}-${userAddress}-${event.data_decoded.reward_token.inner}-${module.claim_count}`,
        pool: Promise.resolve(pool),
        user: Promise.resolve(await getOrCreateUser(userAddress, store, timestamp)),
        transaction_version: BigInt(ctx.version),
        reward_token: event.data_decoded.reward_token.inner,
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
      console.log("In StakeEvent 1");
      const store = getStore(supportedChainId, ctx);
      const timestampMicros = ctx.getTimestamp();
      const timestamp = getTimestampInSeconds(timestampMicros);
      const userAddress = event.data_decoded.user;
      const stakeAmount = event.data_decoded.amount;
      const staking_token = event.data_decoded.staking_token.inner;

      console.log("In StakeEvent 2");

      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "stake_count");

      console.log("In StakeEvent 3");

      // Get or create user
      const user = await getOrCreateUser(userAddress, store, timestamp);

      console.log("In StakeEvent 4");

      // Get or create user staked balance
      const userStakedBalance = await getOrCreateUserStakedBalance(userAddress, staking_token, store, timestamp);

      console.log("In StakeEvent 5");

      // Get all active subscriptions for this user using list
      const activeSubscriptions = await store.list(MRUserSubscription, [
        { field: "user_address", op: "=", value: userAddress },
        { field: "is_currently_subscribed", op: "=", value: true },
      ]);

      console.log(`In StakeEvent 6; ${activeSubscriptions.length}`);

      // Update rewards and total staked for each subscribed pool
      for (const subscription of activeSubscriptions) {
        const pool = await getStakingPool(subscription.pool_address, store);
        if (!pool) continue;

        // Only update pools for matching staking token
        if (pool.staking_token === event.data_decoded.staking_token.inner) {
          // Update rewards before changing stake
          await updateRewards(pool, userAddress, timestamp, store);

          // Update total subscribed
          pool.total_subscribed += stakeAmount;
          await store.upsert(pool);
        }
      }

      console.log("In StakeEvent 7");

      // Update user's staked balance
      userStakedBalance.amount += stakeAmount;

      // Create stake event
      const stakeEvent = new MRStakeEvent({
        id: `${userAddress}-${staking_token}-${module.stake_count}`,
        userID: userAddress,
        // user: Promise.resolve(user),
        transaction_version: BigInt(ctx.version),
        staking_token,
        amount: stakeAmount,
        timestamp,
      });

      console.log("In StakeEvent 8");

      // Persist updates
      await store.upsert(user);

      console.log("In StakeEvent 8.1");

      await store.upsert(userStakedBalance);

      console.log("In StakeEvent 8.2");
      await store.upsert(stakeEvent);

      console.log("In StakeEvent 9");

      const fetchedUserStakedBalance = await getUserStakedBalance(userAddress, staking_token, store);
      /* eslint-disable */
      console.log(
        `StakeEvent: timestamp: ${timestampMicros}; userAddress: ${userAddress}: staking_token: ${staking_token}; fetchedUserStakedBalance: ${!!fetchedUserStakedBalance}`,
      );
      /* eslint-enable */
    })
    .onEventWithdrawEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());
      const userAddress = event.data_decoded.user;
      const withdrawAmount = event.data_decoded.amount;
      const staking_token = event.data_decoded.staking_token.inner;

      const module = await getOrCreateModule(store);
      await incrementModuleStats(module, store, timestamp, "withdrawal_count");

      // Get active subscriptions for this user and staking token
      const activeSubscriptions = await store.list(MRUserSubscription, [
        { field: "user_address", op: "=", value: userAddress },
        { field: "is_currently_subscribed", op: "=", value: true },
      ]);

      // First update rewards for all affected pools
      for (const subscription of activeSubscriptions) {
        const pool = await getStakingPool(subscription.pool_address, store);
        if (!pool) continue;

        // Only update pools for matching staking token
        if (pool.staking_token === event.data_decoded.staking_token.inner) {
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

        pool.total_subscribed -= withdrawAmount;
        pool.withdrawal_count += 1; // Analytics only
        await store.upsert(pool);
      }

      // Create withdraw event
      const withdrawEvent = new MRWithdrawEvent({
        id: `${userAddress}-${staking_token}-${module.withdrawal_count}`,
        user: Promise.resolve(user),
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
      console.log("In SubscriptionEvent");
      const store = getStore(supportedChainId, ctx);
      const timestampMicros = ctx.getTimestamp();
      const timestamp = getTimestampInSeconds(timestampMicros);
      const userAddress = event.data_decoded.user;
      const poolAddress = event.data_decoded.pool_address;
      const staking_token = event.data_decoded.staking_token.inner;

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
        /* eslint-disable */
        console.log(
          `SubscriptionEvent: timestamp: ${timestampMicros}; userAddress: ${userAddress}: staking_token: ${staking_token}; userStakedBalance: ${!!userStakedBalance}`,
        );
        /* eslint-enable */
        throw new Error("User has no staked balance");
      }

      // Get or create user
      const user = await getOrCreateUser(userAddress, store, timestamp);

      // Update rewards before modifying subscription state
      await updateRewards(pool, userAddress, timestamp, store);

      // Create new subscription
      const subscription = new MRUserSubscription({
        id: `${userAddress}-${poolAddress}`,
        pool: Promise.resolve(pool),
        user: Promise.resolve(user),
        user_address: userAddress,
        pool_address: poolAddress,
        staked_balance: Promise.resolve(userStakedBalance),
        user_reward_datas: Promise.resolve([]),
        is_currently_subscribed: true,
        subscribed_at: timestamp,
      });

      // Update pool stats
      pool.subscriber_count += 1;
      pool.total_subscribed += userStakedBalance.amount;

      // Create subscription event
      const subscriptionEvent = new SubscriptionEvent({
        id: `${userAddress}-${poolAddress}-${module.subscription_count}`,
        pool: Promise.resolve(pool),
        user: Promise.resolve(user),
        transaction_version: BigInt(ctx.version),
        staking_token,
        timestamp,
      });

      // Persist all updates
      await store.upsert(subscription);
      await store.upsert(pool);
      await store.upsert(subscriptionEvent);

      // Update global module stats
    })
    .onEventUnsubscriptionEvent(async (event, ctx) => {
      const store = getStore(supportedChainId, ctx);
      const timestamp = getTimestampInSeconds(ctx.getTimestamp());
      const userAddress = event.data_decoded.user;
      const poolAddress = event.data_decoded.pool_address;
      const staking_token = event.data_decoded.staking_token.inner;

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
        pool: Promise.resolve(pool),
        user: Promise.resolve(user),
        transaction_version: BigInt(ctx.version),
        staking_token,
        timestamp,
      });

      // Persist updates
      await store.upsert(subscription);
      await store.upsert(pool);
      await store.upsert(unsubscriptionEvent);
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
    | "withdrawal_count",
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
      if (!subscription || !subscription.is_currently_subscribed) continue;

      // Get or create user reward data
      const userRewardDataId = `${userAddress}-${pool.id}-${reward_token}`;
      let userData = await store.get(MRUserRewardData, userRewardDataId);

      if (!userData) {
        // Initialize new user reward data with zero values
        userData = new MRUserRewardData({
          id: userRewardDataId,
          subscription: Promise.resolve(subscription),
          reward_token,
          reward_per_token_paid_u12: 0n,
          unclaimed_rewards: 0n,
          total_claimed: 0n,
        });
      }

      // Get user's staked balance
      const userBalance = await getUserStakedBalance(userAddress, pool.staking_token, store);
      if (!userBalance) continue;

      // Calculate earned rewards
      const earnedAmount =
        (userBalance.amount * (newRewardPerToken - userData.reward_per_token_paid_u12)) / U12_PRECISION;
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
      staked_balances: Promise.resolve([]),
      subscriptions: Promise.resolve([]),
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
      user: Promise.resolve(user),
      staking_token,
      amount: 0n,
      subscriptions: Promise.resolve([]),
      last_update_time: 0n,
    });
    await store.upsert(balance);

    // Update user's staked balances list
    const staked_balances = await user.staked_balances;
    staked_balances.push(balance);
    user.staked_balances = Promise.resolve(staked_balances);
    await store.upsert(user);
  }

  return balance;
}

// - - - TEST ONLY HELPERS - - -

let test_store = createStore(); // Only for use in tests

function getStore(chain_id: SupportedAptosChainId, ctx: AptosContext): Store {
  if (chain_id === SupportedAptosChainId.JESTNET || ctx.store === undefined) {
    return test_store;
  }
  return ctx.store;
}

export function resetTestDb() {
  test_store = resetDb();
}

export class MultiRewardsTestReader {
  async getModule(): Promise<MRModule | undefined> {
    return test_store.get(MRModule, "1");
  }

  // Pool related getters

  async getStakingPool(poolAddress: string): Promise<MRStakingPool | undefined> {
    return getStakingPool(poolAddress, test_store);
  }

  async getPoolRewardData(poolId: string, rewardToken: string): Promise<MRPoolRewardData | undefined> {
    return getRewardData(poolId, rewardToken, test_store);
  }

  // User related getters

  async getUser(userAddress: string): Promise<MRUser | undefined> {
    return test_store.get(MRUser, userAddress);
  }

  async getUserSubscription(userAddress: string, poolId: string): Promise<MRUserSubscription | undefined> {
    return getUserSubscription(userAddress, poolId, test_store);
  }

  async getUserStakedBalance(userAddress: string, stakingToken: string): Promise<MRUserStakedBalance | undefined> {
    return getUserStakedBalance(userAddress, stakingToken, test_store);
  }

  // Event getters

  async getStakeEvent(user: string, stakingToken: string, stakeCount: number): Promise<MRStakeEvent | undefined> {
    return test_store.get(MRStakeEvent, `${user}-${stakingToken}-${stakeCount}`);
  }

  // Count getters

  async getStakeCount(): Promise<number> {
    const module = await this.getModule();
    return module?.stake_count ?? 0;
  }

  // Add any other getters that may be required for tests
}
