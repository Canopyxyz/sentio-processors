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
import { MRRewardClaimedEvent } from "../../../schema/schema.rewards.js";

describe("Withdraw", async () => {
  const service = new TestProcessorServer(() => import("../multi-rewards-processor.js"));
  const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);

  const INITIAL_BALANCE = 1_000_000n;
  const STAKE_AMOUNT = 100_000n;
  const WITHDRAW_AMOUNT = 50_000n;
  const REWARD_AMOUNT = 1_000_000n;
  const REWARD_DURATION = 86400n; // 1 day in seconds
  const U12_PRECISION = 1_000_000_000_000n; // 1e12

  before(async () => {
    await service.start();
  });

  afterEach(async () => {
    service.db.reset();
  });

  // Test partial withdrawal
  test("test_partial_withdraw", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const accountAddress = generateRandomAddress();
    const poolCreatorAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // First create the staking pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial state
    const initialUserBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert.strictEqual(initialUserBalance?.amount, STAKE_AMOUNT, "Initial staked balance should match STAKE_AMOUNT");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
    });

    // Perform withdrawal
    const withdrawAmount = WITHDRAW_AMOUNT;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify post-withdrawal state
    const finalUserBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert.strictEqual(
      finalUserBalance?.amount,
      STAKE_AMOUNT - withdrawAmount,
      "Remaining staked balance should be STAKE_AMOUNT - withdrawAmount",
    );

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: STAKE_AMOUNT - withdrawAmount,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    // Verify user's subscription is maintained
    const userSubscription = await multiRewardsTestReader.getUserSubscription(accountAddress, poolAddress);
    assert(
      userSubscription && userSubscription.is_currently_subscribed,
      "User should still be subscribed after withdrawal",
    );

    // Get the module to check the withdrawal count (for event verification)
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;

    // Check for withdraw event
    // Since there's no direct method to verify WithdrawEvent, we can verify indirectly by
    // checking the withdrawal count increased and the state changes are as expected
    assert.strictEqual(withdrawalCount, 1, "There should be one withdrawal event recorded");
  });

  // Test full withdrawal
  test("test_full_withdraw", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const accountAddress = generateRandomAddress();
    const poolCreatorAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // First create the staking pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial state
    const initialUserBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert.strictEqual(initialUserBalance?.amount, STAKE_AMOUNT, "Initial staked balance should match STAKE_AMOUNT");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
    });

    // Perform full withdrawal (all staked tokens)
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify post-withdrawal state
    const finalUserBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert.strictEqual(finalUserBalance?.amount, 0n, "Staked balance should be zero after full withdrawal");

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: 0n,
      subscriberCount: 1, // User is still subscribed even with zero balance
      withdrawalCount: 1,
    });

    // Verify user's subscription is maintained
    const userSubscription = await multiRewardsTestReader.getUserSubscription(accountAddress, poolAddress);
    assert(
      userSubscription && userSubscription.is_currently_subscribed,
      "User should still be subscribed after full withdrawal",
    );

    // Get the module to check the withdrawal count (for event verification)
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;

    // Check for withdraw event
    assert.strictEqual(withdrawalCount, 1, "There should be one withdrawal event recorded");

    // Further verify that subscription is maintained by checking the subscription list
    // This mirrors the subscribed_pools check in the Move test
    const userSubscriptions = await multiRewardsTestReader.getUserSubscription(accountAddress, poolAddress);
    assert(userSubscriptions, "User subscription record should exist");
    assert(userSubscriptions.is_currently_subscribed, "User should still be marked as subscribed");
    assert.strictEqual(userSubscriptions.pool_address, poolAddress, "Subscription should reference the correct pool");
  });

  // Test withdrawal updates user balance
  test("test_withdraw_updates_user_balance", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const accountAddress = generateRandomAddress();
    const poolCreatorAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // First create the staking pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial state
    const initialUserBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert.strictEqual(initialUserBalance?.amount, STAKE_AMOUNT, "Initial staked balance should match STAKE_AMOUNT");

    // Get user entity to verify relationships
    const userEntity = await multiRewardsTestReader.getUser(accountAddress);
    assert(userEntity, "User entity should exist");

    // Verify initial pool state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
    });

    // Perform partial withdrawal
    const withdrawAmount = WITHDRAW_AMOUNT;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify user's staked balance is updated
    const finalUserBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert.strictEqual(
      finalUserBalance?.amount,
      STAKE_AMOUNT - withdrawAmount,
      "User's staked balance should be reduced by the withdrawal amount",
    );

    // Verify the relationship between user and staked balance is maintained
    const userAfterWithdraw = await multiRewardsTestReader.getUser(accountAddress);
    assert(userAfterWithdraw, "User entity should still exist after withdrawal");

    // Verify the staked balance exists in the user's staked balances
    const stakedBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert(stakedBalance, "Staked balance record should exist");
    assert.strictEqual(
      stakedBalance.amount,
      STAKE_AMOUNT - withdrawAmount,
      "Staked balance should match expected value after withdrawal",
    );

    // Verify pool subscription is maintained
    const userSubscription = await multiRewardsTestReader.getUserSubscription(accountAddress, poolAddress);
    assert(
      userSubscription && userSubscription.is_currently_subscribed,
      "User should still be subscribed after withdrawal",
    );

    // Get the module to check the withdrawal count
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;

    // Check for withdraw event
    assert.strictEqual(withdrawalCount, 1, "There should be one withdrawal event recorded");
  });

  // Test withdrawal updates pool total subscribed
  test("test_withdraw_updates_pool_total_subscribed", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const accountAddress = generateRandomAddress();
    const poolCreatorAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Create the staking pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial pool state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
    });

    // Perform partial withdrawal
    const withdrawAmount = WITHDRAW_AMOUNT;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(startTime + 1),
    });

    // Verify updated pool state after partial withdrawal
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: STAKE_AMOUNT - withdrawAmount,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    // Perform full withdrawal of remaining amount
    const remainingAmount = STAKE_AMOUNT - withdrawAmount;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: remainingAmount.toString(),
      },
      timestamp: secondsToMicros(startTime + 2),
    });

    // Verify final pool state after full withdrawal
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: 0n,
      subscriberCount: 1, // User is still subscribed even with zero balance
      withdrawalCount: 2,
    });

    // Verify user's staked balance is zero
    const finalUserBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert.strictEqual(finalUserBalance?.amount, 0n, "User's staked balance should be zero after full withdrawal");

    // Get the module to check the withdrawal count
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;

    // Check for withdraw events
    assert.strictEqual(withdrawalCount, 2, "There should be two withdrawal events recorded");
  });

  // Test withdrawal from multiple subscribed pools
  test("test_withdraw_multiple_subscribed_pools", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const accountAddress = generateRandomAddress();
    const poolCreatorAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const pool1Address = generateRandomAddress();
    const pool2Address = generateRandomAddress();
    const pool3Address = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Create multiple staking pools
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: pool1Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: pool2Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: pool3Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // User stakes tokens (divide stake amount among 3 pools in the original test)
    // In our case the entire stake amount is applied to all pools
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User subscribes to all pools
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: pool1Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 1),
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: pool2Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 2),
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: pool3Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 3),
    });

    // Verify initial state
    const initialUserBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert.strictEqual(initialUserBalance?.amount, STAKE_AMOUNT, "Initial staked balance should match STAKE_AMOUNT");

    // Verify each pool's initial state
    await verifyPoolState(multiRewardsTestReader, pool1Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool2Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool3Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
    });

    // Perform partial withdrawal
    const withdrawAmount = WITHDRAW_AMOUNT;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(startTime + 10),
    });

    // Verify updated user balance
    const updatedUserBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert.strictEqual(
      updatedUserBalance?.amount,
      STAKE_AMOUNT - withdrawAmount,
      "User balance should be reduced by withdrawal amount",
    );

    // Verify each pool's updated state - all pools should reflect the withdrawal
    const expectedPoolSubscription = STAKE_AMOUNT - withdrawAmount;

    await verifyPoolState(multiRewardsTestReader, pool1Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: expectedPoolSubscription,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool2Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: expectedPoolSubscription,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool3Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: expectedPoolSubscription,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    // Verify user is still subscribed to all pools
    const subscription1 = await multiRewardsTestReader.getUserSubscription(accountAddress, pool1Address);
    const subscription2 = await multiRewardsTestReader.getUserSubscription(accountAddress, pool2Address);
    const subscription3 = await multiRewardsTestReader.getUserSubscription(accountAddress, pool3Address);

    assert(subscription1 && subscription1.is_currently_subscribed, "User should still be subscribed to pool 1");
    assert(subscription2 && subscription2.is_currently_subscribed, "User should still be subscribed to pool 2");
    assert(subscription3 && subscription3.is_currently_subscribed, "User should still be subscribed to pool 3");

    // Get the module to check the withdrawal count
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;

    // Check for withdraw event
    assert.strictEqual(withdrawalCount, 1, "There should be one withdrawal event recorded");
  });

  // Test withdrawal reward updates
  test("test_withdraw_reward_updates", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // First create the staking pool
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

    // Admin notifies new reward amount
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: ((REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION).toString(),
        period_finish: (startTime + Number(REWARD_DURATION)).toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial reward state
    const initialRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(initialRewardData, "Initial reward data should exist");

    // Fast forward time to accumulate some rewards (quarter of the reward duration)
    const quarterPointTime = startTime + Number(REWARD_DURATION) / 4;

    // Create user reward data by updating rewards at quarter point
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0", // Zero amount withdraw just to trigger reward update
      },
      timestamp: secondsToMicros(quarterPointTime),
    });

    // Get user reward data after first update
    const userRewardDataQuarter = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(userRewardDataQuarter, "Quarter point reward data should exist");

    // Check quarter point rewards are approximately as expected
    const expectedQuarterRewards = REWARD_AMOUNT / 4n;
    assertApproxEqualBigInt(
      userRewardDataQuarter.unclaimed_rewards,
      expectedQuarterRewards,
      10n, // Allow some tolerance for calculation differences
      "Quarter period rewards should be approximately 1/4 of total",
    );

    // Fast forward to half of the reward period
    const midPointTime = startTime + Number(REWARD_DURATION) / 2;

    // Update rewards at midpoint
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0", // Zero amount withdraw just to trigger reward update
      },
      timestamp: secondsToMicros(midPointTime),
    });

    // Get user reward data after midpoint update
    const userRewardDataMid = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(userRewardDataMid, "Mid point reward data should exist");

    // Check mid point rewards are approximately as expected
    const expectedMidRewards = REWARD_AMOUNT / 2n;
    assertApproxEqualBigInt(
      userRewardDataMid.unclaimed_rewards,
      expectedMidRewards,
      10n, // Allow some tolerance for calculation differences
      "Mid period rewards should be approximately 1/2 of total",
    );

    // Capture the reward rate before withdrawal for later comparison
    const rewardRateBeforeWithdraw = initialRewardData.reward_rate_u12;

    // Perform partial withdrawal
    const withdrawAmount = STAKE_AMOUNT / 2n;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(midPointTime + 1), // Just after midpoint
    });

    // Verify user balance is updated
    const userBalanceAfterWithdraw = await multiRewardsTestReader.getUserStakedBalance(userAddress, stakingToken);
    assert(userBalanceAfterWithdraw, "User balance should exist after withdrawal");
    assert.strictEqual(
      userBalanceAfterWithdraw.amount,
      STAKE_AMOUNT - withdrawAmount,
      "User's staked balance should be reduced by withdrawal amount",
    );

    // Verify pool state is updated
    const poolAfterWithdraw = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(poolAfterWithdraw, "Pool should exist after withdrawal");
    assert.strictEqual(
      poolAfterWithdraw.total_subscribed,
      STAKE_AMOUNT - withdrawAmount,
      "Pool's total subscribed amount should be reduced by withdrawal amount",
    );

    // Get user reward data right after withdrawal
    const userRewardDataAfterWithdraw = await multiRewardsTestReader.getUserRewardData(
      userAddress,
      poolAddress,
      rewardToken,
    );
    assert(userRewardDataAfterWithdraw, "User reward data should exist after withdrawal");

    // Unclaimed rewards should not change immediately after withdrawal
    assertApproxEqualBigInt(
      userRewardDataAfterWithdraw.unclaimed_rewards,
      userRewardDataMid.unclaimed_rewards,
      1n,
      "Unclaimed rewards should not change immediately after withdrawal",
    );

    // Fast forward time to three quarters of the reward period
    const threeQuarterPointTime = startTime + (Number(REWARD_DURATION) * 3) / 4;

    // Update rewards at three-quarter point
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0", // Zero amount withdraw just to trigger reward update
      },
      timestamp: secondsToMicros(threeQuarterPointTime),
    });

    // Get user reward data after three-quarter point
    const userRewardData3Q = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(userRewardData3Q, "Three-quarter point reward data should exist");

    // After withdrawal, rewards should accumulate at the same rate as the user is the only user subscribed to the pool
    // and rewards are distributed at a fixed rate
    const expected3QRewards = (REWARD_AMOUNT * 3n) / 4n;
    assertApproxEqualBigInt(
      userRewardData3Q.unclaimed_rewards,
      expected3QRewards,
      100n, // Higher tolerance due to withdrawal calculations
      "After withdrawal, rewards should continue accumulating but at a reduced rate",
    );

    // Fast forward to the end of reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Update rewards at end of period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0", // Zero amount withdraw just to trigger reward update
      },
      timestamp: secondsToMicros(endTime),
    });

    // Get user reward data at end of period
    const userRewardDataEnd = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(userRewardDataEnd, "End of period reward data should exist");

    // Verify that final rewards are greater than three-quarter point rewards
    assert(
      userRewardDataEnd.unclaimed_rewards > expected3QRewards,
      "Rewards should continue accumulating until end of period",
    );

    // Capture final unclaimed rewards for verification after claim
    const finalUnclaimedRewards = userRewardDataEnd.unclaimed_rewards;

    // User claims rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: finalUnclaimedRewards.toString(),
      },
      timestamp: secondsToMicros(endTime + 1),
    });

    // Verify claimed rewards
    const userRewardDataAfterClaim = await multiRewardsTestReader.getUserRewardData(
      userAddress,
      poolAddress,
      rewardToken,
    );
    assert(userRewardDataAfterClaim, "User reward data should exist after claim");
    assert.strictEqual(
      userRewardDataAfterClaim.unclaimed_rewards,
      0n,
      "Unclaimed rewards should be zero after claiming",
    );
    assert.strictEqual(
      userRewardDataAfterClaim.total_claimed,
      finalUnclaimedRewards,
      "Total claimed should equal the final unclaimed rewards",
    );

    // Verify claim events
    const claimEvents = await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);
    assert.strictEqual(
      claimEvents[0].claim_amount,
      finalUnclaimedRewards,
      "Claim event amount should match the claimed rewards",
    );

    // Verify reward rate hasn't changed after claim
    const rewardDataAfterClaim = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardDataAfterClaim, "Reward data should exist after claim");
    assertApproxEqualBigInt(
      rewardDataAfterClaim.reward_rate_u12,
      rewardRateBeforeWithdraw,
      1n,
      "Reward rate should remain constant after claim",
    );

    // Admin notifies new rewards to demonstrate rate change
    const newRewardAmount = REWARD_AMOUNT * 2n;
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: newRewardAmount.toString(),
        reward_rate: ((newRewardAmount * U12_PRECISION) / REWARD_DURATION).toString(),
        period_finish: (endTime + Number(REWARD_DURATION)).toString(),
      },
      timestamp: secondsToMicros(endTime + 2),
    });

    // Verify reward rate has increased after notifying new rewards
    const finalRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(finalRewardData, "Reward data should exist after notifying new rewards");
    assert(
      finalRewardData.reward_rate_u12 > rewardRateBeforeWithdraw,
      "Reward rate should increase after notifying new rewards",
    );
  });

  // Test withdrawal maintains subscriptions
  test("test_withdraw_maintains_subscriptions", async () => {
    // TODO: Implement test
  });

  // Test withdrawal with different tokens
  test("test_withdraw_different_tokens", async () => {
    // TODO: Implement test
  });

  // Test withdrawal after rewards distribution
  test("test_withdraw_after_rewards_distribution", async () => {
    // TODO: Implement test
  });

  // Test multiple withdrawals
  test("test_multiple_withdrawals", async () => {
    // TODO: Implement test
  });

  // Test withdraw and restake
  test("test_withdraw_and_restake", async () => {
    // TODO: Implement test
  });

  // Test withdrawal of a large amount
  test("test_withdraw_large_amount", async () => {
    // TODO: Implement test
  });

  // Test withdrawal with multiple users
  test("test_withdraw_with_multiple_users", async () => {
    // TODO: Implement test
  });

  // Test withdrawal after pool reward exhaustion
  test("test_withdraw_after_pool_reward_exhaustion", async () => {
    // TODO: Implement test
  });

  // Test withdrawal near reward period boundary
  test("test_withdraw_near_reward_period_boundary", async () => {
    // TODO: Implement test
  });

  // Test withdrawal with changing reward rates
  test("test_withdraw_with_changing_reward_rates", async () => {
    // TODO: Implement test
  });
});
