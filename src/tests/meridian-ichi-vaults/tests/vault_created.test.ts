import { describe, test } from "node:test";
import assert from "assert";

import { MIVTestReader } from "../../../processors/meridian-ichi-vault-processor.js";
import { mockViewCalls } from "../../common/mockRpc.js";
import {
  FIXTURE_VAULT_ADDRESS,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_SHARES_METADATA,
  FIXTURE_TOKEN_0_METADATA,
  FIXTURE_TOKEN_1_METADATA,
  FIXTURE_VAULT_OWNER,
} from "../common/constants.js";
import { vaultCreationViewCalls } from "../common/viewFixtures.js";
import { verifyVaultState, secsToMicros } from "../common/helpers.js";
import { setupMeridianIchiVaultsTest } from "../common/testSetup.js";

describe("VaultCreatedEvent", async () => {
  const { service, processor } = setupMeridianIchiVaultsTest();

  test("creates a vault with metadata + Move-default config (is_asset_0_deposit = true)", async () => {
    const reader = new MIVTestReader(service.store);

    mockViewCalls(
      vaultCreationViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        vaultOwner: FIXTURE_VAULT_OWNER,
        depositAssetMetadata: FIXTURE_TOKEN_0_METADATA, // is_asset_0_deposit=true ⇒ token0 is deposit asset
        quoteAssetMetadata: FIXTURE_TOKEN_1_METADATA,
        depositAssetDecimals: 6,
        quoteAssetDecimals: 8,
        maxDepositAmount: 1_000_000n,
      }),
    );

    await processor.processEvent({
      name: "VaultCreatedEvent",
      // Surf ABI wraps Object<T> as { inner } and types u64 as string. The
      // runtime decoder unwraps Object<T> before calling the handler — see
      // multi-rewards stake.test.ts for the same pattern.
      data: {
        vault_owner: FIXTURE_VAULT_OWNER,
        vault_address: FIXTURE_VAULT_ADDRESS,
        underlying_pool: { inner: FIXTURE_POOL_ADDRESS },
        is_asset_0_deposit: true,
        vault_shares_metadata: { inner: FIXTURE_SHARES_METADATA },
        max_deposit_amount: "1000000",
      },
      timestamp: secsToMicros(1_700_000_000),
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      vault_owner: FIXTURE_VAULT_OWNER,
      underlying_pool: FIXTURE_POOL_ADDRESS,
      is_asset_0_deposit: true,
      // is_asset_0_deposit=true ⇒ deposit metadata maps to token0
      token0_metadata: FIXTURE_TOKEN_0_METADATA,
      token1_metadata: FIXTURE_TOKEN_1_METADATA,
      token0_decimals: 6,
      token1_decimals: 8,
      vault_shares_metadata: FIXTURE_SHARES_METADATA,
      total_amount_0: 0n,
      total_amount_1: 0n,
      total_supply: 0n,
      // Move defaults from vault.move:367
      is_rebalance_paused: false,
      is_farming_enabled: true,
      withdraw_fee_bps: 0n,
      deposit_hysteresis_ticks: 100n,
      rebalance_hysteresis_ticks: 500n,
      deposit_twap_period: 300n,
      aux_deposit_twap_period: 60n,
      rebalance_cooldown: 120n,
      max_deposit_amount: 1_000_000n,
      amm_fee_recipient: "0x0",
      affiliate: FIXTURE_VAULT_OWNER,
      staking_pool: undefined,
      whitelisted_reward_tokens: [],
      position_count: 0,
      deposit_count: 0,
      withdraw_count: 0,
      rebalance_count: 0,
      collect_fees_count: 0,
    });

    const module = await reader.getModule();
    assert(module, "MIVModule should exist");
    assert.strictEqual(module.vault_count, 1);
  });

  test("creates a vault with reversed token assignment (is_asset_0_deposit = false)", async () => {
    const reader = new MIVTestReader(service.store);

    // When is_asset_0_deposit=false: deposit_metadata maps to token1, quote_metadata to token0.
    mockViewCalls(
      vaultCreationViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS,
        vaultOwner: FIXTURE_VAULT_OWNER,
        depositAssetMetadata: FIXTURE_TOKEN_1_METADATA,
        quoteAssetMetadata: FIXTURE_TOKEN_0_METADATA,
        depositAssetDecimals: 8,
        quoteAssetDecimals: 6,
      }),
    );

    await processor.processEvent({
      name: "VaultCreatedEvent",
      data: {
        vault_owner: FIXTURE_VAULT_OWNER,
        vault_address: FIXTURE_VAULT_ADDRESS,
        underlying_pool: { inner: FIXTURE_POOL_ADDRESS },
        is_asset_0_deposit: false,
        vault_shares_metadata: { inner: FIXTURE_SHARES_METADATA },
        max_deposit_amount: "0",
      },
    });

    await verifyVaultState(reader, FIXTURE_VAULT_ADDRESS, {
      is_asset_0_deposit: false,
      // is_asset_0_deposit=false ⇒ quote metadata maps to token0
      token0_metadata: FIXTURE_TOKEN_0_METADATA,
      token0_decimals: 6,
      token1_metadata: FIXTURE_TOKEN_1_METADATA,
      token1_decimals: 8,
    });
  });

  test("address normalization: mixed-case event payloads are lower-cased in the store", async () => {
    const reader = new MIVTestReader(service.store);

    mockViewCalls(
      vaultCreationViewCalls({
        vaultAddress: FIXTURE_VAULT_ADDRESS, // RPC payload uses lowercase
        vaultOwner: FIXTURE_VAULT_OWNER,
        depositAssetMetadata: FIXTURE_TOKEN_0_METADATA,
        quoteAssetMetadata: FIXTURE_TOKEN_1_METADATA,
        depositAssetDecimals: 6,
        quoteAssetDecimals: 8,
      }),
    );

    // Mixed-case event payload (real on-chain addresses are sometimes presented
    // with mixed case in tooling); the handler is responsible for normalizing.
    // The `0x${string}` template-literal types don't accept "0X..." so cast.
    type Addr = `0x${string}`;
    const upperVaultOwner = FIXTURE_VAULT_OWNER.toUpperCase() as Addr;
    const upperVaultAddress = FIXTURE_VAULT_ADDRESS.toUpperCase() as Addr;
    const upperPoolAddress = FIXTURE_POOL_ADDRESS.toUpperCase() as Addr;
    const upperSharesMetadata = FIXTURE_SHARES_METADATA.toUpperCase() as Addr;

    await processor.processEvent({
      name: "VaultCreatedEvent",
      data: {
        vault_owner: upperVaultOwner,
        vault_address: upperVaultAddress,
        underlying_pool: { inner: upperPoolAddress },
        is_asset_0_deposit: true,
        vault_shares_metadata: { inner: upperSharesMetadata },
        max_deposit_amount: "0",
      },
    });

    // Stored under the lower-cased ID.
    const vault = await reader.getVault(FIXTURE_VAULT_ADDRESS);
    assert(vault, "vault should be looked up by lowercased address");
    assert.strictEqual(vault.vault_owner, FIXTURE_VAULT_OWNER);
    assert.strictEqual(vault.underlying_pool, FIXTURE_POOL_ADDRESS);
  });
});
