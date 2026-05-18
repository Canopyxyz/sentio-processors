// Shared test scaffolding for Meridian Ichi vaults tests. Centralizes the
// TestProcessorServer construction, TestProcessor instantiation, module-ABI
// fetch interception, and the lifecycle hooks each test file would otherwise
// repeat.

import { before, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { TestProcessorServer } from "@sentio/sdk/testing";
import { AptosChainId } from "@sentio/chain";

import { ichi_vault_meridian_abi } from "../../../abis/ichi_vault_meridian.js";
import { TestProcessor } from "../../utils/processor.js";
import { mockHttpEndpoints, mockAptosModuleAbi, resetMockRpc } from "../../common/mockRpc.js";
import { meridianIchiVaultsHandlerIds, ICHI_VAULT_MERIDIAN_PACKAGE } from "./constants.js";

// Vendored module ABIs. The Aptos SDK fetches these via
// GET /v1/accounts/<pkg>/module/<name> before serializing view-call args and
// deserializing responses; without them the test fails on the unmocked GET.
//
// Lives outside src/ (rootDir), so we can't import the JSON statically —
// read it at module load time.
const ICHI_VAULT_MERIDIAN_ABI_ENTRY = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "abis/aptos/movement-mainnet/ichi_vault_meridian.json"), "utf-8"),
)[0];

const TIMELOCKED_ABI_PATH = path.resolve(process.cwd(), "abis/aptos/movement-mainnet/timelocked.json");
const TIMELOCKED_ABI_ENTRY = fs.existsSync(TIMELOCKED_ABI_PATH)
  ? JSON.parse(fs.readFileSync(TIMELOCKED_ABI_PATH, "utf-8"))[0]
  : undefined;

/**
 * Install the standard MIV test harness inside a `describe` block.
 *
 * Wires up:
 *   - TestProcessorServer pointed at the mock RPC host
 *   - TestProcessor bound to ichi_vault_meridian with movement-mainnet chainId
 *   - Persistent module-ABI fetch interceptor (re-installed after each test
 *     since resetMockRpc clears it)
 *   - before(): service.start() + initial mocks
 *   - afterEach(): db.reset() + resetMockRpc() + re-install module ABIs
 *
 * Return type intentionally inferred so TestProcessor's two generic params
 * (TABITable, TABI) resolve correctly without explicit annotation.
 */
export function setupMeridianIchiVaultsTest() {
  const service = new TestProcessorServer(() => import("../meridian-ichi-vaults-processor.js"), mockHttpEndpoints());
  const processor = new TestProcessor(
    ichi_vault_meridian_abi,
    meridianIchiVaultsHandlerIds,
    service,
    AptosChainId.APTOS_MOVEMENT_MAINNET,
  );

  before(async () => {
    await service.start();
    installModuleAbiMocks();
  });

  afterEach(async () => {
    await service.db.reset();
    resetMockRpc();
    installModuleAbiMocks();
  });

  return { service, processor };
}

function installModuleAbiMocks() {
  mockAptosModuleAbi(ICHI_VAULT_MERIDIAN_PACKAGE, "ichi_vault_meridian", ICHI_VAULT_MERIDIAN_ABI_ENTRY);
  if (TIMELOCKED_ABI_ENTRY) {
    mockAptosModuleAbi(ICHI_VAULT_MERIDIAN_PACKAGE, "timelocked", TIMELOCKED_ABI_ENTRY);
  }
}
