import { describe, test } from "node:test";
import assert from "assert";

import { MIVTestReader } from "../../../processors/meridian-ichi-vault-processor.js";
import { MIVEmergencyExitEvent } from "../../../schema/schema.meridian-ichi-vaults.js";
import { mockViewCalls } from "../../common/mockRpc.js";
import {
  FIXTURE_VAULT_ADDRESS,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_SHARES_METADATA,
  FIXTURE_TOKEN_0_METADATA,
  FIXTURE_TOKEN_1_METADATA,
  FIXTURE_VAULT_OWNER,
  FIXTURE_REBALANCER,
} from "../common/constants.js";
import { vaultCreationViewCalls, vaultLiveStateViewCalls, positionsViewCalls } from "../common/viewFixtures.js";
import { verifyVaultState, secsToMicros } from "../common/helpers.js";
import { setupMeridianIchiVaultsTest } from "../common/testSetup.js";

const POSITION_OBJECT_1 = "0x0000000000000000000000000000000000000000000000000000000000000d10";
const POSITION_OBJECT_2 = "0x0000000000000000000000000000000000000000000000000000000000000d11";

describe("EmergencyExitEvent", async () => {
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

  test("emergency exit: clears MIVPosition rows + records audit event + cumulative fees", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    // First, simulate a rebalance that establishes 2 positions.
    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 1_000n,
        totalAmount1: 2_000n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 1_000n,
      }),
    );
    mockViewCalls(
      positionsViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        positions: [
          {
            positionObject: POSITION_OBJECT_1,
            positionId: 1n,
            liquidity: 100n,
            lowerTick: -10n,
            upperTick: 10n,
            amount0: 500n,
            amount1: 1_000n,
          },
          {
            positionObject: POSITION_OBJECT_2,
            positionId: 2n,
            liquidity: 200n,
            lowerTick: 10n,
            upperTick: 20n,
            amount0: 500n,
            amount1: 1_000n,
          },
        ],
      }),
    );
    await processor.processEvent({
      name: "RebalanceEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        rebalancer: FIXTURE_REBALANCER,
        positions_count: "2",
        swap_amount: "0",
        zero_for_one: true,
        collected_fees_0: "0",
        collected_fees_1: "0",
        total_0: "1000",
        total_1: "2000",
      },
      timestamp: secsToMicros(1_700_000_010),
    });
    assert.strictEqual((await reader.getPositions(FIXTURE_VAULT_ADDRESS)).length, 2, "rebalance set 2 positions");

    // Now emergency exit. Live state shows assets back in the vault, supply
    // unchanged (shares aren't burned), fees collected before exit.
    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 1_005n, // recovered + collected fee
        totalAmount1: 2_010n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 1_000n,
      }),
    );
    await processor.processEvent({
      name: "EmergencyExitEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        executor: FIXTURE_REBALANCER,
        removed_positions_count: "2",
        collected_fees_0: "5",
        collected_fees_1: "10",
        removed_0: "1000",
        removed_1: "2000",
      },
      timestamp: secsToMicros(1_700_000_020),
    });

    // MIVPosition rows cleared.
    const positions = await reader.getPositions(FIXTURE_VAULT_ADDRESS);
    assert.strictEqual(positions.length, 0, "emergency exit clears all positions");

    // Vault: position_count zeroed, fees cumulative.
    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      position_count: 0,
      total_amount_0: 1_005n,
      total_amount_1: 2_010n,
      total_fees_0_collected: 5n,
      total_fees_1_collected: 10n,
    });

    // Audit event row.
    const events = await service.store.list(MIVEmergencyExitEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(events.length, 1);
    const ev = events[0];
    assert.strictEqual(ev.executor, FIXTURE_REBALANCER);
    assert.strictEqual(ev.removed_positions_count, 2);
    assert.strictEqual(ev.collected_fees_0, 5n);
    assert.strictEqual(ev.collected_fees_1, 10n);
    assert.strictEqual(ev.removed_0, 1_000n);
    assert.strictEqual(ev.removed_1, 2_000n);

    // Module counter.
    const module = await reader.getModule();
    assert(module);
    assert.strictEqual(module.emergency_exit_count, 1);
  });
});
