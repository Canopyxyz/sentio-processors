import { DBRequest, ProcessStreamResponse } from "@sentio/sdk";
import { StoreContext } from "@sentio/sdk/store";

export class MemoryDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db = new Map<string, any>();
  public lastDbRequest: DBRequest | undefined;
  constructor(readonly dbContext: StoreContext) {}

  start() {
    this.dbContext.subject.subscribe(this.processRequest.bind(this));
  }

  stop() {
    this.dbContext.subject.unsubscribe();
    this.dbContext.subject.complete();
  }

  private processRequest(request: ProcessStreamResponse) {
    const req = request.dbRequest;
    this.lastDbRequest = req;
    if (req) {
      if (req.upsert) {
        const { entityData, entity } = req.upsert;
        entityData.forEach((d, i) => {
          const id = d.fields["id"].stringValue!;
          const entityName = entity[i];
          this.db.set(`${entityName}-${id}`, d);
        });

        this.dbContext.result({
          opId: req.opId,
        });
      }
      if (req.delete) {
        const { id, entity } = req.delete;
        id.forEach((i, idx) => {
          const entityName = entity[idx];
          this.db.delete(`${entityName}-${id}`);
        });
        this.dbContext.result({
          opId: req.opId,
        });
      }

      if (req.get) {
        const { entity, id } = req.get;
        const data = this.db.get(`${entity}-${id}`);
        this.dbContext.result({
          opId: req.opId,
          // entities: { entities: data ? [data] : [] },
          entityList: {
            entities: data ? [toEntity(entity, data)] : [],
          },
        });
      }
      if (req.list) {
        const { entity, cursor } = req.list;
        const list = [];
        for (const key of this.db.keys()) {
          if (key.startsWith(entity)) {
            list.push(this.db.get(key));
          }
        }

        if (list.length === 0) {
          // Return empty list when no entities found
          this.dbContext.result({
            opId: req.opId,
            entityList: { entities: [] },
            nextCursor: undefined,
          });
        } else if (cursor) {
          const idx = parseInt(cursor);
          this.dbContext.result({
            opId: req.opId,
            entityList: {
              entities: list.slice(idx, idx + 1).map((d) => toEntity(entity, d)),
            },
            nextCursor: idx + 1 < list.length ? `${idx + 1}` : undefined,
          });
        } else {
          this.dbContext.result({
            opId: req.opId,
            entityList: { entities: [toEntity(entity, list[0])] },
            nextCursor: list.length > 1 ? "1" : undefined,
          });
        }
      }
    }
  }

  reset() {
    this.db.clear();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEntity(entity: string, data: any) {
  return {
    entity,
    genBlockChain: "",
    genBlockNumber: 0n,
    genBlockTime: new Date(),
    data,
  };
}
