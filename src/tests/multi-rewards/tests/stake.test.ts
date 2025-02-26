/* eslint-disable */
// TODO: remove the above disable
import assert from "assert";
import { before, afterEach, describe, test } from "node:test";
import { TestProcessorServer, MemoryDatabase } from "@sentio/sdk/testing";

import { Subject } from "rxjs";
import { StoreContext } from "@sentio/sdk/store";
import { DeepPartial, ProcessStreamResponse } from "@sentio/sdk";

import { MultiRewardsTestReader } from "../../../processors/multi-rewards-processor.js";
import { multi_rewards_abi } from "../../../abis/multi-rewards-testnet.js";
import { TestProcessor } from "../../utils/processor.js";
import { multiRewardsHandlerIds } from "../common/constants.js";
import { generateRandomAddress, secondsToMicros } from "../../common/helpers.js";
import { verifyStakeEvent, verifyUserState, verifyPoolState, verifyRewardState } from "../common/helpers.js";

describe("Stake", async () => {
  //  - - - setup local store and db - - -

  // TODO: remove if the TestProcessorServer already creats a DB
  const subject = new Subject<DeepPartial<ProcessStreamResponse>>();
  const storeContext = new StoreContext(subject, 1);
  const db = new MemoryDatabase(storeContext);
  db.start();

  // - - - - - -

  const service = new TestProcessorServer(() => import("../multi-rewards-processor.js"));
  const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);

  // const INITIAL_BALANCE = 1_000_000n;
  const STAKE_AMOUNT = 100_000n;
  // const STAKE_AMOUNT_1 = 100_000n;
  // const STAKE_AMOUNT_2 = 200_000n;
  // const STAKE_AMOUNT_3 = 150_000n;
  const REWARD_AMOUNT = 1_000_000n;
  const REWARD_DURATION = 86400n; // 1 day in seconds
  const INITIAL_STAKE = 100_000n;
  const ADDITIONAL_STAKE = 50_000n;
  // const MIN_STAKE_AMOUNT = 1000n;
  const U12_PRECISION = 1_000_000_000_000n; // 1e12

  before(async () => {
    await service.start();
  });

  afterEach(async () => {
    db.reset();
  });

  test("Basic stake", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test addresses
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();

    // Initial stake
    const stakeAmount = 100000n;

    // Process the stake event
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: stakeAmount.toString(),
      },
      timestamp: 0n, // Start at time 0
    });

    // Verify the user's state after staking
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: stakeAmount,
      subscribedPools: [], // No pools subscribed initially
    });
  });

  test("Stake minimum amount", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test addresses
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();

    const MIN_STAKE_AMOUNT = 1000n;

    // First stake at minimum amount
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: MIN_STAKE_AMOUNT.toString(),
      },
      timestamp: 0n,
    });

    // Get stake count after first event
    const firstStakeCount = await multiRewardsTestReader.getStakeCount();

    // Verify first stake event
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: MIN_STAKE_AMOUNT,
      timestamp: 0n,
      stake_count: firstStakeCount,
    });

    // Second stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: MIN_STAKE_AMOUNT.toString(),
      },
      timestamp: 1n,
    });

    // Get stake count after second event
    const secondStakeCount = await multiRewardsTestReader.getStakeCount();

    // Verify second stake event
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: MIN_STAKE_AMOUNT,
      timestamp: 1n,
      stake_count: secondStakeCount,
    });
  });

  test("Stake multiple times", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test addresses
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();

    // Define stake amounts matching Move test
    const stakeAmount1 = 100000n;
    const stakeAmount2 = 200000n;
    const stakeAmount3 = 150000n;

    // First stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: stakeAmount1.toString(),
      },
      timestamp: 0n,
    });

    // Verify first stake
    const firstStakeCount = await multiRewardsTestReader.getStakeCount();
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: stakeAmount1,
      timestamp: 0n,
      stake_count: firstStakeCount,
    });
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: stakeAmount1,
      subscribedPools: [],
    });

    // Second stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: stakeAmount2.toString(),
      },
      timestamp: 1n,
    });

    // Verify second stake
    const secondStakeCount = await multiRewardsTestReader.getStakeCount();
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: stakeAmount2,
      timestamp: 1n,
      stake_count: secondStakeCount,
    });
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: stakeAmount1 + stakeAmount2,
      subscribedPools: [],
    });

    // Third stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: stakeAmount3.toString(),
      },
      timestamp: 2n,
    });

    // Verify third stake
    const thirdStakeCount = await multiRewardsTestReader.getStakeCount();
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: stakeAmount3,
      timestamp: 2n,
      stake_count: thirdStakeCount,
    });
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: stakeAmount1 + stakeAmount2 + stakeAmount3,
      subscribedPools: [],
    });
  });

  test("Stake without existing pools", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const stakeAmount = 100000n;

    // Verify no pools exist initially for this staking token
    const user = await multiRewardsTestReader.getUser(userAddress);
    assert(!user, "User should not exist yet");

    // Process stake event
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: stakeAmount.toString(),
      },
      timestamp: 0n,
    });

    // Verify the stake was successful
    let stakeCount = await multiRewardsTestReader.getStakeCount();
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: stakeAmount,
      timestamp: 0n,
      stake_count: stakeCount,
    });

    // Verify user state with empty subscriptions
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: stakeAmount,
      subscribedPools: [], // No pools subscribed
    });
  });

  test("Stake with existing subscription", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);

    // Generate test addresses
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolCreator = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    const initialStake = 100_000n;
    const additionalStake = 50_000n;

    // Create a pool first
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreator,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: 0n,
    });

    // Initial stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: initialStake.toString(),
      },
      timestamp: 1n,
    });

    // Subscribe to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: 2n,
    });

    // amount subscribed to pool should be increased

    // Verify initial subscription state
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: initialStake,
      subscribedPools: [poolAddress],
    });

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreator,
      totalSubscribed: initialStake,
      subscriberCount: 1,
    });

    // Perform additional stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: additionalStake.toString(),
      },
      timestamp: 3n,
    });

    // since the user is already subscribed to a pool staking more should increase the total subscribed for that pool

    // Verify final states
    const finalStakeCount = await multiRewardsTestReader.getStakeCount();
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: additionalStake,
      timestamp: 3n,
      stake_count: finalStakeCount,
    });

    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: initialStake + additionalStake,
      subscribedPools: [poolAddress],
    });

    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: poolCreator,
      totalSubscribed: initialStake + additionalStake,
      subscriberCount: 1,
    });
  });

  test("Stake with multiple subscriptions", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test addresses
    const userAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolCreator = generateRandomAddress();
    const poolAddress1 = generateRandomAddress();
    const poolAddress2 = generateRandomAddress();
    const poolAddress3 = generateRandomAddress();

    const initialStake = 100000n;
    const additionalStake = 50000n;

    // Create multiple pools
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreator,
        pool_address: poolAddress1,
        staking_token: { inner: stakingToken },
      },
      timestamp: 0n,
    });

    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreator,
        pool_address: poolAddress2,
        staking_token: { inner: stakingToken },
      },
      timestamp: 1n,
    });

    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: poolCreator,
        pool_address: poolAddress3,
        staking_token: { inner: stakingToken },
      },
      timestamp: 2n,
    });

    // Initial stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: initialStake.toString(),
      },
      timestamp: 3n,
    });

    // Subscribe to all pools
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress1,
        staking_token: { inner: stakingToken },
      },
      timestamp: 4n,
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress2,
        staking_token: { inner: stakingToken },
      },
      timestamp: 5n,
    });

    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: userAddress,
        pool_address: poolAddress3,
        staking_token: { inner: stakingToken },
      },
      timestamp: 6n,
    });

    // Verify initial subscriptions and pool states
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: initialStake,
      subscribedPools: [poolAddress1, poolAddress2, poolAddress3],
    });

    // Verify each pool's initial state
    for (const poolAddress of [poolAddress1, poolAddress2, poolAddress3]) {
      await verifyPoolState(multiRewardsTestReader, poolAddress, {
        stakingToken,
        creator: poolCreator,
        totalSubscribed: initialStake,
        subscriberCount: 1,
      });
    }

    // Perform additional stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken },
        amount: additionalStake.toString(),
      },
      timestamp: 7n,
    });

    // Verify final states
    const finalStakeCount = await multiRewardsTestReader.getStakeCount();
    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken,
      amount: additionalStake,
      timestamp: 7n,
      stake_count: finalStakeCount,
    });

    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken,
      stakedBalance: initialStake + additionalStake,
      subscribedPools: [poolAddress1, poolAddress2, poolAddress3],
    });

    // Verify each pool's final state
    for (const poolAddress of [poolAddress1, poolAddress2, poolAddress3]) {
      await verifyPoolState(multiRewardsTestReader, poolAddress, {
        stakingToken,
        creator: poolCreator,
        totalSubscribed: initialStake + additionalStake,
        subscriberCount: 1,
      });
    }
  });

  test("Stake reward updates", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test addresses (mirroring account indices 0 and 1 from Move test)
    const stakerAddress = generateRandomAddress();
    const adminAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    // Create pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: adminAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(0),
    });

    // Add reward to pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        rewards_distributor: adminAddress,
        rewards_duration: REWARD_DURATION.toString(),
      },
      timestamp: secondsToMicros(1),
    });

    // Initial stake
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: stakerAddress,
        staking_token: { inner: stakingToken },
        amount: INITIAL_STAKE.toString(),
      },
      timestamp: secondsToMicros(2),
    });

    // Subscribe to pool
    await processor.processEvent({
      name: "SubscriptionEvent",
      data: {
        user: stakerAddress,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(3),
    });

    // Notify reward amount
    await processor.processEvent({
      name: "RewardNotifiedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(),
        reward_rate: ((REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION).toString(),
        period_finish: (3 + Number(REWARD_DURATION)).toString(),
      },
      timestamp: secondsToMicros(3),
    });

    // Fast forward time halfway through reward period
    const midPoint = 3 + Number(REWARD_DURATION) / 2;

    // Additional stake at midpoint
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: stakerAddress,
        staking_token: { inner: stakingToken },
        amount: ADDITIONAL_STAKE.toString(),
      },
      timestamp: secondsToMicros(midPoint),
    });

    // Fast forward to end of reward period
    const endPoint = 3 + Number(REWARD_DURATION);

    // Claim rewards
    await processor.processEvent({
      name: "RewardClaimedEvent",
      data: {
        pool_address: poolAddress,
        user: stakerAddress,
        reward_token: { inner: rewardToken },
        reward_amount: REWARD_AMOUNT.toString(), // Full amount as only staker
      },
      timestamp: secondsToMicros(endPoint),
    });

    // Verify final states
    await verifyUserState(multiRewardsTestReader, stakerAddress, {
      stakingToken,
      stakedBalance: INITIAL_STAKE + ADDITIONAL_STAKE,
      subscribedPools: [poolAddress],
    });

    // Calculate expected reward per token stored
    // Over the full period, with staking amount changing midway:
    // First half: reward_rate * (REWARD_DURATION/2) / INITIAL_STAKE
    // Second half: reward_rate * (REWARD_DURATION/2) / (INITIAL_STAKE + ADDITIONAL_STAKE)
    const rewardRate = (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION;
    const firstHalf = (rewardRate * (REWARD_DURATION / 2n)) / INITIAL_STAKE;
    const secondHalf = (rewardRate * (REWARD_DURATION / 2n)) / (INITIAL_STAKE + ADDITIONAL_STAKE);
    const expectedRewardPerToken = firstHalf + secondHalf;

    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: adminAddress,
      duration: REWARD_DURATION,
      rewardBalance: 0n, // All claimed
      unallocatedRewards: 0n,
      totalDistributed: REWARD_AMOUNT,
      rewardRateU12: (REWARD_AMOUNT * U12_PRECISION) / REWARD_DURATION,
      rewardPerTokenStoredU12: expectedRewardPerToken,
    });
  });

  test("Stake different tokens", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test addresses
    const userAddress = generateRandomAddress();
    const stakingToken1 = generateRandomAddress();
    const stakingToken2 = generateRandomAddress();
    const stakingToken3 = generateRandomAddress();

    const stakeAmount1 = STAKE_AMOUNT;
    const stakeAmount2 = STAKE_AMOUNT * 2n;
    const stakeAmount3 = STAKE_AMOUNT * 3n;

    // Stake first token
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken1 },
        amount: stakeAmount1.toString(),
      },
      timestamp: secondsToMicros(0),
    });

    // Stake second token
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken2 },
        amount: stakeAmount2.toString(),
      },
      timestamp: secondsToMicros(1),
    });

    // Stake third token
    await processor.processEvent({
      name: "StakeEvent",
      data: {
        user: userAddress,
        staking_token: { inner: stakingToken3 },
        amount: stakeAmount3.toString(),
      },
      timestamp: secondsToMicros(2),
    });

    // Verify staked balances for each token
    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken: stakingToken1,
      stakedBalance: stakeAmount1,
      subscribedPools: [],
    });

    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken: stakingToken2,
      stakedBalance: stakeAmount2,
      subscribedPools: [],
    });

    await verifyUserState(multiRewardsTestReader, userAddress, {
      stakingToken: stakingToken3,
      stakedBalance: stakeAmount3,
      subscribedPools: [],
    });

    // Verify stake events
    const finalStakeCount = await multiRewardsTestReader.getStakeCount();

    await verifyStakeEvent(multiRewardsTestReader, {
      user: userAddress,
      staking_token: stakingToken3,
      amount: stakeAmount3,
      timestamp: secondsToMicros(2),
      stake_count: finalStakeCount,
    });
  });

  test("Stake multiple users", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test addresses
    const tokenCreator = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const poolAddress = generateRandomAddress();

    // Create multiple user addresses
    const user1 = generateRandomAddress();
    const user2 = generateRandomAddress();
    const user3 = generateRandomAddress();
    const users = [user1, user2, user3];

    // Create pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        creator: tokenCreator,
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
      },
      timestamp: secondsToMicros(0),
    });

    // Stake for each user and subscribe them to the pool
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const stakeAmount = STAKE_AMOUNT * BigInt(i + 1);

      // Stake tokens
      await processor.processEvent({
        name: "StakeEvent",
        data: {
          user: user,
          staking_token: { inner: stakingToken },
          amount: stakeAmount.toString(),
        },
        timestamp: secondsToMicros(i * 2 + 1),
      });

      // Subscribe to pool
      await processor.processEvent({
        name: "SubscriptionEvent",
        data: {
          user: user,
          pool_address: poolAddress,
          staking_token: { inner: stakingToken },
        },
        timestamp: secondsToMicros(i * 2 + 2),
      });

      // Verify user's staked balance and subscription
      await verifyUserState(multiRewardsTestReader, user, {
        stakingToken,
        stakedBalance: stakeAmount,
        subscribedPools: [poolAddress],
      });

      // Get stake count and verify stake event
      const stakeCount = await multiRewardsTestReader.getStakeCount();
      await verifyStakeEvent(multiRewardsTestReader, {
        user: user,
        staking_token: stakingToken,
        amount: stakeAmount,
        timestamp: secondsToMicros(i * 2 + 1),
        stake_count: stakeCount,
      });
    }

    // Verify final pool state
    // Total subscribed should be STAKE_AMOUNT * (1 + 2 + 3) = 6 * STAKE_AMOUNT
    await verifyPoolState(multiRewardsTestReader, poolAddress, {
      stakingToken,
      creator: tokenCreator,
      totalSubscribed: STAKE_AMOUNT * 6n,
      subscriberCount: 3,
    });
  });

  test("Stake after unstake", async () => {
    // Test staking after complete withdrawal
  });
});
