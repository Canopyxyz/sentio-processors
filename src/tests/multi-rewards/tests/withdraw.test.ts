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

  test("test_withdraw_maintains_subscriptions", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const accountAddress = generateRandomAddress();
    const poolCreatorAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const pool1Address = generateRandomAddress();
    const pool2Address = generateRandomAddress();
    const pool3Address = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Create multiple pools
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

    // User stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime + 1),
    });

    // User subscribes to all pools
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: pool1Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 2),
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: pool2Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 3),
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: pool3Address,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 4),
    });

    // Verify initial subscriptions
    const subscription1 = await multiRewardsTestReader.getUserSubscription(accountAddress, pool1Address);
    const subscription2 = await multiRewardsTestReader.getUserSubscription(accountAddress, pool2Address);
    const subscription3 = await multiRewardsTestReader.getUserSubscription(accountAddress, pool3Address);

    assert(subscription1 && subscription1.is_currently_subscribed, "User should be initially subscribed to pool 1");
    assert(subscription2 && subscription2.is_currently_subscribed, "User should be initially subscribed to pool 2");
    assert(subscription3 && subscription3.is_currently_subscribed, "User should be initially subscribed to pool 3");

    // Check initial pool states
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
    const withdrawAmount = STAKE_AMOUNT / 2n;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(startTime + 5),
    });

    // Verify subscriptions are maintained after partial withdrawal
    const subscription1AfterPartial = await multiRewardsTestReader.getUserSubscription(accountAddress, pool1Address);
    const subscription2AfterPartial = await multiRewardsTestReader.getUserSubscription(accountAddress, pool2Address);
    const subscription3AfterPartial = await multiRewardsTestReader.getUserSubscription(accountAddress, pool3Address);

    assert(
      subscription1AfterPartial && subscription1AfterPartial.is_currently_subscribed,
      "User should still be subscribed to pool 1 after partial withdrawal",
    );
    assert(
      subscription2AfterPartial && subscription2AfterPartial.is_currently_subscribed,
      "User should still be subscribed to pool 2 after partial withdrawal",
    );
    assert(
      subscription3AfterPartial && subscription3AfterPartial.is_currently_subscribed,
      "User should still be subscribed to pool 3 after partial withdrawal",
    );

    // Check updated pool states after partial withdrawal
    const expectedRemainingStake = STAKE_AMOUNT - withdrawAmount;
    await verifyPoolState(multiRewardsTestReader, pool1Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: expectedRemainingStake,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool2Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: expectedRemainingStake,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool3Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: expectedRemainingStake,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    // Perform full withdrawal of remaining amount
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken },
        amount: expectedRemainingStake.toString(),
      },
      timestamp: secondsToMicros(startTime + 6),
    });

    // Verify subscriptions are still maintained after full withdrawal
    const subscription1AfterFull = await multiRewardsTestReader.getUserSubscription(accountAddress, pool1Address);
    const subscription2AfterFull = await multiRewardsTestReader.getUserSubscription(accountAddress, pool2Address);
    const subscription3AfterFull = await multiRewardsTestReader.getUserSubscription(accountAddress, pool3Address);

    assert(
      subscription1AfterFull && subscription1AfterFull.is_currently_subscribed,
      "User should still be subscribed to pool 1 after full withdrawal",
    );
    assert(
      subscription2AfterFull && subscription2AfterFull.is_currently_subscribed,
      "User should still be subscribed to pool 2 after full withdrawal",
    );
    assert(
      subscription3AfterFull && subscription3AfterFull.is_currently_subscribed,
      "User should still be subscribed to pool 3 after full withdrawal",
    );

    // Verify user's staked balance is zero
    const userStakedBalance = await multiRewardsTestReader.getUserStakedBalance(accountAddress, stakingToken);
    assert(userStakedBalance, "User staked balance should exist");
    assert.strictEqual(userStakedBalance.amount, 0n, "User should have zero staked balance after full withdrawal");

    // Check final pool states after full withdrawal
    await verifyPoolState(multiRewardsTestReader, pool1Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: 0n,
      subscriberCount: 1, // User is still subscribed even with zero balance
      withdrawalCount: 2,
    });

    await verifyPoolState(multiRewardsTestReader, pool2Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: 0n,
      subscriberCount: 1,
      withdrawalCount: 2,
    });

    await verifyPoolState(multiRewardsTestReader, pool3Address, {
      stakingToken,
      creator: poolCreatorAddress,
      totalSubscribed: 0n,
      subscriberCount: 1,
      withdrawalCount: 2,
    });

    // Get the module to check the withdrawal count
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;

    // Check for withdraw events
    assert.strictEqual(withdrawalCount, 2, "There should be two withdrawal events recorded");
  });

  test("test_withdraw_different_tokens", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const accountAddress = generateRandomAddress();
    const poolCreatorAddress = generateRandomAddress();
    const stakingToken1 = generateRandomAddress();
    const stakingToken2 = generateRandomAddress();
    const stakingToken3 = generateRandomAddress();
    const pool1Address = generateRandomAddress();
    const pool2Address = generateRandomAddress();
    const pool3Address = generateRandomAddress();

    const startTime = 1000; // Base timestamp for the test

    // Create pools for each token
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: pool1Address,
        staking_token: { inner: stakingToken1 },
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: pool2Address,
        staking_token: { inner: stakingToken2 },
      },
      timestamp: secondsToMicros(startTime),
    });

    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreatorAddress,
        pool_address: pool3Address,
        staking_token: { inner: stakingToken3 },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Stake different amounts for each token
    const stakeAmount1 = STAKE_AMOUNT;
    const stakeAmount2 = STAKE_AMOUNT * 2n;
    const stakeAmount3 = STAKE_AMOUNT * 3n;

    // User stakes tokens for each pool
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken1 },
        amount: stakeAmount1.toString(),
      },
      timestamp: secondsToMicros(startTime + 1),
    });

    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken2 },
        amount: stakeAmount2.toString(),
      },
      timestamp: secondsToMicros(startTime + 2),
    });

    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken3 },
        amount: stakeAmount3.toString(),
      },
      timestamp: secondsToMicros(startTime + 3),
    });

    // User subscribes to each pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: pool1Address,
        staking_token: { inner: stakingToken1 },
      },
      timestamp: secondsToMicros(startTime + 4),
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: pool2Address,
        staking_token: { inner: stakingToken2 },
      },
      timestamp: secondsToMicros(startTime + 5),
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: accountAddress,
        pool_address: pool3Address,
        staking_token: { inner: stakingToken3 },
      },
      timestamp: secondsToMicros(startTime + 6),
    });

    // Verify initial states
    await verifyUserState(multiRewardsTestReader, accountAddress, {
      stakingToken: stakingToken1,
      stakedBalance: stakeAmount1,
      subscribedPools: [pool1Address],
    });

    await verifyUserState(multiRewardsTestReader, accountAddress, {
      stakingToken: stakingToken2,
      stakedBalance: stakeAmount2,
      subscribedPools: [pool2Address],
    });

    await verifyUserState(multiRewardsTestReader, accountAddress, {
      stakingToken: stakingToken3,
      stakedBalance: stakeAmount3,
      subscribedPools: [pool3Address],
    });

    await verifyPoolState(multiRewardsTestReader, pool1Address, {
      stakingToken: stakingToken1,
      creator: poolCreatorAddress,
      totalSubscribed: stakeAmount1,
      subscriberCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool2Address, {
      stakingToken: stakingToken2,
      creator: poolCreatorAddress,
      totalSubscribed: stakeAmount2,
      subscriberCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool3Address, {
      stakingToken: stakingToken3,
      creator: poolCreatorAddress,
      totalSubscribed: stakeAmount3,
      subscriberCount: 1,
    });

    // Perform withdrawals for each token
    const withdrawAmount1 = stakeAmount1 / 2n;
    const withdrawAmount2 = stakeAmount2 / 2n;
    const withdrawAmount3 = stakeAmount3 / 2n;

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken1 },
        amount: withdrawAmount1.toString(),
      },
      timestamp: secondsToMicros(startTime + 7),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken2 },
        amount: withdrawAmount2.toString(),
      },
      timestamp: secondsToMicros(startTime + 8),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: accountAddress,
        staking_token: { inner: stakingToken3 },
        amount: withdrawAmount3.toString(),
      },
      timestamp: secondsToMicros(startTime + 9),
    });

    // Verify final balances after withdrawals
    await verifyUserState(multiRewardsTestReader, accountAddress, {
      stakingToken: stakingToken1,
      stakedBalance: stakeAmount1 - withdrawAmount1,
      subscribedPools: [pool1Address],
    });

    await verifyUserState(multiRewardsTestReader, accountAddress, {
      stakingToken: stakingToken2,
      stakedBalance: stakeAmount2 - withdrawAmount2,
      subscribedPools: [pool2Address],
    });

    await verifyUserState(multiRewardsTestReader, accountAddress, {
      stakingToken: stakingToken3,
      stakedBalance: stakeAmount3 - withdrawAmount3,
      subscribedPools: [pool3Address],
    });

    // Verify pool states after withdrawals
    await verifyPoolState(multiRewardsTestReader, pool1Address, {
      stakingToken: stakingToken1,
      creator: poolCreatorAddress,
      totalSubscribed: stakeAmount1 - withdrawAmount1,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool2Address, {
      stakingToken: stakingToken2,
      creator: poolCreatorAddress,
      totalSubscribed: stakeAmount2 - withdrawAmount2,
      subscriberCount: 1,
      withdrawalCount: 1,
    });

    await verifyPoolState(multiRewardsTestReader, pool3Address, {
      stakingToken: stakingToken3,
      creator: poolCreatorAddress,
      totalSubscribed: stakeAmount3 - withdrawAmount3,
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

    // Check for withdraw events
    assert.strictEqual(withdrawalCount, 3, "There should be three withdrawal events recorded");
  });

  test("test_withdraw_after_rewards_distribution", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const user1Address = generateRandomAddress();
    const user2Address = generateRandomAddress();
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
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime + 1),
    });

    // User1 stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime + 2),
    });

    // User1 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 3),
    });

    // Add a second user
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime + 4),
    });

    // User2 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 5),
    });

    // Admin notifies reward amount
    const periodFinish = startTime + Number(REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: ((REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime + 6),
    });

    // Verify initial user states
    await verifyUserState(multiRewardsTestReader, user1Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    await verifyUserState(multiRewardsTestReader, user2Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    // Verify initial pool state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 2n, // Two users with STAKE_AMOUNT each
      subscriberCount: 2,
      rewardTokens: [rewardToken],
    });

    // Verify initial reward state
    const initialRewardState = await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: REWARD_AMOUNT,
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION,
      rewardPerTokenStoredU12: 0n,
    });

    // Fast forward time to distribute some rewards (halfway through reward period)
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Update rewards by simulating a zero-amount withdrawal
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    // Log reward state after user1's update
    const rewardStateAfterUser1Update = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(halfwayTime + 1),
    });

    // Get reward data after half period
    const user1RewardDataHalf = await multiRewardsTestReader.getUserRewardData(user1Address, poolAddress, rewardToken);
    const user2RewardDataHalf = await multiRewardsTestReader.getUserRewardData(user2Address, poolAddress, rewardToken);

    assert(user1RewardDataHalf, "User1 reward data should exist at halfway point");
    assert(user2RewardDataHalf, "User2 reward data should exist at halfway point");

    // Expected rewards after half the period (each user should have ~25% of total rewards)
    const expectedHalfReward = REWARD_AMOUNT / 4n;

    // Verify rewards are approximately as expected
    assertApproxEqualBigInt(
      user1RewardDataHalf.unclaimed_rewards,
      expectedHalfReward,
      expectedHalfReward / 100n, // Allow 1% tolerance
      "User1 should have approximately 25% of rewards at halfway point",
    );

    assertApproxEqualBigInt(
      user2RewardDataHalf.unclaimed_rewards,
      expectedHalfReward,
      expectedHalfReward / 100n, // Allow 1% tolerance
      "User2 should have approximately 25% of rewards at halfway point",
    );

    // User1 performs a partial withdrawal
    const withdrawAmount = STAKE_AMOUNT / 2n;

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(halfwayTime + 2),
    });

    // Verify user1 balance after withdrawal
    const user1BalanceAfterWithdraw = await multiRewardsTestReader.getUserStakedBalance(user1Address, stakingToken);

    await verifyUserState(multiRewardsTestReader, user1Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - withdrawAmount,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after user1's withdrawal
    const poolStateAfterWithdraw = await multiRewardsTestReader.getStakingPool(poolAddress);

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 2n - withdrawAmount, // Adjusted for user1's withdrawal
      subscriberCount: 2,
      rewardTokens: [rewardToken],
      withdrawalCount: 3, // Including the zero-amount withdrawals
    });

    // Fast forward to end of reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Update rewards at end of period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endTime),
    });

    // Log reward state after end period user1 update
    const rewardStateAfterEndUser1 = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endTime + 1),
    });

    // Get reward data at end of period
    const user1RewardDataEnd = await multiRewardsTestReader.getUserRewardData(user1Address, poolAddress, rewardToken);
    const user2RewardDataEnd = await multiRewardsTestReader.getUserRewardData(user2Address, poolAddress, rewardToken);

    assert(user1RewardDataEnd, "User1 reward data should exist at end of period");
    assert(user2RewardDataEnd, "User2 reward data should exist at end of period");

    // Store the unclaimed rewards before claiming
    const user1UnclaimedBeforeClaim = user1RewardDataEnd.unclaimed_rewards;
    const user2UnclaimedBeforeClaim = user2RewardDataEnd.unclaimed_rewards;

    // In the second half of the period, User1 had half their original stake (1/3 of total)
    // and User2 maintained full stake (2/3 of total)
    const totalRewards = user1UnclaimedBeforeClaim + user2UnclaimedBeforeClaim;

    // Check that total rewards distributed is approximately REWARD_AMOUNT
    assertApproxEqualBigInt(
      totalRewards,
      REWARD_AMOUNT,
      REWARD_AMOUNT / 100n, // Allow 1% tolerance
      "Total rewards should approximately equal REWARD_AMOUNT",
    );

    // Verify user1's proportion is roughly 40-43% of total rewards (accounting for rounding)
    const user1Proportion = (user1UnclaimedBeforeClaim * 100n) / REWARD_AMOUNT;

    assert(
      user1Proportion >= 40n && user1Proportion <= 43n,
      `User1 should have ~41.67% of rewards but has ${user1Proportion}%`,
    );

    // Verify user2's proportion is roughly 57-60% of total rewards (accounting for rounding)
    const user2Proportion = (user2UnclaimedBeforeClaim * 100n) / REWARD_AMOUNT;

    assert(
      user2Proportion >= 57n && user2Proportion <= 60n,
      `User2 should have ~58.33% of rewards but has ${user2Proportion}%`,
    );

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: user1UnclaimedBeforeClaim.toString(),
      },
      timestamp: secondsToMicros(endTime + 5),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: user2UnclaimedBeforeClaim.toString(),
      },
      timestamp: secondsToMicros(endTime + 6),
    });

    // Verify claim events
    await verifyClaimEvents(service, poolAddress, user1Address, rewardToken, 1);
    await verifyClaimEvents(service, poolAddress, user2Address, rewardToken, 1);

    // Verify reward data after claims
    const user1RewardDataAfterClaim = await multiRewardsTestReader.getUserRewardData(
      user1Address,
      poolAddress,
      rewardToken,
    );
    const user2RewardDataAfterClaim = await multiRewardsTestReader.getUserRewardData(
      user2Address,
      poolAddress,
      rewardToken,
    );

    assert(user1RewardDataAfterClaim, "User1 reward data should exist after claim");
    assert(user2RewardDataAfterClaim, "User2 reward data should exist after claim");

    assert.strictEqual(
      user1RewardDataAfterClaim.unclaimed_rewards,
      0n,
      "User1 should have no unclaimed rewards after claiming",
    );
    assert.strictEqual(
      user2RewardDataAfterClaim.unclaimed_rewards,
      0n,
      "User2 should have no unclaimed rewards after claiming",
    );

    assert.strictEqual(
      user1RewardDataAfterClaim.total_claimed,
      user1UnclaimedBeforeClaim,
      "User1's total_claimed should equal previous unclaimed_rewards",
    );
    assert.strictEqual(
      user2RewardDataAfterClaim.total_claimed,
      user2UnclaimedBeforeClaim,
      "User2's total_claimed should equal previous unclaimed_rewards",
    );

    // Try to withdraw again after reward period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT / 2n).toString(),
      },
      timestamp: secondsToMicros(endTime + 10),
    });

    // Verify user2's balance after second withdrawal
    await verifyUserState(multiRewardsTestReader, user2Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT / 2n,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after user2's withdrawal
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT, // Both users have STAKE_AMOUNT/2 each, totaling STAKE_AMOUNT
      subscriberCount: 2,
      claimCount: 2,
      rewardTokens: [rewardToken],
      withdrawalCount: 6, // Including all withdrawals
    });

    // Fast forward a bit more
    const postPeriodTime = endTime + 100;

    // Check rewards after period end - should be no new rewards
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(postPeriodTime),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(postPeriodTime + 1),
    });

    // Get reward data after period end
    const user1RewardDataPostPeriod = await multiRewardsTestReader.getUserRewardData(
      user1Address,
      poolAddress,
      rewardToken,
    );
    const user2RewardDataPostPeriod = await multiRewardsTestReader.getUserRewardData(
      user2Address,
      poolAddress,
      rewardToken,
    );

    // No new rewards should be earned after period ends
    assert.strictEqual(
      user1RewardDataPostPeriod?.unclaimed_rewards,
      0n,
      "User1 should not earn new rewards after period end",
    );
    assert.strictEqual(
      user2RewardDataPostPeriod?.unclaimed_rewards,
      0n,
      "User2 should not earn new rewards after period end",
    );

    // Verify both users are still subscribed to the pool
    const subscription1 = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const subscription2 = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);

    assert(subscription1 && subscription1.is_currently_subscribed, "User1 should still be subscribed to the pool");
    assert(subscription2 && subscription2.is_currently_subscribed, "User2 should still be subscribed to the pool");

    // Check withdrawal count in module
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;
    assert(withdrawalCount >= 6, "There should be at least 6 withdrawal events recorded");
  });

  test("test_multiple_withdrawals", async () => {
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
        rewards_duration: REWARD_DURATION.toString(),
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

    // Admin notifies reward amount
    const periodFinish = startTime + Number(REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: ((REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime + 4),
    });

    // Verify initial user state
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    // Verify initial pool state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Perform first withdrawal (1/4 of the stake)
    const withdrawAmount1 = STAKE_AMOUNT / 4n;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount1.toString(),
      },
      timestamp: secondsToMicros(startTime + 5),
    });

    // Verify user state after first withdrawal
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - withdrawAmount1,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after first withdrawal
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT - withdrawAmount1,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      withdrawalCount: 1,
    });

    // Fast forward time (quarter of the reward duration)
    const quarterPointTime = startTime + Number(REWARD_DURATION) / 4;

    // Perform second withdrawal (1/3 of the original stake)
    const withdrawAmount2 = STAKE_AMOUNT / 3n;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount2.toString(),
      },
      timestamp: secondsToMicros(quarterPointTime),
    });

    // Verify user state after second withdrawal
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - withdrawAmount1 - withdrawAmount2,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after second withdrawal
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT - withdrawAmount1 - withdrawAmount2,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      withdrawalCount: 2,
    });

    // Fast forward time (another quarter of the reward duration)
    const halfPointTime = startTime + Number(REWARD_DURATION) / 2;

    // Check rewards after multiple withdrawals
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(halfPointTime),
    });

    const rewardDataHalfPoint = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(rewardDataHalfPoint, "User reward data should exist at half point");
    assert(rewardDataHalfPoint.unclaimed_rewards > 0n, "User should have earned some rewards");

    // Perform final withdrawal (remaining balance)
    const remainingBalance = STAKE_AMOUNT - withdrawAmount1 - withdrawAmount2;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: remainingBalance.toString(),
      },
      timestamp: secondsToMicros(halfPointTime + 1),
    });

    // Verify user has no staked balance after final withdrawal
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: 0n,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after final withdrawal
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      withdrawalCount: 4,
    });

    // Verify user is still subscribed to the pool
    const subscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      subscription && subscription.is_currently_subscribed,
      "User should still be subscribed after full withdrawal",
    );

    // Claim rewards
    const rewardDataBeforeClaim = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(rewardDataBeforeClaim, "User reward data should exist before claim");

    const unclaimedRewards = rewardDataBeforeClaim.unclaimed_rewards;
    assert(unclaimedRewards > 0n, "User should have unclaimed rewards");

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: unclaimedRewards.toString(),
      },
      timestamp: secondsToMicros(halfPointTime + 10),
    });

    // Verify claim events
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);

    // Verify reward data after claim
    const rewardDataAfterClaim = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(rewardDataAfterClaim, "User reward data should exist after claim");

    assert.strictEqual(
      rewardDataAfterClaim.unclaimed_rewards,
      0n,
      "User should have no unclaimed rewards after claiming",
    );
    assert.strictEqual(
      rewardDataAfterClaim.total_claimed,
      unclaimedRewards,
      "User's total_claimed should equal previous unclaimed_rewards",
    );

    // Get the module to check the withdrawal count
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;
    assert.strictEqual(withdrawalCount, 4, "There should be four withdrawal events recorded (including zero amount)");
  });

  test("test_withdraw_and_restake", async () => {
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
        rewards_duration: REWARD_DURATION.toString(),
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

    // Admin notifies reward amount
    const periodFinish = startTime + Number(REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: ((REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime + 4),
    });

    // Verify initial user state
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    // Verify initial pool state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
    });

    // Perform partial withdrawal
    const withdrawAmount = STAKE_AMOUNT / 2n;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(startTime + 5),
    });

    // Verify user state after withdrawal
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - withdrawAmount,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after withdrawal
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT - withdrawAmount,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      withdrawalCount: 1,
    });

    // Fast forward time (quarter of the reward duration)
    const quarterPointTime = startTime + Number(REWARD_DURATION) / 4;

    // Restake the withdrawn amount
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(quarterPointTime),
    });

    // Verify user state after restaking
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after restaking
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      withdrawalCount: 1,
    });

    // Fast forward to end of reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Update rewards at end of period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endTime),
    });

    // Check earned rewards
    const rewardDataEndPeriod = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(rewardDataEndPeriod, "User reward data should exist at end of period");
    assert(rewardDataEndPeriod.unclaimed_rewards > 0n, "User should have earned rewards");

    // Store unclaimed rewards before claiming
    const unclaimedRewards = rewardDataEndPeriod.unclaimed_rewards;

    // Claim rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: userAddress,
        reward_token: { inner: rewardToken },
        reward_amount: unclaimedRewards.toString(),
      },
      timestamp: secondsToMicros(endTime + 1),
    });

    // Verify claim events
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);

    // Verify reward data after claim
    const rewardDataAfterClaim = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(rewardDataAfterClaim, "User reward data should exist after claim");

    assert.strictEqual(
      rewardDataAfterClaim.unclaimed_rewards,
      0n,
      "User should have no unclaimed rewards after claiming",
    );
    assert.strictEqual(
      rewardDataAfterClaim.total_claimed,
      unclaimedRewards,
      "User's total_claimed should equal previous unclaimed_rewards",
    );

    // Perform full withdrawal
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(endTime + 10),
    });

    // Verify user state after full withdrawal
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: 0n,
      subscribedPools: [poolAddress],
    });

    // Verify pool state after full withdrawal
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      withdrawalCount: 3,
      claimCount: 1,
    });

    // Verify user is still subscribed to the pool
    const subscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(subscription && subscription.is_currently_subscribed, "User should still be subscribed to the pool");

    // Get the module to check the stake and withdrawal counts
    const module = await multiRewardsTestReader.getModule();
    const stakeCount = module?.stake_count || 0;
    const withdrawalCount = module?.withdrawal_count || 0;

    assert.strictEqual(stakeCount, 2, "There should be two stake events recorded");
    assert.strictEqual(withdrawalCount, 3, "There should be three withdrawal events recorded (including zero amount)");

    // Verify stake events
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: STAKE_AMOUNT,
      timestamp: BigInt(secondsToMicros(startTime + 2)),
      stake_count: 1,
    });

    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: withdrawAmount,
      timestamp: BigInt(secondsToMicros(quarterPointTime)),
      stake_count: 2,
    });
  });

  test("test_withdraw_with_multiple_users", async () => {
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
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime + 1),
    });

    // User1 stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime + 2),
    });

    // User1 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user1Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 3),
    });

    // User2 stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime + 4),
    });

    // User2 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 5),
    });

    // User3 stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user3Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime + 6),
    });

    // User3 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user3Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime + 7),
    });

    // Admin notifies reward amount
    const periodFinish = startTime + Number(REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: ((REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime + 8),
    });

    // Verify initial user states
    await verifyUserState(multiRewardsTestReader, user1Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    await verifyUserState(multiRewardsTestReader, user2Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    await verifyUserState(multiRewardsTestReader, user3Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    // Verify initial pool state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 3n, // Three users with STAKE_AMOUNT each
      subscriberCount: 3,
      rewardTokens: [rewardToken],
    });

    // Fast forward to accumulate some rewards (halfway through reward period)
    const halfwayTime = startTime + Number(REWARD_DURATION) / 2;

    // Update rewards by simulating a zero-amount withdrawal
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(halfwayTime),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(halfwayTime + 1),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user3Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(halfwayTime + 2),
    });

    // Get reward data at halfway point
    const user1RewardDataHalf = await multiRewardsTestReader.getUserRewardData(user1Address, poolAddress, rewardToken);

    const user2RewardDataHalf = await multiRewardsTestReader.getUserRewardData(user2Address, poolAddress, rewardToken);

    const user3RewardDataHalf = await multiRewardsTestReader.getUserRewardData(user3Address, poolAddress, rewardToken);

    assert(user1RewardDataHalf, "User1 reward data should exist at halfway point");
    assert(user2RewardDataHalf, "User2 reward data should exist at halfway point");
    assert(user3RewardDataHalf, "User3 reward data should exist at halfway point");

    // Record initial rewards
    const initialReward1 = user1RewardDataHalf.unclaimed_rewards;
    const initialReward2 = user2RewardDataHalf.unclaimed_rewards;
    const initialReward3 = user3RewardDataHalf.unclaimed_rewards;

    // Each user should have approximately 1/6 of the total rewards (half period, equally divided among 3 users)
    const expectedHalfwayReward = REWARD_AMOUNT / 6n;

    // Allow 1% tolerance for reward calculations
    assertApproxEqualBigInt(
      initialReward1,
      expectedHalfwayReward,
      expectedHalfwayReward / 100n,
      "User1 should have approximately 1/6 of total rewards at halfway point",
    );

    assertApproxEqualBigInt(
      initialReward2,
      expectedHalfwayReward,
      expectedHalfwayReward / 100n,
      "User2 should have approximately 1/6 of total rewards at halfway point",
    );

    assertApproxEqualBigInt(
      initialReward3,
      expectedHalfwayReward,
      expectedHalfwayReward / 100n,
      "User3 should have approximately 1/6 of total rewards at halfway point",
    );

    // User1 performs a partial withdrawal
    const withdrawAmount = STAKE_AMOUNT / 2n;
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(halfwayTime + 3),
    });

    // Verify user1's new balance
    await verifyUserState(multiRewardsTestReader, user1Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - withdrawAmount,
      subscribedPools: [poolAddress],
    });

    // Verify pool's total subscribed amount
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 3n - withdrawAmount, // Initial 3*STAKE_AMOUNT minus user1's withdrawal
      subscriberCount: 3,
      rewardTokens: [rewardToken],
      withdrawalCount: 4, // Including zero-amount withdrawals
    });

    // Fast forward to 3/4 of the reward period
    const threeQuarterTime = startTime + (Number(REWARD_DURATION) * 3) / 4;

    // Update rewards
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(threeQuarterTime),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(threeQuarterTime + 1),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user3Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(threeQuarterTime + 2),
    });

    // Get reward data at three-quarter point
    const user1Reward3Q = await multiRewardsTestReader
      .getUserRewardData(user1Address, poolAddress, rewardToken)
      .then((data) => data?.unclaimed_rewards || 0n);

    const user2Reward3Q = await multiRewardsTestReader
      .getUserRewardData(user2Address, poolAddress, rewardToken)
      .then((data) => data?.unclaimed_rewards || 0n);

    const user3Reward3Q = await multiRewardsTestReader
      .getUserRewardData(user3Address, poolAddress, rewardToken)
      .then((data) => data?.unclaimed_rewards || 0n);

    // Check rewards after user1's withdrawal
    // User1's reward rate has decreased, user2 and user3 should have higher rate
    const reward1Increase = user1Reward3Q - initialReward1;
    const reward2Increase = user2Reward3Q - initialReward2;
    const reward3Increase = user3Reward3Q - initialReward3;

    // Verify that user1's reward rate has decreased
    assert(reward1Increase < reward2Increase, "User1's reward accrual rate should be lower than User2's");
    assert(reward1Increase < reward3Increase, "User1's reward accrual rate should be lower than User3's");

    // Verify that user2 and user3's reward rates are approximately equal
    assertApproxEqualBigInt(
      reward2Increase,
      reward3Increase,
      reward2Increase / 100n, // Allow 1% tolerance
      "User2 and User3 should have similar reward increases",
    );

    // User2 performs a full withdrawal
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(threeQuarterTime + 10),
    });

    // Verify user2's new balance
    await verifyUserState(multiRewardsTestReader, user2Address, {
      stakingToken,
      stakedBalance: 0n,
      subscribedPools: [poolAddress],
    });

    // Verify pool's new total subscribed amount
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT + STAKE_AMOUNT / 2n, // User3 has STAKE_AMOUNT, User1 has STAKE_AMOUNT/2
      subscriberCount: 3,
      rewardTokens: [rewardToken],
      withdrawalCount: 8, // Including all withdrawals
    });

    // Fast forward to the end of the reward period
    const endTime = startTime + Number(REWARD_DURATION);

    // Update rewards at end of period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endTime),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endTime + 1),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user3Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endTime + 2),
    });

    // Get final reward data
    const user1RewardFinal = await multiRewardsTestReader
      .getUserRewardData(user1Address, poolAddress, rewardToken)
      .then((data) => data?.unclaimed_rewards || 0n);

    const user2RewardFinal = await multiRewardsTestReader
      .getUserRewardData(user2Address, poolAddress, rewardToken)
      .then((data) => data?.unclaimed_rewards || 0n);

    const user3RewardFinal = await multiRewardsTestReader
      .getUserRewardData(user3Address, poolAddress, rewardToken)
      .then((data) => data?.unclaimed_rewards || 0n);

    // Final assertions on rewards
    assert(user1RewardFinal > initialReward1, "User1's final rewards should be greater than initial rewards");
    assert(user2RewardFinal > initialReward2, "User2's final rewards should be greater than initial rewards");
    assert(user3RewardFinal > initialReward3, "User3's final rewards should be greater than initial rewards");

    assert(user3RewardFinal > user1RewardFinal, "User3 should earn more than User1 due to higher stake");
    assert(user2RewardFinal < user3RewardFinal, "User2 should earn less than User3 due to full withdrawal");

    // Verify all users are still subscribed
    const subscription1 = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const subscription2 = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);
    const subscription3 = await multiRewardsTestReader.getUserSubscription(user3Address, poolAddress);

    assert(subscription1 && subscription1.is_currently_subscribed, "User1 should still be subscribed");
    assert(subscription2 && subscription2.is_currently_subscribed, "User2 should still be subscribed");
    assert(subscription3 && subscription3.is_currently_subscribed, "User3 should still be subscribed");

    // Get the module to check the withdrawal count
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;
    assert(withdrawalCount >= 10, "There should be at least 10 withdrawal events recorded");
  });

  test("test_withdraw_after_pool_reward_exhaustion", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const user1Address = generateRandomAddress();
    const user2Address = generateRandomAddress();
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
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User1 stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
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

    // User2 stakes tokens
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: STAKE_AMOUNT.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // User2 subscribes to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: user2Address,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(startTime),
    });

    // Admin notifies reward amount
    const periodFinish = startTime + Number(REWARD_DURATION);
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: ((REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime),
    });

    // Verify initial states
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 2n,
      subscriberCount: 2,
      rewardTokens: [rewardToken],
    });

    await verifyUserState(multiRewardsTestReader, user1Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    await verifyUserState(multiRewardsTestReader, user2Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT,
      subscribedPools: [poolAddress],
    });

    // Fast forward to end of reward period to exhaust all rewards
    const endTime = startTime + Number(REWARD_DURATION);

    // Update rewards at end of period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endTime),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endTime),
    });

    // Check and record rewards for both users
    const user1RewardData = await multiRewardsTestReader.getUserRewardData(user1Address, poolAddress, rewardToken);
    const user2RewardData = await multiRewardsTestReader.getUserRewardData(user2Address, poolAddress, rewardToken);

    assert(user1RewardData, "User1 reward data should exist");
    assert(user2RewardData, "User2 reward data should exist");

    // Each user should have approximately half the rewards (slight rounding differences expected)
    const expectedReward = REWARD_AMOUNT / 2n;
    assertApproxEqualBigInt(
      user1RewardData.unclaimed_rewards,
      expectedReward,
      expectedReward / 100n, // Allow 1% tolerance
      "User1 should have approximately half of the rewards",
    );

    assertApproxEqualBigInt(
      user2RewardData.unclaimed_rewards,
      expectedReward,
      expectedReward / 100n, // Allow 1% tolerance
      "User2 should have approximately half of the rewards",
    );

    // Users claim their rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user1Address,
        reward_token: { inner: rewardToken },
        reward_amount: user1RewardData.unclaimed_rewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: user2Address,
        reward_token: { inner: rewardToken },
        reward_amount: user2RewardData.unclaimed_rewards.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Verify claim events
    await verifyClaimEvents(service, poolAddress, user1Address, rewardToken, 1);
    await verifyClaimEvents(service, poolAddress, user2Address, rewardToken, 1);

    // Verify reward exhaustion
    const rewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(rewardData, "Reward data should exist");

    // The remaining rewards should be close to zero (allowing for small rounding differences)
    assertApproxEqualBigInt(
      rewardData.reward_balance,
      0n,
      10n, // Allow small rounding errors
      "Reward balance should be approximately zero after claims",
    );

    // Perform withdrawals after reward exhaustion
    const withdrawAmount = STAKE_AMOUNT / 2n;

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: withdrawAmount.toString(),
      },
      timestamp: secondsToMicros(endTime),
    });

    // Verify user balances after withdrawals
    await verifyUserState(multiRewardsTestReader, user1Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - withdrawAmount,
      subscribedPools: [poolAddress],
    });

    await verifyUserState(multiRewardsTestReader, user2Address, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT - withdrawAmount,
      subscribedPools: [poolAddress],
    });

    // Verify pool's total subscribed amount
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: STAKE_AMOUNT * 2n - withdrawAmount * 2n,
      subscriberCount: 2,
      rewardTokens: [rewardToken],
      claimCount: 2,
      withdrawalCount: 4,
    });

    // Fast forward some more time after reward period
    const postRewardTime = endTime + 100;

    // Update rewards to check if new rewards are earned
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(postRewardTime),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(postRewardTime),
    });

    // Verify no new rewards are earned after period end
    const user1RewardDataPost = await multiRewardsTestReader.getUserRewardData(user1Address, poolAddress, rewardToken);
    const user2RewardDataPost = await multiRewardsTestReader.getUserRewardData(user2Address, poolAddress, rewardToken);

    assert(user1RewardDataPost, "User1 reward data should exist post-period");
    assert(user2RewardDataPost, "User2 reward data should exist post-period");

    assert.strictEqual(user1RewardDataPost.unclaimed_rewards, 0n, "User1 should not earn new rewards after period end");
    assert.strictEqual(user2RewardDataPost.unclaimed_rewards, 0n, "User2 should not earn new rewards after period end");

    // Add new rewards
    const newRewardAmount = REWARD_AMOUNT / 2n;
    const newPeriodFinish = postRewardTime + Number(REWARD_DURATION);

    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: newRewardAmount.toString(),
        reward_rate: ((newRewardAmount * U12_PRECISION) / REWARD_DURATION).toString(),
        period_finish: newPeriodFinish.toString(),
      },
      timestamp: secondsToMicros(postRewardTime),
    });

    // Fast forward to halfway through new reward period
    const halfwayNewPeriod = postRewardTime + Number(REWARD_DURATION) / 2;

    // Update rewards at halfway point of new period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(halfwayNewPeriod),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(halfwayNewPeriod),
    });

    // Check new rewards are accruing
    const user1RewardDataNew = await multiRewardsTestReader.getUserRewardData(user1Address, poolAddress, rewardToken);
    const user2RewardDataNew = await multiRewardsTestReader.getUserRewardData(user2Address, poolAddress, rewardToken);

    assert(user1RewardDataNew, "User1 reward data should exist for new period");
    assert(user2RewardDataNew, "User2 reward data should exist for new period");

    const expectedNewHalfReward = newRewardAmount / 4n; // Half time, equal stakes

    assertApproxEqualBigInt(
      user1RewardDataNew.unclaimed_rewards,
      expectedNewHalfReward,
      expectedNewHalfReward / 100n, // Allow 1% tolerance
      "User1 should have earned approximately 1/4 of new rewards at halfway point",
    );

    assertApproxEqualBigInt(
      user2RewardDataNew.unclaimed_rewards,
      expectedNewHalfReward,
      expectedNewHalfReward / 100n, // Allow 1% tolerance
      "User2 should have earned approximately 1/4 of new rewards at halfway point",
    );

    // Perform final withdrawals
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user1Address,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT - withdrawAmount).toString(),
      },
      timestamp: secondsToMicros(halfwayNewPeriod),
    });

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: user2Address,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT - withdrawAmount).toString(),
      },
      timestamp: secondsToMicros(halfwayNewPeriod),
    });

    // Verify final balances
    await verifyUserState(multiRewardsTestReader, user1Address, {
      stakingToken,
      stakedBalance: 0n,
      subscribedPools: [poolAddress],
    });

    await verifyUserState(multiRewardsTestReader, user2Address, {
      stakingToken,
      stakedBalance: 0n,
      subscribedPools: [poolAddress],
    });

    // Verify pool's final state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 2,
      rewardTokens: [rewardToken],
      withdrawalCount: 10,
      claimCount: 2,
    });

    // Verify users are still subscribed
    const subscription1 = await multiRewardsTestReader.getUserSubscription(user1Address, poolAddress);
    const subscription2 = await multiRewardsTestReader.getUserSubscription(user2Address, poolAddress);

    assert(subscription1 && subscription1.is_currently_subscribed, "User1 should still be subscribed");
    assert(subscription2 && subscription2.is_currently_subscribed, "User2 should still be subscribed");

    // Get the module to check the withdrawal count
    const module = await multiRewardsTestReader.getModule();
    const withdrawalCount = module?.withdrawal_count || 0;
    assert(withdrawalCount >= 6, "There should be at least 6 withdrawal events recorded");
  });

  test("test_withdraw_with_changing_reward_rates", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const adminAddress = generateRandomAddress();
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    // Use precise timestamps and durations for easier math
    const startTime = 10000;
    const rewardDuration = 100000; // 100,000 seconds for easier math
    const periodFinish = startTime + rewardDuration;

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
        rewards_duration: rewardDuration.toString(),
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

    // Initial reward notification of 1 million tokens
    const initialRewardAmount = 1000000n;
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: initialRewardAmount.toString(),
        reward_rate: ((initialRewardAmount * U12_PRECISION) / BigInt(rewardDuration)).toString(),
        period_finish: periodFinish.toString(),
      },
      timestamp: secondsToMicros(startTime + 4),
    });

    // Get initial reward rate
    const initialRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(initialRewardData, "Initial reward data should exist");

    const rewardRate1 = initialRewardData.reward_rate_u12;

    // The expected rate is initialRewardAmount * U12_PRECISION / rewardDuration = 10,000,000,000,000
    const expectedRate1 = (initialRewardAmount * U12_PRECISION) / BigInt(rewardDuration);
    assertApproxEqualBigInt(
      rewardRate1,
      expectedRate1,
      1n,
      "Initial reward rate should be approximately 10,000,000,000,000",
    );

    // First reward period (25% duration)
    const quarterPointTime = startTime + rewardDuration / 4;

    // Update rewards at quarter point
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(quarterPointTime),
    });

    // Check rewards at quarter point
    const rewardDataQuarter = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(rewardDataQuarter, "Quarter point reward data should exist");

    const expectedQuarterRewards = initialRewardAmount / 4n;

    // Expected rewards after 25% of period: initialRewardAmount * 0.25 = 250,000
    assertApproxEqualBigInt(
      rewardDataQuarter.unclaimed_rewards,
      expectedQuarterRewards,
      initialRewardAmount / 400n, // Allow 0.25% tolerance
      "User should have earned approximately 1/4 of rewards at quarter point",
    );

    // User withdraws half their stake
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT / 2n).toString(),
      },
      timestamp: secondsToMicros(quarterPointTime + 1),
    });

    // Verify user's balance after withdrawal
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT / 2n,
      subscribedPools: [poolAddress],
    });

    // Change reward rate with new reward notification
    const newRewardAmount = 1500000n; // 1.5 million tokens
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: newRewardAmount.toString(),
        // The new reward rate will be calculated in the handler based on remaining rewards
        reward_rate: "22500000000000", // This value isn't actually used by the handler
        period_finish: (startTime + rewardDuration).toString(), // Reset to original end time
      },
      timestamp: secondsToMicros(quarterPointTime + 2),
    });

    // Get updated reward rate
    const updatedRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(updatedRewardData, "Updated reward data should exist");

    const rewardRate2 = updatedRewardData.reward_rate_u12;

    // Verify reward rate has increased
    assert(rewardRate2 > rewardRate1, "Reward rate should increase after new notification");

    const expectedRate2 = (2250000n * U12_PRECISION) / 100000n; // Use full duration, not remaining time
    assertApproxEqualBigInt(
      rewardRate2,
      expectedRate2,
      expectedRate2 / 100n, // Allow 1% tolerance
      "New reward rate should be approximately 22,500,000,000,000",
    );

    // Fast forward time to half point (further 25% of original duration)
    const halfPointTime = startTime + rewardDuration / 2;

    // Update rewards at half point
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(halfPointTime),
    });

    // Check rewards at half point
    const rewardDataHalf = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(rewardDataHalf, "Half point reward data should exist");

    // Initial 250,000 + (1/4 of duration * new rate with half stake)
    // We can't predict the exact amount due to complex rate calculations, but it should be significant
    assert(
      rewardDataHalf.unclaimed_rewards > expectedQuarterRewards + 100000n,
      "User should have earned significant additional rewards with new rate",
    );

    // User withdraws half of their remaining stake
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT / 4n).toString(),
      },
      timestamp: secondsToMicros(halfPointTime + 1),
    });

    // Verify user's balance after second withdrawal
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: STAKE_AMOUNT / 4n,
      subscribedPools: [poolAddress],
    });

    // Change reward rate again
    const finalRewardAmount = 500000n; // 0.5 million tokens
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: finalRewardAmount.toString(),
        // The new reward rate will be calculated in the handler
        reward_rate: "30000000000000", // This value isn't actually used by the handler
        period_finish: (startTime + rewardDuration).toString(), // Reset to original end time
      },
      timestamp: secondsToMicros(halfPointTime + 2),
    });

    // Get final reward rate
    const finalRewardData = await multiRewardsTestReader.getPoolRewardData(poolAddress, rewardToken);
    assert(finalRewardData, "Final reward data should exist");

    const rewardRate3 = finalRewardData.reward_rate_u12;

    // Calculate rewards that would be left from previous distribution
    // 2,250,000 - (25,000 seconds * previous rate) + 500,000 new rewards
    // The exact calculation is complex, but reward rate should remain high
    assert(rewardRate3 > rewardRate1, "Final reward rate should be higher than initial rate");

    // Allow remaining time to pass
    const endTime = startTime + rewardDuration;

    // Update rewards at end of period
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: "0",
      },
      timestamp: secondsToMicros(endTime),
    });

    // Check final rewards
    const rewardDataEnd = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(rewardDataEnd, "End of period reward data should exist");

    // Store final unclaimed rewards
    const finalUnclaimedRewards = rewardDataEnd.unclaimed_rewards;
    assert(finalUnclaimedRewards > 0n, "User should have substantial unclaimed rewards at end");

    // Claim rewards
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

    // Verify claim events
    await verifyClaimEvents(service, poolAddress, userAddress, rewardToken, 1);

    // Verify reward data after claim
    const rewardDataAfterClaim = await multiRewardsTestReader.getUserRewardData(userAddress, poolAddress, rewardToken);
    assert(rewardDataAfterClaim, "User reward data should exist after claim");

    assert.strictEqual(
      rewardDataAfterClaim.unclaimed_rewards,
      0n,
      "User should have no unclaimed rewards after claiming",
    );
    assert.strictEqual(
      rewardDataAfterClaim.total_claimed,
      finalUnclaimedRewards,
      "User's total_claimed should equal previous unclaimed_rewards",
    );

    // Final withdrawal
    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: (STAKE_AMOUNT / 4n).toString(),
      },
      timestamp: secondsToMicros(endTime + 10),
    });

    // Verify user's final balance
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: 0n,
      subscribedPools: [poolAddress],
    });

    // Verify pool's final state
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: adminAddress,
      totalSubscribed: 0n,
      subscriberCount: 1,
      rewardTokens: [rewardToken],
      withdrawalCount: 6, // All withdrawals including zero-amount ones
      claimCount: 1,
    });

    // Verify user is still subscribed
    const subscription = await multiRewardsTestReader.getUserSubscription(userAddress, poolAddress);
    assert(
      subscription && subscription.is_currently_subscribed,
      "User should still be subscribed after full withdrawal",
    );

    // Check total rewards distributed approximately matches expected total
    const totalDistributedRewards = finalUnclaimedRewards;
    const totalExpectedRewards = initialRewardAmount + newRewardAmount + finalRewardAmount;

    // Note: The total claimed won't exactly match total rewards due to:
    // 1. User withdrawing before all rewards are distributed
    // 2. Potential rounding in fixed-point calculations
    // We check that it's at least a reasonable proportion
    assert(
      totalDistributedRewards > totalExpectedRewards / 2n,
      "Total distributed rewards should be a significant portion of total rewards",
    );
  });
});
