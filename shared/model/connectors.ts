import { Connector } from "./connector";
import { compact, syncFields } from "./sync";
import type { ConnectorDataOf, IntegrationState } from "./wire";

type FileOp = ConnectorDataOf<"touches">["op"];

export class ContainsConnector extends Connector<"contains"> {
  public constructor(data: ConnectorDataOf<"contains">) {
    super(data);
  }

  get styleState(): string | undefined {
    return undefined;
  }

  toData(): ConnectorDataOf<"contains"> {
    return this.baseData();
  }

  protected applyData(): boolean {
    return false;
  }
}

export class BranchOfConnector extends Connector<"branch-of"> {
  public constructor(data: ConnectorDataOf<"branch-of">) {
    super(data);
  }

  get styleState(): string | undefined {
    return undefined;
  }

  toData(): ConnectorDataOf<"branch-of"> {
    return this.baseData();
  }

  protected applyData(): boolean {
    return false;
  }
}

export class SpawnedConnector extends Connector<"spawned"> {
  public constructor(data: ConnectorDataOf<"spawned">) {
    super(data);
  }

  get styleState(): string | undefined {
    return undefined;
  }

  toData(): ConnectorDataOf<"spawned"> {
    return this.baseData();
  }

  protected applyData(): boolean {
    return false;
  }
}

export class TouchesConnector extends Connector<"touches"> {
  op: FileOp;

  public constructor(data: ConnectorDataOf<"touches">) {
    super(data);
    this.op = data.op;
  }

  get styleState(): string | undefined {
    return this.op;
  }

  toData(): ConnectorDataOf<"touches"> {
    return { ...this.baseData(), op: this.op };
  }

  protected applyData(data: ConnectorDataOf<"touches">): boolean {
    return syncFields(this, data, ["op"]);
  }
}

export class MergesIntoConnector extends Connector<"merges-into"> {
  state: IntegrationState;

  public constructor(data: ConnectorDataOf<"merges-into">) {
    super(data);
    this.state = data.state;
  }

  get styleState(): string | undefined {
    return this.state;
  }

  toData(): ConnectorDataOf<"merges-into"> {
    return { ...this.baseData(), state: this.state };
  }

  protected applyData(data: ConnectorDataOf<"merges-into">): boolean {
    return syncFields(this, data, ["state"]);
  }
}

export class SharesContextConnector extends Connector<"shares-context"> {
  lastExchangeAt: string | undefined;

  public constructor(data: ConnectorDataOf<"shares-context">) {
    super(data);
    this.lastExchangeAt = data.lastExchangeAt;
  }

  get styleState(): string | undefined {
    return undefined;
  }

  toData(): ConnectorDataOf<"shares-context"> {
    return compact({ ...this.baseData(), lastExchangeAt: this.lastExchangeAt });
  }

  protected applyData(data: ConnectorDataOf<"shares-context">): boolean {
    return syncFields(this, data, ["lastExchangeAt"]);
  }
}

export type ConnectorByKind = {
  contains: ContainsConnector;
  "branch-of": BranchOfConnector;
  spawned: SpawnedConnector;
  touches: TouchesConnector;
  "merges-into": MergesIntoConnector;
  "shares-context": SharesContextConnector;
};
