import {
  RunbookReferenceModel,
  type IRunbookReferenceDoc,
} from "../models/InvestigationRunbookReference.model.js";
import {
  RunbookReference,
  RunbookStatus,
} from "../domains/investigation/RunbookReference.js";
import type {
  InvestigationId,
  RunbookId,
} from "../domains/investigation/types.js";
import type {
  IRunbookReferenceRepository,
} from "../domains/investigation/RepositoryInterfaces.js";

function toDomain(doc: IRunbookReferenceDoc): RunbookReference {
  return RunbookReference.reconstitute({
    id: doc._id as RunbookId,
    version: doc.version,
    status: doc.status as RunbookStatus,
    generatedAt: doc.generatedAt,
    githubUrl: doc.githubUrl,
  });
}

export class MongoRunbookReferenceRepository implements IRunbookReferenceRepository {
  async create(
    runbook: RunbookReference,
    investigationId: InvestigationId,
  ): Promise<void> {
    const doc = new RunbookReferenceModel({
      _id: runbook.id,
      investigationId,
      version: runbook.version,
      status: runbook.status,
      generatedAt: runbook.generatedAt,
      githubUrl: runbook.githubUrl,
    });
    await doc.save();
  }

  async update(runbook: RunbookReference): Promise<void> {
    await RunbookReferenceModel.findByIdAndUpdate(
      runbook.id,
      {
        $set: {
          status: runbook.status,
          githubUrl: runbook.githubUrl,
          version: runbook.version,
        },
      },
      { upsert: true },
    );
  }

  async findById(id: RunbookId): Promise<RunbookReference | null> {
    const doc = await RunbookReferenceModel.findById(id);
    return doc ? toDomain(doc) : null;
  }

  async findByInvestigationId(
    investigationId: InvestigationId,
  ): Promise<RunbookReference | null> {
    const doc = await RunbookReferenceModel.findOne({ investigationId });
    return doc ? toDomain(doc) : null;
  }
}
