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

describe("Set Rewards Duration", async () => {
  const service = new TestProcessorServer(() => import("../multi-rewards-processor.js"));
  const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);

  // Constants from the Move tests
  const INITIAL_REWARD_DURATION = 86400n; // 1 day in seconds
  const NEW_REWARD_DURATION = 172800n; // 2 days in seconds
  const NEW_REWARD_DURATION_1 = 172800n; // 2 days in seconds
  const NEW_REWARD_DURATION_2 = 259200n; // 3 days in seconds
  const THIRD_REWARD_DURATION = 259200n; // 3 days in seconds
  const INITIAL_REWARD_AMOUNT = 1000000n; // 1 million tokens
  const STAKE_AMOUNT = 100000n; // 100,000 tokens
  const REWARD_AMOUNT = 1000000n; // 1 million tokens
  const U12_PRECISION = 1_000_000_000_000n; // 1e12

  before(async () => {
    await service.start();
  });

  afterEach(async () => {
    service.db.reset();
  });

  test("test_set_rewards_duration_success", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Create the staking pool
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
        rewards_duration: INITIAL_REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime + 1),
    });

    // User stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime + 2),
    });

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 3),
    });

    // Notify initial rewards
    const initialRewardAmount = 100000n;
    const periodFinish = startTime + Number(INITIAL_REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: initialRewardAmount.toString(),
        reward_rate: ((initialRewardAmount * U12_PRECISION) / INITIAL_REWARD_DURATION).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime + 4),
    });

    // Verify initial reward data
    const initialRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(initialRewardData, "Initial reward data should exist");
    assert.strictEqual(initialRewardData.duration, INITIAL_REWARD_DURATION, "Initial duration should match");
    assert.strictEqual(initialRewardData.distributor, adminAddress, "Distributor should match");

    // Fast forward to after the reward period ends
    const afterPeriodTime = periodFinish + 10;

    // Set new rewards duration
    await processor.processEvent({
      name: "RewardsDurationUpdatedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        new_duration: NEW_REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(afterPeriodTime),
    });

    // Verify the duration was updated
    const updatedRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(updatedRewardData, "Updated reward data should exist");
    assert.strictEqual(
      updatedRewardData.duration,
      NEW_REWARD_DURATION,
      "Reward duration should be updated to the new value",
    );

    // Verify other reward data remains unchanged
    assert.strictEqual(updatedRewardData.distributor, adminAddress, "Distributor should remain unchanged");

    // Verify the module statistics were updated
    const module = await multiRewardsTestReader.getModule();
    assert(module, "Module should exist");
    assert(module.update_duration_count > 0, "update_duration_count should be incremented");

    // Get staking pool to check it's still valid
    const pool = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(pool, "Pool should still exist after duration update");
    assert(pool.reward_tokens.includes(rewardToken), "Pool should still have the reward token");
  });

  test("test_set_rewards_duration_multiple_tokens", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken1 = generateRandomAddress();
    const rewardToken2 = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Create the staking pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add first reward token to the pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken1 },
        rewards_distributor: adminAddress,
        rewards_duration: INITIAL_REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add second reward token to the pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken2 },
        rewards_distributor: adminAddress,
        rewards_duration: INITIAL_REWARD_DURATION.toString(),
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

    // Notify rewards for first token
    const initialRewardAmount = 100000n;
    const periodFinish = startTime + Number(INITIAL_REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: initialRewardAmount.toString(),
        reward_rate: ((initialRewardAmount * U12_PRECISION) / INITIAL_REWARD_DURATION).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Notify rewards for second token
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: initialRewardAmount.toString(),
        reward_rate: ((initialRewardAmount * U12_PRECISION) / INITIAL_REWARD_DURATION).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial reward data for both tokens
    const initialRewardData1 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken1);
    const initialRewardData2 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken2);

    assert(initialRewardData1, "Initial reward data for token 1 should exist");
    assert(initialRewardData2, "Initial reward data for token 2 should exist");

    assert.strictEqual(
      initialRewardData1.duration,
      INITIAL_REWARD_DURATION,
      "Initial duration for token 1 should match",
    );
    assert.strictEqual(
      initialRewardData2.duration,
      INITIAL_REWARD_DURATION,
      "Initial duration for token 2 should match",
    );

    // Fast forward to after the reward period ends
    const afterPeriodTime = periodFinish + 10;

    // Set new rewards duration for first token
    await processor.processEvent({
      name: "RewardsDurationUpdatedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken1 },
        new_duration: NEW_REWARD_DURATION_1.toString(),
      },
      timestamp: secondsToMicros(afterPeriodTime),
    });

    // Set new rewards duration for second token
    await processor.processEvent({
      name: "RewardsDurationUpdatedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken2 },
        new_duration: NEW_REWARD_DURATION_2.toString(),
      },
      timestamp: secondsToMicros(afterPeriodTime),
    });

    // Verify the durations were updated for both tokens
    const updatedRewardData1 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken1);
    const updatedRewardData2 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken2);

    assert(updatedRewardData1, "Updated reward data for token 1 should exist");
    assert(updatedRewardData2, "Updated reward data for token 2 should exist");

    assert.strictEqual(
      updatedRewardData1.duration,
      NEW_REWARD_DURATION_1,
      "Reward duration for token 1 should be updated to the new value",
    );

    assert.strictEqual(
      updatedRewardData2.duration,
      NEW_REWARD_DURATION_2,
      "Reward duration for token 2 should be updated to the new value",
    );

    // Verify other reward data remains unchanged
    assert.strictEqual(updatedRewardData1.distributor, adminAddress, "Distributor for token 1 should remain unchanged");

    assert.strictEqual(updatedRewardData2.distributor, adminAddress, "Distributor for token 2 should remain unchanged");

    // Verify the module statistics were updated
    const module = await multiRewardsTestReader.getModule();
    assert(module, "Module should exist");
    assert.strictEqual(module.update_duration_count, 2, "update_duration_count should be incremented twice");

    // Verify the pool still has both reward tokens
    const pool = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(pool, "Pool should still exist after duration updates");
    assert(pool.reward_tokens.includes(rewardToken1), "Pool should still have reward token 1");
    assert(pool.reward_tokens.includes(rewardToken2), "Pool should still have reward token 2");
  });

  test("test_set_rewards_duration_effect_on_rewards", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Create the staking pool
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
        rewards_duration: INITIAL_REWARD_DURATION.toString(),
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

    // Notify a small initial reward amount (we'll notify more after changing duration)
    const initialRewardAmount = 1000n; // Small amount to establish the period
    const periodFinish = startTime + Number(INITIAL_REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: initialRewardAmount.toString(),
        reward_rate: ((initialRewardAmount * U12_PRECISION) / INITIAL_REWARD_DURATION).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Fast forward to after the initial reward period ends
    const afterPeriodTime = periodFinish + 10;

    // Update rewards by simulating a zero-amount withdrawal to ensure all state is updated
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(afterPeriodTime),
    });

    // Get user's reward data before changing duration
    const userRewardDataBeforeDurationChange = await multiRewardsTestReader.getUserRewardData(
      userAddress,
      poolAddress,
      rewardToken,
    );

    // Set new rewards duration
    await processor.processEvent({
      name: "RewardsDurationUpdatedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        new_duration: NEW_REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(afterPeriodTime),
    });

    // Verify the duration was updated
    const updatedRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(updatedRewardData, "Updated reward data should exist");
    assert.strictEqual(
      updatedRewardData.duration,
      NEW_REWARD_DURATION,
      "Reward duration should be updated to the new value",
    );

    // Notify new rewards with the new duration
    const newPeriodFinish = afterPeriodTime + Number(NEW_REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: INITIAL_REWARD_AMOUNT.toString(),
        reward_rate: ((INITIAL_REWARD_AMOUNT * U12_PRECISION) / NEW_REWARD_DURATION).toString(),
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(afterPeriodTime),
    });

    // Verify the reward rate has been updated
    const rewardDataAfterNotify = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    const expectedRewardRate = (INITIAL_REWARD_AMOUNT * U12_PRECISION) / NEW_REWARD_DURATION;
    assertApproxEqualBigInt(
      rewardDataAfterNotify!.reward_rate_u12,
      expectedRewardRate,
      100n, // Allow small rounding differences
      "Reward rate should be set based on the new duration",
    );

    // Fast forward to the middle of the new reward period
    const midNewPeriodTime = afterPeriodTime + Number(NEW_REWARD_DURATION) / 2;

    // Update rewards at midpoint
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(midNewPeriodTime),
    });

    // Check user's earned rewards at middle of period
    const userRewardDataMid = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(userRewardDataMid, "Midpoint reward data should exist");

    // User should have earned approximately half of the rewards at midpoint
    const expectedMidRewards = INITIAL_REWARD_AMOUNT / 2n;
    assertApproxEqualBigInt(
      userRewardDataMid.unclaimed_rewards,
      expectedMidRewards,
      expectedMidRewards / 100n, // Allow 1% tolerance
      "User should have earned approximately half of rewards at midpoint",
    );

    // Fast forward to the end of the new reward period
    const endNewPeriodTime = afterPeriodTime + Number(NEW_REWARD_DURATION);

    // Update rewards at end of period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endNewPeriodTime),
    });

    // Check user's final earned rewards
    const userRewardDataEnd = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(userRewardDataEnd, "End of period reward data should exist");

    // User should have earned approximately all of the rewards by the end
    const expectedFinalRewards = INITIAL_REWARD_AMOUNT;
    assertApproxEqualBigInt(
      userRewardDataEnd.unclaimed_rewards,
      expectedFinalRewards,
      expectedFinalRewards / 100n, // Allow 1% tolerance
      "User should have earned approximately all rewards by end of period",
    );

    // Store unclaimed rewards for claim verification
    const unclaimedRewards = userRewardDataEnd.unclaimed_rewards;

    // User claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: unclaimedRewards.toString(),
      },
      timestamp: secondsToMicros(endNewPeriodTime),
    });

    // Verify claim event
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);

    // Verify reward data after claim
    const userRewardDataAfterClaim = await multiRewardsTestReader.getUserRewardData(
      userAddress,
      poolAddress,
      rewardToken,
    );
    assert(userRewardDataAfterClaim, "User reward data should exist after claim");
    assert.strictEqual(
      userRewardDataAfterClaim.unclaimed_rewards,
      0n,
      "User should have no unclaimed rewards after claiming",
    );
    assert.strictEqual(
      userRewardDataAfterClaim.total_claimed,
      unclaimedRewards,
      "User's total_claimed should equal previous unclaimed_rewards",
    );
  });

  test("test_set_rewards_duration_multiple_times", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Create the staking pool
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
        rewards_duration: INITIAL_REWARD_DURATION.toString(),
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

    // Verify initial reward duration
    const initialRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(initialRewardData, "Initial reward data should exist");
    assert.strictEqual(initialRewardData.duration, INITIAL_REWARD_DURATION, "Initial duration should match");

    // Fast forward past the initial period (without distributing rewards yet)
    const firstChangeTime = startTime + Number(INITIAL_REWARD_DURATION) + 10;

    // Change reward duration for the first time
    await processor.processEvent({
      name: "RewardsDurationUpdatedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        new_duration: NEW_REWARD_DURATION.toString(), // 2 days
      },
      timestamp: secondsToMicros(firstChangeTime),
    });

    // Verify the first duration change
    const rewardDataAfterFirstChange = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardDataAfterFirstChange, "Reward data after first change should exist");
    assert.strictEqual(
      rewardDataAfterFirstChange.duration,
      NEW_REWARD_DURATION,
      "Duration should be updated to the first new value",
    );

    // Notify rewards for the first period with new duration
    const firstPeriodFinish = firstChangeTime + Number(NEW_REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: ((REWARD_AMOUNT * U12_PRECISION) / NEW_REWARD_DURATION).toString(),
        period_finish: firstPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(firstChangeTime),
    });

    // Fast forward to the end of first reward period
    const firstPeriodEndTime = firstChangeTime + Number(NEW_REWARD_DURATION) + 10;

    // Update rewards at end of first period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(firstPeriodEndTime),
    });

    // Check user rewards after first period
    const userRewardDataFirstPeriod = await multiRewardsTestReader.getUserRewardData(
      userAddress,
      poolAddress,
      rewardToken,
    );
    assert(userRewardDataFirstPeriod, "User reward data after first period should exist");

    const firstPeriodRewards = userRewardDataFirstPeriod.unclaimed_rewards;
    // User should have earned approximately all the rewards from the first period
    assertApproxEqualBigInt(
      firstPeriodRewards,
      REWARD_AMOUNT,
      REWARD_AMOUNT / 100n, // Allow 1% tolerance
      "User should have earned approximately all rewards from first period",
    );

    // Change reward duration for the second time
    await processor.processEvent({
      name: "RewardsDurationUpdatedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        new_duration: THIRD_REWARD_DURATION.toString(), // 3 days
      },
      timestamp: secondsToMicros(firstPeriodEndTime),
    });

    // Verify the second duration change
    const rewardDataAfterSecondChange = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardDataAfterSecondChange, "Reward data after second change should exist");
    assert.strictEqual(
      rewardDataAfterSecondChange.duration,
      THIRD_REWARD_DURATION,
      "Duration should be updated to the second new value",
    );

    // Notify rewards for the second period with the third duration
    const secondPeriodFinish = firstPeriodEndTime + Number(THIRD_REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: ((REWARD_AMOUNT * U12_PRECISION) / THIRD_REWARD_DURATION).toString(),
        period_finish: secondPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(firstPeriodEndTime),
    });

    // Fast forward to the end of second reward period
    const secondPeriodEndTime = firstPeriodEndTime + Number(THIRD_REWARD_DURATION) + 10;

    // Update rewards at end of second period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(secondPeriodEndTime),
    });

    // Check user's total earned rewards after second period
    const userRewardDataSecondPeriod = await multiRewardsTestReader.getUserRewardData(
      userAddress,
      poolAddress,
      rewardToken,
    );
    assert(userRewardDataSecondPeriod, "User reward data after second period should exist");

    const totalRewards = userRewardDataSecondPeriod.unclaimed_rewards;
    // User should have earned approximately all rewards from both periods
    assertApproxEqualBigInt(
      totalRewards,
      REWARD_AMOUNT * 2n,
      (REWARD_AMOUNT * 2n) / 100n, // Allow 1% tolerance
      "User should have earned approximately all rewards from both periods",
    );

    // User claims their total rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: totalRewards.toString(),
      },
      timestamp: secondsToMicros(secondPeriodEndTime),
    });

    // Verify claim events
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);

    // Verify reward data after claim
    const userRewardDataAfterClaim = await multiRewardsTestReader.getUserRewardData(
      userAddress,
      poolAddress,
      rewardToken,
    );
    assert(userRewardDataAfterClaim, "User reward data should exist after claim");
    assert.strictEqual(
      userRewardDataAfterClaim.unclaimed_rewards,
      0n,
      "User should have no unclaimed rewards after claiming",
    );
    assert.strictEqual(
      userRewardDataAfterClaim.total_claimed,
      totalRewards,
      "User's total_claimed should equal previous total rewards",
    );

    // Verify the module statistics for duration updates
    const module = await multiRewardsTestReader.getModule();
    assert(module, "Module should exist");
    assert.strictEqual(module.update_duration_count, 2, "update_duration_count should be 2 for two duration changes");
  });
});
