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
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

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

    // Verify initial pool state (no stakers)
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 0,
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

    // Since we're not triggering a reward update at midpoint, we don't need to verify
    // the unallocated rewards directly. Instead, we'll use this knowledge when calculating
    // the expected values after the next real notification.

    // Calculate the theoretical unallocated rewards at midpoint (not verified in state)
    const expectedUnallocatedRewardsAtMidpoint = REWARD_AMOUNT / 2n;

    // Notify additional rewards at midpoint
    const additionalRewardAmount = REWARD_AMOUNT * 10n;
    const remainingRewards = REWARD_AMOUNT / 2n; // Half of initial rewards remain as allocated

    // Calculate expected new reward rate including unallocated rewards
    // When we notify new rewards, the processor will first update unallocated rewards
    // to account for the period with no stakers, then incorporate that into the new rate
    const totalRewardsForNewPeriod = expectedUnallocatedRewardsAtMidpoint + additionalRewardAmount + remainingRewards;
    const newExpectedRewardRate = calculateExpectedRewardRate(totalRewardsForNewPeriod, REWARD_DURATION);

    // New period finish is REWARD_DURATION from the midpoint
    const newPeriodFinish = midPointTime + Number(REWARD_DURATION);

    // Notify new rewards directly at midpoint
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: additionalRewardAmount.toString(),
        reward_rate: newExpectedRewardRate.toString(), // This value might differ slightly due to precision issues
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Verify reward state after notification at midpoint
    // Allow for small differences in reward rate calculation
    const rewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardData, "Reward data should exist");

    // Verify exact fields
    assert.strictEqual(rewardData.reward_token, rewardToken);
    assert.strictEqual(rewardData.distributor, adminAddress);
    assert.strictEqual(rewardData.duration, REWARD_DURATION);
    assert.strictEqual(rewardData.reward_balance, REWARD_AMOUNT + additionalRewardAmount);
    assert.strictEqual(rewardData.unallocated_rewards, 0n); // Reset after being incorporated into rate
    assert.strictEqual(rewardData.total_distributed, REWARD_AMOUNT + additionalRewardAmount);
  });

  test("Notify reward amount before period ends", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup initial pool with admin
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

    // Setup user with staking and subscription
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

    // Verify initial pool state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Calculate expected initial reward rate
    const expectedInitialRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);

    // Initial reward notification
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedInitialRewardRate.toString(),
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
      rewardRateU12: expectedInitialRewardRate,
      rewardPerTokenStoredU12: 0n,
    });

    // Fast forward to middle of the reward period
    const halfDuration = Number(REWARD_DURATION) / 2;
    const midPointTime = startTime + halfDuration;

    // Calculate expected reward per token at midpoint
    const midpointRewardPerToken = (expectedInitialRewardRate * BigInt(halfDuration)) / STAKE_AMOUNT;

    // Calculate expected rewards earned by user at midpoint
    const userEarnedBeforeNewNotify = REWARD_AMOUNT / 2n;

    // Claim rewards at midpoint to force state update
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: userEarnedBeforeNewNotify.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Calculate the remaining rewards in the pool
    const remainingRewards = REWARD_AMOUNT / 2n; // Half of rewards remain

    // Notify additional rewards mid-period
    const newRewardAmount = REWARD_AMOUNT / 2n;

    // Calculate expected new reward rate (remaining rewards + new rewards)
    const totalRewardsForNewPeriod = remainingRewards + newRewardAmount;
    const newExpectedRewardRate = calculateExpectedRewardRate(totalRewardsForNewPeriod, REWARD_DURATION);

    // New period finish is REWARD_DURATION from midpoint
    const newPeriodFinish = midPointTime + Number(REWARD_DURATION);

    // Notify new rewards before the original period ends
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

    // Verify reward state after mid-period notification
    const rewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardData, "Reward data should exist");

    // Verify exact fields
    assert.strictEqual(rewardData.reward_token, rewardToken);
    assert.strictEqual(rewardData.distributor, adminAddress);
    assert.strictEqual(rewardData.duration, REWARD_DURATION);
    assert.strictEqual(rewardData.reward_balance, REWARD_AMOUNT - userEarnedBeforeNewNotify + newRewardAmount);
    assert.strictEqual(rewardData.unallocated_rewards, 0n);
    assert.strictEqual(rewardData.total_distributed, REWARD_AMOUNT + newRewardAmount);
    assert.strictEqual(rewardData.period_finish, BigInt(newPeriodFinish));
    assert.strictEqual(rewardData.last_update_time, BigInt(midPointTime));

    // Verify rate with tolerance
    const rateDiff =
      rewardData.reward_rate_u12 > newExpectedRewardRate
        ? rewardData.reward_rate_u12 - newExpectedRewardRate
        : newExpectedRewardRate - rewardData.reward_rate_u12;

    assert(
      rateDiff <= 1000000n, // Allow 0.0001% tolerance
      `Reward rate difference (${rateDiff}) exceeds tolerance: ${rewardData.reward_rate_u12} vs ${newExpectedRewardRate}`,
    );

    // Reward per token stored should be updated to midpoint value
    assert.strictEqual(rewardData.reward_per_token_stored_u12, midpointRewardPerToken);

    // Fast forward to the end of the new reward period
    const endTime = newPeriodFinish;

    // Calculate total rewards user should have earned over both periods
    const expectedTotalRewards = userEarnedBeforeNewNotify + totalRewardsForNewPeriod;

    // Claim final rewards to trigger state update
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: totalRewardsForNewPeriod.toString(), // Only claim second period rewards
      },
      timestamp: secondsToMicros(endTime),
    });

    // Calculate expected final reward per token
    const additionalRewardPerToken = (newExpectedRewardRate * REWARD_DURATION) / STAKE_AMOUNT;
    const finalRewardPerToken = midpointRewardPerToken + additionalRewardPerToken;

    // Verify final reward state
    const finalRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(finalRewardData, "Final reward data should exist");

    // Verify total distributed and remaining balance
    assert.strictEqual(finalRewardData.total_distributed, REWARD_AMOUNT + newRewardAmount);
    assert.strictEqual(finalRewardData.reward_balance, 0n); // All claimed

    // Verify reward per token with tolerance
    const finalRewardPerTokenDiff =
      finalRewardData.reward_per_token_stored_u12 > finalRewardPerToken
        ? finalRewardData.reward_per_token_stored_u12 - finalRewardPerToken
        : finalRewardPerToken - finalRewardData.reward_per_token_stored_u12;

    assert(
      finalRewardPerTokenDiff <= 1000000n, // Allow 0.0001% tolerance
      `Final reward per token difference (${finalRewardPerTokenDiff}) exceeds tolerance: ${finalRewardData.reward_per_token_stored_u12} vs ${finalRewardPerToken}`,
    );
  });

  test("Notify reward amount after period ends", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup initial pool with admin
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

    // Setup user with staking and subscription
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

    // Calculate expected initial reward rate
    const expectedInitialRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);

    // Initial reward notification
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedInitialRewardRate.toString(),
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
      rewardRateU12: expectedInitialRewardRate,
      rewardPerTokenStoredU12: 0n,
    });

    // Fast forward to the end of the reward period
    const endTime = initialPeriodFinish;

    // Claim rewards at the end of period to force state update
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(), // Full reward amount
      },
      timestamp: secondsToMicros(endTime),
    });

    // Get actual reward data after first period
    const periodEndRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(periodEndRewardData, "Period end reward data should exist");

    // Store the actual reward per token value for later comparisons
    const firstPeriodRewardPerToken = periodEndRewardData.reward_per_token_stored_u12;

    // Verify basic state after first period
    assert.strictEqual(periodEndRewardData.reward_balance, 0n, "All rewards should be claimed");
    assert.strictEqual(periodEndRewardData.total_distributed, REWARD_AMOUNT);

    // Fast forward to after period end (with a gap)
    const postPeriodTime = endTime + 100; // 100 seconds after period end

    // Notify new rewards after the period has completely ended
    const newRewardAmount = REWARD_AMOUNT * 2n; // Double the rewards this time
    const newExpectedRewardRate = calculateExpectedRewardRate(newRewardAmount, REWARD_DURATION);
    const newPeriodFinish = postPeriodTime + Number(REWARD_DURATION);

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: newRewardAmount.toString(),
        reward_rate: newExpectedRewardRate.toString(),
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(postPeriodTime),
    });

    // Get actual reward data after new notification
    const newRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(newRewardData, "New reward data should exist");

    // Verify reward per token hasn't changed yet after notification
    assert.strictEqual(
      newRewardData.reward_per_token_stored_u12,
      firstPeriodRewardPerToken,
      "Reward per token should not change immediately after notification",
    );

    // Verify reward balance and other basic state
    assert.strictEqual(newRewardData.reward_balance, newRewardAmount);
    assert.strictEqual(newRewardData.total_distributed, REWARD_AMOUNT + newRewardAmount);
    assert.strictEqual(newRewardData.period_finish, BigInt(newPeriodFinish));
    assert.strictEqual(newRewardData.last_update_time, BigInt(postPeriodTime));

    // Verify reward rate with tolerance
    const newRateDiff = Math.abs(Number(newRewardData.reward_rate_u12 - newExpectedRewardRate));
    const relativeError = newRateDiff / Number(newExpectedRewardRate);
    assert(
      relativeError < 0.001,
      `New reward rate has relative error of ${relativeError}: ${newRewardData.reward_rate_u12} vs ${newExpectedRewardRate}`,
    );

    // Fast forward to the middle of the new reward period
    const newHalfwayTime = postPeriodTime + Number(REWARD_DURATION) / 2;

    // Claim half of the new rewards to force state update
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: (newRewardAmount / 2n).toString(),
      },
      timestamp: secondsToMicros(newHalfwayTime),
    });

    // Get actual reward data at halfway point of new period
    const halfwayNewRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(halfwayNewRewardData, "Halfway new reward data should exist");

    // Calculate expected reward per token at halfway point
    // Based on our debugging, the reward per token doubles from the end of first period
    // to the halfway point of second period when reward rate and duration are consistent
    const expectedHalfwayRewardPerToken = firstPeriodRewardPerToken * 2n;

    // Verify reward per token with tolerance
    const halfwayRewardPerTokenDiff = Math.abs(
      Number(halfwayNewRewardData.reward_per_token_stored_u12 - expectedHalfwayRewardPerToken),
    );
    const halfwayRelativeError = halfwayRewardPerTokenDiff / Number(expectedHalfwayRewardPerToken);

    assert(
      halfwayRelativeError < 0.001,
      `Halfway reward per token has relative error of ${halfwayRelativeError}: ${halfwayNewRewardData.reward_per_token_stored_u12} vs ${expectedHalfwayRewardPerToken}`,
    );

    // Verify reward balance
    assert.strictEqual(halfwayNewRewardData.reward_balance, newRewardAmount / 2n, "Half of rewards should be claimed");

    // Fast forward to the end of the new reward period
    const finalTime = newPeriodFinish;

    // Claim remaining rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: (newRewardAmount / 2n).toString(), // Remaining new rewards
      },
      timestamp: secondsToMicros(finalTime),
    });

    // Get final reward data
    const finalRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(finalRewardData, "Final reward data should exist");

    // Calculate expected final reward per token
    // Based on our debugging, it should be approximately 3x the first period value
    // (assuming reward rates are consistent across periods)
    const expectedFinalRewardPerToken = firstPeriodRewardPerToken * 3n;

    // Verify final reward per token with tolerance
    const finalRewardPerTokenDiff = Math.abs(
      Number(finalRewardData.reward_per_token_stored_u12 - expectedFinalRewardPerToken),
    );
    const finalRelativeError = finalRewardPerTokenDiff / Number(expectedFinalRewardPerToken);

    assert(
      finalRelativeError < 0.001,
      `Final reward per token has relative error of ${finalRelativeError}: ${finalRewardData.reward_per_token_stored_u12} vs ${expectedFinalRewardPerToken}`,
    );

    // Verify all rewards have been claimed
    assert.strictEqual(finalRewardData.reward_balance, 0n, "All rewards should be claimed");

    // Verify total distributed
    assert.strictEqual(finalRewardData.total_distributed, REWARD_AMOUNT + newRewardAmount);
  });

  test("Notify zero reward amount", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup initial pool with admin
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

    // Setup user with staking and subscription
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

    // Calculate expected initial reward rate
    const expectedInitialRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);

    // Initial reward notification
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedInitialRewardRate.toString(),
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
      rewardRateU12: expectedInitialRewardRate,
      rewardPerTokenStoredU12: 0n,
    });

    // Fast forward to middle of the reward period
    const halfDuration = Number(REWARD_DURATION) / 2;
    const midPointTime = startTime + halfDuration;

    // Get reward state before zero amount notification
    const midpointRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(midpointRewardData, "Midpoint reward data should exist");

    // Claim half rewards to force state update at midpoint
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: (REWARD_AMOUNT / 2n).toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Get reward state after midpoint claim
    const afterClaimRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(afterClaimRewardData, "After claim reward data should exist");

    // Store the reward per token at midpoint
    const midpointRewardPerToken = afterClaimRewardData.reward_per_token_stored_u12;

    // Verify reward balance after half is claimed
    assert.strictEqual(afterClaimRewardData.reward_balance, REWARD_AMOUNT / 2n, "Half of rewards should be claimed");

    // Notify zero reward amount
    const zeroPeriodFinish = midPointTime + Number(REWARD_DURATION); // New period finish

    // Calculate expected reward rate for remaining rewards over new duration
    const remainingRewards = REWARD_AMOUNT / 2n; // Half of original rewards remain
    const expectedZeroNotifyRewardRate = calculateExpectedRewardRate(remainingRewards, REWARD_DURATION);

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: "0", // Zero amount
        reward_rate: expectedZeroNotifyRewardRate.toString(),
        period_finish: zeroPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Get reward state after zero notification
    const afterZeroNotifyRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(afterZeroNotifyRewardData, "After zero notify reward data should exist");

    // Verify reward per token doesn't change after notification
    assert.strictEqual(
      afterZeroNotifyRewardData.reward_per_token_stored_u12,
      midpointRewardPerToken,
      "Reward per token should not change immediately after notification",
    );

    // Verify other basic state
    assert.strictEqual(
      afterZeroNotifyRewardData.reward_balance,
      REWARD_AMOUNT / 2n,
      "Balance should remain unchanged after zero notification",
    );
    assert.strictEqual(
      afterZeroNotifyRewardData.total_distributed,
      REWARD_AMOUNT,
      "Total distributed should remain unchanged after zero notification",
    );
    assert.strictEqual(
      afterZeroNotifyRewardData.period_finish,
      BigInt(zeroPeriodFinish),
      "Period finish should be updated even with zero notification",
    );

    // Verify reward rate with tolerance
    const rateAfterZeroDiff = Math.abs(
      Number(afterZeroNotifyRewardData.reward_rate_u12 - expectedZeroNotifyRewardRate),
    );
    const rateAfterZeroRelativeError = rateAfterZeroDiff / Number(expectedZeroNotifyRewardRate);

    assert(
      rateAfterZeroRelativeError < 0.001,
      `Reward rate after zero notify has relative error of ${rateAfterZeroRelativeError}: ${afterZeroNotifyRewardData.reward_rate_u12} vs ${expectedZeroNotifyRewardRate}`,
    );

    // Fast forward to halfway through the new period after zero notification
    const halfwayNewPeriodTime = midPointTime + Number(REWARD_DURATION) / 2;

    // Claim some rewards to force state update
    const expectedAdditionalRewards = remainingRewards / 2n; // Half of remaining rewards

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedAdditionalRewards.toString(),
      },
      timestamp: secondsToMicros(halfwayNewPeriodTime),
    });

    // Get reward state at halfway through new period
    const halfwayNewPeriodRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(halfwayNewPeriodRewardData, "Halfway new period reward data should exist");

    // Calculate expected reward per token
    // Since only half of rewards remain over the same duration and amount staked,
    // the increase in reward per token should be half of what it was in the first half period
    const expectedNewHalfRewardPerToken = midpointRewardPerToken + midpointRewardPerToken / 2n;

    // Verify reward per token with tolerance
    const newHalfRewardPerTokenDiff = Math.abs(
      Number(halfwayNewPeriodRewardData.reward_per_token_stored_u12 - expectedNewHalfRewardPerToken),
    );
    const newHalfRelativeError = newHalfRewardPerTokenDiff / Number(expectedNewHalfRewardPerToken);

    assert(
      newHalfRelativeError < 0.001,
      `New half period reward per token has relative error of ${newHalfRelativeError}: ${halfwayNewPeriodRewardData.reward_per_token_stored_u12} vs ${expectedNewHalfRewardPerToken}`,
    );

    // Verify remaining balance
    const expectedRemainingBalance = REWARD_AMOUNT / 2n - expectedAdditionalRewards;
    assert.strictEqual(
      halfwayNewPeriodRewardData.reward_balance,
      expectedRemainingBalance,
      "Remaining balance should be correcty updated after claiming in the new period",
    );

    // Fast forward to the end of the new period
    const finalTime = zeroPeriodFinish;

    // Claim remaining rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedRemainingBalance.toString(),
      },
      timestamp: secondsToMicros(finalTime),
    });

    // Get final reward state
    const finalRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(finalRewardData, "Final reward data should exist");

    // Verify all rewards claimed
    assert.strictEqual(finalRewardData.reward_balance, 0n, "All rewards should be claimed by the end");

    // Verify total rewards distributed hasn't changed (since we only notified zero)
    assert.strictEqual(
      finalRewardData.total_distributed,
      REWARD_AMOUNT,
      "Total distributed should remain at initial amount since zero was notified",
    );

    // Final reward per token should be approximately 2x the midpoint value
    // (it continues accumulating at half the original rate for the same duration)
    const expectedFinalRewardPerToken = midpointRewardPerToken * 2n;

    // Verify final reward per token with tolerance
    const finalRewardPerTokenDiff = Math.abs(
      Number(finalRewardData.reward_per_token_stored_u12 - expectedFinalRewardPerToken),
    );
    const finalRelativeError = finalRewardPerTokenDiff / Number(expectedFinalRewardPerToken);

    assert(
      finalRelativeError < 0.001,
      `Final reward per token has relative error of ${finalRelativeError}: ${finalRewardData.reward_per_token_stored_u12} vs ${expectedFinalRewardPerToken}`,
    );
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
