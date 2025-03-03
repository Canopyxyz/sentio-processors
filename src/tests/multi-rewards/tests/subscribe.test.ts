/* eslint-disable */
import assert from "assert";
import { before, afterEach, describe, test } from "node:test";
import { TestProcessorServer } from "@sentio/sdk/testing";

import { MultiRewardsTestReader } from "../../../processors/multi-rewards-processor.js";
import { multi_rewards_abi } from "../../../abis/multi_rewards.js";
import { TestProcessor } from "../../utils/processor.js";
import { multiRewardsHandlerIds } from "../common/constants.js";
import { generateRandomAddress, secondsToMicros } from "../../common/helpers.js";
import {
  verifyStakeEvent,
  verifyUserState,
  verifyPoolState,
  verifyRewardState,
  verifyClaimEvents,
  verifyUserRewardData,
  verifySubscriptionEvent,
} from "../common/helpers.js";
import { assertApproxEqualBigInt } from "../../common/assertions.js";

describe("Subscribe", async () => {
  const service = new TestProcessorServer(() => import("../multi-rewards-processor.js"));
  const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);

  const INITIAL_BALANCE = 1_000_000n;
  const STAKE_AMOUNT = 100_000n;
  const UNSTAKE_AMOUNT = 50_000n;
  const RESTAKE_AMOUNT = 75_000n;
  const MIN_STAKE_AMOUNT = 1_000n;
  const REWARD_AMOUNT = 1_000_000n;
  const REWARD_DURATION = 100n; // 100 seconds for simplicity
  const U12_PRECISION = 1_000_000_000_000n; // 1e12

  const STAKE_AMOUNT_1 = 100_000n;
  const STAKE_AMOUNT_2 = 50_000n;

  before(async () => {
    await service.start();
  });

  afterEach(async () => {
    service.db.reset();
  });

  test("Successful subscription", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify pool state after creation
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [],
    });

    // User stakes
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify user's staked balance after staking
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
    });

    // Verify stake event was processed
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: STAKE_AMOUNT,
      timestamp: secondsToMicros(startTime),
      stake_count: 1,
    });

    // Verify pre-subscription state
    const preSubscriptionPools = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      !preSubscriptionPools || !preSubscriptionPools.is_currently_subscribed,
      "User should not be subscribed before subscription event",
    );

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Get module to determine subscription count
    const module = await multiRewardsTestReader.getModule();
    assert(module, "Module should exist");
    const subscriptionCount = module.subscription_count;

    // Verify subscription event
    await verifySubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(startTime),
      subscription_count: subscriptionCount,
    });

    // Verify post-subscription state
    const postSubscriptionPool = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(postSubscriptionPool, "Subscription should exist");
    assert(postSubscriptionPool.is_currently_subscribed, "User should be subscribed after subscription event");

    // Verify pool state after subscription
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [],
    });

    // Verify user state after subscription
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });
  });

  test("Subscribe with minimum stake", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test
    const minStakeAmount = MIN_STAKE_AMOUNT; // Using the minimum stake amount from constants

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify pool state after creation
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [],
    });

    // User stakes minimum amount
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: minStakeAmount.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify user's staked balance after staking
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: minStakeAmount,
    });

    // Verify stake event was processed
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: minStakeAmount,
      timestamp: secondsToMicros(startTime),
      stake_count: 1,
    });

    // Verify pre-subscription state
    const preSubscriptionPools = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      !preSubscriptionPools || !preSubscriptionPools.is_currently_subscribed,
      "User should not be subscribed before subscription event",
    );

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Get module to determine subscription count
    const module = await multiRewardsTestReader.getModule();
    assert(module, "Module should exist");
    const subscriptionCount = module.subscription_count;

    // Verify subscription event
    await verifySubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(startTime),
      subscription_count: subscriptionCount,
    });

    // Verify post-subscription state
    const postSubscriptionPool = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(postSubscriptionPool, "Subscription should exist");
    assert(postSubscriptionPool.is_currently_subscribed, "User should be subscribed after subscription event");

    // Verify pool state after subscription - total subscribed should be the minimum stake amount
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: minStakeAmount,
      subscriberCount: 1,
      rewardTokens: [],
    });

    // Verify user state after subscription
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: minStakeAmount,
      subscribedPools: [poolAddress],
    });
  });

  test("Subscribe to multiple pools", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();

    // Create multiple pool addresses
    const poolAddress1 = generateRandomAddress();
    const poolAddress2 = generateRandomAddress();
    const poolAddress3 = generateRandomAddress();
    const poolAddresses = [poolAddress1, poolAddress2, poolAddress3];

    const startTime = 1000; // Base timestamp for the test

    // Create three staking pools
    for (const poolAddress of poolAddresses) {
      await processor.processEvent({
        name: "StakingPoolCreatedEvent",
        data: {
          creator: adminAddress,
          pool_address: poolAddress,
          staking_token: { inner: stakingToken },
        },
        timestamp: secondsToMicros(startTime),
      });

      // Verify pool state after creation
      await verifyPoolState(multiRewardsTestReader, poolAddress, {
        stakingToken,
        creator: adminAddress,
        totalSubscribed: 0n,
        subscriberCount: 0,
        rewardTokens: [],
      });
    }

    // User stakes enough for all pools (3x regular stake amount)
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT * 3n).toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify user's staked balance after staking
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT * 3n,
    });

    // Verify pre-subscription state for all pools
    for (const poolAddress of poolAddresses) {
      const preSubscriptionPool = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
      assert(
        !preSubscriptionPool || !preSubscriptionPool.is_currently_subscribed,
        `User should not be subscribed to pool ${poolAddress} before subscription event`,
      );
    }

    // Subscribe to all pools and verify each subscription
    for (let i = 0; i < poolAddresses.length; i++) {
      const poolAddress = poolAddresses[i];

      await processor.processEvent({
        name: "SubscriptionEvent",
        data: {
          user: userAddress,
          pool_address: poolAddress,
          staking_token: { inner: stakingToken },
        },
        timestamp: secondsToMicros(startTime),
      });

      // Get module to determine subscription count
      const module = await multiRewardsTestReader.getModule();
      assert(module, "Module should exist");
      const subscriptionCount = module.subscription_count;

      // Verify subscription event
      await verifySubscriptionEvent(multiRewardsTestReader, {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: stakingToken,
        timestamp: secondsToMicros(startTime),
        subscription_count: subscriptionCount,
      });

      // Verify post-subscription state for this pool
      const postSubscriptionPool = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
      assert(postSubscriptionPool, `Subscription should exist for pool ${poolAddress}`);
      assert(
        postSubscriptionPool.is_currently_subscribed,
        `User should be subscribed to pool ${poolAddress} after subscription event`,
      );

      // Verify pool state after subscription
      await verifyPoolState(multiRewardsTestReader, poolAddress, {
        stakingToken,
        creator: adminAddress,
        totalSubscribed: STAKE_AMOUNT * 3n, // All pools get the full stake
        subscriberCount: 1,
        rewardTokens: [],
      });
    }

    // Verify user's final state with all subscribed pools
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT * 3n,
      subscribedPools: poolAddresses,
    });

    // Verify the total number of subscriptions matches the expected count
    const module = await multiRewardsTestReader.getModule();
    assert(module, "Module should exist");
    assert.strictEqual(
      module.subscription_count,
      poolAddresses.length,
      "Module subscription count should match the number of subscriptions",
    );
  });

  test("Subscribe with different staking tokens", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();

    // Create different staking token addresses
    const stakingToken1 = generateRandomAddress();
    const stakingToken2 = generateRandomAddress();
    const stakingToken3 = generateRandomAddress();
    const stakingTokens = [stakingToken1, stakingToken2, stakingToken3];

    // Create pool addresses for each staking token
    const poolAddress1 = generateRandomAddress();
    const poolAddress2 = generateRandomAddress();
    const poolAddress3 = generateRandomAddress();
    const poolAddresses = [poolAddress1, poolAddress2, poolAddress3];

    const startTime = 1000; // Base timestamp for the test

    // Create pools with different staking tokens
    for (let i = 0; i < poolAddresses.length; i++) {
      await processor.processEvent({
        name: "StakingPoolCreatedEvent",
        data: {
          creator: adminAddress,
          pool_address: poolAddresses[i],
          staking_token: { inner: stakingTokens[i] },
        },
        timestamp: secondsToMicros(startTime),
      });

      // Verify pool state after creation
      await verifyPoolState(multiRewardsTestReader, poolAddresses[i], {
        stakingToken: stakingTokens[i],
        creator: adminAddress,
        totalSubscribed: 0n,
        subscriberCount: 0,
        rewardTokens: [],
      });
    }

    // User stakes in each token separately
    for (let i = 0; i < stakingTokens.length; i++) {
      await processor.processEvent({
        name: "StakeEvent",
        data: {
          user: userAddress,
          staking_token: { inner: stakingTokens[i] },
          amount: STAKE_AMOUNT.toString(),
        },
        timestamp: secondsToMicros(startTime),
      });

      // Verify user's staked balance for each token
      await verifyUserState(multiRewardsTestReader, userAddress, {
        stakingToken: stakingTokens[i],
        stakedBalance: STAKE_AMOUNT,
      });

      // Verify stake event was processed
      await verifyStakeEvent(multiRewardsTestReader, {
        user: userAddress,
        staking_token: stakingTokens[i],
        amount: STAKE_AMOUNT,
        timestamp: secondsToMicros(startTime),
        stake_count: i + 1, // Stake count increases per token
      });
    }

    // Verify pre-subscription state for all pools
    for (let i = 0; i < poolAddresses.length; i++) {
      const preSubscriptionPool = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddresses[i]);
      assert(
        !preSubscriptionPool || !preSubscriptionPool.is_currently_subscribed,
        `User should not be subscribed to pool ${poolAddresses[i]} before subscription event`,
      );
    }

    // Subscribe to each pool with its corresponding staking token
    for (let i = 0; i < poolAddresses.length; i++) {
      await processor.processEvent({
        name: "SubscriptionEvent",
        data: {
          user: userAddress,
          pool_address: poolAddresses[i],
          staking_token: { inner: stakingTokens[i] },
        },
        timestamp: secondsToMicros(startTime),
      });

      // Get module to determine subscription count
      const module = await multiRewardsTestReader.getModule();
      assert(module, "Module should exist");
      const subscriptionCount = module.subscription_count;

      // Verify subscription event
      await verifySubscriptionEvent(multiRewardsTestReader, {
        user: userAddress,
        pool_address: poolAddresses[i],
        staking_token: stakingTokens[i],
        timestamp: secondsToMicros(startTime),
        subscription_count: subscriptionCount,
      });

      // Verify post-subscription state for this pool
      const postSubscriptionPool = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddresses[i]);
      assert(postSubscriptionPool, `Subscription should exist for pool ${poolAddresses[i]}`);
      assert(
        postSubscriptionPool.is_currently_subscribed,
        `User should be subscribed to pool ${poolAddresses[i]} after subscription event`,
      );

      // Verify pool state after subscription
      await verifyPoolState(multiRewardsTestReader, poolAddresses[i], {
        stakingToken: stakingTokens[i],
        creator: adminAddress,
        totalSubscribed: STAKE_AMOUNT, // Each pool gets its own staked amount
        subscriberCount: 1,
        rewardTokens: [],
      });
    }

    // Verify user's final state for each staking token
    for (let i = 0; i < stakingTokens.length; i++) {
      await verifyUserState(multiRewardsTestReader, userAddress, {
        stakingToken: stakingTokens[i],
        stakedBalance: STAKE_AMOUNT,
        subscribedPools: [poolAddresses[i]], // Each token is associated with one pool
      });
    }

    // Verify the total number of subscriptions matches the expected count
    const module = await multiRewardsTestReader.getModule();
    assert(module, "Module should exist");
    assert.strictEqual(
      module.subscription_count,
      poolAddresses.length,
      "Module subscription count should match the number of subscriptions",
    );
  });

  test("Subscribe after unstake and restake", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Initial subscription
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial subscription state
    const initialSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(initialSubscription, "Initial subscription should exist");
    assert(initialSubscription.is_currently_subscribed, "User should be subscribed after initial subscription");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [],
    });

    // Unsubscribe from the pool
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 1),
    });

    // Verify post-unsubscription state
    const postUnsubscriptionData = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(postUnsubscriptionData, "Subscription entity should still exist after unsubscription");
    assert(!postUnsubscriptionData.is_currently_subscribed, "User should not be subscribed after unsubscription");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n, // Total subscribed goes to 0 after unsubscription
      subscriberCount: 0,
      rewardTokens: [],
    });

    // Unstake some tokens
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: UNSTAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime + 2),
    });

    // Verify staked balance after unstaking
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - UNSTAKE_AMOUNT,
    });

    // Restake with a different amount
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: RESTAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime + 3),
    });

    // Verify staked balance after restaking
    const totalStaked = STAKE_AMOUNT - UNSTAKE_AMOUNT + RESTAKE_AMOUNT;
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: totalStaked,
    });

    // Subscribe again
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 4),
    });

    // Get module to determine subscription count
    const module = await multiRewardsTestReader.getModule();
    assert(module, "Module should exist");
    const subscriptionCount = module.subscription_count;

    // Verify subscription event
    await verifySubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(startTime + 4),
      subscription_count: subscriptionCount,
    });

    // Verify final subscription state
    const finalSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(finalSubscription, "Final subscription should exist");
    assert(finalSubscription.is_currently_subscribed, "User should be subscribed after resubscription");

    // Verify final pool state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: totalStaked,
      subscriberCount: 1,
      rewardTokens: [],
    });

    // Verify final user state
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: totalStaked,
      subscribedPools: [poolAddress],
    });
  });

  test("Subscribe with existing rewards", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const user1Address = generateRandomAddress();
    const user2Address = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // User1 stakes
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT_1.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User1 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add reward token to the pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Calculate expected reward rate
    const expectedRewardRate = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);

    // Notify rewards
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify reward token was added to pool
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT_1,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Verify reward data was set up correctly
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: 0n,
    });

    // Simulate time passage (half of reward duration)
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Check pre-subscription state for User2
    const preSubReward = await multiRewardsTestReader.getUserRewardData(user2Address, poolAddress, rewardToken);
    assert(!preSubReward, "User2 should have no reward data before staking and subscribing");

    // User2 stakes
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT_2.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // User2 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify User2's subscription state
    const user2Subscription = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    assert(user2Subscription, "User2 subscription should exist");
    assert(user2Subscription.is_currently_subscribed, "User2 should be subscribed after subscription event");

    // Calculate reward per token at halfway point
    const halfwayRewardPerToken = (expectedRewardRate * (REWARD_DURATION / 2n)) / STAKE_AMOUNT_1;

    // Verify reward state after User2 subscribes
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT, // No rewards claimed yet
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: halfwayRewardPerToken,
    });

    // Verify User2's initial reward data (should have zero unclaimed rewards upon subscription)
    await verifyUserRewardData(service, user2Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: halfwayRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    // Simulate more time passage (remaining half of reward duration)
    const endTime = startTime + Number(REWARD_DURATION);

    // Calculate expected rewards for the second half of the period
    // For second half, reward rate remains the same but total stake is increased
    const secondHalfRewardPerToken = (expectedRewardRate * (REWARD_DURATION / 2n)) / (STAKE_AMOUNT_1 + STAKE_AMOUNT_2);
    const finalRewardPerToken = halfwayRewardPerToken + secondHalfRewardPerToken;

    // User1 claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: ((REWARD_AMOUNT * 3n) / 4n).toString(), // User1 should get 3/4 of rewards
      },
      timestamp: secondsToMicros(endTime),
    });

    // User2 claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: (REWARD_AMOUNT / 4n).toString(), // User2 should get 1/4 of rewards
      },
      timestamp: secondsToMicros(endTime),
    });

    // Verify reward state after both users claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All rewards claimed
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: finalRewardPerToken,
    });

    // Verify User1's final reward data
    await verifyUserRewardData(service, user1Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: (REWARD_AMOUNT * 3n) / 4n,
    });

    // Verify User2's final reward data
    await verifyUserRewardData(service, user2Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: REWARD_AMOUNT / 4n,
    });

    // Verify claim events
    const user1ClaimEvents = await verifyClaimEvents(service, poolAddress, user1Address, rewardToken, 1);
    const user2ClaimEvents = await verifyClaimEvents(service, poolAddress, user2Address, rewardToken, 1);

    // Check that User1's claim amount is higher than User2's
    assert(
      user1ClaimEvents[0].claim_amount > user2ClaimEvents[0].claim_amount,
      "User1 should have claimed more rewards than User2",
    );

    // Verify that User2's reward is less than half of User1's (since User2 joined halfway)
    assert(
      user2ClaimEvents[0].claim_amount < user1ClaimEvents[0].claim_amount / 2n,
      "User2's reward should be less than half of User1's reward",
    );

    // Verify total claimed rewards add up to the total distributed
    const totalClaimed = user1ClaimEvents[0].claim_amount + user2ClaimEvents[0].claim_amount;
    assert(
      totalClaimed === REWARD_AMOUNT,
      `Total claimed (${totalClaimed}) should equal total reward amount (${REWARD_AMOUNT})`,
    );
  });

  test("Subscribe user reward data initialization", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    // Create reward token addresses
    const rewardToken1 = generateRandomAddress();
    const rewardToken2 = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add multiple reward tokens to the pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken1 },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken2 },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify reward tokens were added to pool
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken1, rewardToken2],
    });

    // Verify pre-subscription state - user reward data should not exist yet
    const preSubRewardData1 = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken1);
    const preSubRewardData2 = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken2);
    assert(!preSubRewardData1, "User reward data for token1 should not exist before subscription");
    assert(!preSubRewardData2, "User reward data for token2 should not exist before subscription");

    // User stakes
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify user's staked balance after staking
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
    });

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify subscription status
    const subscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(subscription, "Subscription should exist");
    assert(subscription.is_currently_subscribed, "User should be subscribed after subscription event");

    // Verify user reward data was initialized for each reward token
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken1, {
      rewardPerTokenPaidU12: 0n,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken2, {
      rewardPerTokenPaidU12: 0n,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    // Verify pool state after subscription
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken1, rewardToken2],
    });

    // Verify user state after subscription
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });
  });

  test("Subscribe with multiple reward tokens", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    // Number of reward tokens to test with
    const numRewardTokens = 3;
    const rewardTokens = Array.from({ length: numRewardTokens }, () => generateRandomAddress());

    const startTime = 1000; // Base timestamp for the test

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add multiple reward tokens to the pool
    for (let i = 0; i < numRewardTokens; i++) {
      await processor.processEvent({
        name: "RewardAddedEvent",
        data: {
          pool_address: poolAddress,
          reward_token: { inner: rewardTokens[i] },
          rewards_distributor: adminAddress,
          rewards_duration: REWARD_DURATION.toString(),
        },
        timestamp: secondsToMicros(startTime),
      });
    }

    // Verify reward tokens were added to pool
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: rewardTokens,
    });

    // User stakes
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify user's staked balance after staking
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
    });

    // Verify pre-subscription state for all reward tokens
    for (const rewardToken of rewardTokens) {
      const preSubRewardData = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
      assert(!preSubRewardData, `User reward data for ${rewardToken} should not exist before subscription`);
    }

    // Notify reward amounts for each reward token
    for (const rewardToken of rewardTokens) {
      // Calculate reward rate
      const expectedRewardRate = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
      const periodFinish = startTime + Number(REWARD_DURATION);

      await processor.processEvent({
        name: "RewardNotifiedEvent",
        data: {
          pool_address: poolAddress,
          reward_token: { inner: rewardToken },
          reward_amount: REWARD_AMOUNT.toString(),
          reward_rate: expectedRewardRate.toString(),
          period_finish: periodFinish.toString(),
        },
        timestamp: secondsToMicros(startTime),
      });

      // Verify reward data after notification
      await verifyRewardState(multiRewardsTestReader, poolAddress, {
        rewardToken,
        distributor: adminAddress,
        duration: REWARD_DURATION,
        rewardBalance: REWARD_AMOUNT,
        unallocatedRewards: 0n,
        totalDistributed: REWARD_AMOUNT,
        rewardRateU12: expectedRewardRate,
        rewardPerTokenStoredU12: 0n,
      });
    }

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify post-subscription state
    const subscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(subscription, "Subscription should exist");
    assert(subscription.is_currently_subscribed, "User should be subscribed after subscription event");

    // Verify user reward data was initialized for each reward token
    for (const rewardToken of rewardTokens) {
      await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
        rewardPerTokenPaidU12: 0n,
        unclaimedRewards: 0n,
        totalClaimed: 0n,
      });
    }

    // Verify pool state after subscription
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: rewardTokens,
    });

    // Fast forward time to accrue rewards (half of reward duration)
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Verify rewards accrual at halfway point
    for (const rewardToken of rewardTokens) {
      // User claims rewards at halfway point
      const expectedHalfwayReward = REWARD_AMOUNT / 2n; // Half the rewards
      await processor.processEvent({
        name: "RewardClaimedEvent",
        data: {
          pool_address: poolAddress,
          user: userAddress,
          reward_token: { inner: rewardToken },
          reward_amount: expectedHalfwayReward.toString(),
        },
        timestamp: secondsToMicros(halfwayTime),
      });

      // Verify claim event
      const claimEvents = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);
      assert.strictEqual(
        claimEvents[0].claim_amount,
        expectedHalfwayReward,
        "Claim amount should be half of total rewards",
      );

      // Verify reward state after claim
      await verifyRewardState(multiRewardsTestReader, poolAddress, {
        rewardToken,
        distributor: adminAddress,
        duration: REWARD_DURATION,
        rewardBalance: REWARD_AMOUNT - expectedHalfwayReward, // Half of rewards claimed
        unallocatedRewards: 0n,
        totalDistributed: REWARD_AMOUNT,
        rewardRateU12: (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION,
        // The reward per token stored will be half the rate * duration / stake
        rewardPerTokenStoredU12: (REWARD_AMOUNT * U12_PRECISION) / (2n * STAKE_AMOUNT),
      });

      // Verify user reward data after claiming half the rewards
      await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
        rewardPerTokenPaidU12: (REWARD_AMOUNT * U12_PRECISION) / (2n * STAKE_AMOUNT),
        unclaimedRewards: 0n, // Rewards were claimed
        totalClaimed: expectedHalfwayReward,
      });
    }

    // Fast forward to the end of the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Claim rewards at the end
    for (const rewardToken of rewardTokens) {
      // User claims remaining rewards
      const expectedRemainingReward = REWARD_AMOUNT / 2n; // Remaining half of rewards
      await processor.processEvent({
        name: "RewardClaimedEvent",
        data: {
          pool_address: poolAddress,
          user: userAddress,
          reward_token: { inner: rewardToken },
          reward_amount: expectedRemainingReward.toString(),
        },
        timestamp: secondsToMicros(endTime),
      });

      // Verify claim events (should now have 2 claims per token)
      const claimEvents = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 2);
      assert.strictEqual(
        claimEvents[1].claim_amount,
        expectedRemainingReward,
        "Second claim amount should be remaining half of rewards",
      );

      // Verify reward state after claiming all rewards
      await verifyRewardState(multiRewardsTestReader, poolAddress, {
        rewardToken,
        distributor: adminAddress,
        duration: REWARD_DURATION,
        rewardBalance: 0n, // All rewards claimed
        unallocatedRewards: 0n,
        totalDistributed: REWARD_AMOUNT,
        rewardRateU12: (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION,
        // The reward per token stored will now reflect the full period
        rewardPerTokenStoredU12: (REWARD_AMOUNT * U12_PRECISION) / STAKE_AMOUNT,
      });

      // Verify user reward data after claiming all rewards
      await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
        rewardPerTokenPaidU12: (REWARD_AMOUNT * U12_PRECISION) / STAKE_AMOUNT,
        unclaimedRewards: 0n, // All rewards claimed
        totalClaimed: REWARD_AMOUNT, // Total claimed is now full amount
      });
    }
  });

  test("Subscribe after emergency withdraw", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Create reward token in the pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial subscription state
    const initialSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(initialSubscription, "Initial subscription should exist");
    assert(initialSubscription.is_currently_subscribed, "User should be subscribed after initial subscription");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Notify reward amount
    const expectedRewardRate = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Fast forward time to accrue some rewards (1/4 of reward duration)
    const quarterTime = startTime + Number(REWARD_DURATION) / 4;

    // Perform emergency withdrawal
    await processor.processEvent({
      name: "EmergencyWithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(quarterTime),
    });

    // Verify post-emergency withdrawal state
    // User remains subscribed after an emergency withdrawal but total_subscribed is 0
    const postEmergencySubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(postEmergencySubscription, "Subscription should still exist after emergency withdrawal");
    assert(
      postEmergencySubscription.is_currently_subscribed,
      "User should still be subscribed after emergency withdrawal",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n, // Total subscribed goes to 0 after emergency withdrawal
      subscriberCount: 1, // User is still subscribed
      rewardTokens: [rewardToken],
    });

    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: 0n, // User's staked balance is now 0
    });

    // Try to claim rewards (should be zero after emergency withdrawal)
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: "0", // No rewards should be claimed
      },
      timestamp: secondsToMicros(quarterTime + 1),
    });

    // Verify that no rewards were claimed
    const userRewardData = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(userRewardData, "User reward data should exist");
    assert.strictEqual(userRewardData.total_claimed, 0n, "No rewards should have been claimed");

    // Stake again
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(quarterTime + 2),
    });

    // Verify staked balance after restaking
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
    });

    // Verify pool state after restaking
    // NOTE: Total subscribed is already updated by the stake event handler
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT, // Changed from 0n to STAKE_AMOUNT
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      claimCount: 1,
    });

    // User subscribes to pool (actually, the subscription already exists,
    // but we process the event to update the pool's total_subscribed)
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(quarterTime + 3),
    });

    // Verify post-resubscription state
    const postResubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(postResubscription, "Subscription should exist after resubscription");
    assert(postResubscription.is_currently_subscribed, "User should be subscribed after resubscription");

    // Verify pool state after resubscription
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      claimCount: 1,
    });

    // Fast forward more time (another 1/4 of reward duration)
    const halfTime = quarterTime + Number(REWARD_DURATION) / 4;

    // User claims rewards after resubscription
    const expectedQuarterReward = REWARD_AMOUNT / 4n; // 1/4 of rewards accrued after resubscription
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedQuarterReward.toString(),
      },
      timestamp: secondsToMicros(halfTime),
    });

    // Verify reward claim
    const claimEvents = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 2);

    // The second claim event should have the expected reward amount
    assert.strictEqual(
      claimEvents[1].claim_amount,
      expectedQuarterReward,
      "Claim amount should be approximately 1/4 of the reward amount",
    );

    // Verify user reward data after claiming
    const actualRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    if (!actualRewardData) throw new Error("Reward data not found");

    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      // Use the actual reward_per_token_stored_u12 from the reward data
      rewardPerTokenPaidU12: actualRewardData.reward_per_token_stored_u12,
      unclaimedRewards: 0n, // Just claimed
      totalClaimed: expectedQuarterReward, // 1/4 of total rewards
    });
  });

  test("Subscribe after reward notification", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const user1Address = generateRandomAddress();
    const user2Address = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add reward token to the pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Calculate expected reward rate
    const expectedRewardRate = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);

    // Notify rewards
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify pool state after reward notification
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken],
    });

    // Verify reward data was set up correctly
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: 0n,
    });

    // Simulate time passage (1/4 of reward duration)
    const quarterTime = startTime + Number(REWARD_DURATION) / 4;

    // User1 stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT_1.toString(),
      },
      timestamp: secondsToMicros(quarterTime),
    });

    // User1 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(quarterTime),
    });

    // Verify user1's subscription state
    const user1Subscription = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    assert(user1Subscription, "User1 subscription should exist");
    assert(user1Subscription.is_currently_subscribed, "User1 should be subscribed after subscription event");

    // Verify pool state after user1 subscribes
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT_1,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // For the first quarter, no one was subscribed, so we expect 1/4 of rewards to be unallocated
    const expectedUnallocatedRewards = REWARD_AMOUNT / 4n;

    // Verify reward state after user1 subscribes
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT,
      unallocatedRewards: expectedUnallocatedRewards,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: 0n, // Should still be 0 as no rewards were accrued before anyone subscribed
    });

    // Simulate more time passing (another 1/4 of reward duration)
    const halfwayTime = quarterTime + Number(REWARD_DURATION) / 4;

    // User2 stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT_2.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // User2 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify user2's subscription state
    const user2Subscription = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    assert(user2Subscription, "User2 subscription should exist");
    assert(user2Subscription.is_currently_subscribed, "User2 should be subscribed after subscription event");

    // Verify pool state after user2 subscribes
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT_1 + STAKE_AMOUNT_2,
      subscriberCount: 2,
      rewardTokens: [rewardToken],
    });

    // Calculate what user1 should have earned (1/4 of rewards)
    const expectedRewardForSecondQuarter = REWARD_AMOUNT / 4n;

    // Calculate reward per token after second quarter
    // For the second quarter, only user1 was subscribed with STAKE_AMOUNT_1
    const expectedRewardPerTokenAfterHalfway = (expectedRewardForSecondQuarter * U12_PRECISION) / STAKE_AMOUNT_1;

    // Get the actual reward data for more accurate comparison
    const halfwayRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    if (!halfwayRewardData) throw new Error("Reward data not found at halfway point");

    // Verify user1's reward data at halfway point
    await verifyUserRewardData(service, user1Address, poolAddress, rewardToken, {
      // reward_per_token_paid_u12 is 0 because it's only updated when the user explicitly
      // interacts with the contract in ways that trigger reward updates (claim, unsubscribe, etc.)
      // It remains at the initial value (0) until such an interaction occurs
      rewardPerTokenPaidU12: 0n,

      // Similarly, unclaimedRewards shows 0 in storage even though the user has technically
      // accrued rewards. These rewards exist conceptually but are only calculated and stored
      // when the user performs an action like claiming rewards
      unclaimedRewards: 0n,

      // No rewards claimed yet
      totalClaimed: 0n,
    });

    // Verify user2's reward data at halfway point (should have no rewards yet)
    await verifyUserRewardData(service, user2Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: halfwayRewardData.reward_per_token_stored_u12,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    // Simulate time passage to end of reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Calculate what each user should receive for the final half
    // For the last half, both users are subscribed with a total of STAKE_AMOUNT_1 + STAKE_AMOUNT_2
    const remainingRewards = REWARD_AMOUNT / 2n; // Half of total rewards

    // User1's share of final half is proportional to their stake
    const user1ShareOfFinalHalf = (remainingRewards * STAKE_AMOUNT_1) / (STAKE_AMOUNT_1 + STAKE_AMOUNT_2);

    // User2's share of final half is proportional to their stake
    const user2ShareOfFinalHalf = (remainingRewards * STAKE_AMOUNT_2) / (STAKE_AMOUNT_1 + STAKE_AMOUNT_2);

    // Total expected rewards for each user
    const expectedUser1TotalRewards = expectedRewardForSecondQuarter + user1ShareOfFinalHalf;
    const expectedUser2TotalRewards = user2ShareOfFinalHalf;

    // User1 claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser1TotalRewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // User2 claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser2TotalRewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Get the actual reward data at the end for more accurate comparison
    const finalRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    if (!finalRewardData) throw new Error("Reward data not found at end point");

    // Verify final user1 reward data
    await verifyUserRewardData(service, user1Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardData.reward_per_token_stored_u12,
      unclaimedRewards: 0n,
      totalClaimed: expectedUser1TotalRewards,
    });

    // Verify final user2 reward data
    await verifyUserRewardData(service, user2Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardData.reward_per_token_stored_u12,
      unclaimedRewards: 0n,
      totalClaimed: expectedUser2TotalRewards,
    });

    // Verify claim events
    const user1ClaimEvents = await verifyClaimEvents(service, poolAddress, user1Address, rewardToken, 1);
    const user2ClaimEvents = await verifyClaimEvents(service, poolAddress, user2Address, rewardToken, 1);

    // Verify the claim amounts match expectations
    assert.strictEqual(
      user1ClaimEvents[0].claim_amount,
      expectedUser1TotalRewards,
      "User1 claim amount should match expected total rewards",
    );

    assert.strictEqual(
      user2ClaimEvents[0].claim_amount,
      expectedUser2TotalRewards,
      "User2 claim amount should match expected total rewards",
    );

    // Verify that user1 got more rewards than user2
    assert(
      user1ClaimEvents[0].claim_amount > user2ClaimEvents[0].claim_amount,
      "User1 should have received more rewards than User2",
    );

    // Verify that expected rewards plus unallocated rewards equals total rewards
    const totalClaimedRewards = user1ClaimEvents[0].claim_amount + user2ClaimEvents[0].claim_amount;

    assertApproxEqualBigInt(
      totalClaimedRewards + expectedUnallocatedRewards,
      REWARD_AMOUNT,
      1n,
      "Total claimed rewards plus unallocated rewards should equal total reward amount",
    );
  });

  test("Subscribe delay after staking", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const user1Address = generateRandomAddress();
    const user2Address = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Users stake their tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT_1.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT_2.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial user states
    await verifyUserState(multiRewardsTestReader, user1Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT_1,
      subscribedPools: [], // Not subscribed to any pools yet
    });

    await verifyUserState(multiRewardsTestReader, user2Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT_2,
      subscribedPools: [], // Not subscribed to any pools yet
    });

    // Verify pool state before subscriptions
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n, // No subscribed users yet
      subscriberCount: 0,
      rewardTokens: [],
    });

    // Simulate some time passing
    const quarterTime = startTime + Number(REWARD_DURATION) / 4;

    // Add reward token to the pool and notify rewards
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(quarterTime),
    });

    // Calculate expected reward rate
    const expectedRewardRate = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
    const initialPeriodFinish = quarterTime + Number(REWARD_DURATION);

    // Notify rewards - REWARD DURATION STARTS NOW
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(quarterTime),
    });

    // Verify reward data was set up correctly
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: 0n,
    });

    // More time passes - 1/4 of rewards remain unallocated since no one is subscribed
    const halfwayTime = quarterTime + Number(REWARD_DURATION) / 4;

    // User1 subscribes
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify subscription event
    await verifySubscriptionEvent(multiRewardsTestReader, {
      user: user1Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(halfwayTime),
      subscription_count: 1, // First subscription
    });

    // Verify pool state after user1 subscribes
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT_1,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Verify user1's subscription state
    const user1Subscription = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    assert(user1Subscription, "User1 subscription should exist");
    assert(user1Subscription.is_currently_subscribed, "User1 should be subscribed after subscription event");

    // User1's reward data after subscription
    // Note: reward_per_token_paid_u12 is 0 because it's only updated when the user explicitly
    // interacts with the contract in ways that trigger reward updates (claim, unsubscribe, etc.)
    await verifyUserRewardData(service, user1Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: 0n,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    // More time passes - now at 3/4 of the reward duration
    const threeQuarterTime = halfwayTime + Number(REWARD_DURATION) / 4;

    // User2 subscribes
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(threeQuarterTime),
    });

    // Verify subscription event
    await verifySubscriptionEvent(multiRewardsTestReader, {
      user: user2Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(threeQuarterTime),
      subscription_count: 2, // Second subscription
    });

    // Verify pool state after user2 subscribes
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT_1 + STAKE_AMOUNT_2,
      subscriberCount: 2,
      rewardTokens: [rewardToken],
    });

    // Verify user2's subscription state
    const user2Subscription = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    assert(user2Subscription, "User2 subscription should exist");
    assert(user2Subscription.is_currently_subscribed, "User2 should be subscribed after subscription event");

    // Get the actual reward data at the time User2 subscribes
    const threeQuarterRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    if (!threeQuarterRewardData) throw new Error("Reward data not found at three-quarter point");

    // User2's reward data after subscription - should match current pool reward_per_token_stored_u12
    await verifyUserRewardData(service, user2Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: threeQuarterRewardData.reward_per_token_stored_u12,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    // Wait for the reward period to finish
    const endTime = quarterTime + Number(REWARD_DURATION);

    // Calculate expected rewards:
    // First 1/4: No subscribers, rewards are unallocated
    const unallocatedRewardsFirstQuarter = REWARD_AMOUNT / 4n;

    // Second 1/4: Only user1 subscribed
    const user1RewardsSecondQuarter = REWARD_AMOUNT / 4n;

    // Third 1/4: Only user1 subscribed
    const user1RewardsThirdQuarter = REWARD_AMOUNT / 4n;

    // Last 1/4: Both users subscribed, divided proportionally to stake
    const lastQuarterRewards = REWARD_AMOUNT / 4n;
    const user1ShareOfLastQuarter = (lastQuarterRewards * STAKE_AMOUNT_1) / (STAKE_AMOUNT_1 + STAKE_AMOUNT_2);
    const user2ShareOfLastQuarter = (lastQuarterRewards * STAKE_AMOUNT_2) / (STAKE_AMOUNT_1 + STAKE_AMOUNT_2);

    // Total expected rewards
    const expectedUser1TotalRewards = user1RewardsSecondQuarter + user1RewardsThirdQuarter + user1ShareOfLastQuarter;
    const expectedUser2TotalRewards = user2ShareOfLastQuarter;

    // User1 claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser1TotalRewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // User2 claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser2TotalRewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Get the actual reward data at the end for verification
    const finalRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    if (!finalRewardData) throw new Error("Reward data not found at end point");

    // Verify final user1 reward data
    await verifyUserRewardData(service, user1Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardData.reward_per_token_stored_u12,
      unclaimedRewards: 0n, // All claimed
      totalClaimed: expectedUser1TotalRewards,
    });

    // Verify final user2 reward data
    await verifyUserRewardData(service, user2Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardData.reward_per_token_stored_u12,
      unclaimedRewards: 0n, // All claimed
      totalClaimed: expectedUser2TotalRewards,
    });

    // Verify claim events
    const user1ClaimEvents = await verifyClaimEvents(service, poolAddress, user1Address, rewardToken, 1);
    const user2ClaimEvents = await verifyClaimEvents(service, poolAddress, user2Address, rewardToken, 1);

    // Verify the claim amounts
    assert.strictEqual(
      user1ClaimEvents[0].claim_amount,
      expectedUser1TotalRewards,
      "User1 claim amount should match expected total rewards",
    );

    assert.strictEqual(
      user2ClaimEvents[0].claim_amount,
      expectedUser2TotalRewards,
      "User2 claim amount should match expected total rewards",
    );

    // Verify that user1 got more rewards than user2
    assert(
      user1ClaimEvents[0].claim_amount > user2ClaimEvents[0].claim_amount,
      "User1 should have received more rewards than User2",
    );

    // Verify unallocated rewards in the pool
    assert.strictEqual(
      finalRewardData.unallocated_rewards,
      unallocatedRewardsFirstQuarter,
      "Unallocated rewards should match expected amount",
    );

    // Verify that claimed rewards plus unallocated rewards equals total rewards
    const totalClaimedRewards = user1ClaimEvents[0].claim_amount + user2ClaimEvents[0].claim_amount;

    assertApproxEqualBigInt(
      totalClaimedRewards + unallocatedRewardsFirstQuarter,
      REWARD_AMOUNT,
      1n,
      "Total claimed rewards plus unallocated rewards should equal total reward amount",
    );
  });

  test("Subscribe before reward notification", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const user1Address = generateRandomAddress();
    const user2Address = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add reward token to the pool (but don't notify rewards yet)
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify pool state after adding reward token
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken],
    });

    // Verify reward data was created but has zero values
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n,
      unallocatedRewards: 0n,
      totalDistributed: 0n,
      rewardRateU12: 0n,
      rewardPerTokenStoredU12: 0n,
    });

    // Users stake their tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT_1.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT_2.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Users subscribe to the pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify pool state after both users subscribe
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT_1 + STAKE_AMOUNT_2,
      subscriberCount: 2,
      rewardTokens: [rewardToken],
    });

    // Verify user subscriptions
    const user1Subscription = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    assert(user1Subscription, "User1 subscription should exist");
    assert(user1Subscription.is_currently_subscribed, "User1 should be subscribed");

    const user2Subscription = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    assert(user2Subscription, "User2 subscription should exist");
    assert(user2Subscription.is_currently_subscribed, "User2 should be subscribed");

    // Verify users have no rewards yet (since rewards haven't been notified)
    await verifyUserRewardData(service, user1Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: 0n,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    await verifyUserRewardData(service, user2Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: 0n,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    // Check that no rewards are accruing yet
    // Simulate half the reward duration passing
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Calculate expected reward rate
    const expectedRewardRate = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
    const periodFinish = halfwayTime + Number(REWARD_DURATION);

    // Notify rewards at halfway point
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate.toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify reward data after notification
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: 0n, // Should still be 0 at the moment of notification
    });

    // Let rewards accrue - another quarter of the reward duration
    const threeQuarterTime = halfwayTime + Number(REWARD_DURATION) / 2;

    // Calculate expected rewards at the three-quarter point
    // Both users should earn proportionally to their stake
    const totalStake = STAKE_AMOUNT_1 + STAKE_AMOUNT_2;
    const halfRewards = REWARD_AMOUNT / 2n; // Half of total rewards distributed in this period
    const expectedUser1Rewards = (halfRewards * STAKE_AMOUNT_1) / totalStake;
    const expectedUser2Rewards = (halfRewards * STAKE_AMOUNT_2) / totalStake;

    // Get the actual reward data to see what's in the database
    const finalRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    if (!finalRewardData) throw new Error("Reward data not found");

    // User1 claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser1Rewards.toString(),
      },
      timestamp: secondsToMicros(threeQuarterTime),
    });

    // User2 claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser2Rewards.toString(),
      },
      timestamp: secondsToMicros(threeQuarterTime),
    });

    // Verify claim events
    const user1ClaimEvents = await verifyClaimEvents(service, poolAddress, user1Address, rewardToken, 1);
    const user2ClaimEvents = await verifyClaimEvents(service, poolAddress, user2Address, rewardToken, 1);

    // Verify claimed amounts match expectations
    assert.strictEqual(
      user1ClaimEvents[0].claim_amount,
      expectedUser1Rewards,
      "User1 claim amount should match expected rewards",
    );

    assert.strictEqual(
      user2ClaimEvents[0].claim_amount,
      expectedUser2Rewards,
      "User2 claim amount should match expected rewards",
    );

    // Verify user1 got more rewards than user2 (since they staked more)
    assert(
      user1ClaimEvents[0].claim_amount > user2ClaimEvents[0].claim_amount,
      "User1 should have received more rewards than User2 proportional to their stake",
    );

    // Verify user reward data after claiming
    await verifyUserRewardData(service, user1Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardData.reward_per_token_stored_u12,
      unclaimedRewards: 0n, // All rewards claimed
      totalClaimed: expectedUser1Rewards,
    });

    await verifyUserRewardData(service, user2Address, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardData.reward_per_token_stored_u12,
      unclaimedRewards: 0n, // All rewards claimed
      totalClaimed: expectedUser2Rewards,
    });

    // Verify total rewards claimed match expectations
    const totalClaimed = user1ClaimEvents[0].claim_amount + user2ClaimEvents[0].claim_amount;
    assertApproxEqualBigInt(
      totalClaimed,
      halfRewards,
      1n,
      "Total claimed rewards should match half of the total rewards",
    );

    // Verify remainder of rewards are still in balance
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT - totalClaimed,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: finalRewardData.reward_per_token_stored_u12, // Use actual value from DB
    });
  });
});
