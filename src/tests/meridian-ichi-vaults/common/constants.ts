// Fixture data for Meridian Ichi vault tests.
//
// Addresses don't need to match anything on-chain — the mock RPC server in
// mockRpc.ts intercepts every view call, so we can fabricate vault/token
// addresses freely.

import { HandlerIdMapping } from "../../utils/processor.js";
import { ichi_vault_meridian_abi } from "../../../abis/ichi_vault_meridian.js";
import { timelocked_abi } from "../../../abis/timelocked.js";

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

// Handler ID mapping for the ichi_vault_meridian base processor. Order must
// match the .onEvent... chain in src/processors/meridian-ichi-vault-processor.ts
// — Sentio assigns IDs sequentially in declaration order, starting from 0.
//
// When adding/removing/reordering handlers there, update this map in lockstep.
export const meridianIchiVaultsHandlerIds: HandlerIdMapping<typeof ichi_vault_meridian_abi> = {
  VaultCreatedEvent: 0,
  DepositEvent: 1,
  WithdrawEvent: 2,
  CollectFeesEvent: 3,
  RebalanceEvent: 4,
  PositionAddedEvent: 5,
  EmergencyExitEvent: 6,
  AssetRecoveredEvent: 7,
  SetStakingPoolEvent: 8,
  WhitelistedRewardTokenAddedEvent: 9,
  WhitelistedRewardTokenRemovedEvent: 10,
  VaultOwnershipTransferInitiatedEvent: 11,
  VaultOwnershipTransferredEvent: 12,
  SetAmmFeeRecipientEvent: 13,
  SetAffiliateEvent: 14,
  SetMaxDepositAmountEvent: 15,
  SetDepositRoleEvent: 16,
  SetRebalancerRoleEvent: 17,
  RebalancePausedEvent: 18,
  FarmingEnabledEvent: 19,
  GlobalOwnershipTransferInitiatedEvent: 20,
  GlobalOwnershipTransferredEvent: 21,
  SetBaseFeeEvent: 22,
  SetBaseSplitFeeEvent: 23,
  SetFeeRecipientEvent: 24,
  SetAmmFeeEvent: 25,
};

// Handler ID mapping for the timelocked base processor (bound separately in
// the same processor module, AFTER the vault binding).
//
// Sentio assigns handler IDs per-chain, not per-binding (see
// @sentio/sdk/src/core/handler-register.ts — entries are keyed by chainId, id
// = entries.length). Both bindings target movement-mainnet, so the timelocked
// handlers pick up where the vault handlers left off — IDs 26 and 27.
export const meridianTimelockedHandlerIds: HandlerIdMapping<typeof timelocked_abi> = {
  TimelockedUpdateProposedEvent: 26,
  TimelockedUpdateExecutedEvent: 27,
};
