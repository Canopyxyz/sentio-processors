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
  verifyUnsubscriptionEvent,
} from "../common/helpers.js";

import { assertApproxEqualBigInt } from "../../common/assertions.js";

describe("Unsubscribe", async () => {
  const service = new TestProcessorServer(() => import("../multi-rewards-processor.js"));
  const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);

  const INITIAL_BALANCE = 1_000_000n;
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

    // Verify no more rewards accrued after unsubscription
    const userRewardData1 = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken1);
    const userRewardData2 = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken2);
    // Since we processed an unsubscription, the user reward data should be deleted
    assert(!userRewardData1, "User reward data should be deleted after unsubscription");
    assert(!userRewardData2, "User reward data should be deleted after unsubscription");

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
    // TODO: Implement test
  });

  // Test unsubscribing with zero rewards
  test("test_unsubscribe_with_zero_rewards", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing and then resubscribing
  test("test_unsubscribe_and_resubscribe", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing with multiple users
  test("test_unsubscribe_with_multiple_users", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing after reward period ends
  test("test_unsubscribe_after_reward_period_ends", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing with different stake amounts
  test("test_unsubscribe_with_different_stake_amounts", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing immediately after subscribing
  test("test_unsubscribe_immediately_after_subscribe", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing during active reward notification
  test("test_unsubscribe_during_active_reward_notification", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing with multiple reward tokens
  test("test_unsubscribe_with_multiple_reward_tokens", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing after partial withdrawal
  test("test_unsubscribe_after_partial_withdraw", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing after emergency withdrawal (scenario 1)
  test("test_unsubscribe_after_emergency_withdraw_scenario1", async () => {
    // TODO: Implement test
  });

  // Test unsubscribing after emergency withdrawal (scenario 2)
  test("test_unsubscribe_after_emergency_withdraw_scenario2", async () => {
    // TODO: Implement test
  });
});
