// Setup file imported by TestProcessorServer in every Meridian Ichi vaults
// test. Mirrors the multi-rewards pattern: invoke the per-chain setup to bind
// handlers, using JESTNET as the chain ID (which routes to the
// movement-mainnet base processor — see getMeridianIchiVaultBaseProcessor in
// src/config.ts).
import { SupportedAptosChainId } from "../../chains.js";
import { setupMeridianIchiVaultsProcessor } from "../../config.js";

setupMeridianIchiVaultsProcessor(SupportedAptosChainId.JESTNET);
