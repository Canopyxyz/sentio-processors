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
} from "../common/helpers.js";
import {
  MRRewardClaimedEvent,
  MRRewardNotifiedEvent,
  MRSubscriptionEvent,
  MRUnsubscriptionEvent,
  MRUserRewardData,
} from "../../../schema/schema.rewards.js";

describe("Claim Reward", async () => {
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

  test("Claim reward for a single pool with a single token", async () => {
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

    // Calculate expected reward rate
    const expectedRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);

    // Notify rewards
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

    // Verify reward state after notification
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

    // Fast forward to the middle of the reward period
    const midPointTime = startTime + Number(REWARD_DURATION) / 2;

    // Calculate expected rewards at midpoint (50% of total)
    const expectedMidpointRewards = REWARD_AMOUNT / 2n;

    // Claim rewards at midpoint
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedMidpointRewards.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Calculate expected reward per token at midpoint
    const midpointRewardPerToken = (expectedRewardRate * (REWARD_DURATION / 2n)) / STAKE_AMOUNT;

    // Verify reward state after first claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT - expectedMidpointRewards,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: midpointRewardPerToken,
    });

    // Verify user's reward data after first claim
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: midpointRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: expectedMidpointRewards,
    });

    // Verify claim events after first claim
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);

    // Fast forward to the end of the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Calculate expected rewards for the second half
    const expectedSecondHalfRewards = REWARD_AMOUNT / 2n;

    // Claim rewards at the end
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedSecondHalfRewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Calculate expected final reward per token
    const finalRewardPerToken = (expectedRewardRate * REWARD_DURATION) / STAKE_AMOUNT;

    // Verify reward state after final claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: finalRewardPerToken,
    });

    // Verify final user reward data
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: REWARD_AMOUNT,
    });

    // Verify all claim events
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 2);

    // Verify reward balance updates correctly tracked in token entities
    const poolWithClaims = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(poolWithClaims, "Pool should exist after claims");
    assert.strictEqual(poolWithClaims.claim_count, 2, "Claim count should be updated");
  });

  test("Claim reward for a single pool with multiple tokens", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken1 = generateRandomAddress();
    const rewardToken2 = generateRandomAddress();
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

    // Add first reward token
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

    // Add second reward token to the pool
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

    // Verify pool state after setup
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken1, rewardToken2],
    });

    // Calculate expected reward rates
    const expectedRewardRate1 = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);
    const rewardAmount2 = REWARD_AMOUNT * 2n; // Double rewards for second token
    const expectedRewardRate2 = calculateExpectedRewardRate(rewardAmount2, REWARD_DURATION);

    // Notify rewards for both tokens
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);

    // Notify first token rewards
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate1.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Notify second token rewards
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: rewardAmount2.toString(),
        reward_rate: expectedRewardRate2.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify reward state for both tokens after notification
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken1,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate1,
      rewardPerTokenStoredU12: 0n,
    });

    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken2,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount2,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount2,
      rewardRateU12: expectedRewardRate2,
      rewardPerTokenStoredU12: 0n,
    });

    // Fast forward to the middle of the reward period
    const midPointTime = startTime + Number(REWARD_DURATION) / 2;

    // Calculate expected rewards at midpoint
    const expectedMidpointRewards1 = REWARD_AMOUNT / 2n;
    const expectedMidpointRewards2 = rewardAmount2 / 2n;

    // Claim rewards at midpoint
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: expectedMidpointRewards1.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: expectedMidpointRewards2.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Calculate expected reward per token at midpoint
    const midpointRewardPerToken1 = (expectedRewardRate1 * (REWARD_DURATION / 2n)) / STAKE_AMOUNT;
    const midpointRewardPerToken2 = (expectedRewardRate2 * (REWARD_DURATION / 2n)) / STAKE_AMOUNT;

    // Verify reward state for both tokens after first claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken1,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT - expectedMidpointRewards1,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate1,
      rewardPerTokenStoredU12: midpointRewardPerToken1,
    });

    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken2,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount2 - expectedMidpointRewards2,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount2,
      rewardRateU12: expectedRewardRate2,
      rewardPerTokenStoredU12: midpointRewardPerToken2,
    });

    // Verify user's reward data after first claim for both tokens
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken1, {
      rewardPerTokenPaidU12: midpointRewardPerToken1,
      unclaimedRewards: 0n,
      totalClaimed: expectedMidpointRewards1,
    });

    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken2, {
      rewardPerTokenPaidU12: midpointRewardPerToken2,
      unclaimedRewards: 0n,
      totalClaimed: expectedMidpointRewards2,
    });

    // Verify claim events after first claim
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken1, 1);
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken2, 1);

    // Fast forward to the end of the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Calculate expected rewards for the second half
    const expectedSecondHalfRewards1 = REWARD_AMOUNT / 2n;
    const expectedSecondHalfRewards2 = rewardAmount2 / 2n;

    // Claim rewards at the end for both tokens
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: expectedSecondHalfRewards1.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: expectedSecondHalfRewards2.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Calculate expected final reward per token
    const finalRewardPerToken1 = (expectedRewardRate1 * REWARD_DURATION) / STAKE_AMOUNT;
    const finalRewardPerToken2 = (expectedRewardRate2 * REWARD_DURATION) / STAKE_AMOUNT;

    // Verify reward state for both tokens after final claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken1,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate1,
      rewardPerTokenStoredU12: finalRewardPerToken1,
    });

    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken2,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount2,
      rewardRateU12: expectedRewardRate2,
      rewardPerTokenStoredU12: finalRewardPerToken2,
    });

    // Verify final user reward data for both tokens
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken1, {
      rewardPerTokenPaidU12: finalRewardPerToken1,
      unclaimedRewards: 0n,
      totalClaimed: REWARD_AMOUNT,
    });

    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken2, {
      rewardPerTokenPaidU12: finalRewardPerToken2,
      unclaimedRewards: 0n,
      totalClaimed: rewardAmount2,
    });

    // Verify all claim events
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken1, 2);
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken2, 2);

    // Verify pool claim count
    const poolWithClaims = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(poolWithClaims, "Pool should exist after claims");
    assert.strictEqual(poolWithClaims.claim_count, 4, "Claim count should be 4 (2 claims for each of 2 tokens)");
  });

  test("Claim reward for multiple pools", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken1 = generateRandomAddress();
    const rewardToken2 = generateRandomAddress();
    const pool1Address = generateRandomAddress();
    const pool2Address = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup first pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: pool1Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add reward token to first pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: pool1Address,
        reward_token: { inner: rewardToken1 },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes for first pool
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to first pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: pool1Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Setup second pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: pool2Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add reward token to second pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: pool2Address,
        reward_token: { inner: rewardToken2 },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes for second pool
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to second pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: pool2Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify pools state after setup
    await verifyPoolState(multiRewardsTestReader, pool1Address, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 2n * STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken1],
    });

    await verifyPoolState(multiRewardsTestReader, pool2Address, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 2n * STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken2],
    });

    // Calculate expected reward rates
    const expectedRewardRate1 = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);
    const rewardAmount2 = REWARD_AMOUNT * 2n; // Double rewards for second pool
    const expectedRewardRate2 = calculateExpectedRewardRate(rewardAmount2, REWARD_DURATION);

    // Notify rewards for both pools
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);

    // Notify first pool rewards
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: pool1Address,
        reward_token: { inner: rewardToken1 },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: expectedRewardRate1.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Notify second pool rewards
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: pool2Address,
        reward_token: { inner: rewardToken2 },
        reward_amount: rewardAmount2.toString(),
        reward_rate: expectedRewardRate2.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify reward state for both pools after notification
    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken: rewardToken1,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate1,
      rewardPerTokenStoredU12: 0n,
    });

    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken: rewardToken2,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount2,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount2,
      rewardRateU12: expectedRewardRate2,
      rewardPerTokenStoredU12: 0n,
    });

    // Fast forward to the middle of the reward period
    const midPointTime = startTime + Number(REWARD_DURATION) / 2;

    // Calculate expected rewards at midpoint
    const expectedMidpointRewards1 = REWARD_AMOUNT / 2n;
    const expectedMidpointRewards2 = rewardAmount2 / 2n;

    // Claim rewards at midpoint for both pools in a single claim operation
    // This simulates multi_rewards::claim_reward which claims from all subscribed pools
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool1Address,
        user: userAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: expectedMidpointRewards1.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool2Address,
        user: userAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: expectedMidpointRewards2.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Calculate expected reward per token at midpoint
    const midpointRewardPerToken1 = (expectedRewardRate1 * (REWARD_DURATION / 2n)) / (2n * STAKE_AMOUNT);
    const midpointRewardPerToken2 = (expectedRewardRate2 * (REWARD_DURATION / 2n)) / (2n * STAKE_AMOUNT);

    // Verify reward state for both pools after first claim
    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken: rewardToken1,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT - expectedMidpointRewards1,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate1,
      rewardPerTokenStoredU12: midpointRewardPerToken1,
    });

    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken: rewardToken2,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount2 - expectedMidpointRewards2,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount2,
      rewardRateU12: expectedRewardRate2,
      rewardPerTokenStoredU12: midpointRewardPerToken2,
    });

    // Verify user's reward data after first claim for both pools
    await verifyUserRewardData(service, userAddress, pool1Address, rewardToken1, {
      rewardPerTokenPaidU12: midpointRewardPerToken1,
      unclaimedRewards: 0n,
      totalClaimed: expectedMidpointRewards1,
    });

    await verifyUserRewardData(service, userAddress, pool2Address, rewardToken2, {
      rewardPerTokenPaidU12: midpointRewardPerToken2,
      unclaimedRewards: 0n,
      totalClaimed: expectedMidpointRewards2,
    });

    // Verify claim events after first claim
    await verifyClaimEvents(service, pool1Address, userAddress, rewardToken1, 1);
    await verifyClaimEvents(service, pool2Address, userAddress, rewardToken2, 1);

    // Fast forward to the end of the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Calculate expected rewards for the second half
    const expectedSecondHalfRewards1 = REWARD_AMOUNT / 2n;
    const expectedSecondHalfRewards2 = rewardAmount2 / 2n;

    // Claim rewards at the end for both pools
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool1Address,
        user: userAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: expectedSecondHalfRewards1.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool2Address,
        user: userAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: expectedSecondHalfRewards2.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Calculate expected final reward per token
    const finalRewardPerToken1 = (expectedRewardRate1 * REWARD_DURATION) / (2n * STAKE_AMOUNT);
    const finalRewardPerToken2 = (expectedRewardRate2 * REWARD_DURATION) / (2n * STAKE_AMOUNT);

    // Verify reward state for both pools after final claim
    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken: rewardToken1,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate1,
      rewardPerTokenStoredU12: finalRewardPerToken1,
    });

    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken: rewardToken2,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount2,
      rewardRateU12: expectedRewardRate2,
      rewardPerTokenStoredU12: finalRewardPerToken2,
    });

    // Verify final user reward data for both pools
    await verifyUserRewardData(service, userAddress, pool1Address, rewardToken1, {
      rewardPerTokenPaidU12: finalRewardPerToken1,
      unclaimedRewards: 0n,
      totalClaimed: REWARD_AMOUNT,
    });

    await verifyUserRewardData(service, userAddress, pool2Address, rewardToken2, {
      rewardPerTokenPaidU12: finalRewardPerToken2,
      unclaimedRewards: 0n,
      totalClaimed: rewardAmount2,
    });

    // Verify all claim events
    await verifyClaimEvents(service, pool1Address, userAddress, rewardToken1, 2);
    await verifyClaimEvents(service, pool2Address, userAddress, rewardToken2, 2);

    // Verify pool claim counts
    const pool1WithClaims = await multiRewardsTestReader.getStakingPool(pool1Address);
    const pool2WithClaims = await multiRewardsTestReader.getStakingPool(pool2Address);
    assert(pool1WithClaims, "Pool 1 should exist after claims");
    assert(pool2WithClaims, "Pool 2 should exist after claims");
    assert.strictEqual(pool1WithClaims.claim_count, 2, "Pool 1 claim count should be 2");
    assert.strictEqual(pool2WithClaims.claim_count, 2, "Pool 2 claim count should be 2");

    // Verify user state
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT * 2n, // Total staked across both pools
      subscribedPools: [pool1Address, pool2Address],
    });
  });

  test("Claim reward for multiple pools with multiple tokens", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken1 = generateRandomAddress();
    const rewardToken2 = generateRandomAddress();
    const rewardToken3 = generateRandomAddress();
    const rewardToken4 = generateRandomAddress();
    const pool1Address = generateRandomAddress();
    const pool2Address = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Setup first pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: pool1Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add first reward token to first pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: pool1Address,
        reward_token: { inner: rewardToken1 },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add second reward token to first pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: pool1Address,
        reward_token: { inner: rewardToken2 },
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

    // User subscribes to first pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: pool1Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Setup second pool with admin
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: pool2Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add first reward token to second pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: pool2Address,
        reward_token: { inner: rewardToken3 },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Add second reward token to second pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: pool2Address,
        reward_token: { inner: rewardToken4 },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes again
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to second pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: pool2Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify pools state after setup
    await verifyPoolState(multiRewardsTestReader, pool1Address, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 2n * STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken1, rewardToken2],
    });

    await verifyPoolState(multiRewardsTestReader, pool2Address, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 2n * STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken3, rewardToken4],
    });

    // Set different reward amounts for each token
    const rewardAmount1 = REWARD_AMOUNT;
    const rewardAmount2 = REWARD_AMOUNT * 2n;
    const rewardAmount3 = REWARD_AMOUNT * 3n;
    const rewardAmount4 = REWARD_AMOUNT * 4n;

    // Calculate expected reward rates
    const expectedRewardRate1 = calculateExpectedRewardRate(rewardAmount1, REWARD_DURATION);
    const expectedRewardRate2 = calculateExpectedRewardRate(rewardAmount2, REWARD_DURATION);
    const expectedRewardRate3 = calculateExpectedRewardRate(rewardAmount3, REWARD_DURATION);
    const expectedRewardRate4 = calculateExpectedRewardRate(rewardAmount4, REWARD_DURATION);

    // Notify rewards for all tokens
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);

    // Notify rewards for first pool, first token
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: pool1Address,
        reward_token: { inner: rewardToken1 },
        reward_amount: rewardAmount1.toString(),
        reward_rate: expectedRewardRate1.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Notify rewards for first pool, second token
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: pool1Address,
        reward_token: { inner: rewardToken2 },
        reward_amount: rewardAmount2.toString(),
        reward_rate: expectedRewardRate2.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Notify rewards for second pool, first token
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: pool2Address,
        reward_token: { inner: rewardToken3 },
        reward_amount: rewardAmount3.toString(),
        reward_rate: expectedRewardRate3.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Notify rewards for second pool, second token
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: pool2Address,
        reward_token: { inner: rewardToken4 },
        reward_amount: rewardAmount4.toString(),
        reward_rate: expectedRewardRate4.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify reward state for all tokens after notification
    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken: rewardToken1,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount1,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount1,
      rewardRateU12: expectedRewardRate1,
      rewardPerTokenStoredU12: 0n,
    });

    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken: rewardToken2,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount2,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount2,
      rewardRateU12: expectedRewardRate2,
      rewardPerTokenStoredU12: 0n,
    });

    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken: rewardToken3,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount3,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount3,
      rewardRateU12: expectedRewardRate3,
      rewardPerTokenStoredU12: 0n,
    });

    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken: rewardToken4,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount4,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount4,
      rewardRateU12: expectedRewardRate4,
      rewardPerTokenStoredU12: 0n,
    });

    // Fast forward to the middle of the reward period
    const midPointTime = startTime + Number(REWARD_DURATION) / 2;

    // Calculate expected rewards at midpoint (50% of total)
    const expectedMidpointRewards1 = rewardAmount1 / 2n;
    const expectedMidpointRewards2 = rewardAmount2 / 2n;
    const expectedMidpointRewards3 = rewardAmount3 / 2n;
    const expectedMidpointRewards4 = rewardAmount4 / 2n;

    // Claim rewards at midpoint for all pools and all tokens
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool1Address,
        user: userAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: expectedMidpointRewards1.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool1Address,
        user: userAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: expectedMidpointRewards2.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool2Address,
        user: userAddress,
        reward_token: { inner: rewardToken3 },
        reward_amount: expectedMidpointRewards3.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool2Address,
        user: userAddress,
        reward_token: { inner: rewardToken4 },
        reward_amount: expectedMidpointRewards4.toString(),
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Calculate expected reward per token at midpoint
    const midpointRewardPerToken1 = (expectedRewardRate1 * (REWARD_DURATION / 2n)) / (2n * STAKE_AMOUNT);
    const midpointRewardPerToken2 = (expectedRewardRate2 * (REWARD_DURATION / 2n)) / (2n * STAKE_AMOUNT);
    const midpointRewardPerToken3 = (expectedRewardRate3 * (REWARD_DURATION / 2n)) / (2n * STAKE_AMOUNT);
    const midpointRewardPerToken4 = (expectedRewardRate4 * (REWARD_DURATION / 2n)) / (2n * STAKE_AMOUNT);

    // Verify reward state for all tokens after first claim
    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken: rewardToken1,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount1 - expectedMidpointRewards1,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount1,
      rewardRateU12: expectedRewardRate1,
      rewardPerTokenStoredU12: midpointRewardPerToken1,
    });

    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken: rewardToken2,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount2 - expectedMidpointRewards2,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount2,
      rewardRateU12: expectedRewardRate2,
      rewardPerTokenStoredU12: midpointRewardPerToken2,
    });

    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken: rewardToken3,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount3 - expectedMidpointRewards3,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount3,
      rewardRateU12: expectedRewardRate3,
      rewardPerTokenStoredU12: midpointRewardPerToken3,
    });

    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken: rewardToken4,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: rewardAmount4 - expectedMidpointRewards4,
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount4,
      rewardRateU12: expectedRewardRate4,
      rewardPerTokenStoredU12: midpointRewardPerToken4,
    });

    // Verify user's reward data after first claim for all tokens
    await verifyUserRewardData(service, userAddress, pool1Address, rewardToken1, {
      rewardPerTokenPaidU12: midpointRewardPerToken1,
      unclaimedRewards: 0n,
      totalClaimed: expectedMidpointRewards1,
    });

    await verifyUserRewardData(service, userAddress, pool1Address, rewardToken2, {
      rewardPerTokenPaidU12: midpointRewardPerToken2,
      unclaimedRewards: 0n,
      totalClaimed: expectedMidpointRewards2,
    });

    await verifyUserRewardData(service, userAddress, pool2Address, rewardToken3, {
      rewardPerTokenPaidU12: midpointRewardPerToken3,
      unclaimedRewards: 0n,
      totalClaimed: expectedMidpointRewards3,
    });

    await verifyUserRewardData(service, userAddress, pool2Address, rewardToken4, {
      rewardPerTokenPaidU12: midpointRewardPerToken4,
      unclaimedRewards: 0n,
      totalClaimed: expectedMidpointRewards4,
    });

    // Verify claim events after first claim
    await verifyClaimEvents(service, pool1Address, userAddress, rewardToken1, 1);
    await verifyClaimEvents(service, pool1Address, userAddress, rewardToken2, 1);
    await verifyClaimEvents(service, pool2Address, userAddress, rewardToken3, 1);
    await verifyClaimEvents(service, pool2Address, userAddress, rewardToken4, 1);

    // Fast forward to the end of the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Calculate expected rewards for the second half
    const expectedSecondHalfRewards1 = rewardAmount1 / 2n;
    const expectedSecondHalfRewards2 = rewardAmount2 / 2n;
    const expectedSecondHalfRewards3 = rewardAmount3 / 2n;
    const expectedSecondHalfRewards4 = rewardAmount4 / 2n;

    // Claim rewards at the end for all pools and all tokens
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool1Address,
        user: userAddress,
        reward_token: { inner: rewardToken1 },
        reward_amount: expectedSecondHalfRewards1.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool1Address,
        user: userAddress,
        reward_token: { inner: rewardToken2 },
        reward_amount: expectedSecondHalfRewards2.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool2Address,
        user: userAddress,
        reward_token: { inner: rewardToken3 },
        reward_amount: expectedSecondHalfRewards3.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: pool2Address,
        user: userAddress,
        reward_token: { inner: rewardToken4 },
        reward_amount: expectedSecondHalfRewards4.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Calculate expected final reward per token
    const finalRewardPerToken1 = (expectedRewardRate1 * REWARD_DURATION) / (2n * STAKE_AMOUNT);
    const finalRewardPerToken2 = (expectedRewardRate2 * REWARD_DURATION) / (2n * STAKE_AMOUNT);
    const finalRewardPerToken3 = (expectedRewardRate3 * REWARD_DURATION) / (2n * STAKE_AMOUNT);
    const finalRewardPerToken4 = (expectedRewardRate4 * REWARD_DURATION) / (2n * STAKE_AMOUNT);

    // Verify reward state for all tokens after final claim
    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken: rewardToken1,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount1,
      rewardRateU12: expectedRewardRate1,
      rewardPerTokenStoredU12: finalRewardPerToken1,
    });

    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken: rewardToken2,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount2,
      rewardRateU12: expectedRewardRate2,
      rewardPerTokenStoredU12: finalRewardPerToken2,
    });

    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken: rewardToken3,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount3,
      rewardRateU12: expectedRewardRate3,
      rewardPerTokenStoredU12: finalRewardPerToken3,
    });

    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken: rewardToken4,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: rewardAmount4,
      rewardRateU12: expectedRewardRate4,
      rewardPerTokenStoredU12: finalRewardPerToken4,
    });

    // Verify final user reward data for all tokens
    await verifyUserRewardData(service, userAddress, pool1Address, rewardToken1, {
      rewardPerTokenPaidU12: finalRewardPerToken1,
      unclaimedRewards: 0n,
      totalClaimed: rewardAmount1,
    });

    await verifyUserRewardData(service, userAddress, pool1Address, rewardToken2, {
      rewardPerTokenPaidU12: finalRewardPerToken2,
      unclaimedRewards: 0n,
      totalClaimed: rewardAmount2,
    });

    await verifyUserRewardData(service, userAddress, pool2Address, rewardToken3, {
      rewardPerTokenPaidU12: finalRewardPerToken3,
      unclaimedRewards: 0n,
      totalClaimed: rewardAmount3,
    });

    await verifyUserRewardData(service, userAddress, pool2Address, rewardToken4, {
      rewardPerTokenPaidU12: finalRewardPerToken4,
      unclaimedRewards: 0n,
      totalClaimed: rewardAmount4,
    });

    // Verify all claim events
    await verifyClaimEvents(service, pool1Address, userAddress, rewardToken1, 2);
    await verifyClaimEvents(service, pool1Address, userAddress, rewardToken2, 2);
    await verifyClaimEvents(service, pool2Address, userAddress, rewardToken3, 2);
    await verifyClaimEvents(service, pool2Address, userAddress, rewardToken4, 2);

    // Verify pool claim counts
    const pool1WithClaims = await multiRewardsTestReader.getStakingPool(pool1Address);
    const pool2WithClaims = await multiRewardsTestReader.getStakingPool(pool2Address);
    assert(pool1WithClaims, "Pool 1 should exist after claims");
    assert(pool2WithClaims, "Pool 2 should exist after claims");
    assert.strictEqual(
      pool1WithClaims.claim_count,
      4,
      "Pool 1 claim count should be 4 (2 claims for each of 2 tokens)",
    );
    assert.strictEqual(
      pool2WithClaims.claim_count,
      4,
      "Pool 2 claim count should be 4 (2 claims for each of 2 tokens)",
    );

    // Verify user state
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT * 2n, // Total staked amount (both stake events)
      subscribedPools: [pool1Address, pool2Address],
    });
  });

  test("Claim reward with zero rewards", async () => {
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

    // Add reward token to pool
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

    // Verify pool state after setup
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Verify initial reward state (before notify)
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

    // Attempt to claim rewards immediately after subscribing (should be zero)
    // Since no rewards have been notified, the claim amount is 0
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: "0", // Zero rewards claimed
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify user reward data after first claim (should be zero)
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: 0n,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    // Now notify rewards, but don't advance time
    const expectedRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);
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

    // Verify reward state after notification
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

    // Attempt to claim rewards again (should still be zero as no time has passed)
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: "0", // Still zero rewards claimed
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify user reward data after second claim (should still be zero)
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: 0n,
      unclaimedRewards: 0n,
      totalClaimed: 0n,
    });

    // Fast forward a small amount of time (1 second)
    const smallAdvanceTime = startTime + 1;

    // Calculate expected small rewards (1 second worth)
    const smallRewardAmount = REWARD_AMOUNT / REWARD_DURATION; // 1 second of rewards

    // Claim rewards after small time advance
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: smallRewardAmount.toString(),
      },
      timestamp: secondsToMicros(smallAdvanceTime),
    });

    // Calculate expected reward per token after 1 second
    const smallTimeRewardPerToken = (expectedRewardRate * 1n) / STAKE_AMOUNT;

    // Verify reward state after small time claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT - smallRewardAmount,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: smallTimeRewardPerToken,
    });

    // Verify user reward data after small time claim
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: smallTimeRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: smallRewardAmount,
    });

    // Verify claim events
    const claimEvents = await service.store.list(MRRewardClaimedEvent, [
      { field: "reward_token", op: "=", value: rewardToken },
    ]);

    assert.strictEqual(claimEvents.length, 3, "Should have 3 claim events");
    assert.strictEqual(claimEvents[0].claim_amount, 0n, "First claim amount should be 0");
    assert.strictEqual(claimEvents[1].claim_amount, 0n, "Second claim amount should be 0");
    assert.strictEqual(
      claimEvents[2].claim_amount,
      smallRewardAmount,
      "Third claim amount should be the 1-second reward",
    );

    // Verify pool claim count
    const poolWithClaims = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(poolWithClaims, "Pool should exist after claims");
    assert.strictEqual(poolWithClaims.claim_count, 3, "Pool claim count should be 3");
  });

  test("Claim reward after additional stake", async () => {
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

    // Add reward token to pool
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

    // Initial stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Subscribe to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify pool state after setup
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Notify rewards
    const expectedRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);
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

    // Fast forward to 1/4 of the reward period
    const quarterTime = startTime + Number(REWARD_DURATION) / 4;

    // Calculate expected rewards at quarter point
    const expectedQuarterRewards = REWARD_AMOUNT / 4n;

    // Additional stake at quarter point
    const additionalStakeAmount = STAKE_AMOUNT; // Same amount as initial stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: additionalStakeAmount.toString(),
      },
      timestamp: secondsToMicros(quarterTime),
    });

    // Calculate expected reward per token at quarter point (before additional stake is included)
    const quarterRewardPerToken = (expectedRewardRate * (REWARD_DURATION / 4n)) / STAKE_AMOUNT;

    // Verify user's staked balance after additional stake
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT + additionalStakeAmount,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after additional stake
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT + additionalStakeAmount,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Fast forward to 1/2 of the reward period
    const halfTime = startTime + Number(REWARD_DURATION) / 2;

    // Claim rewards at half time
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedQuarterRewards.toString(),
      },
      timestamp: secondsToMicros(halfTime),
    });

    // Calculate expected reward per token at half time
    // First quarter with original stake amount, second quarter with doubled stake amount
    // The actual reward per token will be what was accumulated at quarter time (quarterRewardPerToken)
    // plus what accumulated in the second quarter with the new stake amount
    const secondQuarterRewardPerToken =
      (expectedRewardRate * (REWARD_DURATION / 4n)) / (STAKE_AMOUNT + additionalStakeAmount);
    const halfTimeRewardPerToken = quarterRewardPerToken + secondQuarterRewardPerToken;

    // Verify reward state after first claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT - expectedQuarterRewards,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: halfTimeRewardPerToken,
    });

    // Verify user's reward data after first claim
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: halfTimeRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: expectedQuarterRewards,
    });

    // Fast forward to the end of the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Update the second claim event to reflect all remaining rewards
    const expectedSecondHalfRewards = REWARD_AMOUNT - expectedQuarterRewards; // Should be 375,000

    // Claim rewards at the end (all remaining rewards)
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedSecondHalfRewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Calculate expected final reward per token
    // The final reward per token will be halfTimeRewardPerToken plus what accumulated in the second half
    const secondHalfRewardPerToken =
      (expectedRewardRate * (REWARD_DURATION / 2n)) / (STAKE_AMOUNT + additionalStakeAmount);
    const finalRewardPerToken = halfTimeRewardPerToken + secondHalfRewardPerToken;

    // Verify reward state after final claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT - expectedQuarterRewards - expectedSecondHalfRewards,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: finalRewardPerToken,
    });

    // Verify final user reward data
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: expectedQuarterRewards + expectedSecondHalfRewards,
    });

    // Verify claim events
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 2);

    // Verify pool claim count
    const poolWithClaims = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(poolWithClaims, "Pool should exist after claims");
    assert.strictEqual(poolWithClaims.claim_count, 2, "Pool claim count should be 2");

    // Verify that the total claimed is approximately REWARD_AMOUNT (allowing for minor rounding differences)
    const totalClaimed = expectedQuarterRewards + expectedSecondHalfRewards;
    // Use 1% tolerance for comparison because of potential precision issues
    const tolerance = REWARD_AMOUNT / 100n;
    const difference = totalClaimed > REWARD_AMOUNT ? totalClaimed - REWARD_AMOUNT : REWARD_AMOUNT - totalClaimed;

    assert(
      difference <= tolerance,
      `Total claimed ${totalClaimed} should be approximately equal to total rewards ${REWARD_AMOUNT}`,
    );
  });

  test("Claim reward after partial unstake", async () => {
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

    // Add reward token to pool
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

    // Initial stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Subscribe to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify pool state after setup
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Notify rewards
    const expectedRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);
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

    // Fast forward to 1/4 of the reward period
    const quarterTime = startTime + Number(REWARD_DURATION) / 4;

    // Calculate expected rewards at quarter point
    const expectedQuarterRewards = REWARD_AMOUNT / 4n;

    // Calculate expected reward per token at quarter point
    const quarterRewardPerToken = (expectedRewardRate * (REWARD_DURATION / 4n)) / STAKE_AMOUNT;

    // Partially unstake (withdraw half of staked amount) at quarter point
    const unstakeAmount = STAKE_AMOUNT / 2n;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: unstakeAmount.toString(),
      },
      timestamp: secondsToMicros(quarterTime),
    });

    // Verify user's staked balance after unstake
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - unstakeAmount,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after unstake
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT - unstakeAmount,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      withdrawalCount: 1,
    });

    // Fast forward to 1/2 of the reward period
    const halfTime = startTime + Number(REWARD_DURATION) / 2;

    // Claim rewards at half time
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedQuarterRewards.toString(),
      },
      timestamp: secondsToMicros(halfTime),
    });

    // Calculate expected reward per token at half time
    // First quarter with original stake amount, second quarter with halved stake amount
    const secondQuarterRewardPerToken = (expectedRewardRate * (REWARD_DURATION / 4n)) / (STAKE_AMOUNT - unstakeAmount);
    const halfTimeRewardPerToken = quarterRewardPerToken + secondQuarterRewardPerToken;

    // Verify reward state after first claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT - expectedQuarterRewards,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: halfTimeRewardPerToken,
    });

    // Verify user's reward data after first claim
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: halfTimeRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: expectedQuarterRewards,
    });

    // Fast forward to the end of the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Calculate expected remaining rewards
    const expectedRemainingRewards = REWARD_AMOUNT - expectedQuarterRewards;

    // Claim rewards at the end
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedRemainingRewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Calculate expected final reward per token
    // The final reward per token will be halfTimeRewardPerToken plus what accumulated in the second half
    const secondHalfRewardPerToken = (expectedRewardRate * (REWARD_DURATION / 2n)) / (STAKE_AMOUNT - unstakeAmount);
    const finalRewardPerToken = halfTimeRewardPerToken + secondHalfRewardPerToken;

    // Verify reward state after final claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: finalRewardPerToken,
    });

    // Verify final user reward data
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: REWARD_AMOUNT,
    });

    // Verify claim events
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 2);

    // Verify pool claim count
    const poolWithClaims = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(poolWithClaims, "Pool should exist after claims");
    assert.strictEqual(poolWithClaims.claim_count, 2, "Pool claim count should be 2");
    assert.strictEqual(poolWithClaims.withdrawal_count, 1, "Pool withdrawal count should be 1");

    // Verify the remaining staked balance matches what we expect
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - unstakeAmount,
      subscribedPools: [poolAddress],
    });
  });

  test("Claim reward at period boundary", async () => {
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

    // Add reward token to pool
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

    // Verify pool state after setup
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Notify rewards
    const expectedRewardRate = calculateExpectedRewardRate(REWARD_AMOUNT, REWARD_DURATION);
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

    // Fast forward to exactly the end of the reward period
    const endTime = periodFinish;

    // Calculate expected reward per token at the exact end
    const endRewardPerToken = (expectedRewardRate * REWARD_DURATION) / STAKE_AMOUNT;

    // Claim rewards exactly at the period boundary
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(), // User should get all rewards
      },
      timestamp: secondsToMicros(endTime),
    });

    // Verify reward state after claiming at period end
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All rewards claimed
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: endRewardPerToken,
    });

    // Verify user's reward data after claim at period end
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: endRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: REWARD_AMOUNT,
    });

    // Fast forward a small amount of time past the reward period (10 seconds)
    const pastEndTime = endTime + 10;

    // Attempt to claim rewards again after the period has ended
    // Since no new rewards should have accrued, the claim amount is 0
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: "0", // No additional rewards
      },
      timestamp: secondsToMicros(pastEndTime),
    });

    // Verify reward state remains unchanged after the second claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // Still all claimed
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: expectedRewardRate,
      rewardPerTokenStoredU12: endRewardPerToken, // Unchanged
    });

    // Verify user's reward data after second claim (should be unchanged)
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: endRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: REWARD_AMOUNT, // Unchanged
    });

    // Verify claim events
    const claimEvents = await service.store.list(MRRewardClaimedEvent, [
      { field: "reward_token", op: "=", value: rewardToken },
    ]);

    assert.strictEqual(claimEvents.length, 2, "Should have 2 claim events");
    assert.strictEqual(claimEvents[0].claim_amount, REWARD_AMOUNT, "First claim amount should be REWARD_AMOUNT");
    assert.strictEqual(claimEvents[1].claim_amount, 0n, "Second claim amount should be 0");

    // Verify remaining rewards in the pool (should be 0)
    const remainingRewards = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(remainingRewards, "Reward data should exist");
    assert.strictEqual(remainingRewards.reward_balance, 0n, "Remaining rewards should be 0");

    // Verify pool claim count
    const poolWithClaims = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(poolWithClaims, "Pool should exist after claims");
    assert.strictEqual(poolWithClaims.claim_count, 2, "Pool claim count should be 2");
  });

  test("Claim reward with updated reward amount", async () => {
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

    // Add reward token to pool
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

    // Verify pool state after setup
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Initial reward notification
    const initialReward = REWARD_AMOUNT;
    const initialRewardRate = calculateExpectedRewardRate(initialReward, REWARD_DURATION);
    const initialPeriodFinish = startTime + Number(REWARD_DURATION);

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: initialReward.toString(),
        reward_rate: initialRewardRate.toString(),
        period_finish: initialPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial reward state
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: initialReward,
      unallocatedRewards: 0n,
      totalDistributed: initialReward,
      rewardRateU12: initialRewardRate,
      rewardPerTokenStoredU12: 0n,
    });

    // Fast forward to half of the reward period
    const halfTime = startTime + Number(REWARD_DURATION) / 2;

    // Calculate expected rewards at half point
    const expectedHalfRewards = initialReward / 2n;

    // Calculate expected reward per token at half time
    const halfRewardPerToken = (initialRewardRate * (REWARD_DURATION / 2n)) / STAKE_AMOUNT;

    // Update reward amount at half time
    const additionalReward = REWARD_AMOUNT / 2n; // Half of the initial amount

    // The new reward rate needs to consider remaining rewards from the original period plus the new rewards
    // The remaining rewards from the original period would be initialReward/2
    const totalRewardsForNewPeriod = initialReward / 2n + additionalReward;
    const newRewardRate = calculateExpectedRewardRate(totalRewardsForNewPeriod, REWARD_DURATION);
    const newPeriodFinish = halfTime + Number(REWARD_DURATION);

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: additionalReward.toString(),
        reward_rate: newRewardRate.toString(),
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(halfTime),
    });

    // Verify reward state after reward update
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: initialReward + additionalReward, // Initial + added (no subtraction until claim)
      unallocatedRewards: 0n,
      totalDistributed: initialReward + additionalReward,
      rewardRateU12: newRewardRate,
      rewardPerTokenStoredU12: halfRewardPerToken,
    });

    // Fast forward to the end of the first reward period (which was extended by the second notification)
    const originalEndTime = startTime + Number(REWARD_DURATION);

    // Earned rewards at this point should be initialReward (not the full amount)
    // This is because we've reached the end of the original period, but the new rewards
    // are distributed over a new period that extends past this point
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: expectedHalfRewards.toString(), // Only half of initial rewards
      },
      timestamp: secondsToMicros(originalEndTime),
    });

    // Calculate expected reward per token at original end time
    // It's halfRewardPerToken plus what accrued from halfTime to originalEndTime
    const timeElapsed = originalEndTime - halfTime;
    const additionalRewardPerToken = (newRewardRate * BigInt(timeElapsed)) / STAKE_AMOUNT;
    const originalEndRewardPerToken = halfRewardPerToken + additionalRewardPerToken;

    // Verify reward state after first claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: initialReward / 2n + additionalReward,
      unallocatedRewards: 0n,
      totalDistributed: initialReward + additionalReward,
      rewardRateU12: newRewardRate,
      rewardPerTokenStoredU12: originalEndRewardPerToken,
    });

    // Verify user's reward data after first claim
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: originalEndRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: expectedHalfRewards, // Only claimed half of initial rewards
    });

    // Fast forward to the end of the new reward period
    const newEndTime = newPeriodFinish;

    // Claim all remaining rewards
    const remainingRewards = initialReward / 2n + additionalReward; // Second half of initial + all additional
    // This should be 250,000 + 250,000 = 500,000

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: remainingRewards.toString(),
      },
      timestamp: secondsToMicros(newEndTime),
    });

    // Calculate expected final reward per token
    const finalTimeElapsed = newEndTime - originalEndTime;
    const finalAdditionalRewardPerToken = (newRewardRate * BigInt(finalTimeElapsed)) / STAKE_AMOUNT;
    const finalRewardPerToken = originalEndRewardPerToken + finalAdditionalRewardPerToken;

    // Verify reward state after final claim
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: initialReward + additionalReward,
      rewardRateU12: newRewardRate,
      rewardPerTokenStoredU12: finalRewardPerToken,
    });

    // Verify final user reward data
    await verifyUserRewardData(service, userAddress, poolAddress, rewardToken, {
      rewardPerTokenPaidU12: finalRewardPerToken,
      unclaimedRewards: 0n,
      totalClaimed: initialReward + additionalReward, // Should have claimed all rewards
    });

    // Verify claim events
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 2);

    // Verify total claimed matches total distributed
    const userRewardData = await service.store.get(MRUserRewardData, `${userAddress}-${poolAddress}-${rewardToken}`);
    assert(userRewardData, "User reward data should exist");
    assert.strictEqual(
      userRewardData.total_claimed,
      initialReward + additionalReward,
      "Total claimed should match total distributed rewards",
    );

    // Verify pool claim count
    const poolWithClaims = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(poolWithClaims, "Pool should exist after claims");
    assert.strictEqual(poolWithClaims.claim_count, 2, "Pool claim count should be 2");
  });

  // Helper function to calculate expected reward rate
  function calculateExpectedRewardRate(rewardAmount: bigint, duration: bigint): bigint {
    return (rewardAmount * U12_PRECISION) / duration;
  }
});
