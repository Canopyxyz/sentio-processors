import assert from "assert";

import { getTimestampInSeconds, MultiRewardsTestReader } from "../../../processors/multi-rewards-processor.js";
import { assertApproxEqualBigInt } from "../../common/assertions.js";
import { TestProcessorServer } from "@sentio/sdk/testing";
import { MRRewardClaimedEvent, MRUserRewardData } from "../../../schema/schema.rewards.js";

// Helper to verify pool state
export async function verifyPoolState(
  reader: MultiRewardsTestReader,
  poolAddress: string,
  expectedState: {
    stakingToken: string;
    creator: string;
    totalSubscribed?: bigint;
    rewardTokens?: string[];
    withdrawalCount?: number;
    claimCount?: number;
    subscriberCount?: number;
  },
) {
  const pool = await reader.getStakingPool(poolAddress);
  assert(pool, "Pool should exist");

  assert.strictEqual(pool.staking_token, expectedState.stakingToken);
  assert.strictEqual(pool.creator, expectedState.creator);
  assert.strictEqual(pool.total_subscribed, expectedState.totalSubscribed ?? 0n);
  assert.deepStrictEqual(pool.reward_tokens, expectedState.rewardTokens ?? []);
  assert.strictEqual(pool.withdrawal_count, expectedState.withdrawalCount ?? 0);
  assert.strictEqual(pool.claim_count, expectedState.claimCount ?? 0);
  assert.strictEqual(pool.subscriber_count, expectedState.subscriberCount ?? 0);
}

// Helper to verify reward state
export async function verifyRewardState(
  reader: MultiRewardsTestReader,
  poolAddress: string,
  expectedState: {
    rewardToken: string;
    distributor: string;
    duration: bigint;
    rewardBalance: bigint;
    unallocatedRewards: bigint;
    totalDistributed: bigint;
    rewardRateU12: bigint;
    rewardPerTokenStoredU12: bigint;
  },
) {
  const rewardData = await reader.getPoolRewardData(poolAddress, expectedState.rewardToken);
  assert(rewardData, "Reward data should exist");

  assert.strictEqual(rewardData.reward_token, expectedState.rewardToken);
  assert.strictEqual(rewardData.distributor, expectedState.distributor);
  assert.strictEqual(rewardData.duration, expectedState.duration);
  assert.strictEqual(rewardData.reward_balance, expectedState.rewardBalance);
  assertApproxEqualBigInt(
    rewardData.unallocated_rewards,
    expectedState.unallocatedRewards,
    1n,
    "Unallocated rewards not approximately equal",
  );
  assert.strictEqual(rewardData.total_distributed, expectedState.totalDistributed);

  // Use approximate comparison for reward rate
  assertApproxEqualBigInt(
    rewardData.reward_rate_u12,
    expectedState.rewardRateU12,
    1n,
    "Reward rate not approximately equal",
  );

  // You might want to use the same for reward_per_token_stored_u12 as well
  assertApproxEqualBigInt(
    rewardData.reward_per_token_stored_u12,
    expectedState.rewardPerTokenStoredU12,
    1n,
    "Reward per token stored not approximately equal",
  );

  return rewardData;
}

export async function verifyUserState(
  reader: MultiRewardsTestReader,
  userAddress: string,
  expectedState: {
    stakingToken: string;
    stakedBalance: bigint;
    subscribedPools?: string[]; // pool addresses
  },
) {
  // Verify staked balance
  const stakedBalance = await reader.getUserStakedBalance(userAddress, expectedState.stakingToken);
  assert(stakedBalance, "Staked balance should exist");
  assert.strictEqual(stakedBalance.amount, expectedState.stakedBalance);

  // Verify subscribed pools if provided
  if (expectedState.subscribedPools !== undefined) {
    for (const poolAddress of expectedState.subscribedPools) {
      const subscription = await reader.getUserSubscription(userAddress, poolAddress);
      assert(subscription, `Subscription to pool ${poolAddress} should exist`);
      assert(subscription.is_currently_subscribed, `Should be currently subscribed to pool ${poolAddress}`);
    }
  }
}

