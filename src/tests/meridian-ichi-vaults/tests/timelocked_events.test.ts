import { before, afterEach, describe, test } from "node:test";
import assert from "assert";
import { TestProcessorServer } from "@sentio/sdk/testing";
import { AptosChainId } from "@sentio/chain";

import { MIVTestReader } from "../../../processors/meridian-ichi-vault-processor.js";
import {
  MIVTimelockedUpdateProposedEvent,
  MIVTimelockedUpdateExecutedEvent,
} from "../../../schema/schema.meridian-ichi-vaults.js";
import { timelocked_abi } from "../../../abis/timelocked.js";
import { TestProcessor } from "../../utils/processor.js";
import { mockHttpEndpoints, mockViewCalls, resetMockRpc, mockAptosModuleAbi } from "../../common/mockRpc.js";
import {
  meridianTimelockedHandlerIds,
  ICHI_VAULT_MERIDIAN_PACKAGE,
  FIXTURE_VAULT_ADDRESS,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_SHARES_METADATA,
  FIXTURE_TOKEN_0_METADATA,
  FIXTURE_TOKEN_1_METADATA,
  FIXTURE_VAULT_OWNER,
} from "../common/constants.js";
import { vaultCreationViewCalls } from "../common/viewFixtures.js";
import { secsToMicros } from "../common/helpers.js";
import fs from "node:fs";
import path from "node:path";

// Timelocked tests need their own TestProcessor instance bound to timelocked_abi
// (with handler IDs 26-27 since both bindings register on the same chain).
// They also reuse the standard vault TestProcessor to seed a MIVVault first.
import { ichi_vault_meridian_abi } from "../../../abis/ichi_vault_meridian.js";
import { meridianIchiVaultsHandlerIds } from "../common/constants.js";

const ICHI_VAULT_MERIDIAN_ABI_ENTRY = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "abis/aptos/movement-mainnet/ichi_vault_meridian.json"), "utf-8"),
)[0];
const TIMELOCKED_ABI_ENTRY = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "abis/aptos/movement-mainnet/timelocked.json"), "utf-8"),
)[0];

