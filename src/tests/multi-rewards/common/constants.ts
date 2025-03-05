import { multi_rewards_abi } from "../../../abis/multi_rewards.js";
import { HandlerIdMapping } from "../../utils/processor.js";

// NOTE: this should follow the some order that the event handlers are bound to the sentio MultiRewardsProcessor
export const multiRewardsHandlerIds: HandlerIdMapping<typeof multi_rewards_abi> = {
  StakingPoolCreatedEvent: 0,
  RewardAddedEvent: 1,
  RewardNotifiedEvent: 2,
  RewardsDurationUpdatedEvent: 3,
  RewardClaimedEvent: 4,
  StakeEvent: 5,
  WithdrawEvent: 6,
  SubscriptionEvent: 7,
  UnsubscriptionEvent: 8,
  EmergencyWithdrawEvent: 9,
};
