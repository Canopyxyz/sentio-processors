import { afterEach, before, describe, test } from "node:test";
import assert from "assert";
import { TestProcessorServer } from "@sentio/sdk/testing";

import { MultiRewardsTestReader } from "../../../processors/multi-rewards-processor.js";
import { multi_rewards_abi } from "../../../abis/multi_rewards.js";
import { TestProcessor } from "../../utils/processor.js";
import { multiRewardsHandlerIds } from "../common/constants.js";
import { generateRandomAddress } from "../../common/helpers.js";
import { verifyRewardState } from "../common/helpers.js";

describe("Add Reward", async () => {
  const service = new TestProcessorServer(() => import("../multi-rewards-processor.js"));
  const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);

  before(async () => {
    await service.start();
  });

  afterEach(async () => {
    service.db.reset();
  });

  test("Basic Add Reward", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test data
    const poolAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const creator = generateRandomAddress();

    // First create the pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
        creator,
      },
    });

    // Add reward to pool
    const rewardDuration = 86400; // 1 day, matching Move test
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        rewards_distributor: creator,
        rewards_duration: rewardDuration.toString(),
      },
    });

    // Verify reward was added correctly
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: creator,
      duration: BigInt(rewardDuration),
      rewardBalance: 0n,
      unallocatedRewards: 0n,
      totalDistributed: 0n,
      rewardRateU12: 0n,
      rewardPerTokenStoredU12: 0n,
    });

    // Verify pool's reward tokens list was updated
    const pool = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(pool, "Pool should exist");
    assert.deepStrictEqual(pool.reward_tokens, [rewardToken], "Pool should have the reward token added");
  });

  test("Add Multiple Rewards", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test data
    const poolAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const creator = generateRandomAddress();
    const rewardToken1 = generateRandomAddress();
    const rewardToken2 = generateRandomAddress();
    const rewardToken3 = generateRandomAddress();

    // First create the pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
        creator,
      },
    });

    // Add rewards with different durations (matching Move test)
    const rewardDuration1 = 86400; // 1 day
    const rewardDuration2 = 172800; // 2 days
    const rewardDuration3 = 259200; // 3 days

    // Add first reward
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken1 },
        rewards_distributor: creator,
        rewards_duration: rewardDuration1.toString(),
      },
    });

    // Add second reward
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken2 },
        rewards_distributor: creator,
        rewards_duration: rewardDuration2.toString(),
      },
    });

    // Add third reward
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken3 },
        rewards_distributor: creator,
        rewards_duration: rewardDuration3.toString(),
      },
    });

    // Verify each reward's state
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken1,
      distributor: creator,
      duration: BigInt(rewardDuration1),
      rewardBalance: 0n,
      unallocatedRewards: 0n,
      totalDistributed: 0n,
      rewardRateU12: 0n,
      rewardPerTokenStoredU12: 0n,
    });

    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken2,
      distributor: creator,
      duration: BigInt(rewardDuration2),
      rewardBalance: 0n,
      unallocatedRewards: 0n,
      totalDistributed: 0n,
      rewardRateU12: 0n,
      rewardPerTokenStoredU12: 0n,
    });

    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken: rewardToken3,
      distributor: creator,
      duration: BigInt(rewardDuration3),
      rewardBalance: 0n,
      unallocatedRewards: 0n,
      totalDistributed: 0n,
      rewardRateU12: 0n,
      rewardPerTokenStoredU12: 0n,
    });

    // Verify pool's reward tokens list contains all three tokens
    const pool = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(pool, "Pool should exist");
    assert.deepStrictEqual(
      pool.reward_tokens,
      [rewardToken1, rewardToken2, rewardToken3],
      "Pool should have all three reward tokens in order",
    );
  });

  test("Add Reward With Max Duration", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test data
    const poolAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const creator = generateRandomAddress();

    // First create the pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
        creator,
      },
    });

    // Max duration: 2 years in seconds (matching MAX_DURATION in Move)
    const maxDuration = 86400n * 365n * 2n;

    // Add reward with max duration
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        rewards_distributor: creator,
        rewards_duration: maxDuration.toString(),
      },
    });

    // Verify reward state
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: creator,
      duration: BigInt(maxDuration),
      rewardBalance: 0n,
      unallocatedRewards: 0n,
      totalDistributed: 0n,
      rewardRateU12: 0n,
      rewardPerTokenStoredU12: 0n,
    });

    // Verify pool's reward tokens list
    const pool = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(pool, "Pool should exist");
    assert.deepStrictEqual(pool.reward_tokens, [rewardToken], "Pool should have the reward token added");
  });

  test("Add Reward To Multiple Pools", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test data
    const pool1Address = generateRandomAddress();
    const pool2Address = generateRandomAddress();
    const stakingToken1 = generateRandomAddress();
    const stakingToken2 = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const creator = generateRandomAddress();
    const rewardDuration = 86400; // 1 day, matching Move test

    // Create first pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        pool_address: pool1Address,
        staking_token: { inner: stakingToken1 },
        creator,
      },
    });

    // Create second pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        pool_address: pool2Address,
        staking_token: { inner: stakingToken2 },
        creator,
      },
    });

    // Add reward token to first pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: pool1Address,
        reward_token: { inner: rewardToken },
        rewards_distributor: creator,
        rewards_duration: rewardDuration.toString(),
      },
    });

    // Add same reward token to second pool
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: pool2Address,
        reward_token: { inner: rewardToken },
        rewards_distributor: creator,
        rewards_duration: rewardDuration.toString(),
      },
    });

    // Verify reward state in first pool
    await verifyRewardState(multiRewardsTestReader, pool1Address, {
      rewardToken,
      distributor: creator,
      duration: BigInt(rewardDuration),
      rewardBalance: 0n,
      unallocatedRewards: 0n,
      totalDistributed: 0n,
      rewardRateU12: 0n,
      rewardPerTokenStoredU12: 0n,
    });

    // Verify reward state in second pool
    await verifyRewardState(multiRewardsTestReader, pool2Address, {
      rewardToken,
      distributor: creator,
      duration: BigInt(rewardDuration),
      rewardBalance: 0n,
      unallocatedRewards: 0n,
      totalDistributed: 0n,
      rewardRateU12: 0n,
      rewardPerTokenStoredU12: 0n,
    });

    // Verify pools' reward tokens lists
    const pool1 = await multiRewardsTestReader.getStakingPool(pool1Address);
    const pool2 = await multiRewardsTestReader.getStakingPool(pool2Address);
    assert(pool1 && pool2, "Both pools should exist");
    assert.deepStrictEqual(pool1.reward_tokens, [rewardToken], "First pool should have the reward token");
    assert.deepStrictEqual(pool2.reward_tokens, [rewardToken], "Second pool should have the reward token");
  });

  test("Add Reward With Different Distributor", async () => {
    const multiRewardsTestReader = new MultiRewardsTestReader(service.store);
    // Generate test data
    const poolAddress = generateRandomAddress();
    const stakingToken = generateRandomAddress();
    const rewardToken = generateRandomAddress();
    const creator = generateRandomAddress();
    const distributor = generateRandomAddress();
    const rewardDuration = 86400; // 1 day, matching Move test

    // Verify creator and distributor are different addresses
    assert.notStrictEqual(creator, distributor, "Creator and distributor should be different addresses");

    // First create the pool
    await processor.processEvent({
      name: "StakingPoolCreatedEvent",
      data: {
        pool_address: poolAddress,
        staking_token: { inner: stakingToken },
        creator,
      },
    });

    // Add reward with different distributor
    await processor.processEvent({
      name: "RewardAddedEvent",
      data: {
        pool_address: poolAddress,
        reward_token: { inner: rewardToken },
        rewards_distributor: distributor, // Using different distributor address
        rewards_duration: rewardDuration.toString(),
      },
    });

    // Verify reward state
    await verifyRewardState(multiRewardsTestReader, poolAddress, {
      rewardToken,
      distributor: distributor, // Should match the different distributor
      duration: BigInt(rewardDuration),
      rewardBalance: 0n,
      unallocatedRewards: 0n,
      totalDistributed: 0n,
      rewardRateU12: 0n,
      rewardPerTokenStoredU12: 0n,
    });

    // Verify pool's reward tokens list
    const pool = await multiRewardsTestReader.getStakingPool(poolAddress);
    assert(pool, "Pool should exist");
    assert.deepStrictEqual(pool.reward_tokens, [rewardToken], "Pool should have the reward token added");
  });
});
