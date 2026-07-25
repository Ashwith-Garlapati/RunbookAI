import { FindingModel, type IFindingDoc } from "../models/InvestigationFinding.model.js";
import { Finding, type FindingProps, FindingStatus } from "../domains/investigation/Finding.js";
import type { InvestigationId, FindingId } from "../domains/investigation/types.js";
import type { IFindingRepository } from "../domains/investigation/RepositoryInterfaces.js";

function toDomain(doc: IFindingDoc): Finding {
  return Finding.reconstitute({
    id: doc._id as FindingId,
    title: doc.title,
    summary: doc.summary,
    confidence: doc.confidence,
    reasoning: doc.reasoning,
    recommendation: doc.recommendation,
    relatedEvidence: doc.relatedEvidence as FindingProps["relatedEvidence"],
    status: doc.status as FindingStatus,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

export class MongoFindingRepository implements IFindingRepository {
  async create(finding: Finding, investigationId: InvestigationId): Promise<void> {
    const doc = new FindingModel({
      _id: finding.id,
      investigationId,
      title: finding.title,
      summary: finding.summary,
      confidence: finding.confidence,
      reasoning: finding.reasoning,
      recommendation: finding.recommendation,
      relatedEvidence: finding.relatedEvidence,
      status: finding.status,
      createdAt: finding.createdAt,
      updatedAt: finding.updatedAt,
    });
    await doc.save();
  }

  async findById(id: FindingId): Promise<Finding | null> {
    const doc = await FindingModel.findById(id);
    return doc ? toDomain(doc) : null;
  }

  async findByInvestigationId(investigationId: InvestigationId): Promise<Finding[]> {
    const docs = await FindingModel.find({ investigationId });
    return docs.map(toDomain);
  }
}
