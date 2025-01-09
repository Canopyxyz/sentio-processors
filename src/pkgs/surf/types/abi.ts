/**
 * The ABI JSON related types.
 */

export interface ABIRoot {
  address: string;
  name: string;
  friends: readonly string[];
  exposed_functions: readonly ABIFunction[];
  structs: readonly ABIStruct[];
}

export interface ABIFunction {
  name: string;
  visibility: "friend" | "public" | "private";
  is_entry: boolean;
  is_view: boolean;
  generic_type_params: readonly ABIFunctionGenericTypeParam[];
  params: readonly string[];
  return: readonly string[];
}

export interface ABIFunctionGenericTypeParam {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constraints: readonly any[];
}

export interface ABIStruct {
  name: string;
  is_native: boolean;
  is_event?: boolean; // NOTE: original @thalalabs/surf pkg did not specify this field
  abilities: readonly string[];
  generic_type_params: readonly ABIFunctionGenericTypeParam[];
  fields: readonly ABIStructField[];
}

export interface ABIStructField {
  name: string;
  type: string;
}