// Helper to verify stake event
export async function verifyStakeEvent(
  reader: MultiRewardsTestReader,
  expectedState: {
    user: string;
    staking_token: string;
    amount: bigint;
    timestamp: bigint;
    stake_count: number;
  },
) {
  const event = await reader.getStakeEvent(expectedState.user, expectedState.staking_token, expectedState.stake_count);
  assert(event, "Stake event should exist");

  const userEntity = await reader.getUser(expectedState.user);

  const userAddress = event.userID.toString();
  assert.strictEqual(expectedState.user, userAddress);
  // after we get the user address we can get the user as follows; however we don't need to test anything on the user so it's commented out
  // const userEntityForEvent = await reader.getUser(userAddress);

  assert(userEntity, "User entity should exist");
  assert.strictEqual(userEntity.id, expectedState.user);
  assert.strictEqual(event.staking_token, expectedState.staking_token);
  assert.strictEqual(event.amount, expectedState.amount);
  // since the processor runtime deals with only microseconds but the actual event handlers deal with seconds
  // we convert the microseconds to seconds to compare
  assert.strictEqual(event.timestamp, getTimestampInSeconds(expectedState.timestamp));
}

// Helper to verify user reward data
export async function verifyUserRewardData(
  service: TestProcessorServer,
  userAddress: string,
  poolAddress: string,
  rewardToken: string,
  expectedState: {
    rewardPerTokenPaidU12: bigint;
    unclaimedRewards: bigint;
    totalClaimed: bigint;
  },
) {
  const userRewardDataId = `${userAddress}-${poolAddress}-${rewardToken}`;
  const userRewardData = await service.store.get(MRUserRewardData, userRewardDataId);
  assert(userRewardData, `User reward data should exist for ${userRewardDataId}`);
  assertApproxEqualBigInt(
    userRewardData.reward_per_token_paid_u12,
    expectedState.rewardPerTokenPaidU12,
    1n,
    "reward_per_token_paid_u12 should match",
  );
  assert.strictEqual(
    userRewardData.unclaimed_rewards,
    expectedState.unclaimedRewards,
    "unclaimed_rewards should match",
  );
  assert.strictEqual(userRewardData.total_claimed, expectedState.totalClaimed, "total_claimed should match");
  return userRewardData;
}

// Helper to verify claim events
export async function verifyClaimEvents(
  service: TestProcessorServer,
  poolAddress: string,
  userAddress: string,
  rewardToken: string,
  expectedCounts: number,
) {
  // First get all events for the reward token
  const allClaimEvents = await service.store.list(MRRewardClaimedEvent, [
    { field: "reward_token", op: "=", value: rewardToken },
  ]);

  // Then manually filter for the specific user
  const userClaimEvents = allClaimEvents.filter((event) => event.userID.toString() === userAddress);

  assert.strictEqual(
    userClaimEvents.length,
    expectedCounts,
    `Should have ${expectedCounts} claim events for user ${userAddress}`,
  );

  // Optionally verify other claim event properties
  for (const event of userClaimEvents) {
    assert.strictEqual(event.poolID.toString(), poolAddress, "Pool ID should match");
    // User ID check is redundant here since we already filtered, but kept for clarity
    assert.strictEqual(event.userID.toString(), userAddress, "User ID should match");
  }

  return userClaimEvents;
}

// Proposed helper function to add to your helpers.js
export async function verifySubscriptionEvent(
  reader: MultiRewardsTestReader,
  expectedState: {
    user: string;
    pool_address: string;
    staking_token: string;
    timestamp: bigint;
    subscription_count: number;
  },
) {
  const event = await reader.getSubscriptionEvent(
    expectedState.user,
    expectedState.pool_address,
    expectedState.subscription_count,
  );
  assert(event, "Subscription event should exist");

  assert.strictEqual(event.userID.toString(), expectedState.user);
  assert.strictEqual(event.poolID.toString(), expectedState.pool_address);
  assert.strictEqual(event.staking_token, expectedState.staking_token);
  assert.strictEqual(event.timestamp, getTimestampInSeconds(expectedState.timestamp));
}

// Helper to verify unsubscription event
export async function verifyUnsubscriptionEvent(
  reader: MultiRewardsTestReader,
  expectedState: {
    user: string;
    pool_address: string;
    staking_token: string;
    timestamp: bigint;
    unsubscription_count: number;
  },
) {
  const event = await reader.getUnsubscriptionEvent(
    expectedState.user,
    expectedState.pool_address,
    expectedState.unsubscription_count,
  );
  assert(event, "Unsubscription event should exist");

  assert.strictEqual(event.userID.toString(), expectedState.user);
  assert.strictEqual(event.poolID.toString(), expectedState.pool_address);
  assert.strictEqual(event.staking_token, expectedState.staking_token);
  assert.strictEqual(event.timestamp, getTimestampInSeconds(expectedState.timestamp));
}
