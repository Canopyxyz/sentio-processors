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
  verifyPoolState,
  verifyClaimEvents,
  verifySubscriptionEvent,
  verifyUnsubscriptionEvent,
} from "../common/helpers.js";

import { assertApproxEqualBigInt } from "../../common/assertions.js";
import { MRRewardClaimedEvent, MRUserRewardData } from "../../../schema/schema.rewards.js";

describe("Unsubscribe", async () => {
  const service = new TestProcessorServer(() => import("../multi-rewards-processor.js"));
  const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);

  const STAKE_AMOUNT = 100_000n;
  const REWARD_AMOUNT = 1_000_000n;
  const REWARD_DURATION = 100n; // 100 seconds for simplicity
  const U12_PRECISION = 1_000_000_000_000n; // 1e12

  before(async () => {
    await service.start();
  });

  afterEach(async () => {
    service.db.reset();
  });

  // Basic test case for unsubscribing from a pool
  test("test_unsubscribe", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken1 = generateRandomAddress();
    const rewardToken2 = generateRandomAddress();
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

    // Add reward tokens to the pool
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

    // User stakes tokens
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

    // Verify initial state
    const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscription, "User subscription should exist");
    assert(userSubscription.is_currently_subscribed, "User should be subscribed after subscription event");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken1, rewardToken2],
    });

    // Notify rewards for both tokens
    const expectedRewardRate = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
    const periodFinish = startTime + Number(REWARD_DURATION);

    // Notify for first reward token
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate.toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Notify for second reward token
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate.toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Let rewards accrue (half of REWARD_DURATION)
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Check accrued rewards before unsubscribe - user should have earned half of the rewards
    // We simulate this by checking the reward data in the pool
    const rewardData1 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken1);
    const rewardData2 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken2);
    assert(rewardData1, "Reward data for token1 should exist");
    assert(rewardData2, "Reward data for token2 should exist");

    // Now user unsubscribes
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify post-unsubscription state
    const userSubscriptionAfter = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscriptionAfter, "User subscription should still exist");
    assert(!userSubscriptionAfter.is_currently_subscribed, "User should be unsubscribed after unsubscription event");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken1, rewardToken2],
    });

    // Verify rewards were claimed during unsubscription
    // In Sentio, we can verify this by checking the RewardClaimedEvent was emitted
    // for both reward tokens with approximately half of the rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: (REWARD_AMOUNT / 2n).toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: (REWARD_AMOUNT / 2n).toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Let more time pass to end of reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // TODO: pending fix: https://github.com/sentioxyz/sentio-sdk/issues/1170
    // // Verify no more rewards accrued after unsubscription
    // const userRewardData1 = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken1);
    // const userRewardData2 = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken2);
    // // Since we processed an unsubscription, the user reward data should be deleted
    // assert(!userRewardData1, "User reward data should be deleted after unsubscription");
    // assert(!userRewardData2, "User reward data should be deleted after unsubscription");

    // Verify unsubscription event was properly recorded
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(halfwayTime),
      unsubscription_count: 1,
    });
  });

  // Test unsubscribing from multiple pools
  test("test_unsubscribe_multiple_pools", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();

    // Generate multiple pool addresses
    const poolAddress1 = generateRandomAddress();
    const poolAddress2 = generateRandomAddress();
    const poolAddress3 = generateRandomAddress();

    const poolAddresses = [poolAddress1, poolAddress2, poolAddress3];

    const startTime = 1000; // Base timestamp for the test

    // Setup multiple pools with admin
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

      // Add reward token to each pool
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
    }

    // User stakes tokens (enough for all pools)
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT * 3n).toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to all pools
    for (const poolAddress of poolAddresses) {
      await processor.processEvent({
        name: "SubscriptionEvent",
        data: {
          user: userAddress,
          pool_address: poolAddress,
          staking_token: { inner: stakingToken },
        },
        timestamp: secondsToMicros(startTime),
      });
    }

    // Verify initial state for all pools
    for (const poolAddress of poolAddresses) {
      const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
      assert(userSubscription, "User subscription should exist");
      assert(userSubscription.is_currently_subscribed, "User should be subscribed after subscription event");

      await verifyPoolState(multiRewardsTestReader, poolAddress, {
        stakingToken,
        creator: adminAddress,
        totalSubscribed: STAKE_AMOUNT * 3n, // Total staked amount spread across all pools
        subscriberCount: 1,
        rewardTokens: [rewardToken],
      });
    }

    // Notify rewards for all pools
    const expectedRewardRate = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
    const periodFinish = startTime + Number(REWARD_DURATION);

    for (const poolAddress of poolAddresses) {
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
    }

    // Let rewards accrue (half of REWARD_DURATION)
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Total earned rewards so far should be approximately half of REWARD_AMOUNT per pool
    let totalExpectedRewards = 0n;

    let unsubscriptionCount = 1;

    // Unsubscribe from all pools
    for (const poolAddress of poolAddresses) {
      // Process claim event before unsubscription (in the Move test, claims happen during unsubscription)
      await processor.processEvent({
        name: "RewardClaimedEvent",
        data: {
          pool_address: poolAddress,
          user: userAddress,
          reward_token: { inner: rewardToken },
          reward_amount: (REWARD_AMOUNT / 2n).toString(),
        },
        timestamp: secondsToMicros(halfwayTime),
      });

      totalExpectedRewards += REWARD_AMOUNT / 2n;

      // Now process the unsubscription
      await processor.processEvent({
        name: "UnsubscriptionEvent",
        data: {
          user: userAddress,
          pool_address: poolAddress,
          staking_token: { inner: stakingToken },
        },
        timestamp: secondsToMicros(halfwayTime),
      });

      // Verify user is no longer subscribed to this pool
      const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
      assert(userSubscription, "User subscription should still exist");
      assert(!userSubscription.is_currently_subscribed, "User should be unsubscribed after unsubscription event");

      // Verify pool state after unsubscription
      await verifyPoolState(multiRewardsTestReader, poolAddress, {
        stakingToken,
        creator: adminAddress,
        totalSubscribed: 0n,
        subscriberCount: 0,
        rewardTokens: [rewardToken],
        claimCount: 1,
      });

      // Verify unsubscription event
      await verifyUnsubscriptionEvent(multiRewardsTestReader, {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: stakingToken,
        timestamp: secondsToMicros(halfwayTime),
        unsubscription_count: unsubscriptionCount++,
      });
    }

    // Let more time pass to end of reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Since there's an issue with store.delete, we can't directly check that the reward data is gone
    // Instead, verify that the user is no longer subscribed to any pools
    for (const poolAddress of poolAddresses) {
      const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
      assert(
        userSubscription && !userSubscription.is_currently_subscribed,
        "User should still be marked as unsubscribed after reward period ends",
      );
    }

    // In a real environment, a query for all subscribed pools would return an empty list
    // but we can't test that effectively with the current store.delete issue
  });

  // Test unsubscribing with zero rewards
  test("test_unsubscribe_with_zero_rewards", async () => {
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

    // User stakes tokens
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

    // Verify initial state
    const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscription, "User subscription should exist");
    assert(userSubscription.is_currently_subscribed, "User should be subscribed after subscription event");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Check that no rewards have accrued yet (no notify_reward_amount has been called)
    const rewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardData, "Reward data should exist");
    assert.strictEqual(rewardData.reward_rate_u12, 0n, "Reward rate should be zero before notification");

    const userRewardData = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    // User reward data might not exist yet if it's only created after rewards are notified

    // Track the unsubscription count
    const module = await multiRewardsTestReader.getModule();
    const unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Unsubscribe user
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify post-unsubscription state
    const userSubscriptionAfter = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscriptionAfter, "User subscription should still exist");
    assert(!userSubscriptionAfter.is_currently_subscribed, "User should be unsubscribed after unsubscription event");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken],
    });

    // Verify unsubscription event was emitted
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(startTime),
      unsubscription_count: unsubscriptionCount,
    });

    // Notify rewards after unsubscription
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

    // Let the reward period pass
    const endTime = startTime + Number(REWARD_DURATION);

    // Verify no rewards were accrued by the unsubscribed user
    // Since there's no claim event expected, we don't need to process one
    // The user reward data should remain at 0 or not exist

    // We can't reliably verify user reward data is deleted due to the store.delete issue,
    // but we can verify the user remains unsubscribed
    const finalUserSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      finalUserSubscription && !finalUserSubscription.is_currently_subscribed,
      "User should remain unsubscribed after reward period ends",
    );
  });

  // Test unsubscribing and then resubscribing
  test("test_unsubscribe_and_resubscribe", async () => {
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

    // User stakes tokens
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

    // Verify initial state
    const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscription, "User subscription should exist");
    assert(userSubscription.is_currently_subscribed, "User should be subscribed after subscription event");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Notify initial rewards
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

    // Let rewards accrue for half the duration
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Track unsubscription count
    const module = await multiRewardsTestReader.getModule();
    const unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Process claim event for first period rewards (half of REWARD_AMOUNT)
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: (REWARD_AMOUNT / 2n).toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Unsubscribe user
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify post-unsubscription state
    const userSubscriptionAfter = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscriptionAfter, "User subscription should still exist");
    assert(!userSubscriptionAfter.is_currently_subscribed, "User should be unsubscribed after unsubscription event");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken],
      claimCount: 1,
    });

    // Verify unsubscription event was emitted
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(halfwayTime),
      unsubscription_count: unsubscriptionCount,
    });

    // Let some time pass (1/4 of REWARD_DURATION)
    const threeQuartersTime = halfwayTime + Number(REWARD_DURATION) / 4;

    // Track subscription count
    const moduleAfterUnsubscribe = await multiRewardsTestReader.getModule();
    const subscriptionCount = (moduleAfterUnsubscribe?.subscription_count || 0) + 1;

    // Resubscribe to the pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(threeQuartersTime),
    });

    // Verify resubscription state
    const userSubscriptionAfterResubscribe = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscriptionAfterResubscribe, "User subscription should exist");
    assert(
      userSubscriptionAfterResubscribe.is_currently_subscribed,
      "User should be subscribed after resubscription event",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      claimCount: 1,
    });

    // Verify subscription event after resubscription
    await verifySubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(threeQuartersTime),
      subscription_count: subscriptionCount,
    });

    // Notify new rewards
    // At this point:
    // - 1/4 of initial REWARD_AMOUNT was unclaimed from first period
    // - 1/4 of initial REWARD_AMOUNT was unallocated during no subscription
    // - 1 full REWARD_AMOUNT is newly notified
    const newPeriodFinish = threeQuartersTime + Number(REWARD_DURATION);

    // In a real scenario, the reward rate would account for unallocated rewards,
    // but for simplicity we'll just simulate a fresh notification
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate.toString(),
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(threeQuartersTime),
    });

    // Let rewards accrue for half of the new duration
    const secondHalfwayTime = threeQuartersTime + Number(REWARD_DURATION) / 2;

    // Calculate expected second period rewards
    // User should earn half of the REWARD_AMOUNT for this period
    const secondPeriodRewards = REWARD_AMOUNT / 2n;

    // Track new unsubscription count
    const moduleBeforeSecondUnsubscribe = await multiRewardsTestReader.getModule();
    const secondUnsubscriptionCount = (moduleBeforeSecondUnsubscribe?.unsubscription_count || 0) + 1;

    // Process claim event for second period rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: secondPeriodRewards.toString(),
      },
      timestamp: secondsToMicros(secondHalfwayTime),
    });

    // Unsubscribe again
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(secondHalfwayTime),
    });

    // Verify final state
    const finalUserSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(finalUserSubscription, "User subscription should still exist");
    assert(
      !finalUserSubscription.is_currently_subscribed,
      "User should be unsubscribed after second unsubscription event",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken],
      claimCount: 2,
    });

    // Verify second unsubscription event
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(secondHalfwayTime),
      unsubscription_count: secondUnsubscriptionCount,
    });

    // Verify final claimed rewards
    // First period: REWARD_AMOUNT / 2
    // Second period: REWARD_AMOUNT / 2
    // Total: REWARD_AMOUNT

    // We can verify this by checking the claim events
    const claimEvents = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 2);
    assert.strictEqual(claimEvents.length, 2, "Should have two claim events");
    assert.strictEqual(
      claimEvents[0].claim_amount,
      REWARD_AMOUNT / 2n,
      "First claim amount should be half of reward amount",
    );
    assert.strictEqual(
      claimEvents[1].claim_amount,
      secondPeriodRewards,
      "Second claim amount should match expected second period rewards",
    );
  });

  // Test unsubscribing with multiple users
  test("test_unsubscribe_with_multiple_users", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const user1Address = generateRandomAddress();
    const user2Address = generateRandomAddress();
    const user3Address = generateRandomAddress();
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

    // Set up users with stake
    const userAddresses = [user1Address, user2Address, user3Address];

    for (const userAddress of userAddresses) {
      // User stakes tokens
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
    }

    // Verify initial state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 3n, // 3 users with STAKE_AMOUNT each
      subscriberCount: 3,
      rewardTokens: [rewardToken],
    });

    // Notify rewards
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

    // Let rewards accrue for half the duration
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Track unsubscription count
    let module = await multiRewardsTestReader.getModule();
    let unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // User1 unsubscribes at halfway point
    // Process claim event for user1 first (1/3 of half the rewards = 1/6 of total)
    const user1ClaimAmount = REWARD_AMOUNT / 6n;

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: user1ClaimAmount.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Unsubscribe user1
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify state after user1 unsubscribes
    const user1SubscriptionAfter = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const user2SubscriptionAfter = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    const user3SubscriptionAfter = await multiRewardsTestReader.getUserSubscription(user3Address, poolAddress);

    assert(user1SubscriptionAfter && !user1SubscriptionAfter.is_currently_subscribed, "User1 should be unsubscribed");
    assert(
      user2SubscriptionAfter && user2SubscriptionAfter.is_currently_subscribed,
      "User2 should still be subscribed",
    );
    assert(
      user3SubscriptionAfter && user3SubscriptionAfter.is_currently_subscribed,
      "User3 should still be subscribed",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 2n, // 2 users remaining with STAKE_AMOUNT each
      subscriberCount: 2,
      rewardTokens: [rewardToken],
      claimCount: 1,
    });

    // Let more rewards accrue (quarter of full duration)
    const threeQuartersTime = halfwayTime + Number(REWARD_DURATION) / 4;

    // Update unsubscription count
    module = await multiRewardsTestReader.getModule();
    unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // User2 unsubscribes at three-quarters point
    // User2 gets 1/3 of first half + 1/2 of next quarter = 1/6 + 1/8 = 7/24 of total rewards
    const user2ClaimAmount = (REWARD_AMOUNT * 7n) / 24n;

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: user2ClaimAmount.toString(),
      },
      timestamp: secondsToMicros(threeQuartersTime),
    });

    // Unsubscribe user2
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(threeQuartersTime),
    });

    // Verify state after user2 unsubscribes
    const user1SubscriptionAfter2 = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const user2SubscriptionAfter2 = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    const user3SubscriptionAfter2 = await multiRewardsTestReader.getUserSubscription(user3Address, poolAddress);

    assert(
      user1SubscriptionAfter2 && !user1SubscriptionAfter2.is_currently_subscribed,
      "User1 should remain unsubscribed",
    );
    assert(user2SubscriptionAfter2 && !user2SubscriptionAfter2.is_currently_subscribed, "User2 should be unsubscribed");
    assert(
      user3SubscriptionAfter2 && user3SubscriptionAfter2.is_currently_subscribed,
      "User3 should still be subscribed",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT, // 1 user remaining with STAKE_AMOUNT
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      claimCount: 2,
    });

    // Finish the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Update unsubscription count
    module = await multiRewardsTestReader.getModule();
    unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // User3 gets 1/3 of first half + 1/2 of next quarter + all of final quarter = 1/6 + 1/8 + 1/4 = 13/24
    const user3ClaimAmount = (REWARD_AMOUNT * 13n) / 24n;

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user3Address,
        reward_token: { inner: rewardToken },
        reward_amount: user3ClaimAmount.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Unsubscribe user3
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: user3Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(endTime),
    });

    // Verify final state
    const user1SubscriptionFinal = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const user2SubscriptionFinal = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    const user3SubscriptionFinal = await multiRewardsTestReader.getUserSubscription(user3Address, poolAddress);

    assert(
      user1SubscriptionFinal && !user1SubscriptionFinal.is_currently_subscribed,
      "User1 should remain unsubscribed",
    );
    assert(
      user2SubscriptionFinal && !user2SubscriptionFinal.is_currently_subscribed,
      "User2 should remain unsubscribed",
    );
    assert(user3SubscriptionFinal && !user3SubscriptionFinal.is_currently_subscribed, "User3 should be unsubscribed");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n, // No users remaining
      subscriberCount: 0,
      rewardTokens: [rewardToken],
      claimCount: 3,
    });

    // Verify total rewards distributed
    // Get claim events for each user
    const user1ClaimEvents = await verifyClaimEvents(service, poolAddress, user1Address, rewardToken, 1);
    const user2ClaimEvents = await verifyClaimEvents(service, poolAddress, user2Address, rewardToken, 1);
    const user3ClaimEvents = await verifyClaimEvents(service, poolAddress, user3Address, rewardToken, 1);

    assert.strictEqual(user1ClaimEvents[0].claim_amount, user1ClaimAmount, "User1 claim amount should match expected");
    assert.strictEqual(user2ClaimEvents[0].claim_amount, user2ClaimAmount, "User2 claim amount should match expected");
    assert.strictEqual(user3ClaimEvents[0].claim_amount, user3ClaimAmount, "User3 claim amount should match expected");

    // Total rewards should approximately equal REWARD_AMOUNT
    const totalClaimed = user1ClaimAmount + user2ClaimAmount + user3ClaimAmount;
    assertApproxEqualBigInt(totalClaimed, REWARD_AMOUNT, 2n, "Total claimed rewards should equal total reward amount");

    // Verify unsubscription events for all users
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: user1Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(halfwayTime),
      unsubscription_count: 1, // First unsubscription
    });

    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: user2Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(threeQuartersTime),
      unsubscription_count: 2, // Second unsubscription
    });

    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: user3Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(endTime),
      unsubscription_count: 3, // Third unsubscription
    });
  });

  // Test unsubscribing after reward period ends
  test("test_unsubscribe_after_reward_period_ends", async () => {
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

    // User stakes tokens
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

    // Verify initial state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Notify rewards
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

    // Let the entire reward period pass
    const endTime = startTime + Number(REWARD_DURATION);

    // Sanity check - get reward data at end time
    const rewardDataAtEnd = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardDataAtEnd, "Reward data should exist");

    // Let additional time pass after the reward period
    const afterPeriodTime = endTime + Number(REWARD_DURATION) / 2;

    // Track unsubscription count
    const module = await multiRewardsTestReader.getModule();
    const unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Process claim event for full rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(afterPeriodTime),
    });

    // Unsubscribe user
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(afterPeriodTime),
    });

    // Verify post-unsubscription state
    const userSubscriptionAfter = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscriptionAfter, "User subscription should still exist");
    assert(!userSubscriptionAfter.is_currently_subscribed, "User should be unsubscribed after unsubscription event");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken],
      claimCount: 1,
    });

    // Verify unsubscription event
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(afterPeriodTime),
      unsubscription_count: unsubscriptionCount,
    });

    // Verify rewards were claimed
    const claimEvents = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);
    assert.strictEqual(claimEvents[0].claim_amount, REWARD_AMOUNT, "User should claim full reward amount");

    // Verify remaining rewards in the pool (should be zero)
    const rewardDataAfterUnsubscribe = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardDataAfterUnsubscribe, "Reward data should exist after unsubscribe");
    assert.strictEqual(rewardDataAfterUnsubscribe.reward_balance, 0n, "No rewards should remain in the pool");

    // Notify new rewards after user has unsubscribed
    const newPeriodFinish = afterPeriodTime + Number(REWARD_DURATION);

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate.toString(),
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(afterPeriodTime),
    });

    // Let new reward period finish
    const newRewardPeriodEnd = afterPeriodTime + Number(REWARD_DURATION);

    // Verify the unsubscribed user doesn't receive any new rewards
    const finalUserSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      finalUserSubscription && !finalUserSubscription.is_currently_subscribed,
      "User should remain unsubscribed after new reward period",
    );

    // The unsubscribed user should not claim any new rewards
    // In a real system we would verify no new claim events, but in our test setup
    // we control when claim events happen, so there's no risk of unexpected events
  });

  // Test unsubscribing with different stake amounts
  test("test_unsubscribe_with_different_stake_amounts", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const user1Address = generateRandomAddress();
    const user2Address = generateRandomAddress();
    const user3Address = generateRandomAddress();
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

    // User1 stakes tokens (1x amount)
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User2 stakes tokens (2x amount)
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT * 2n).toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User3 stakes tokens (3x amount)
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user3Address,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT * 3n).toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Users subscribe to pool
    for (const userAddress of [user1Address, user2Address, user3Address]) {
      await processor.processEvent({
        name: "SubscriptionEvent",
        data: {
          user: userAddress,
          pool_address: poolAddress,
          staking_token: { inner: stakingToken },
        },
        timestamp: secondsToMicros(startTime),
      });
    }

    // Verify initial state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 6n, // 1x + 2x + 3x = 6x
      subscriberCount: 3,
      rewardTokens: [rewardToken],
    });

    // Notify rewards
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

    // Let rewards accrue for half the duration
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Track unsubscription count
    let module = await multiRewardsTestReader.getModule();
    let unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Calculate user1's rewards for the first half period
    // User1 has 1/6 of total stake, so gets 1/6 of half the rewards = 1/12 of total
    const user1FirstHalfRewards = REWARD_AMOUNT / 12n;

    // Process claim event for user1
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: user1FirstHalfRewards.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Unsubscribe user1 (lowest stake)
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify state after user1 unsubscribes
    const user1SubscriptionAfter = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const user2SubscriptionAfter = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    const user3SubscriptionAfter = await multiRewardsTestReader.getUserSubscription(user3Address, poolAddress);

    assert(user1SubscriptionAfter && !user1SubscriptionAfter.is_currently_subscribed, "User1 should be unsubscribed");
    assert(
      user2SubscriptionAfter && user2SubscriptionAfter.is_currently_subscribed,
      "User2 should still be subscribed",
    );
    assert(
      user3SubscriptionAfter && user3SubscriptionAfter.is_currently_subscribed,
      "User3 should still be subscribed",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 5n, // 2x + 3x = 5x
      subscriberCount: 2,
      rewardTokens: [rewardToken],
      claimCount: 1,
    });

    // Let more rewards accrue (quarter of full duration)
    const threeQuartersTime = halfwayTime + Number(REWARD_DURATION) / 4;

    // Update unsubscription count
    module = await multiRewardsTestReader.getModule();
    unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Calculate user2's rewards
    // First half: 2/6 of total stake, so gets 2/6 of half the rewards = 2/12 of total
    // Second quarter: 2/5 of total stake, so gets 2/5 of quarter the rewards = 2/20 of total
    // Total for user2: 2/12 + 2/20 = 10/60 + 6/60 = 16/60 = 4/15 of total
    const user2TotalRewards = (REWARD_AMOUNT * 4n) / 15n;

    // Process claim event for user2
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: user2TotalRewards.toString(),
      },
      timestamp: secondsToMicros(threeQuartersTime),
    });

    // Unsubscribe user2 (medium stake)
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(threeQuartersTime),
    });

    // Verify state after user2 unsubscribes
    const user1SubscriptionAfter2 = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const user2SubscriptionAfter2 = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    const user3SubscriptionAfter2 = await multiRewardsTestReader.getUserSubscription(user3Address, poolAddress);

    assert(
      user1SubscriptionAfter2 && !user1SubscriptionAfter2.is_currently_subscribed,
      "User1 should remain unsubscribed",
    );
    assert(user2SubscriptionAfter2 && !user2SubscriptionAfter2.is_currently_subscribed, "User2 should be unsubscribed");
    assert(
      user3SubscriptionAfter2 && user3SubscriptionAfter2.is_currently_subscribed,
      "User3 should still be subscribed",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 3n, // Only user3 remains with 3x
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      claimCount: 2,
    });

    // Finish the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Update unsubscription count
    module = await multiRewardsTestReader.getModule();
    unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Calculate user3's rewards
    // First half: 3/6 of total stake, so gets 3/6 of half the rewards = 3/12 = 1/4 of total
    // Second quarter: 3/5 of total stake, so gets 3/5 of quarter the rewards = 3/20 of total
    // Last quarter: All of the stake, so gets all of quarter the rewards = 1/4 of total
    // Total for user3: 1/4 + 3/20 + 1/4 = 5/20 + 3/20 + 5/20 = 13/20 of total
    const user3TotalRewards = (REWARD_AMOUNT * 13n) / 20n;

    // Process claim event for user3
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user3Address,
        reward_token: { inner: rewardToken },
        reward_amount: user3TotalRewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Unsubscribe user3 (highest stake)
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: user3Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(endTime),
    });

    // Verify final state
    const user1SubscriptionFinal = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const user2SubscriptionFinal = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    const user3SubscriptionFinal = await multiRewardsTestReader.getUserSubscription(user3Address, poolAddress);

    assert(
      user1SubscriptionFinal && !user1SubscriptionFinal.is_currently_subscribed,
      "User1 should remain unsubscribed",
    );
    assert(
      user2SubscriptionFinal && !user2SubscriptionFinal.is_currently_subscribed,
      "User2 should remain unsubscribed",
    );
    assert(user3SubscriptionFinal && !user3SubscriptionFinal.is_currently_subscribed, "User3 should be unsubscribed");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n, // No users remaining
      subscriberCount: 0,
      rewardTokens: [rewardToken],
      claimCount: 3,
    });

    // Verify rewards claimed by each user
    const user1ClaimEvents = await verifyClaimEvents(service, poolAddress, user1Address, rewardToken, 1);
    const user2ClaimEvents = await verifyClaimEvents(service, poolAddress, user2Address, rewardToken, 1);
    const user3ClaimEvents = await verifyClaimEvents(service, poolAddress, user3Address, rewardToken, 1);

    assert.strictEqual(
      user1ClaimEvents[0].claim_amount,
      user1FirstHalfRewards,
      "User1 claim amount should match expected rewards",
    );

    assert.strictEqual(
      user2ClaimEvents[0].claim_amount,
      user2TotalRewards,
      "User2 claim amount should match expected rewards",
    );

    assert.strictEqual(
      user3ClaimEvents[0].claim_amount,
      user3TotalRewards,
      "User3 claim amount should match expected rewards",
    );

    // Verify total rewards distributed is approximately equal to REWARD_AMOUNT
    const totalDistributed = user1FirstHalfRewards + user2TotalRewards + user3TotalRewards;
    assertApproxEqualBigInt(
      totalDistributed,
      REWARD_AMOUNT,
      2n,
      "Total distributed rewards should equal REWARD_AMOUNT",
    );

    // Verify unsubscription events
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: user1Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(halfwayTime),
      unsubscription_count: 1, // First unsubscription
    });

    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: user2Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(threeQuartersTime),
      unsubscription_count: 2, // Second unsubscription
    });

    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: user3Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(endTime),
      unsubscription_count: 3, // Third unsubscription
    });
  });

  // Test unsubscribing immediately after subscribing
  test("test_unsubscribe_immediately_after_subscribe", async () => {
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

    // User stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial staked balance
    const userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert(userStakedBalance, "User staked balance should exist");
    assert.strictEqual(userStakedBalance.amount, STAKE_AMOUNT, "User should have staked STAKE_AMOUNT");

    // Track subscription count
    let module = await multiRewardsTestReader.getModule();
    const subscriptionCount = (module?.subscription_count || 0) + 1;

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

    // Verify subscription state
    const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscription, "User subscription should exist");
    assert(userSubscription.is_currently_subscribed, "User should be subscribed after subscription event");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Verify subscription event was emitted
    await verifySubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(startTime),
      subscription_count: subscriptionCount,
    });

    // Track unsubscription count
    module = await multiRewardsTestReader.getModule();
    const unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Unsubscribe immediately
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify unsubscription state
    const userSubscriptionAfter = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscriptionAfter, "User subscription should still exist");
    assert(!userSubscriptionAfter.is_currently_subscribed, "User should be unsubscribed after unsubscription event");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken],
    });

    // Verify staked balance remains unchanged
    const userStakedBalanceAfter = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert(userStakedBalanceAfter, "User staked balance should still exist");
    assert.strictEqual(userStakedBalanceAfter.amount, STAKE_AMOUNT, "User staked balance should remain unchanged");

    // Verify unsubscription event was emitted
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(startTime),
      unsubscription_count: unsubscriptionCount,
    });

    // Notify rewards after unsubscription
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

    // Fast forward through reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Verify user is still unsubscribed and didn't earn any rewards
    const finalUserSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      finalUserSubscription && !finalUserSubscription.is_currently_subscribed,
      "User should remain unsubscribed after reward period",
    );

    // Since the user unsubscribed immediately, no rewards should have been claimed
    const claimEvents = await service.store.list(MRRewardClaimedEvent, [
      { field: "userID", op: "=", value: userAddress },
    ]);
    assert.strictEqual(claimEvents.length, 0, "No rewards should have been claimed");
  });

  // Test unsubscribing during active reward notification
  test("test_unsubscribe_during_active_reward_notification", async () => {
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

    // Set up users with staking tokens and subscribe them to the pool
    for (const userAddress of [user1Address, user2Address]) {
      // User stakes tokens
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
    }

    // Verify initial state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 2n,
      subscriberCount: 2,
      rewardTokens: [rewardToken],
    });

    // Notify initial rewards
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

    // Let half of the reward period pass
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Check accrued rewards before second notification
    // Each user has 1/2 of total stake and earns for half the period, so each gets 1/4 of total
    const user1EarnedBefore = REWARD_AMOUNT / 4n;
    const user2EarnedBefore = REWARD_AMOUNT / 4n;

    // Process claim event for user1
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: user1EarnedBefore.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Process claim event for user2
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: user2EarnedBefore.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Notify additional rewards
    // On the new notify_reward_amount, leftover rewards from previous period (REWARD_AMOUNT/2)
    // are combined with new rewards, so 1.5 * REWARD_AMOUNT will be distributed over new period
    const newPeriodFinish = halfwayTime + Number(REWARD_DURATION);
    const newRewardRate = ((REWARD_AMOUNT + REWARD_AMOUNT / 2n) * U12_PRECISION) / REWARD_DURATION;

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: newRewardRate.toString(),
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Track unsubscription count
    const module = await multiRewardsTestReader.getModule();
    const unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Unsubscribe user1 immediately after new reward notification
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify state after user1 unsubscribes
    const user1SubscriptionAfter = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const user2SubscriptionAfter = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);

    assert(user1SubscriptionAfter && !user1SubscriptionAfter.is_currently_subscribed, "User1 should be unsubscribed");
    assert(
      user2SubscriptionAfter && user2SubscriptionAfter.is_currently_subscribed,
      "User2 should still be subscribed",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      claimCount: 2,
    });

    // Verify user1's rewards were claimed correctly (just the first period's rewards)
    const user1ClaimEvents = await verifyClaimEvents(service, poolAddress, user1Address, rewardToken, 1);
    assert.strictEqual(
      user1ClaimEvents[0].claim_amount,
      user1EarnedBefore,
      "User1 should claim rewards from first period only",
    );

    // Let the rest of the reward period pass
    const newPeriodEndTime = halfwayTime + Number(REWARD_DURATION);

    // For user2, they get all the second period rewards (100% of 1.5 * REWARD_AMOUNT)
    const user2SecondPeriodRewards = (REWARD_AMOUNT * 3n) / 2n;

    // Process claim event for user2
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: user2SecondPeriodRewards.toString(),
      },
      timestamp: secondsToMicros(newPeriodEndTime),
    });

    // Unsubscribe user2
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(newPeriodEndTime),
    });

    // Verify final state
    const user1SubscriptionFinal = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const user2SubscriptionFinal = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);

    assert(
      user1SubscriptionFinal && !user1SubscriptionFinal.is_currently_subscribed,
      "User1 should remain unsubscribed",
    );
    assert(user2SubscriptionFinal && !user2SubscriptionFinal.is_currently_subscribed, "User2 should be unsubscribed");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken],
      claimCount: 3, // 2 from halfway + 1 from end
    });

    // Verify user2's total rewards
    const user2ClaimEvents = await verifyClaimEvents(service, poolAddress, user2Address, rewardToken, 2);

    // User2's total claims should be from both periods (1/4 of initial REWARD_AMOUNT + 3/2 of REWARD_AMOUNT)
    const user2TotalClaimed = user2EarnedBefore + user2SecondPeriodRewards;

    // Sum up the claim amounts from events
    const user2ActualClaimed = user2ClaimEvents.reduce((sum, event) => sum + event.claim_amount, 0n);

    assert.strictEqual(user2ActualClaimed, user2TotalClaimed, "User2 should have claimed from both periods");

    // Verify total rewards distributed
    const totalDistributed = user1EarnedBefore + user2TotalClaimed;
    const expectedTotalDistributed = REWARD_AMOUNT / 2n + (REWARD_AMOUNT * 3n) / 2n;

    assertApproxEqualBigInt(
      totalDistributed,
      expectedTotalDistributed,
      2n,
      "Total distributed rewards should match expected amount",
    );

    // Verify unsubscription events
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: user1Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(halfwayTime),
      unsubscription_count: unsubscriptionCount,
    });

    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: user2Address,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(newPeriodEndTime),
      unsubscription_count: unsubscriptionCount + 1,
    });
  });

  // Test unsubscribing with multiple reward tokens
  test("test_unsubscribe_with_multiple_reward_tokens", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken1 = generateRandomAddress();
    const rewardToken2 = generateRandomAddress();
    const rewardToken3 = generateRandomAddress();
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

    // Add multiple reward tokens to the pool with different durations
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken1 },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(), // Standard duration
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken2 },
        rewards_distributor: adminAddress,
        rewards_duration: (REWARD_DURATION * 2n).toString(), // Double duration
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken3 },
        rewards_distributor: adminAddress,
        rewards_duration: (REWARD_DURATION / 2n).toString(), // Half duration
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes tokens
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

    // Verify initial state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken1, rewardToken2, rewardToken3],
    });

    // Calculate reward rates for each token
    const rewardRate1 = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
    const rewardRate2 = (REWARD_AMOUNT * U12_PRECISION) / (REWARD_DURATION * 2n);
    const rewardRate3 = (REWARD_AMOUNT * U12_PRECISION) / (REWARD_DURATION / 2n);

    // Calculate period finish timestamps
    const periodFinish1 = startTime + Number(REWARD_DURATION);
    const periodFinish2 = startTime + Number(REWARD_DURATION * 2n);
    const periodFinish3 = startTime + Number(REWARD_DURATION / 2n);

    // Notify rewards for all tokens
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: rewardRate1.toString(),
        period_finish: periodFinish1.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: rewardRate2.toString(),
        period_finish: periodFinish2.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken3 },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: rewardRate3.toString(),
        period_finish: periodFinish3.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Let half of the shortest reward duration pass (REWARD_DURATION / 4)
    const quarterDurationTime = startTime + Number(REWARD_DURATION) / 4;

    // Track unsubscription count
    const module = await multiRewardsTestReader.getModule();
    const unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Calculate expected rewards for each token at quarter duration
    // - Token1 (standard duration): 1/4 of REWARD_AMOUNT
    // - Token2 (double duration): 1/8 of REWARD_AMOUNT
    // - Token3 (half duration): 1/2 of REWARD_AMOUNT
    const expectedReward1 = REWARD_AMOUNT / 4n;
    const expectedReward2 = REWARD_AMOUNT / 8n;
    const expectedReward3 = REWARD_AMOUNT / 2n;

    // Process claim events for all tokens
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: expectedReward1.toString(),
      },
      timestamp: secondsToMicros(quarterDurationTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: expectedReward2.toString(),
      },
      timestamp: secondsToMicros(quarterDurationTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken3 },
        reward_amount: expectedReward3.toString(),
      },
      timestamp: secondsToMicros(quarterDurationTime),
    });

    // Unsubscribe user
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(quarterDurationTime),
    });

    // Verify post-unsubscription state
    const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscription && !userSubscription.is_currently_subscribed, "User should be unsubscribed");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken1, rewardToken2, rewardToken3],
      claimCount: 3, // One claim per reward token
    });

    // Verify reward claims for each token
    const claims1 = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken1, 1);
    const claims2 = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken2, 1);
    const claims3 = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken3, 1);

    assert.strictEqual(claims1[0].claim_amount, expectedReward1, "Token1 reward claim amount should match");
    assert.strictEqual(claims2[0].claim_amount, expectedReward2, "Token2 reward claim amount should match");
    assert.strictEqual(claims3[0].claim_amount, expectedReward3, "Token3 reward claim amount should match");

    // Verify remaining rewards in each pool
    const rewardData1 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken1);
    const rewardData2 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken2);
    const rewardData3 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken3);

    assert(rewardData1, "Expected rewardData1");
    assert(rewardData2, "Expected rewardData2");
    assert(rewardData3, "Expected rewardData3");

    // Remaining rewards should be:
    // - Token1: 3/4 of REWARD_AMOUNT
    // - Token2: 7/8 of REWARD_AMOUNT
    // - Token3: 1/2 of REWARD_AMOUNT
    assertApproxEqualBigInt(
      rewardData1.reward_balance,
      REWARD_AMOUNT - expectedReward1,
      1n,
      "Remaining rewards for token1 should match",
    );
    assertApproxEqualBigInt(
      rewardData2.reward_balance,
      REWARD_AMOUNT - expectedReward2,
      1n,
      "Remaining rewards for token2 should match",
    );
    assertApproxEqualBigInt(
      rewardData3.reward_balance,
      REWARD_AMOUNT - expectedReward3,
      1n,
      "Remaining rewards for token3 should match",
    );

    // Verify unsubscription event
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(quarterDurationTime),
      unsubscription_count: unsubscriptionCount,
    });

    // Let the rest of the longest reward period pass
    const endTime = startTime + Number(REWARD_DURATION * 2n);

    // Verify user doesn't get any more rewards
    // We do this by making sure the user reward data is deleted on unsubscribe
    for (const rewardToken of [rewardToken1, rewardToken2, rewardToken3]) {
      const userRewardDataId = `${userAddress}-${poolAddress}-${rewardToken}`;
      const userRewardData = await service.store.get(MRUserRewardData, userRewardDataId);
      assert.strictEqual(
        userRewardData,
        undefined,
        `User reward data for ${rewardToken} should be deleted on unsubscribe`,
      );
    }
  });

  // Test unsubscribing after partial withdrawal
  test("test_unsubscribe_after_partial_withdraw", async () => {
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

    // User stakes tokens
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

    // Verify initial state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Verify user's staked balance
    let userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert.strictEqual(userStakedBalance?.amount, STAKE_AMOUNT, "Initial staked balance should match");

    // Notify rewards
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

    // Let half of the reward period pass
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Partially withdraw staked tokens (half of them)
    const withdrawAmount = STAKE_AMOUNT / 2n;

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify state after partial withdrawal
    userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert.strictEqual(
      userStakedBalance?.amount,
      STAKE_AMOUNT - withdrawAmount,
      "Staked balance after withdrawal should be reduced",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT - withdrawAmount,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      withdrawalCount: 1,
    });

    // Let a quarter of the reward period pass
    const threeQuartersTime = halfwayTime + Number(REWARD_DURATION) / 4;

    // Calculate expected rewards before unsubscription
    // First half: Full STAKE_AMOUNT for half the duration = REWARD_AMOUNT / 2
    // Third quarter: Half STAKE_AMOUNT for quarter the duration = REWARD_AMOUNT / 4 / 2 = REWARD_AMOUNT / 8
    // Total: REWARD_AMOUNT * (1/2 + 1/8) = REWARD_AMOUNT * 5/8 = REWARD_AMOUNT * 0.625
    const expectedReward = (REWARD_AMOUNT * 5n) / 8n;

    // Process claim event
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedReward.toString(),
      },
      timestamp: secondsToMicros(threeQuartersTime),
    });

    // Track unsubscription count
    const module = await multiRewardsTestReader.getModule();
    const unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Unsubscribe user
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(threeQuartersTime),
    });

    // Verify post-unsubscription state
    const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(userSubscription && !userSubscription.is_currently_subscribed, "User should be unsubscribed");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
      rewardTokens: [rewardToken],
      withdrawalCount: 1,
      claimCount: 1,
    });

    // Verify user's staked balance remains unchanged after unsubscribe
    userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert.strictEqual(
      userStakedBalance?.amount,
      STAKE_AMOUNT - withdrawAmount,
      "Staked balance should remain unchanged after unsubscription",
    );

    // Verify user's rewards
    const claimEvents = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);
    assert.strictEqual(claimEvents[0].claim_amount, expectedReward, "Claim amount should match expected rewards");

    // Verify remaining rewards in the pool
    const rewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardData, "Expected rewardData");
    const expectedRemainingRewards = REWARD_AMOUNT - expectedReward;
    assertApproxEqualBigInt(rewardData.reward_balance, expectedRemainingRewards, 1n, "Remaining rewards should match");

    // Verify unsubscription event
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(threeQuartersTime),
      unsubscription_count: unsubscriptionCount,
    });

    // Let the rest of the reward period pass
    const endTime = startTime + Number(REWARD_DURATION);

    // Verify user doesn't receive any more rewards
    const userRewardDataId = `${userAddress}-${poolAddress}-${rewardToken}`;
    const userRewardData = await service.store.get(MRUserRewardData, userRewardDataId);
    assert.strictEqual(userRewardData, undefined, "User reward data should be deleted after unsubscription");

    // Withdraw remaining staked tokens
    const remainingStake = STAKE_AMOUNT - withdrawAmount;

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: remainingStake.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Verify final staked balance is zero
    userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert.strictEqual(userStakedBalance?.amount, 0n, "Final staked balance should be zero");
  });

  // Test unsubscribing after emergency withdrawal (scenario 1)
  test("test_unsubscribe_after_emergency_withdraw_scenario1", async () => {
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

    // User stakes tokens
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

    // Verify initial state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Notify rewards
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

    // Let some time pass to accrue rewards
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Calculate expected rewards before emergency withdraw
    const earnedBefore = REWARD_AMOUNT / 2n; // Half of the reward amount for half the duration

    // Track emergency withdraw count
    let module = await multiRewardsTestReader.getModule();
    const emergencyWithdrawCount = (module?.emergency_withdraw_count || 0) + 1;

    // Perform emergency withdrawal
    await processor.processEvent({
      name: "EmergencyWithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify state after emergency withdraw
    const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      userSubscription && userSubscription.is_currently_subscribed,
      "User should still be subscribed after emergency withdraw",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n, // Total subscribed should be 0 after emergency withdraw
      subscriberCount: 1, // But subscriber count still 1
      rewardTokens: [rewardToken],
    });

    // Verify user's staked balance is 0
    let userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert.strictEqual(userStakedBalance?.amount, 0n, "User's staked balance should be 0 after emergency withdraw");

    // Check that rewards are still accrued but not claimed
    // In scenario 1, user loses their pending rewards
    const userRewardDataId = `${userAddress}-${poolAddress}-${rewardToken}`;
    let userRewardData = await service.store.get(MRUserRewardData, userRewardDataId);

    // The user reward data might still exist, but unclaimed_rewards should be reset to 0
    if (userRewardData) {
      assert.strictEqual(
        userRewardData.unclaimed_rewards,
        0n,
        "User's unclaimed rewards should be 0 after emergency withdraw",
      );
    }

    // Verify no rewards were claimed
    const claimEventsBefore = await service.store.list(MRRewardClaimedEvent, [
      { field: "userID", op: "=", value: userAddress },
    ]);
    assert.strictEqual(claimEventsBefore.length, 0, "No rewards should be claimed yet");

    // Track unsubscription count
    module = await multiRewardsTestReader.getModule();
    const unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Unsubscribe after emergency withdraw
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify final state
    const userSubscriptionAfter = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      userSubscriptionAfter && !userSubscriptionAfter.is_currently_subscribed,
      "User should be unsubscribed after unsubscription event",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0, // Now subscriber count is 0
      rewardTokens: [rewardToken],
    });

    // Check that no rewards were claimed during unsubscribe
    const claimEventsAfter = await service.store.list(MRRewardClaimedEvent, [
      { field: "userID", op: "=", value: userAddress },
    ]);
    assert.strictEqual(claimEventsAfter.length, 0, "No rewards should be claimed during unsubscription");

    // Verify user's staked balance remains 0
    userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert.strictEqual(userStakedBalance?.amount, 0n, "User's staked balance should remain 0");

    // Verify user reward data is removed
    userRewardData = await service.store.get(MRUserRewardData, userRewardDataId);
    assert.strictEqual(userRewardData, undefined, "User reward data should be deleted after unsubscription");

    // Verify events
    // Verify emergency withdraw event
    // Note: No direct event verification helper for EmergencyWithdrawEvent exists,
    // so we rely on indirect verification through state changes

    // Verify unsubscription event
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(halfwayTime),
      unsubscription_count: unsubscriptionCount,
    });
  });

  // Test unsubscribing after emergency withdrawal (scenario 2)
  test("test_unsubscribe_after_emergency_withdraw_scenario2", async () => {
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

    // User stakes tokens
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

    // Verify initial state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Notify rewards
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

    // Let some time pass to accrue rewards
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Calculate expected rewards
    const earnedBefore = REWARD_AMOUNT / 2n; // Half of the reward amount for half the duration

    // Withdraw just 1 unit to trigger accumulation of "pending" rewards
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "1",
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify user's staked balance after small withdrawal
    let userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert.strictEqual(userStakedBalance?.amount, STAKE_AMOUNT - 1n, "User's staked balance should be reduced by 1");

    // Track emergency withdraw count
    let module = await multiRewardsTestReader.getModule();
    const emergencyWithdrawCount = (module?.emergency_withdraw_count || 0) + 1;

    // Perform emergency withdrawal
    await processor.processEvent({
      name: "EmergencyWithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT - 1n).toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify state after emergency withdraw
    const userSubscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      userSubscription && userSubscription.is_currently_subscribed,
      "User should still be subscribed after emergency withdraw",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n, // Total subscribed should be 0 after emergency withdraw
      subscriberCount: 1, // But subscriber count still 1
      rewardTokens: [rewardToken],
      withdrawalCount: 1, // One regular withdrawal
    });

    // Verify user's staked balance is 0
    userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert.strictEqual(userStakedBalance?.amount, 0n, "User's staked balance should be 0 after emergency withdraw");

    // Check that rewards are still accrued but not claimed
    // In scenario 2, user preserves their pending rewards
    const userRewardDataId = `${userAddress}-${poolAddress}-${rewardToken}`;
    let userRewardData = await service.store.get(MRUserRewardData, userRewardDataId);

    // The user reward data should exist with pending rewards
    assert(userRewardData, "User reward data should exist after emergency withdraw");
    assertApproxEqualBigInt(
      userRewardData.unclaimed_rewards,
      earnedBefore,
      1n,
      "User should have unclaimed rewards after emergency withdraw in scenario 2",
    );

    // Track unsubscription count
    module = await multiRewardsTestReader.getModule();
    const unsubscriptionCount = (module?.unsubscription_count || 0) + 1;

    // Process claim event
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: earnedBefore.toString(),
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Unsubscribe after emergency withdraw
    await processor.processEvent({
      name: "UnsubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Verify final state
    const userSubscriptionAfter = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      userSubscriptionAfter && !userSubscriptionAfter.is_currently_subscribed,
      "User should be unsubscribed after unsubscription event",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0, // Now subscriber count is 0
      rewardTokens: [rewardToken],
      withdrawalCount: 1,
      claimCount: 1, // One claim event
    });

    // Verify rewards were claimed
    const claimEvents = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);
    assert.strictEqual(claimEvents[0].claim_amount, earnedBefore, "Claim amount should match expected rewards");

    // Verify user's staked balance remains 0
    userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert.strictEqual(userStakedBalance?.amount, 0n, "User's staked balance should remain 0");

    // Verify user reward data is removed
    userRewardData = await service.store.get(MRUserRewardData, userRewardDataId);
    assert.strictEqual(userRewardData, undefined, "User reward data should be deleted after unsubscription");

    // Verify unsubscription event
    await verifyUnsubscriptionEvent(multiRewardsTestReader, {
      user: userAddress,
      pool_address: poolAddress,
      staking_token: stakingToken,
      timestamp: secondsToMicros(halfwayTime),
      unsubscription_count: unsubscriptionCount,
    });
  });
});
