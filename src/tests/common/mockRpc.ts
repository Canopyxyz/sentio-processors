// Test infrastructure for intercepting Aptos view-function RPC calls without
// hitting a live RPC endpoint.
//
// Usage:
//   import { mockHttpEndpoints, mockViewCall, resetMockRpc } from "../../common/mockRpc.js";
//   import { AptosChainId } from "@sentio/chain";
//
//   const service = new TestProcessorServer(
//     () => import("../meridian-ichi-vaults-processor.js"),
//     mockHttpEndpoints(),
//   );
//
//   // Inside a test:
//   mockViewCall({
//     function: `${PKG}::ichi_vault_meridian::get_total_vault_holdings`,
//     functionArguments: [VAULT_ADDR],
//     response: ["1000000", "2000000"],
//   });
//
// The TestProcessorServer constructor overwrites Endpoints.INSTANCE for every
// known chain to point at whatever we pass. We provide the mock host so
// ctx.getClient().view(...) POSTs land on the nock interceptor.
//
// The Aptos client appends "/v1" to the chain-server URL, so the nock matcher
// targets POST /v1/view on the mock host.

import nock from "nock";
import { AptosChainId } from "@sentio/chain";

export const MOCK_RPC_HOST = "http://sentio-mock-rpc.local";

/**
 * Returns the httpEndpoints map to pass as the second arg of TestProcessorServer.
 *
 * By default points every supported Aptos chain at MOCK_RPC_HOST. Tests don't
 * need to opt in individually — any view call originating from any chain will
 * end up at the mock host.
 */
export function mockHttpEndpoints(): Record<string, string> {
  return {
    [AptosChainId.APTOS_MAINNET]: MOCK_RPC_HOST,
    [AptosChainId.APTOS_TESTNET]: MOCK_RPC_HOST,
    [AptosChainId.APTOS_MOVEMENT_MAINNET]: MOCK_RPC_HOST,
  };
}

/**
 * One expected view call and its canned response.
 *
 * `function` is the fully-qualified function name (e.g.
 * "0x96cf...::ichi_vault_meridian::get_total_vault_holdings").
 *
 * `functionArguments` are the positional args the handler will pass. Sentio's
 * Aptos client serializes bigint / number / boolean as strings on the wire, so
 * pass values in whatever form is natural — the matcher String()s them before
 * comparing.
 *
 * `response` is the JSON the view call should return — always an array, since
 * Move view functions return tuples.
 */
export type ViewCallExpectation = {
  function: string;
  typeArguments?: string[];
  functionArguments: unknown[];
  response: unknown[];
};

/**
 * Install a single view-call interceptor. Persists across multiple invocations
 * within a test (the handler may make the same view call repeatedly).
 *
 * Call resetMockRpc() in afterEach to clear all interceptors between tests.
 */
export function mockViewCall(expectation: ViewCallExpectation): nock.Scope {
  return nock(MOCK_RPC_HOST)
    .persist()
    .post("/v1/view", (body) => viewCallMatches(body, expectation))
    .reply(200, expectation.response);
}

/**
 * Convenience: install many view-call interceptors at once.
 */
export function mockViewCalls(expectations: ViewCallExpectation[]): nock.Scope[] {
  return expectations.map(mockViewCall);
}

/**
 * Clears all nock interceptors and re-enables network connections for any
 * non-mocked hosts. Call in afterEach.
 */
export function resetMockRpc(): void {
  nock.cleanAll();
}

/**
 * Disable real network access during a test run. Recommended in a global
 * before(); pair with enableNetConnect() in afterAll() if other test suites
 * in the same process need real network.
 */
export function disableRealNetwork(): void {
  nock.disableNetConnect();
}

export function enableRealNetwork(): void {
  nock.enableNetConnect();
}

// - - - Internals - - -

function viewCallMatches(body: unknown, e: ViewCallExpectation): boolean {
  if (typeof body !== "object" || body === null) return false;
  // Aptos REST view payload: { function, type_arguments, arguments }
  const b = body as {
    function?: string;
    type_arguments?: unknown[];
    arguments?: unknown[];
  };
  if (b.function !== e.function) return false;

  const expectedTypeArgs = e.typeArguments ?? [];
  const actualTypeArgs = b.type_arguments ?? [];
  if (!shallowStringEqual(actualTypeArgs, expectedTypeArgs)) return false;

  const actualArgs = b.arguments ?? [];
  // Sentio's Aptos client stringifies u64/u128 arguments; normalize both sides.
  if (!shallowStringEqual(actualArgs, e.functionArguments)) return false;

  return true;
}

function shallowStringEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}
