import { GLOBAL_CONFIG } from "@sentio/runtime";
import { getSupportedAptosChainId, SupportedAptosChainId } from "./chains.js";
import { setupMultiRewardsProcessor } from "./config.js"; // setupICHIVaultsProcessor

// to avoid race conditions when event handlers not been called sequentially in the order of event emission
// we set sequential to true
// TODO: investigate if this is per processor or across processors, if it is across processors then create an issue to improve this
// since processors are typically isolated from each other they can be executed in parallel though event handlers within a processor
// should be executed sequentially
GLOBAL_CONFIG.execution = {
  sequential: true,
};

const { CHAIN_ID } = process.env;

if (!CHAIN_ID) {
  throw new Error("please specify CHAIN_ID in .env");
}

const supportedChainId = getSupportedAptosChainId(Number(CHAIN_ID));

if (supportedChainId === SupportedAptosChainId.JESTNET) {
  throw new Error("JESTNET is only for local testing; please set a valid sentio supported CHAIN_ID");
}

// NOTE: for each chain we specify the processors that exist on that chain and
// that we want to include under the same sentio project on the dashboard

switch (supportedChainId) {
  case SupportedAptosChainId.APTOS_TESTNET: {
    // Aptos testnet has modules to be indexed by the following processors
    // setupICHIVaultsProcessor(supportedChainId);
    setupMultiRewardsProcessor(supportedChainId);
    break;
  }
  case SupportedAptosChainId.APTOS_MAINNET: {
    // Aptos mainnet has modules to be indexed by the following processors
    // setupICHIVaultsProcessor(supportedChainId);
    break;
  }
  case SupportedAptosChainId.MOVEMENT_PORTO: {
    // Movement porto has modules to be indexed by the following processors
    setupMultiRewardsProcessor(supportedChainId);
    break;
  }
  default: {
    throw new Error(`Unsupported chainId: ${supportedChainId}`);
  }
}
