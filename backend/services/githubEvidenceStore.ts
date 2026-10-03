/**
 * GitHub Evidence Store - persists normalized GitHub records through the
 * COMMON evidence store (same IEvidenceRepository + dedupe as Slack).
 *
 * API unchanged ({ stored, skipped }); canonical mapping preserves
 * provenance, searchable text, timestamps, and stable sourceIds.
 */

import { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";
import type { InvestigationId } from "../domains/investigation/types.js";
import { CommonEvidenceStore } from "./commonEvidenceStore.js";
import type { GitHubEvidenceRecord } from "./githubEvidenceTypes.js";

export class GitHubEvidenceStore {
  private readonly _common: CommonEvidenceStore;

  constructor(repository: IEvidenceRepository) {
    this._common = new CommonEvidenceStore(repository);
  }

  /** Persists records, skipping deterministic duplicates. Returns stored count. */
  async saveAll(investigationId: InvestigationId, records: GitHubEvidenceRecord[]): Promise<{ stored: number; skipped: number }> {
    const items = records.map((record) =>
      EvidenceItem.createCanonical({
        investigationId,
        source: EvidenceSource.GitHub,
        type: record.type,
        sourceId: record.sourceId,
        ...(record.incidentId ? { incidentId: record.incidentId } : {}),
        content: record.content,
        searchableText: record.searchableText,
        ...(record.occurredAt ? { occurredAt: new Date(record.occurredAt) } : {}),
        provenance: { ...record.provenance },
        metadata: {
          evidenceId: record.id,
          hash: record.hash,
          createdAt: record.createdAt,
          detail: record.metadata,
        },
      }),
    );
    return this._common.saveAll(investigationId, items);
  }
}
