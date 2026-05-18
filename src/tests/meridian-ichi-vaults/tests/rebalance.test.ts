import { describe, test } from "node:test";
import assert from "assert";

import { MIVTestReader } from "../../../processors/meridian-ichi-vault-processor.js";
import { MIVRebalanceEvent, MIVPositionAddedEvent } from "../../../schema/schema.meridian-ichi-vaults.js";
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
import { verifyVaultState, verifyPositions, secsToMicros } from "../common/helpers.js";
import { setupMeridianIchiVaultsTest } from "../common/testSetup.js";

const POSITION_OBJECT_1 = "0x0000000000000000000000000000000000000000000000000000000000000d01";
const POSITION_OBJECT_2 = "0x0000000000000000000000000000000000000000000000000000000000000d02";

describe("RebalanceEvent", async () => {
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

  test("multi-event tx: 2x PositionAddedEvent followed by RebalanceEvent", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    // Live-state mocks for the rebalance handler's fetchVaultLiveState +
    // rebuildPositions calls.
    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 10_000n,
        totalAmount1: 20_000n,
        currentTick: -100n,
        twapTick: -95n,
        auxTwapTick: -98n,
        sharesPriceE18: 1_100_000_000_000_000_000n, // 1.1e18 (10% accumulated)
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 500_000n,
      }),
    );
    mockViewCalls(
      positionsViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        positions: [
          {
            positionObject: POSITION_OBJECT_1,
            positionId: 1n,
            liquidity: 5_000n,
            lowerTick: -200n,
            upperTick: -100n,
            amount0: 3_000n,
            amount1: 7_000n,
          },
          {
            positionObject: POSITION_OBJECT_2,
            positionId: 2n,
            liquidity: 8_000n,
            lowerTick: 100n,
            upperTick: 300n,
            amount0: 7_000n,
            amount1: 13_000n,
          },
        ],
      }),
    );

    // processTransaction simulates the on-chain ordering: two PositionAddedEvents
    // fire BEFORE the wrapping RebalanceEvent (verified at vault.move:2585 vs :707).
    // Each event gets a sequential eventIndex and they share one tx version.
    await processor.processTransaction({
      version: 42n,
      timestamp: secsToMicros(1_700_000_010),
      events: [
        {
          name: "PositionAddedEvent",
          data: {
            lower: "200",
            lower_is_negative: true,
            upper: "100",
            upper_is_negative: true,
            liquidity: "5000",
            amount_0: "3000",
            amount_1: "7000",
          },
        },
        {
          name: "PositionAddedEvent",
          data: {
            lower: "100",
            lower_is_negative: false,
            upper: "300",
            upper_is_negative: false,
            liquidity: "8000",
            amount_0: "7000",
            amount_1: "13000",
          },
        },
        {
          name: "RebalanceEvent",
          data: {
            vault_address: FIXTURE_VAULT_ADDRESS,
            rebalancer: FIXTURE_REBALANCER,
            positions_count: "2",
            swap_amount: "500",
            zero_for_one: true,
            collected_fees_0: "100",
            collected_fees_1: "200",
            total_0: "9900",
            total_1: "19800",
          },
        },
      ],
    });

    // Vault: post-rebalance live state + rebalance counter + cumulative fees
    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      total_amount_0: 10_000n,
      total_amount_1: 20_000n,
      total_supply: 500_000n,
      last_tick: -100n,
      shares_price_e18: 1_100_000_000_000_000_000n,
      rebalance_count: 1,
      total_fees_0_collected: 100n,
      total_fees_1_collected: 200n,
      position_count: 2,
    });

    // MIVPosition rows rebuilt authoritatively from view calls
    await verifyPositions(reader, FIXTURE_VAULT_ADDRESS, [
      {
        index: 0,
        position_object: POSITION_OBJECT_1,
        position_id: 1n,
        liquidity: 5_000n,
        lower_tick: -200n,
        upper_tick: -100n,
        amount_0: 3_000n,
        amount_1: 7_000n,
      },
      {
        index: 1,
        position_object: POSITION_OBJECT_2,
        position_id: 2n,
        liquidity: 8_000n,
        lower_tick: 100n,
        upper_tick: 300n,
        amount_0: 7_000n,
        amount_1: 13_000n,
      },
    ]);

    // RebalanceEvent audit row
    const rebalanceEvents = await service.store.list(MIVRebalanceEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(rebalanceEvents.length, 1);
    const re = rebalanceEvents[0];
    assert.strictEqual(re.rebalancer, FIXTURE_REBALANCER);
    assert.strictEqual(re.positions_count, 2);
    assert.strictEqual(re.swap_amount, 500n);
    assert.strictEqual(re.zero_for_one, true);
    assert.strictEqual(re.collected_fees_0, 100n);
    assert.strictEqual(re.collected_fees_1, 200n);
    assert.strictEqual(re.total_0_before, 9_900n);
    assert.strictEqual(re.total_1_before, 19_800n);
    assert.strictEqual(re.total_amount_0, 10_000n); // post-state
    assert.strictEqual(re.total_amount_1, 20_000n);

    // PositionAddedEvent audit rows
    const positionAddedEvents = await service.store.list(MIVPositionAddedEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(
      positionAddedEvents.length,
      2,
      "PositionAddedEvent rows attributed to vault via same-tx RebalanceEvent",
    );
    // Sort by event_index for deterministic order
    positionAddedEvents.sort((a, b) => a.event_index - b.event_index);
    assert.strictEqual(positionAddedEvents[0].lower_tick, -200n);
    assert.strictEqual(positionAddedEvents[0].upper_tick, -100n);
    assert.strictEqual(positionAddedEvents[0].liquidity, 5_000n);
    assert.strictEqual(positionAddedEvents[1].lower_tick, 100n);
    assert.strictEqual(positionAddedEvents[1].upper_tick, 300n);
    assert.strictEqual(positionAddedEvents[1].liquidity, 8_000n);

    // Both PositionAdded events + RebalanceEvent share a tx version
    assert.strictEqual(positionAddedEvents[0].transaction_version, 42n);
    assert.strictEqual(positionAddedEvents[1].transaction_version, 42n);
    assert.strictEqual(re.transaction_version, 42n);
    // …with distinct event_index values
    assert.notStrictEqual(positionAddedEvents[0].event_index, positionAddedEvents[1].event_index);

    // Module counters
    const module = await reader.getModule();
    assert(module);
    assert.strictEqual(module.rebalance_count, 1);
    assert.strictEqual(module.position_added_count, 2);
  });

  test("subsequent rebalance replaces MIVPosition rows authoritatively", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    // First rebalance: 2 positions
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

    let positions = await reader.getPositions(FIXTURE_VAULT_ADDRESS);
    assert.strictEqual(positions.length, 2);

    // Second rebalance: 1 different position (replaces the 2 above)
    const NEW_POSITION = "0x0000000000000000000000000000000000000000000000000000000000000d99";
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
            positionObject: NEW_POSITION,
            positionId: 3n,
            liquidity: 999n,
            lowerTick: -100n,
            upperTick: 100n,
            amount0: 1_000n,
            amount1: 2_000n,
          },
        ],
      }),
    );
    await processor.processEvent({
      name: "RebalanceEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        rebalancer: FIXTURE_REBALANCER,
        positions_count: "1",
        swap_amount: "0",
        zero_for_one: true,
        collected_fees_0: "0",
        collected_fees_1: "0",
        total_0: "1000",
        total_1: "2000",
      },
      timestamp: secsToMicros(1_700_000_020),
    });

    // Now only the new position exists.
    positions = await reader.getPositions(FIXTURE_VAULT_ADDRESS);
    assert.strictEqual(positions.length, 1);
    assert.strictEqual(positions[0].position_object, NEW_POSITION);
    assert.strictEqual(positions[0].liquidity, 999n);

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      position_count: 1,
      rebalance_count: 2,
    });
  });
});
