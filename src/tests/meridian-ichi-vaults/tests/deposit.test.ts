import { describe, test } from "node:test";
import assert from "assert";

import { MIVTestReader } from "../../../processors/meridian-ichi-vault-processor.js";
import { MIVDepositEvent } from "../../../schema/schema.meridian-ichi-vaults.js";
import { mockViewCalls } from "../../common/mockRpc.js";
import {
  FIXTURE_VAULT_ADDRESS,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_SHARES_METADATA,
  FIXTURE_TOKEN_0_METADATA,
  FIXTURE_TOKEN_1_METADATA,
  FIXTURE_VAULT_OWNER,
  FIXTURE_DEPOSITOR,
} from "../common/constants.js";
import { vaultCreationViewCalls, vaultLiveStateViewCalls } from "../common/viewFixtures.js";
import { verifyVaultState, verifyHourlyHistory, secsToMicros } from "../common/helpers.js";
import { setupMeridianIchiVaultsTest } from "../common/testSetup.js";

describe("DepositEvent", async () => {
  const { service, processor } = setupMeridianIchiVaultsTest();

  type Addr = `0x${string}`;

  async function createVault(opts?: { isAsset0Deposit?: boolean; vaultOwner?: Addr }) {
    const isAsset0Deposit = opts?.isAsset0Deposit ?? true;
    const vaultOwner: Addr = opts?.vaultOwner ?? FIXTURE_VAULT_OWNER;
    mockViewCalls(
      vaultCreationViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        vaultOwner,
        depositAssetMetadata: isAsset0Deposit ? FIXTURE_TOKEN_0_METADATA : FIXTURE_TOKEN_1_METADATA,
        quoteAssetMetadata: isAsset0Deposit ? FIXTURE_TOKEN_1_METADATA : FIXTURE_TOKEN_0_METADATA,
        depositAssetDecimals: isAsset0Deposit ? 6 : 8,
        quoteAssetDecimals: isAsset0Deposit ? 8 : 6,
      }),
    );
    await processor.processEvent({
      name: "VaultCreatedEvent",
      data: {
        vault_owner: vaultOwner,
        vault_address: FIXTURE_VAULT_ADDRESS,
        underlying_pool: { inner: FIXTURE_POOL_ADDRESS },
        is_asset_0_deposit: isAsset0Deposit,
        vault_shares_metadata: { inner: FIXTURE_SHARES_METADATA },
        max_deposit_amount: "0",
      },
      timestamp: secsToMicros(1_700_000_000),
    });
  }

  test("first deposit: vault totals + share supply refresh + pre-event totals + history bucket", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    // Live-state mocks for the deposit handler. is_asset_0_deposit=true means
    // the deposit increases token0; the user deposited 500_000 raw token0 and
    // received 1_000_000_000_000 shares (1e12 shares, lots of zeros).
    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 500_000n,
        totalAmount1: 0n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n, // 1.0 (E18)
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 1_000_000_000_000n,
      }),
    );

    await processor.processEvent({
      name: "DepositEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        depositor: FIXTURE_DEPOSITOR,
        deposit_amount: "500000",
        shares_minted: "1000000000000",
      },
      timestamp: secsToMicros(1_700_003_600), // 1h after vault creation
    });

    // Vault state was refreshed from the view-call snapshot.
    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      total_amount_0: 500_000n,
      total_amount_1: 0n,
      total_supply: 1_000_000_000_000n,
      shares_price_e18: 1_000_000_000_000_000_000n,
      last_tick: 0n,
      deposit_count: 1,
    });

    // Module counter incremented.
    const module = await reader.getModule();
    assert(module, "MIVModule should exist");
    assert.strictEqual(module.deposit_count, 1);

    // Event entity recorded with the live-state snapshot + pre-event totals.
    const events = await service.store.list(MIVDepositEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(events.length, 1, "exactly one MIVDepositEvent");
    const ev = events[0];
    assert.strictEqual(ev.depositor, FIXTURE_DEPOSITOR);
    assert.strictEqual(ev.deposit_amount, 500_000n);
    assert.strictEqual(ev.shares_minted, 1_000_000_000_000n);
    assert.strictEqual(ev.total_amount_0, 500_000n);
    assert.strictEqual(ev.total_amount_1, 0n);
    assert.strictEqual(ev.total_supply, 1_000_000_000_000n);
    assert.strictEqual(ev.share_price_e18, 1_000_000_000_000_000_000n);
    // is_asset_0_deposit=true ⇒ deposit went into token0 side; pre-event:
    // total_amount_0_before = total_amount_0 - deposit_amount = 0
    // total_amount_1_before = total_amount_1 (unchanged) = 0
    assert.strictEqual(ev.total_amount_0_before_event, 0n);
    assert.strictEqual(ev.total_amount_1_before_event, 0n);

    // One hourly + one daily history row created (we don't verify daily
    // shape here; the helper variant checks hourly).
    await verifyHourlyHistory(reader, FIXTURE_VAULT_ADDRESS, 1, {
      total_amount_0: 500_000n,
      total_amount_1: 0n,
      total_supply: 1_000_000_000_000n,
      fees_0_delta: 0n,
      fees_1_delta: 0n,
      transaction_count: 1,
    });
  });

  test("multiple deposits accumulate into the same hourly bucket", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault();

    // First deposit
    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 100n,
        totalAmount1: 0n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 100n,
      }),
    );
    await processor.processEvent({
      name: "DepositEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        depositor: FIXTURE_DEPOSITOR,
        deposit_amount: "100",
        shares_minted: "100",
      },
      timestamp: secsToMicros(1_700_000_010),
    });

    // Second deposit, 5 minutes later — still within the same hour bucket.
    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 300n,
        totalAmount1: 0n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 300n,
      }),
    );
    await processor.processEvent({
      name: "DepositEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        depositor: FIXTURE_DEPOSITOR,
        deposit_amount: "200",
        shares_minted: "200",
      },
      timestamp: secsToMicros(1_700_000_310),
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      total_amount_0: 300n,
      total_supply: 300n,
      deposit_count: 2,
    });

    // Both deposits roll into the same hourly bucket → transaction_count: 2.
    await verifyHourlyHistory(reader, FIXTURE_VAULT_ADDRESS, 1, {
      total_amount_0: 300n,
      total_supply: 300n,
      transaction_count: 2,
    });
  });

  test("is_asset_0_deposit=false: deposit increases token1, pre-event token1_before is reduced", async () => {
    const reader = new MIVTestReader(service.store);
    await createVault({ isAsset0Deposit: false });

    mockViewCalls(
      vaultLiveStateViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        totalAmount0: 0n,
        totalAmount1: 750n,
        currentTick: 0n,
        twapTick: 0n,
        auxTwapTick: 0n,
        sharesPriceE18: 1_000_000_000_000_000_000n,
        sharesMetadata: FIXTURE_SHARES_METADATA,
        totalSupply: 750n,
      }),
    );

    await processor.processEvent({
      name: "DepositEvent",
      data: {
        vault_address: FIXTURE_VAULT_ADDRESS,
        depositor: FIXTURE_DEPOSITOR,
        deposit_amount: "750",
        shares_minted: "750",
      },
      timestamp: secsToMicros(1_700_000_000),
    });

    const events = await service.store.list(MIVDepositEvent, [
      { field: "vault_address", op: "=", value: FIXTURE_VAULT_ADDRESS },
    ]);
    assert.strictEqual(events.length, 1);
    // is_asset_0_deposit=false ⇒ deposit went into token1 side
    assert.strictEqual(events[0].total_amount_0_before_event, 0n);
    assert.strictEqual(events[0].total_amount_1_before_event, 0n);

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      total_amount_1: 750n,
    });
  });
});
