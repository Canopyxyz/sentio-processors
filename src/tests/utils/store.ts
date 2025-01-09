import { Subject } from "rxjs";
import { Store, StoreContext } from "@sentio/sdk/store";
import { DeepPartial, ProcessStreamResponse } from "@sentio/sdk";
import { MemoryDatabase } from "./memory-database.js";

let db: MemoryDatabase;
export function createStore(): Store {
  const subject = new Subject<DeepPartial<ProcessStreamResponse>>();
  const storeContext = new StoreContext(subject, 1);
  db = new MemoryDatabase(storeContext);
  db.start();
  const store = new Store(storeContext);
  return store;
}

export function resetDb(): Store {
  db.reset();
  const subject = new Subject<DeepPartial<ProcessStreamResponse>>();
  const storeContext = new StoreContext(subject, 1);
  db = new MemoryDatabase(storeContext);
  db.start();
  const store = new Store(storeContext);
  return store;
}
