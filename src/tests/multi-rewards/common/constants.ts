import { ABI } from "../../../abis/multi-rewards-testnet.js";
import { HandlerIdMapping } from "../../utils/processor.js";

export const multiRewardsHandlerIds: HandlerIdMapping<typeof ABI> = {
  StakingPoolCreatedEvent: 0,
  RewardAddedEvent: 1,
  RewardNotifiedEvent: 2,
  RewardsDurationUpdatedEvent: 3,
  RewardClaimedEvent: 4,
  StakeEvent: 5,
  WithdrawEvent: 6,
  SubscriptionEvent: 7,
  UnsubscriptionEvent: 8,
};
