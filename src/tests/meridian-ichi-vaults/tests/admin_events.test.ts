import { describe, test } from "node:test";
import assert from "assert";

import { MIVTestReader } from "../../../processors/meridian-ichi-vault-processor.js";
import {
  MIVSetMaxDepositAmountEvent,
  MIVSetStakingPoolEvent,
  MIVWhitelistedRewardTokenAddedEvent,
  MIVSetBaseFeeEvent,
} from "../../../schema/schema.meridian-ichi-vaults.js";
import { mockViewCalls } from "../../common/mockRpc.js";
import {
  FIXTURE_VAULT_ADDRESS,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_SHARES_METADATA,
  FIXTURE_TOKEN_0_METADATA,
  FIXTURE_TOKEN_1_METADATA,
  FIXTURE_VAULT_OWNER,
} from "../common/constants.js";
import { vaultCreationViewCalls, globalConfigBootstrapViewCalls } from "../common/viewFixtures.js";
import { verifyVaultState, secsToMicros } from "../common/helpers.js";
import { setupMeridianIchiVaultsTest } from "../common/testSetup.js";

const REWARD_TOKEN = "0x0000000000000000000000000000000000000000000000000000000000000c01";
const STAKING_POOL = "0x0000000000000000000000000000000000000000000000000000000000000c02";

describe("Admin / config events", async () => {
  const { service, processor } = setupMeridianIchiVaultsTest();

  async function createVault() {
    mockViewCalls(
      vaultCreationViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        vaultOwner: FIXTURE_VAULT_OWNER,
        depositAssetMetadata: FIXTURE_TOKEN_0_METADATA,
        quoteAssetMetadata: FIXTURE_TOKEN_1_METADATA,
        depositAssetDecimals: 6,
        quoteAssetDecimals: 8,
        maxDepositAmount: 1_000n,
      }),
    );
    await processor.processEvent({
      name: "VaultCreatedEvent",
      data: {
        vault_owner: FIXTURE_VAULT_OWNER,
        vault_address: FIXTURE_VAULT_ADDRESS,
        underlying_pool: { inner: FIXTURE_POOL_ADDRESS },
        is_asset_0_deposit: true,
        vault_shares_metadata: { inner: FIXTURE_SHARES_METADATA },
        max_deposit_amount: "1000",
      },
      timestamp: secsToMicros(1_700_000_000),
    });
  }

  test("SetMaxDepositAmountEvent updates MIVVault.max_deposit_amount + records event", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    await processor.processEvent({
      name: "SetMaxDepositAmountEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        previous_amount: "1000",
        new_amount: "5000",
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      max_deposit_amount: 5_000n,
    });

    const events = await service.store.list(MIVSetMaxDepositAmountEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].previous_amount, 1_000n);
    assert.strictEqual(events[0].new_amount, 5_000n);
  });

  test("SetStakingPoolEvent: Option<Object<StakingPool>> decoding (some → some)", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    await processor.processEvent({
      name: "SetStakingPoolEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        previous_pool: { vec: [] }, // None
        new_pool: { vec: [{ inner: STAKING_POOL }] }, // Some(staking_pool)
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      staking_pool: STAKING_POOL,
    });

    const events = await service.store.list(MIVSetStakingPoolEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].previous_pool, undefined);
    assert.strictEqual(events[0].new_pool, STAKING_POOL);
  });

  test("SetStakingPoolEvent: clear (some → none)", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    // First set
    await processor.processEvent({
      name: "SetStakingPoolEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        previous_pool: { vec: [] },
        new_pool: { vec: [{ inner: STAKING_POOL }] },
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    // Then clear
    await processor.processEvent({
      name: "SetStakingPoolEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        previous_pool: { vec: [{ inner: STAKING_POOL }] },
        new_pool: { vec: [] },
      },
      timestamp: secsToMicros(1_700_000_020),
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      staking_pool: undefined,
    });
  });

  test("WhitelistedRewardTokenAddedEvent appends to MIVVault.whitelisted_reward_tokens", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    await processor.processEvent({
      name: "WhitelistedRewardTokenAddedEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        reward_token: { inner: REWARD_TOKEN },
        total_whitelisted: "1",
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      whitelisted_reward_tokens: [REWARD_TOKEN],
    });

    const events = await service.store.list(MIVWhitelistedRewardTokenAddedEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reward_token, REWARD_TOKEN);
    assert.strictEqual(events[0].total_whitelisted, 1);
  });

  test("SetBaseFeeEvent: bootstraps MIVGlobalConfig from view calls + applies update + records event", async () => {
    const reader = new MIVTestReader(service.store);
    const FIXTURE_GLOBAL_OWNER = "0x000000000000000000000000000000000000000000000000000000000000e001";
    const FIXTURE_FEE_RECIPIENT = "0x000000000000000000000000000000000000000000000000000000000000e002";

    // First Global* event in the test ⇒ getOrCreateGlobalConfig bootstraps
    // by fetching get_global_owner + get_global_config.
    mockViewCalls(
      globalConfigBootstrapViewCalls({
        owner: FIXTURE_GLOBAL_OWNER,
        baseFeeBps: 0n,
        baseFeeSplitBps: 5000n,
        feeRecipient: FIXTURE_FEE_RECIPIENT,
        ammFeeBps: 0n,
      }),
    );

    await processor.processEvent({
      name: "SetBaseFeeEvent",
      data: {
        previous_base_fee_bps: "0",
        new_base_fee_bps: "300",
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    const cfg = await reader.getGlobalConfig();
    assert(cfg, "MIVGlobalConfig should exist");
    // Bootstrap populated owner + fee_recipient from view; SetBaseFee updated base_fee_bps.
    assert.strictEqual(cfg.owner, FIXTURE_GLOBAL_OWNER);
    assert.strictEqual(cfg.fee_recipient, FIXTURE_FEE_RECIPIENT);
    assert.strictEqual(cfg.base_fee_split_bps, 5_000n);
    assert.strictEqual(cfg.base_fee_bps, 300n);

    const events = await service.store.list(MIVSetBaseFeeEvent, [{ field: "id", op: "!=", value: "" }]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].previous_base_fee_bps, 0n);
    assert.strictEqual(events[0].new_base_fee_bps, 300n);
  });
});
