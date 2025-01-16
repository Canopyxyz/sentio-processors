import { vault as aptos_testnet_vault } from "./types/aptos/testnet/ichi-vaults-testnet.js";
import { vault as aptos_mainnet_vault } from "./types/aptos/ichi-vaults.js";

// import { multi_rewards as multi_rewards_movement } from "./types/aptos/movement-porto/multi-rewards-movement.js";
import { multi_rewards as multi_rewards_testnet } from "./types/aptos/testnet/multi-rewards-testnet.js";

import { liquidswapIchiVaultsProcessor } from "./processors/liquidswap-ichi-vault-processor.js";
import { multiRewardsProcessor } from "./processors/multi-rewards-processor.js";

import { SupportedAptosChainId } from "./chains.js";

export const MULTI_REWARDS_START_VERSIONS: Partial<Record<SupportedAptosChainId, number>> = {
  [SupportedAptosChainId.JESTNET]: 0,
  [SupportedAptosChainId.APTOS_TESTNET]: 6199595966, // 6199598589
};

export const LIQUIDSWAP_ICHI_VAULTS_START_VERSIONS: Partial<Record<SupportedAptosChainId, number>> = {
  [SupportedAptosChainId.JESTNET]: 0,
  [SupportedAptosChainId.APTOS_TESTNET]: 6187154000,
};

export function getLiquidswapICHIVaultBaseProcessor(chainId: SupportedAptosChainId) {
  switch (chainId) {
    case SupportedAptosChainId.JESTNET: // use APTOS_TESTNET base processor for JESTNET
    case SupportedAptosChainId.APTOS_TESTNET: {
      return aptos_testnet_vault;
    }
    case SupportedAptosChainId.APTOS_MAINNET: {
      return aptos_mainnet_vault;
    }
    default: {
      throw new Error(`LiquidswapICHIVaultBaseProcessor is not defined for chain ${chainId}`);
    }
  }
}

export function setupICHIVaultsProcessor(chainId: SupportedAptosChainId) {
  const ichiVaultsStartVersion = LIQUIDSWAP_ICHI_VAULTS_START_VERSIONS[chainId];
  if (ichiVaultsStartVersion === undefined) {
    throw new Error(`Expected LIQUIDSWAP_ICHI_VAULTS_START_VERSIONS to be defined for chain: ${chainId}`);
  }
  liquidswapIchiVaultsProcessor(chainId, ichiVaultsStartVersion, getLiquidswapICHIVaultBaseProcessor(chainId));
}

export function getMultiRewardsBaseProcessor(chainId: SupportedAptosChainId) {
  switch (chainId) {
    case SupportedAptosChainId.JESTNET: // use APTOS_TESTNET base processor for JESTNET
    case SupportedAptosChainId.APTOS_TESTNET: {
      return multi_rewards_testnet;
    }
    // No longer supported by sentio
    // case SupportedAptosChainId.MOVEMENT_PORTO: {
    //   return multi_rewards_movement;
    // }
    default: {
      throw new Error(`MultiRewardsBaseProcessor is not defined for chain ${chainId}`);
    }
  }
}

export function setupMultiRewardsProcessor(chainId: SupportedAptosChainId) {
  const multiRewardsStartVersion = MULTI_REWARDS_START_VERSIONS[chainId];
  if (multiRewardsStartVersion === undefined) {
    throw new Error(`Expected MULTI_REWARDS_START_VERSIONS to be defined for chain: ${chainId}`);
  }
  multiRewardsProcessor(chainId, multiRewardsStartVersion, getMultiRewardsBaseProcessor(chainId));
}
