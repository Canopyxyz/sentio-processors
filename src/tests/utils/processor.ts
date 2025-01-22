import { TestProcessorServer } from "@sentio/sdk/testing";
import { DataBinding, HandlerType, ProcessBindingResponse } from "@sentio/sdk";

import { ABIRoot } from "../../pkgs/surf/types/abi.js";
import { ABITable, DefaultABITable } from "../../pkgs/surf/types/defaultABITable.js";
import { EventName, EventFields } from "./types.js";

// import { multi_rewards_abi } from "../../abis/multi-rewards-testnet.js";

export type HandlerIdMapping<TABI extends ABIRoot> = {
  [K in EventName<TABI>]?: number;
};

export class TestProcessor<TABITable extends ABITable = DefaultABITable, TABI extends ABIRoot = ABIRoot> {
  private versionCounter = 0n;
  private latestTimestampMicros = 0n; // in microseconds

  constructor(
    private abi: TABI,
    private handlerIds: HandlerIdMapping<TABI>,
    private service: TestProcessorServer,
  ) {}

  async processEvent<TEventName extends EventName<TABI>>(params: {
    name: TEventName;
    data: EventFields<TABITable, TABI, TEventName>;
    timestamp?: bigint;
    version?: bigint;
  }): Promise<ProcessBindingResponse> {
    // 1. Validate event exists in ABI
    const event = this.abi.structs.find((s) => s.is_event && s.name === params.name);
    if (!event) {
      throw new Error(`Event ${params.name} not found in ABI`);
    }

    // 2. Build APT event with proper metadata
    const aptEvent = this.buildEvent(params);

    // 3. Create binding for TestProcessorServer
    const binding = this.createBinding(aptEvent);

    // 4. Process the binding
    return await this.service.processBinding(binding);
  }

  private buildEvent<TEventName extends EventName<TABI>>(params: {
    name: TEventName;
    data: EventFields<TABITable, TABI, TEventName>;
    timestamp?: bigint;
    version?: bigint;
  }) {
    this.versionCounter++;
    this.latestTimestampMicros = params.timestamp || this.latestTimestampMicros;

    return {
      guid: {
        creation_number: this.versionCounter,
        account_address: this.abi.address,
      },
      sequence_number: this.versionCounter,
      type: `${this.abi.address}::${this.abi.name}::${params.name}`,
      version: params.version ?? this.versionCounter,
      data: params.data, // Type-safe from EventFields
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createBinding(event: any): DataBinding {
    // Get the event name from the fully qualified type
    const eventName = event.type.split("::").pop() as EventName<TABI>;

    // Get the corresponding handler ID
    const handlerId = this.handlerIds[eventName];

    if (handlerId === undefined) {
      throw new Error(`handlerId for event ${eventName} is not specified in handlerIds`);
    }

    return {
      data: {
        aptEvent: {
          rawEvent: JSON.stringify(event),
          eventIndex: 0,
          rawTransaction: JSON.stringify({
            version: event.version,
            timestamp: this.latestTimestampMicros,
            events: [event],
          }),
        },
      },
      handlerIds: [handlerId], // Now we use the mapped handler ID
      handlerType: HandlerType.APT_EVENT,
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
