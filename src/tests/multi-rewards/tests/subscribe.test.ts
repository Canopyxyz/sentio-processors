/* eslint-disable */
import assert from "assert";
import { before, afterEach, describe, test } from "node:test";
import { TestProcessorServer } from "@sentio/sdk/testing";

import { MultiRewardsTestReader } from "../../../processors/multi-rewards-processor.js";
import { multi_rewards_abi } from "../../../abis/multi-rewards-testnet.js";
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
    // Test implementation will go here
  });

  test("Subscribe with multiple reward tokens", async () => {
    // Test implementation will go here
  });

  test("Subscribe after emergency withdraw", async () => {
    // Test implementation will go here
  });

  test("Subscribe after reward notification", async () => {
    // Test implementation will go here
  });

  test("Subscribe delay after staking", async () => {
    // Test implementation will go here
  });

  test("Subscribe before reward notification", async () => {
    // Test implementation will go here
  });
});
