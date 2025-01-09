// to generate TS types from graphql schema
// npx tsx ./scripts/codegen.ts

import { codegen } from "@sentio/sdk/store/codegen";

codegen("./", "./src/schema");
