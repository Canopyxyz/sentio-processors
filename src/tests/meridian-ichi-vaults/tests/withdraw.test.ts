import { describe, test } from "node:test";
import assert from "assert";

import { MIVTestReader } from "../../../processors/meridian-ichi-vault-processor.js";
import { MIVWithdrawEvent } from "../../../schema/schema.meridian-ichi-vaults.js";
import { mockViewCalls } from "../../common/mockRpc.js";
import {
  FIXTURE_VAULT_ADDRESS,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_SHARES_METADATA,
  FIXTURE_TOKEN_0_METADATA,
  FIXTURE_TOKEN_1_METADATA,
  FIXTURE_VAULT_OWNER,
} from "../common/constants.js";
import { vaultCreationViewCalls, vaultLiveStateViewCalls } from "../common/viewFixtures.js";
import { verifyVaultState, secsToMicros } from "../common/helpers.js";
import { setupMeridianIchiVaultsTest } from "../common/testSetup.js";

describe("WithdrawEvent", async () => {
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
        max_deposit_amount: "0",
      },
      timestamp: secsToMicros(1_700_000_000),
    });
  }

  test("basic withdraw: pre-event totals = post + amount (fees retained by vault)", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    // Post-event vault state: user withdrew 1000 token0 + 500 token1 net.
    // Vault retained 10 token0 + 5 token1 as withdraw fees.
    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 5_000n,
        totalAmount1: 2_500n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 8_000n, // post-burn supply
      }),
    );

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        shares_burned: "2000",
        amount_0: "1000",
        amount_1: "500",
        withdraw_fee_0: "10",
        withdraw_fee_1: "5",
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      total_amount_0: 5_000n,
      total_amount_1: 2_500n,
      total_supply: 8_000n,
      withdraw_count: 1,
    });

    const events = await service.store.list(MIVWithdrawEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(events.length, 1);
    const ev = events[0];
    assert.strictEqual(ev.shares_burned, 2_000n);
    assert.strictEqual(ev.amount_0, 1_000n);
    assert.strictEqual(ev.amount_1, 500n);
    assert.strictEqual(ev.withdraw_fee_0, 10n);
    assert.strictEqual(ev.withdraw_fee_1, 5n);
    // Pre-event totals = post + amount (NOT + fee). Fees are re-deposited
    // back into the vault by store_remaining_assets at vault.move:530.
    assert.strictEqual(ev.total_amount_0_before_event, 5_000n + 1_000n);
    assert.strictEqual(ev.total_amount_1_before_event, 2_500n + 500n);

    // Module counter
    const module = await reader.getModule();
    assert(module && module.withdraw_count === 1);
  });

  test("withdraw with zero fees: pre + post unchanged on the fee dimension", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 10_000n,
        totalAmount1: 0n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 10_000n,
      }),
    );

    await processor.processEvent({
      name: "WithdrawEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        shares_burned: "500",
        amount_0: "500",
        amount_1: "0",
        withdraw_fee_0: "0",
        withdraw_fee_1: "0",
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    const events = await service.store.list(MIVWithdrawEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].total_amount_0_before_event, 10_500n);
    assert.strictEqual(events[0].total_amount_1_before_event, 0n);

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      total_amount_0: 10_000n,
      total_supply: 10_000n,
      withdraw_count: 1,
    });
  });
});
