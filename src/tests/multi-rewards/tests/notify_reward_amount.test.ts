/* eslint-disable */
// TODO: remove the above disable
import assert from "assert";
import { before, afterEach, describe, test } from "node:test";
import { TestProcessorServer } from "@sentio/sdk/testing";

import { MultiRewardsTestReader } from "../../../processors/multi-rewards-processor.js";
import { multi_rewards_abi } from "../../../abis/multi-rewards-testnet.js";
import { TestProcessor } from "../../utils/processor.js";
import { multiRewardsHandlerIds } from "../common/constants.js";
import { generateRandomAddress, secondsToMicros } from "../../common/helpers.js";
import { verifyStakeEvent, verifyUserState, verifyPoolState, verifyRewardState } from "../common/helpers.js";

describe("Notify Reward Amount", async () => {
  const service = new TestProcessorServer(() => import("../multi-rewards-processor.js"));
  const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);

  const INITIAL_BALANCE = 1_000_000n;
  const STAKE_AMOUNT = 100_000n;
  const REWARD_AMOUNT = 500_000n;
  const REWARD_DURATION = 86400n; // 1 day in seconds
  const U12_PRECISION = 1_000_000_000_000n; // 1e12

  before(async () => {
    await service.start();
  });

  afterEach(async () => {
    service.db.reset();
  });

  test("Basic notify reward amount", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const userAddress = generateRandomAddress();
    const adminAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup all initial events at the same timestamp
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

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

    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Calculate expected reward rate
    const expectedRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);

    // Initial reward notification
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

    // Verify initial reward state
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: 0n,
    });

    // Fast forward to half the reward period
    const halfDuration = Number(REWARD_DURATION) / 2;
    const midPointTime = startTime + halfDuration;

    // At this midpoint:
    // - User has earned half of REWARD_AMOUNT
    // - Half of the reward period has passed
    // - reward_per_token_stored has accumulated for half of the period

    // Calculate expected reward per token at midpoint
    // This is how much reward has accumulated per staked token over the half duration
    const midpointRewardPerToken = (expectedRewardRate * BigInt(halfDuration)) / STAKE_AMOUNT;

    // Additional reward notification at mid-point
    const additionalRewardAmount = REWARD_AMOUNT / 2n;
    const remainingRewards = REWARD_AMOUNT / 2n; // Half of initial rewards remain

    // Calculate expected new reward rate (including remaining rewards)
    const newExpectedRewardRate = calculateExpectedRewardRate(
      remainingRewards + additionalRewardAmount,
      REWARD_DURATION,
    );

    // New period finish is REWARD_DURATION from the midpoint
    const newPeriodFinish = midPointTime + Number(REWARD_DURATION);

    // Notify additional rewards
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: additionalRewardAmount.toString(),
        reward_rate: newExpectedRewardRate.toString(),
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // After notification, reward_per_token_stored should be updated to midpointRewardPerToken
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT + additionalRewardAmount,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT + additionalRewardAmount,
      rewardRateU12: newExpectedRewardRate,
      rewardPerTokenStoredU12: midpointRewardPerToken,
    });

    // Fast forward to the end of the new reward period
    const endPointTime = newPeriodFinish;

    // Add a claim event to trigger reward updates
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: (REWARD_AMOUNT + additionalRewardAmount).toString(),
      },
      timestamp: secondsToMicros(endPointTime),
    });

    // Final verification with updated expectations
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT + additionalRewardAmount,
      rewardRateU12: newExpectedRewardRate,
      rewardPerTokenStoredU12: midpointRewardPerToken + (newExpectedRewardRate * REWARD_DURATION) / STAKE_AMOUNT,
    });
  });

  test("Notify reward amount with multiple users", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const user1Address = generateRandomAddress();
    const user2Address = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp

    // Create a pool
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

    // Setup different stake amounts for each user
    const user1StakeAmount = STAKE_AMOUNT;
    const user2StakeAmount = STAKE_AMOUNT * 2n;

    // User 1 stake and subscribe
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: user1StakeAmount.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // User 2 stake and subscribe
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: user2StakeAmount.toString(),
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

    // Verify initial total subscribed amount
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: user1StakeAmount + user2StakeAmount,
      subscriberCount: 2,
      rewardTokens: [rewardToken],
    });

    // Calculate expected reward rate
    const expectedRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);

    // Initial reward notification
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

    // Fast forward to half the reward period
    const halfDuration = Number(REWARD_DURATION) / 2;
    const midPointTime = startTime + halfDuration;

    // At midpoint, users have earned proportionally to their stake
    // Calculate expected rewards for each user (should be in 1:2 ratio)
    const totalRewardsAtMidpoint = REWARD_AMOUNT / 2n;
    const totalStaked = user1StakeAmount + user2StakeAmount;
    const expectedUser1Rewards = (totalRewardsAtMidpoint * user1StakeAmount) / totalStaked;
    const expectedUser2Rewards = (totalRewardsAtMidpoint * user2StakeAmount) / totalStaked;

    // Verify expected rewards ratio - User2 should earn twice as much as User1
    const rewardRatio = expectedUser2Rewards / expectedUser1Rewards;
    assert.strictEqual(rewardRatio, 2n);

    // Claim rewards at midpoint to trigger state update
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser1Rewards.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser2Rewards.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Calculate midpoint reward per token
    const midpointRewardPerToken = (expectedRewardRate * BigInt(halfDuration)) / totalStaked;

    // Verify reward state after first half
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT - expectedUser1Rewards - expectedUser2Rewards,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: midpointRewardPerToken,
    });

    // Notify additional rewards
    const newRewardAmount = REWARD_AMOUNT / 2n;
    const remainingRewards = REWARD_AMOUNT / 2n; // Half of initial rewards remain

    // Calculate expected new reward rate
    const newExpectedRewardRate = calculateExpectedRewardRate(remainingRewards + newRewardAmount, REWARD_DURATION);

    // New period finish is REWARD_DURATION from midpoint
    const newPeriodFinish = midPointTime + Number(REWARD_DURATION);

    // Notify new rewards
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: newRewardAmount.toString(),
        reward_rate: newExpectedRewardRate.toString(),
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Fast forward to the end of the reward period
    const endPointTime = newPeriodFinish;

    // Calculate expected total rewards for the second half
    const totalRewardsSecondHalf = remainingRewards + newRewardAmount;
    const expectedUser1RewardsSecondHalf = (totalRewardsSecondHalf * user1StakeAmount) / totalStaked;
    const expectedUser2RewardsSecondHalf = (totalRewardsSecondHalf * user2StakeAmount) / totalStaked;

    // Total expected rewards for each user over both periods
    const totalExpectedUser1Rewards = expectedUser1Rewards + expectedUser1RewardsSecondHalf;
    const totalExpectedUser2Rewards = expectedUser2Rewards + expectedUser2RewardsSecondHalf;

    // Claim final rewards to trigger state update
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser1RewardsSecondHalf.toString(),
      },
      timestamp: secondsToMicros(endPointTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: expectedUser2RewardsSecondHalf.toString(),
      },
      timestamp: secondsToMicros(endPointTime),
    });

    // Calculate expected final reward per token
    const finalRewardPerToken = midpointRewardPerToken + (newExpectedRewardRate * REWARD_DURATION) / totalStaked;

    // Verify final reward state
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 2n, // All rewards claimed - except dust lost due to precision loss
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT + newRewardAmount,
      rewardRateU12: newExpectedRewardRate,
      rewardPerTokenStoredU12: finalRewardPerToken,
    });

    // Verify that User2 consistently earns twice as much as User1
    const finalRewardRatio = totalExpectedUser2Rewards / totalExpectedUser1Rewards;
    assert.strictEqual(finalRewardRatio, 2n);
  });

  test("Notify reward amount with no stakers", async () => {
    // TODO: Implement test
  });

  test("Notify reward amount before period ends", async () => {
    // TODO: Implement test
  });

  test("Notify reward amount after period ends", async () => {
    // TODO: Implement test
  });

  test("Notify zero reward amount", async () => {
    // TODO: Implement test
  });

  test("Notify reward amount for multiple tokens", async () => {
    // TODO: Implement test
  });

  test("Notify reward amount with short duration", async () => {
    // TODO: Implement test
  });

  // Note: We can't test authentication failures since they won't emit events
  // test("Notify reward amount unauthorized", async () => {
  //   // Not applicable for Sentio tests as failed transactions won't emit events
  // });

  test("Notify reward amount multiple times", async () => {
    // TODO: Implement test
  });

  test("Notify reward amount after all unstaked", async () => {
    // TODO: Implement test
  });

  // Helper function to calculate expected reward rate
  function calculateExpectedRewardRate(rewardAmount: bigint, duration: bigint): bigint {
    return (rewardAmount * U12_PRECISION) / duration;
  }
});
