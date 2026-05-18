// Fixture data for Meridian Ichi vault tests.
//
// Addresses don't need to match anything on-chain — the mock RPC server in
// mockRpc.ts intercepts every view call, so we can fabricate vault/token
// addresses freely.

import { HandlerIdMapping } from "../../utils/processor.js";
import { ichi_vault_meridian_abi } from "../../../abis/ichi_vault_meridian.js";

export const ICHI_VAULT_MERIDIAN_PACKAGE = "0x96cfeae5e78eeb1b6215bb83ed9023106e0df49e6d4380783e0e40aa8e771f83";

// Synthetic fixture addresses.
export const FIXTURE_VAULT_ADDRESS = "0x000000000000000000000000000000000000000000000000000000000000a001";
export const FIXTURE_POOL_ADDRESS = "0x000000000000000000000000000000000000000000000000000000000000a002";
export const FIXTURE_SHARES_METADATA = "0x000000000000000000000000000000000000000000000000000000000000a003";
export const FIXTURE_TOKEN_0_METADATA = "0x000000000000000000000000000000000000000000000000000000000000a004";
export const FIXTURE_TOKEN_1_METADATA = "0x000000000000000000000000000000000000000000000000000000000000a005";
export const FIXTURE_VAULT_OWNER = "0x000000000000000000000000000000000000000000000000000000000000b001";
export const FIXTURE_DEPOSITOR = "0x000000000000000000000000000000000000000000000000000000000000b002";
export const FIXTURE_REBALANCER = "0x000000000000000000000000000000000000000000000000000000000000b003";

// Handler ID mapping must match the order the meridianIchiVaultsProcessor
// registers its handlers. Fill this out as Phase 4 wires each handler.
//
// Sentio assigns handler IDs sequentially in declaration order, starting from
// 0. When adding a new handler, append it to BOTH the processor binding chain
// AND this map.
export const meridianIchiVaultsHandlerIds: HandlerIdMapping<typeof ichi_vault_meridian_abi> = {
  // populated in Phase 4
};
