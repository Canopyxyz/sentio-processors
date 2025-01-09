import { ABIRoot } from "../../pkgs/surf/types/abi.js";
import { ABITable } from "../../pkgs/surf/types/defaultABITable.js";
import { ConvertStructFieldType } from "../../pkgs/surf/types/convertor/structConvertor.js";

// Reuse your existing type extractors as they're well designed
export type Event<T extends ABIRoot> = Extract<T["structs"][number], { is_event: true }>;
export type EventName<T extends ABIRoot> = Event<T>["name"];
export type EventField<T extends ABIRoot, TEventName extends EventName<T>> = Extract<
  Event<T>,
  { name: TEventName }
>["fields"][number];
export type EventFieldName<T extends ABIRoot, TEventName extends EventName<T>> = EventField<T, TEventName>["name"];
export type EventFieldType<
  T extends ABIRoot,
  TEventName extends EventName<T>,
  TFieldName extends EventFieldName<T, TEventName>,
> = Extract<Extract<Event<T>, { name: TEventName }>["fields"][number], { name: TFieldName }>["type"];

// Reuse your existing EventFields type as it properly handles type conversion
export type EventFields<TABITable extends ABITable, TABI extends ABIRoot, TEventName extends EventName<TABI>> = {
  [TField in EventFieldName<TABI, TEventName>]: ConvertStructFieldType<
    TABITable,
    EventFieldType<TABI, TEventName, TField>
  >;
};
