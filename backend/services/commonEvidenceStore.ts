/**
 * Common Evidence Store - single persistence path for ALL sources.
 *
 * Slack collector and GitHub flows both persist through here into the
 * existing IEvidenceRepository (Mongo). Deduplication is deterministic:
 * the same sourceId is never stored twice per investigation.
 */

import { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";
import type { InvestigationId } from "../domains/investigation/types.js";
import { logger } from "../observability/logger.js";

function stableKey(item: EvidenceItem): string {
  return item.sourceId ?? item.reference;
}

/** Duplicate-key writes (cross-process races) count as skips, not failures. */
function isDuplicateKey(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 11000 || code === "11000") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /E11000|duplicate key/i.test(message);
}

export class CommonEvidenceStore {
  private readonly _seen = new Map<string, Set<string>>();
  private readonly _loaded = new Set<string>();

  constructor(private readonly _repository: IEvidenceRepository) {}

  private _seenFor(investigationId: string): Set<string> {
    let set = this._seen.get(investigationId);
    if (!set) {
      set = new Set();
      this._seen.set(investigationId, set);
    }
    return set;
  }

  /** Persists items, skipping deterministic duplicates. Never throws dedupe reads. */
  async saveAll(investigationId: InvestigationId, items: EvidenceItem[]): Promise<{ stored: number; skipped: number }> {
    const seen = this._seenFor(investigationId);
    if (!this._loaded.has(investigationId)) {
      this._loaded.add(investigationId);
      try {
        const existing = await this._repository.findByInvestigationId(investigationId);
        for (const item of existing) seen.add(stableKey(item));
      } catch (error) {
        logger.warn("CommonEvidenceStore", "DedupeReadFailed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    let stored = 0;
    let skipped = 0;
    for (const item of items) {
      const key = stableKey(item);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      try {
        await this._repository.create(item);
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        seen.add(key);
        skipped++;
        continue;
      }
      seen.add(key);
      stored++;
    }
    logger.info("CommonEvidenceStore", "Saved", { stored, skipped });
    return { stored, skipped };
  }
}
