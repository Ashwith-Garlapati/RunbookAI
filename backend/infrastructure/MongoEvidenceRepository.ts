import { EvidenceModel, type IEvidenceDoc } from "../models/InvestigationEvidence.model.js";
import { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import type { InvestigationId, EvidenceId } from "../domains/investigation/types.js";
import type { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";

function toDomain(doc: IEvidenceDoc): EvidenceItem {
  return EvidenceItem.reconstitute({
    id: doc._id as EvidenceId,
    investigationId: doc.investigationId as InvestigationId,
    source: doc.source as EvidenceSource,
    type: doc.type,
    reference: doc.reference,
    collectedAt: doc.collectedAt,
    metadata: doc.metadata,
  });
}

export class MongoEvidenceRepository implements IEvidenceRepository {
  async create(evidence: EvidenceItem): Promise<void> {
    const doc = new EvidenceModel({
      _id: evidence.id,
      investigationId: evidence.investigationId,
      source: evidence.source,
      type: evidence.type,
      reference: evidence.reference,
      collectedAt: evidence.collectedAt,
      metadata: evidence.metadata,
    });
    await doc.save();
  }

  async findById(id: EvidenceId): Promise<EvidenceItem | null> {
    const doc = await EvidenceModel.findById(id);
    return doc ? toDomain(doc) : null;
  }

  async findByInvestigationId(investigationId: InvestigationId): Promise<EvidenceItem[]> {
    const docs = await EvidenceModel.find({ investigationId });
    return docs.map(toDomain);
  }
}
