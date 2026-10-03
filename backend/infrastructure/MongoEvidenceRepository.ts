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
    ...(doc.teamId ? { teamId: doc.teamId } : {}),
    ...(doc.incidentId ? { incidentId: doc.incidentId } : {}),
    ...(doc.title ? { title: doc.title } : {}),
    ...(doc.content !== undefined ? { content: doc.content } : {}),
    ...(doc.searchableText !== undefined ? { searchableText: doc.searchableText } : {}),
    ...(doc.occurredAt ? { occurredAt: doc.occurredAt } : {}),
    ...(doc.provenance ? { provenance: { ...doc.provenance } } : {}),
    // Legacy rows predate sourceId — reference has always been the stable key.
    ...(doc.sourceId || doc.reference ? { sourceId: (doc.sourceId ?? doc.reference) as string } : {}),
    ...(doc.hash ? { hash: doc.hash } : {}),
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
      ...(evidence.teamId ? { teamId: evidence.teamId } : {}),
      ...(evidence.incidentId ? { incidentId: evidence.incidentId } : {}),
      ...(evidence.title ? { title: evidence.title } : {}),
      ...(evidence.content !== undefined ? { content: evidence.content } : {}),
      ...(evidence.searchableText !== undefined ? { searchableText: evidence.searchableText } : {}),
      ...(evidence.occurredAt ? { occurredAt: evidence.occurredAt } : {}),
      ...(evidence.provenance ? { provenance: { ...evidence.provenance } } : {}),
      ...(evidence.sourceId ? { sourceId: evidence.sourceId } : {}),
      ...(evidence.hash ? { hash: evidence.hash } : {}),
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