describe("Timelocked events", async () => {
  // Cannot use the shared harness because we need TWO TestProcessor instances
  // — one for the vault ABI (to seed the vault) and one for the timelocked ABI.
  const service = new TestProcessorServer(() => import("../meridian-ichi-vaults-processor.js"), mockHttpEndpoints());
  const vaultProcessor = new TestProcessor(
    ichi_vault_meridian_abi,
    meridianIchiVaultsHandlerIds,
    service,
    AptosChainId.APTOS_MOVEMENT_MAINNET,
  );
  const timelockedProcessor = new TestProcessor(
    timelocked_abi,
    meridianTimelockedHandlerIds,
    service,
    AptosChainId.APTOS_MOVEMENT_MAINNET,
  );

  function installAbiMocks() {
    mockAptosModuleAbi(ICHI_VAULT_MERIDIAN_PACKAGE, "ichi_vault_meridian", ICHI_VAULT_MERIDIAN_ABI_ENTRY);
    mockAptosModuleAbi(ICHI_VAULT_MERIDIAN_PACKAGE, "timelocked", TIMELOCKED_ABI_ENTRY);
  }

  before(async () => {
    await service.start();
    installAbiMocks();
  });

  afterEach(async () => {
    await service.db.reset();
    resetMockRpc();
    installAbiMocks();
  });

  async function seedVault() {
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
    await vaultProcessor.processEvent({
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

  test("TimelockedUpdateProposedEvent: records audit row with tag + proposed value", async () => {
    await seedVault();

    await timelockedProcessor.processEvent({
      name: "TimelockedUpdateProposedEvent",
      data: {
        tag: "withdraw_fee_bps",
        current_value: "0",
        proposed_value: { vec: ["50"] }, // Some(50)
        current_delay: "21600",
        proposed_delay: { vec: [] }, // None
        execution_time: "1700050000",
      },
      timestamp: secsToMicros(1_700_000_100),
      typeArguments: ["u64"],
    });

    const events = await service.store.list(MIVTimelockedUpdateProposedEvent, [
      { field: "tag", op: "=", value: "withdraw_fee_bps" },
    ]);
    assert.strictEqual(events.length, 1);
    const ev = events[0];
    assert.strictEqual(ev.tag, "withdraw_fee_bps");
    assert.strictEqual(ev.current_value, 0n);
    assert.strictEqual(ev.proposed_value, 50n);
    assert.strictEqual(ev.current_delay, 21_600n);
    assert.strictEqual(ev.proposed_delay, undefined);
    assert.strictEqual(ev.execution_time, 1_700_050_000n);
  });

  test("TimelockedUpdateExecutedEvent without tx payload: records audit row, leaves vault unchanged", async () => {
    const reader = new MIVTestReader(service.store);
    await seedVault();

    // No transactionPayload ⇒ attributeTimelockedVault returns undefined and
    // the handler skips MIVVault propagation. The audit row is still written.
    await timelockedProcessor.processEvent({
      name: "TimelockedUpdateExecutedEvent",
      data: {
        tag: "withdraw_fee_bps",
        previous_value: "0",
        new_value: "50",
        delay: "21600",
      },
      timestamp: secsToMicros(1_700_050_001),
      typeArguments: ["u64"],
    });

    const events = await service.store.list(MIVTimelockedUpdateExecutedEvent, [
      { field: "tag", op: "=", value: "withdraw_fee_bps" },
    ]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].previous_value, 0n);
    assert.strictEqual(events[0].new_value, 50n);
    assert.strictEqual(events[0].delay, 21_600n);
    assert.strictEqual(events[0].vault_address, undefined);

    // Vault unchanged — attribution failed without a payload.
    const vault = await reader.getVault(FIXTURE_VAULT_ADDRESS);
    assert(vault);
    assert.strictEqual(vault.withdraw_fee_bps, 0n);
  });

  test("TimelockedUpdateExecutedEvent (withdraw_fee_bps) WITH tx payload: propagates new value to MIVVault.withdraw_fee_bps", async () => {
    const reader = new MIVTestReader(service.store);
    await seedVault();

    // Synthesize the manage_timelocked_withdraw_fee_bps entry function payload
    // whose first argument is the vault address — the handler reads it via
    // attributeTimelockedVault.
    await timelockedProcessor.processEvent({
      name: "TimelockedUpdateExecutedEvent",
      data: {
        tag: "withdraw_fee_bps",
        previous_value: "0",
        new_value: "50",
        delay: "21600",
      },
      timestamp: secsToMicros(1_700_050_001),
      typeArguments: ["u64"],
      transactionPayload: {
        payload: {
          function: `${ICHI_VAULT_MERIDIAN_PACKAGE}::ichi_vault_meridian::manage_timelocked_withdraw_fee_bps`,
          arguments: [FIXTURE_VAULT_ADDRESS],
        },
      },
    });

    // Audit row now carries the attributed vault_address.
    const events = await service.store.list(MIVTimelockedUpdateExecutedEvent, [
      { field: "tag", op: "=", value: "withdraw_fee_bps" },
    ]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].vault_address, FIXTURE_VAULT_ADDRESS);

    // Vault's withdraw_fee_bps updated to the new value.
    const vault = await reader.getVault(FIXTURE_VAULT_ADDRESS);
    assert(vault);
    assert.strictEqual(vault.withdraw_fee_bps, 50n);
  });

  test("TimelockedUpdateExecutedEvent (rebalance_cooldown) WITH tx payload: routes by tag to the right vault field", async () => {
    const reader = new MIVTestReader(service.store);
    await seedVault();

    await timelockedProcessor.processEvent({
      name: "TimelockedUpdateExecutedEvent",
      data: {
        tag: "rebalance_cooldown",
        previous_value: "120",
        new_value: "300",
        delay: "21600",
      },
      timestamp: secsToMicros(1_700_050_002),
      typeArguments: ["u64"],
      transactionPayload: {
        payload: {
          function: `${ICHI_VAULT_MERIDIAN_PACKAGE}::ichi_vault_meridian::manage_timelocked_rebalance_cooldown`,
          arguments: [FIXTURE_VAULT_ADDRESS],
        },
      },
    });

    const vault = await reader.getVault(FIXTURE_VAULT_ADDRESS);
    assert(vault);
    // The tag-dispatch logic only updates rebalance_cooldown, not withdraw_fee_bps.
    assert.strictEqual(vault.rebalance_cooldown, 300n);
    assert.strictEqual(vault.withdraw_fee_bps, 0n);
  });

  test("TimelockedUpdateProposedEvent: handles delay-only proposal (proposed_value None)", async () => {
    await seedVault();

    await timelockedProcessor.processEvent({
      name: "TimelockedUpdateProposedEvent",
      data: {
        tag: "rebalance_cooldown",
        current_value: "120",
        proposed_value: { vec: [] }, // None
        current_delay: "21600",
        proposed_delay: { vec: ["43200"] }, // Some(43200)
        execution_time: "1700050000",
      },
      timestamp: secsToMicros(1_700_000_100),
      typeArguments: ["u64"],
    });

    const events = await service.store.list(MIVTimelockedUpdateProposedEvent, [
      { field: "tag", op: "=", value: "rebalance_cooldown" },
    ]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].proposed_value, undefined);
    assert.strictEqual(events[0].proposed_delay, 43_200n);
  });
});
