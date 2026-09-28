import { TimelineEventModel, type ITimelineEventDoc } from "../models/InvestigationTimeline.model.js";
import type { InvestigationId } from "../domains/investigation/types.js";
import { TimelineEvent, type TimelineEventProps } from "../domains/investigation/TimelineEvent.js";
import type { ITimelineRepository } from "../domains/investigation/TimelineService.js";

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
}
