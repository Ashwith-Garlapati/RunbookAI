import { TimelineEventModel, type ITimelineEventDoc } from "../models/InvestigationTimeline.model.js";
import type { InvestigationId } from "../domains/investigation/types.js";
import { TimelineEvent, type TimelineEventProps } from "../domains/investigation/TimelineEvent.js";

function toDomain(doc: ITimelineEventDoc): TimelineEvent {
  return TimelineEvent.reconstitute({
    id: doc._id,
    investigationId: doc.investigationId as InvestigationId,
    type: doc.type as TimelineEventProps["type"],
    description: doc.description,
    timestamp: doc.timestamp,
    metadata: doc.metadata,
  });
}

export interface ITimelineRepository {
  create(event: TimelineEvent): Promise<void>;
  findByInvestigationId(investigationId: InvestigationId): Promise<TimelineEvent[]>;
  findIdsByInvestigationId(investigationId: InvestigationId): Promise<string[]>;
}

export class MongoTimelineRepository implements ITimelineRepository {
  async create(event: TimelineEvent): Promise<void> {
    const doc = new TimelineEventModel({
      _id: event.id,
      investigationId: event.investigationId,
      type: event.type,
      timestamp: event.timestamp,
      description: event.description,
      metadata: event.metadata,
    });
    await doc.save();
  }

  async findByInvestigationId(investigationId: InvestigationId): Promise<TimelineEvent[]> {
    const docs = await TimelineEventModel.find({ investigationId }).sort({ timestamp: 1 });
    return docs.map(toDomain);
  }

  async findIdsByInvestigationId(investigationId: InvestigationId): Promise<string[]> {
    const docs = await TimelineEventModel.find({ investigationId }).select("_id");
    return docs.map((d) => d._id);
  }
}
