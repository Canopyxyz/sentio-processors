import { TestProcessorServer } from "@sentio/sdk/testing";
import { DataBinding, HandlerType, ProcessBindingResponse } from "@sentio/sdk";
import { AptosChainId } from "@sentio/chain";

import { ABIRoot } from "../../pkgs/surf/types/abi.js";
import { ABITable, DefaultABITable } from "../../pkgs/surf/types/defaultABITable.js";
import { EventName, EventFields } from "./types.js";

// import { multi_rewards_abi } from "../../abis/multi-rewards-testnet.js";

export type HandlerIdMapping<TABI extends ABIRoot> = {
  [K in EventName<TABI>]?: number;
};

// Discriminated union over all events in TABI so processTransaction can accept a
// heterogeneous list (e.g. multiple PositionAddedEvents followed by a RebalanceEvent)
// while still type-checking each `data` against its event's field shape.
export type TestEvent<TABITable extends ABITable, TABI extends ABIRoot> = {
  [K in EventName<TABI>]: { name: K; data: EventFields<TABITable, TABI, K> };
}[EventName<TABI>];

export class TestProcessor<TABITable extends ABITable = DefaultABITable, TABI extends ABIRoot = ABIRoot> {
  private versionCounter = 0n;
  private latestTimestampMicros = 0n; // in microseconds

  constructor(
    private abi: TABI,
    private handlerIds: HandlerIdMapping<TABI>,
    private service: TestProcessorServer,
    // Required: must match the chain that the processor under test is bound to
    // (e.g. AptosChainId.APTOS_TESTNET for multi-rewards, APTOS_MOVEMENT_MAINNET
    // for Meridian). DataBinding.chainId is now used for handler dispatch; a
    // mismatch silently routes events to the wrong (or no) handler.
    private chainId: AptosChainId,
  ) {}

  async processEvent<TEventName extends EventName<TABI>>(params: {
    name: TEventName;
    data: EventFields<TABITable, TABI, TEventName>;
    timestamp?: bigint;
    version?: bigint;
  }): Promise<ProcessBindingResponse> {
    const [response] = await this.processTransaction({
      timestamp: params.timestamp,
      version: params.version,
      events: [{ name: params.name, data: params.data }],
    });
    return response;
  }

  async processTransaction(params: {
    timestamp?: bigint;
    version?: bigint;
    events: Array<TestEvent<TABITable, TABI>>;
  }): Promise<ProcessBindingResponse[]> {
    if (params.events.length === 0) {
      throw new Error("processTransaction requires at least one event");
    }

    // Validate all events exist in the ABI before doing any work
    for (const e of params.events) {
      const struct = this.abi.structs.find((s) => s.is_event && s.name === e.name);
      if (!struct) {
        throw new Error(`Event ${e.name} not found in ABI`);
      }
    }

    // All events in a single tx share one version + timestamp
    this.versionCounter++;
    const version = params.version ?? this.versionCounter;
    this.latestTimestampMicros = params.timestamp ?? this.latestTimestampMicros;

    // Build all event objects up-front so rawTransaction.events can include every one
    const builtEvents = params.events.map((e, idx) =>
      this.buildEventAtIndex({ name: e.name, data: e.data, version, eventIndex: idx }),
    );

    const rawTransaction = JSON.stringify({
      version,
      timestamp: this.latestTimestampMicros,
      events: builtEvents,
    });

    // Process each event as its own binding (one handler invocation per event)
    const responses: ProcessBindingResponse[] = [];
    for (const [idx, event] of builtEvents.entries()) {
      const binding = this.createBinding(event, idx, rawTransaction);
      responses.push(await this.service.processBinding(binding));
    }
    return responses;
  }

  private buildEventAtIndex(params: { name: EventName<TABI>; data: unknown; version: bigint; eventIndex: number }) {
    return {
      guid: {
        // creation_number uniquely identifies the event stream; pair with index to differentiate within a tx
        creation_number: this.versionCounter,
        account_address: this.abi.address,
      },
      sequence_number: BigInt(params.eventIndex),
      type: `${this.abi.address}::${this.abi.name}::${params.name}`,
      version: params.version,
      data: params.data,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createBinding(event: any, eventIndex: number, rawTransaction: string): DataBinding {
    const eventName = event.type.split("::").pop() as EventName<TABI>;

    const handlerId = this.handlerIds[eventName];
    if (handlerId === undefined) {
      throw new Error(`handlerId for event ${eventName} is not specified in handlerIds`);
    }

    return {
      data: {
        aptEvent: {
          rawEvent: JSON.stringify(event),
          eventIndex,
          rawTransaction,
        },
      },
      handlerIds: [handlerId],
      handlerType: HandlerType.APT_EVENT,
      chainId: this.chainId,
    };
  }
}

// Example Usage:

/**
 * Maps event names to their corresponding handler IDs for the multi-rewards processor.
 * Handler IDs must match the sequence in which event handlers are attached to the processor.
 *
 * For example, if your processor setup looks like:
 * processor
 *   .onEventStakingPoolCreatedEvent(() => {...})  // First handler -> ID: 0
 *   .onEventRewardAddedEvent(() => {...})         // Second handler -> ID: 1
 *   .onEventRewardNotifiedEvent(() => {...})      // Third handler -> ID: 2
 *
 * Then your mapping should reflect this order:
 * {
 *   StakingPoolCreatedEvent: 0,
 *   RewardAddedEvent: 1,
 *   RewardNotifiedEvent: 2,
 * }
 *
 * Note: Only events that have handlers implemented need to be mapped.
 * The ID for each event must match its handler's position (0-based index)
 * in the processor's event handler chain.
 */
// const multiRewardsHandlerIds: HandlerIdMapping<typeof multi_rewards_abi> = {
//   StakingPoolCreatedEvent: 0,
//   RewardAddedEvent: 1,
//   // ...
// };

// // Test setup
// const service = new TestProcessorServer(() => import("../multi-rewards/multi-rewards-processor.js"));
// const processor = new TestProcessor(multi_rewards_abi, multiRewardsHandlerIds, service);

// // In test
// await processor.processEvent({
//   name: "StakingPoolCreatedEvent",
//   data: {
//     creator: "0x123",
//     pool_address: "0x123",
//     staking_token: { inner: "0x456" },
//   },
// });
