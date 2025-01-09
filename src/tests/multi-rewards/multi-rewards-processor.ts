import { SupportedAptosChainId } from "../../chains.js";
import { setupMultiRewardsProcessor } from "../../config.js";

// we setup the multi rewards processor for the test
setupMultiRewardsProcessor(SupportedAptosChainId.JESTNET);
