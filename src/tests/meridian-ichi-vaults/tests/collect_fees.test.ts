import { describe, test } from "node:test";
import assert from "assert";

import { MIVTestReader } from "../../../processors/meridian-ichi-vault-processor.js";
import { MIVCollectFeesEvent } from "../../../schema/schema.meridian-ichi-vaults.js";
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
import { verifyVaultState, verifyHourlyHistory, secsToMicros } from "../common/helpers.js";
import { setupMeridianIchiVaultsTest } from "../common/testSetup.js";

describe("CollectFeesEvent", async () => {
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

  test("collect_fees: accumulates cumulative fees, emits event, bumps counter", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 100_000n,
        totalAmount1: 200_000n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 500_000n,
      }),
    );

    await processor.processEvent({
      name: "CollectFeesEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        fee_0_collected: "1234",
        fee_1_collected: "5678",
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      total_amount_0: 100_000n,
      total_amount_1: 200_000n,
      total_fees_0_collected: 1234n,
      total_fees_1_collected: 5678n,
      collect_fees_count: 1,
    });

    const events = await service.store.list(MIVCollectFeesEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].fee_0_collected, 1234n);
    assert.strictEqual(events[0].fee_1_collected, 5678n);
    assert.strictEqual(events[0].total_amount_0, 100_000n);
    assert.strictEqual(events[0].total_amount_1, 200_000n);

    const module = await reader.getModule();
    assert(module && module.collect_fees_count === 1);

    // Hourly bucket gets the fee deltas
    await verifyHourlyHistory(reader, FIXTURE_VAULT_ADDRESS, 1, {
      fees_0_delta: 1234n,
      fees_1_delta: 5678n,
      transaction_count: 1,
    });
  });

  test("two collections cumulate; second bucket adds to the first", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    // First collection
    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 100n,
        totalAmount1: 100n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 100n,
      }),
    );
    await processor.processEvent({
      name: "CollectFeesEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        fee_0_collected: "10",
        fee_1_collected: "20",
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    // Second collection, same hour
    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 100n,
        totalAmount1: 100n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 100n,
      }),
    );
    await processor.processEvent({
      name: "CollectFeesEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        fee_0_collected: "30",
        fee_1_collected: "40",
      },
      timestamp: secsToMicros(1_700_000_310),
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      total_fees_0_collected: 40n,
      total_fees_1_collected: 60n,
      collect_fees_count: 2,
    });

    await verifyHourlyHistory(reader, FIXTURE_VAULT_ADDRESS, 1, {
      fees_0_delta: 40n,
      fees_1_delta: 60n,
      transaction_count: 2,
    });
  });
});
