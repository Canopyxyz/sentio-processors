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
 * `functionArguments` are the positional args the handler will pass.
 * **The matcher is strict** — fixtures must mirror the exact on-wire JSON
 * shape that the Aptos REST API expects. In particular, u64/u128/u256 args
 * MUST be passed as strings (the REST API rejects them as numbers with
 * "expect string<u64>, got number"). bools stay as booleans; addresses
 * stay as `"0x..."` strings. This catches a class of bugs where the
 * processor accidentally sends a JS number for a u64.
 *
 * `response` is the JSON the view call should return — always an array, since
 * Move view functions return tuples.
 *
 * `ledgerVersion`, if set, additionally asserts that the request's
 * `?ledger_version=` query parameter matches. Useful for catching regressions
 * where the processor forgets to pin a historical view call.
 */
export type ViewCallExpectation = {
  function: string;
  typeArguments?: string[];
  functionArguments: unknown[];
  response: unknown[];
  ledgerVersion?: bigint | number | string;
};

// Internal: build the nock matcher chain. The Aptos SDK passes
// options.ledgerVersion as a `?ledger_version=...` query param, so we must use
// .query(...) — a bare .post("/v1/view") won't match a request with a query
// string. If the expectation pins a ledger version, assert it; otherwise
// accept any (or no) query.
function buildInterceptor(expectation: ViewCallExpectation) {
  const interceptor = nock(MOCK_RPC_HOST).post("/v1/view", (body) => viewCallMatches(body, expectation));
  if (expectation.ledgerVersion !== undefined) {
    return interceptor.query({ ledger_version: String(expectation.ledgerVersion) });
  }
  return interceptor.query(true);
}

/**
 * Install a single one-shot view-call interceptor. Default semantics: the
 * interceptor matches at most once and is then consumed. For tests that
 * process multiple events with evolving vault state, this prevents a stale
 * interceptor from one event silently satisfying a later event's view call.
 *
 * For repeated calls within the SAME event handler (e.g. rebuildPositions
 * loops over get_all_position_info), install one interceptor per expected
 * call — either by calling mockViewCall multiple times or via
 * mockViewCallSequence (which is just sugar for that).
 *
 * For genuinely stable values that are called many times (e.g. a token's
 * decimals across an entire test run), use mockViewCallPersistent.
 *
 * Call resetMockRpc() in afterEach to clear all interceptors between tests.
 */
export function mockViewCall(expectation: ViewCallExpectation): nock.Scope {
  return buildInterceptor(expectation).reply(200, expectation.response);
}

/**
 * Install a long-lived interceptor that keeps matching the same view call
 * indefinitely. Use sparingly — only for values that are truly stable for the
 * entire test (e.g. token decimals).
 */
export function mockViewCallPersistent(expectation: ViewCallExpectation): nock.Scope {
  return buildInterceptor(expectation).reply(200, expectation.response).persist();
}

/**
 * Convenience: install many one-shot view-call interceptors at once. Order
 * matters when multiple interceptors share the same matcher (queues in FIFO).
 */
export function mockViewCalls(expectations: ViewCallExpectation[]): nock.Scope[] {
  return expectations.map(mockViewCall);
}

/**
 * Install a queue of one-shot interceptors for the same view call, each
 * returning the next response in the sequence. Useful when one handler invokes
 * the same view multiple times with different expected responses (e.g. a loop
 * over get_all_position_info for each position index — though that varies the
 * functionArguments, so installing distinct expectations via mockViewCalls is
 * usually clearer).
 *
 * The matcher fields (function/typeArguments/functionArguments/ledgerVersion)
 * come from `base`; only `response` cycles through `responses`.
 */
export function mockViewCallSequence(
  base: Omit<ViewCallExpectation, "response">,
  responses: unknown[][],
): nock.Scope[] {
  return responses.map((response) => mockViewCall({ ...base, response }));
}

/**
 * Install a persistent interceptor for `GET /v1/accounts/<pkg>/module/<name>`,
 * returning the given { bytecode, abi } object. The Aptos SDK fetches module
 * ABIs automatically before serializing view-call args + deserializing
 * responses; without this mock the test will error with
 * "Nock: No match for request" on the module-fetch GET.
 *
 * Pass the single-module object (not the array) — our vendored
 * abis/aptos/<chain>/<module>.json files contain an array of [{ bytecode,
 * abi }], take the matching entry.
 */
export function mockAptosModuleAbi(packageAddress: string, moduleName: string, abiEntry: object): nock.Scope {
  return nock(MOCK_RPC_HOST)
    .persist()
    .get(`/v1/accounts/${packageAddress}/module/${moduleName}`)
    .reply(200, abiEntry as nock.Body);
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
  // Type args are always strings on the wire (Move type tags), so deep equal
  // via JSON.stringify is sufficient and strict.
  if (JSON.stringify(actualTypeArgs) !== JSON.stringify(expectedTypeArgs)) return false;

  const actualArgs = b.arguments ?? [];
  // Strict: no String() coercion. Fixtures must mirror exactly what goes on
  // the wire (e.g. u64/u128 as strings, bools as booleans). This catches the
  // class of bug where a handler accidentally passes a JS number for a u64
  // — the real Movement REST API rejects it with "expect string<u64>, got
  // number", and we should fail the test before that ships.
  if (JSON.stringify(actualArgs) !== JSON.stringify(e.functionArguments)) return false;

  return true;
}
