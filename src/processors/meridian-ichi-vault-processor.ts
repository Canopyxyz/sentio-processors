import { ichi_vault_meridian as ichi_vault_meridian_movement } from "../types/aptos/movement-mainnet/ichi_vault_meridian.js";

import { SupportedAptosChainId } from "../chains.js";

// Phase 1 stub. Phase 4 will replace this with the full set of event handlers
// for Meridian Ichi vaults (vault lifecycle + admin/config + staking + global
// fee config + timelocked param updates).
export function meridianIchiVaultsProcessor(
  _chainId: SupportedAptosChainId,
  startVersion: number,
  vaultBaseProcessor: typeof ichi_vault_meridian_movement,
) {
  vaultBaseProcessor.bind({ startVersion });
}
