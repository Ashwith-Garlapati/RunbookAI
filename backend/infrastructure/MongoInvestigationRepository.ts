import { InvestigationModel, type IInvestigationDoc } from "../models/Investigation.model.js";
import type { IInvestigationRepository } from "../domains/investigation/InvestigationRepository.js";
import type { InvestigationId } from "../domains/investigation/types.js";
import type { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";
import { Investigation, type InvestigationProps } from "../domains/investigation/Investigation.js";
import { InvestigationStatus as Status } from "../domains/investigation/InvestigationStatus.js";
import type { Trigger } from "../domains/investigation/Trigger.js";
import type { TriggerSource } from "../domains/investigation/TriggerSource.js";
import type { TriggerType } from "../domains/investigation/TriggerType.js";

function toDomain(doc: IInvestigationDoc): Investigation {
  const trigger: Trigger = {
    id: doc.trigger.id,
    source: doc.trigger.source as TriggerSource,
    type: doc.trigger.type as TriggerType,
    actor: doc.trigger.actor,
    payload: doc.trigger.payload,
    timestamp: doc.trigger.timestamp,
    metadata: doc.trigger.metadata,
  };

  const props: InvestigationProps = {
    id: doc._id as InvestigationId,
    organizationId: doc.organizationId as InvestigationProps["organizationId"],
    title: doc.title,
    description: doc.description,
    severity: doc.severity,
    status: doc.status as InvestigationStatus,
    trigger,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    affectedServices: doc.affectedServices,
    tags: doc.tags,
    evidenceIds: doc.evidenceIds as InvestigationProps["evidenceIds"],
    findingIds: doc.findingIds as InvestigationProps["findingIds"],
    runbookId: doc.runbookId as InvestigationProps["runbookId"],
    reportId: doc.reportId as InvestigationProps["reportId"],
    timelineEventIds: doc.timelineEventIds as InvestigationProps["timelineEventIds"],
    metadata: doc.metadata,
  };

  return Investigation.reconstitute(props);
}

function toDocument(investigation: Investigation): Record<string, unknown> {
  return {
    _id: investigation.id,
    organizationId: investigation.organizationId,
    title: investigation.title,
    description: investigation.description,
    severity: investigation.severity,
    status: investigation.status,
    trigger: {
      id: investigation.trigger.id,
      source: investigation.trigger.source,
      type: investigation.trigger.type,
      actor: investigation.trigger.actor,
      payload: investigation.trigger.payload,
      timestamp: investigation.trigger.timestamp,
      metadata: investigation.trigger.metadata,
    },
    createdBy: investigation.createdBy,
    createdAt: investigation.createdAt,
    updatedAt: investigation.updatedAt,
    startedAt: investigation.startedAt,
    completedAt: investigation.completedAt,
    affectedServices: investigation.affectedServices,
    tags: investigation.tags,
    evidenceIds: investigation.evidenceIds,
    findingIds: investigation.findingIds,
    runbookId: investigation.runbookId,
    reportId: investigation.reportId,
    timelineEventIds: investigation.timelineEventIds,
    metadata: investigation.metadata,
  };
}

export class MongoInvestigationRepository implements IInvestigationRepository {
  async create(investigation: Investigation): Promise<Investigation> {
    const doc = new InvestigationModel(toDocument(investigation));
    await doc.save();
    return investigation;
  }

  async update(investigation: Investigation): Promise<Investigation> {
    await InvestigationModel.findByIdAndUpdate(
      investigation.id,
      { $set: toDocument(investigation) },
      { upsert: true },
    );
    return investigation;
  }

  async findById(id: InvestigationId): Promise<Investigation | null> {
    const doc = await InvestigationModel.findById(id);
    return doc ? toDomain(doc) : null;
  }

  async findByStatus(status: InvestigationStatus): Promise<Investigation[]> {
    const docs = await InvestigationModel.find({ status });
    return docs.map(toDomain);
  }

  async findActive(): Promise<Investigation[]> {
    const terminalStatuses = [Status.Completed, Status.Archived];
    const docs = await InvestigationModel.find({
      status: { $nin: terminalStatuses },
    });
    return docs.map(toDomain);
  }

  async findCompleted(): Promise<Investigation[]> {
    const docs = await InvestigationModel.find({ status: Status.Completed });
    return docs.map(toDomain);
  }

  async delete(id: InvestigationId): Promise<void> {
    await InvestigationModel.findByIdAndDelete(id);
  }
}
