import { randomUUID } from "node:crypto";

import type { EvidenceId, InvestigationId } from "./types.js";
import type { EvidenceSource } from "./EvidenceSource.js";
import type { Evidence } from "./Evidence.js";

export class EvidenceItem implements Evidence {
  readonly id: EvidenceId;
  readonly investigationId: InvestigationId;
  readonly source: EvidenceSource;
  readonly type: string;
  readonly reference: string;
  readonly collectedAt: Date;
  readonly metadata: Record<string, unknown>;

  private constructor(props: Evidence) {
    this.id = props.id;
    this.investigationId = props.investigationId;
    this.source = props.source;
    this.type = props.type;
    this.reference = props.reference;
    this.collectedAt = props.collectedAt;
    this.metadata = { ...props.metadata };
  }

  static create(params: {
    investigationId: InvestigationId;
    source: EvidenceSource;
    type: string;
    reference: string;
    metadata?: Record<string, unknown>;
  }): EvidenceItem {
    return new EvidenceItem({
      id: randomUUID() as EvidenceId,
      investigationId: params.investigationId,
      source: params.source,
      type: params.type,
      reference: params.reference,
      collectedAt: new Date(),
      metadata: params.metadata ?? {},
    });
  }

  static reconstitute(props: Evidence): EvidenceItem {
    return new EvidenceItem(props);
  }
}
