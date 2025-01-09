import { Store } from "@sentio/sdk/store";

import { MRPoolRewardData, MRStakingPool, MRUserRewardData, MRUserStakedBalance } from "../schema/schema.rewards.js";

export async function getRewardUserStakedBalance(
  userAddress: string,
  staking_token: string,
  store: Store,
): Promise<MRUserStakedBalance | undefined> {
  const id = `${userAddress}-${staking_token}`;
  const balance = await store.get(MRUserStakedBalance, id);
  return balance;
}

export async function getUserRewardData(
  user_address: string,
  staking_pool_address: string,
  reward_token: string,
  store: Store,
): Promise<MRUserRewardData | undefined> {
  return await store.get(MRUserRewardData, `${user_address}-${staking_pool_address}-${reward_token}`);
}

export function rewardPerToken(
  staking_pool: MRStakingPool,
  reward_data: MRPoolRewardData,
  seconds_timestamp: bigint,
): bigint {
  if (staking_pool.total_subscribed == 0n) {
    return reward_data.reward_per_token_stored_u12;
  }

  const last_time_reward_applicable = lastTimeRewardApplicable(seconds_timestamp, reward_data.period_finish);

  const time_elapsed = last_time_reward_applicable - reward_data.last_update_time;
  const extra_reward_per_token = (time_elapsed * reward_data.reward_rate_u12) / staking_pool.total_subscribed;

  return reward_data.reward_per_token_stored_u12 + extra_reward_per_token;
}

function lastTimeRewardApplicable(seconds_timestamp: bigint, period_finish: bigint): bigint {
  return seconds_timestamp > period_finish ? period_finish : seconds_timestamp;
}
