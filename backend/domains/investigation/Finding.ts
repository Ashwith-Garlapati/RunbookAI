/**
 * Investigation Domain - Finding Entity
 *
 * Represents an insight or conclusion derived from evidence analysis.
 * Findings are created during the GeneratingFindings phase and may be
 * confirmed or rejected through human review.
 *
 * Each finding links back to the evidence that supports it via relatedEvidence IDs.
 */

import { randomUUID } from "node:crypto";

import type { FindingId, EvidenceId } from "./types.js";

export enum FindingStatus {
  Draft = "draft",
  Confirmed = "confirmed",
  Rejected = "rejected",
}

export interface FindingProps {
  readonly id: FindingId;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly recommendation: string;
  readonly relatedEvidence: EvidenceId[];
  readonly status: FindingStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class Finding {
  readonly id: FindingId;
  title: string;
  summary: string;
  confidence: number;
  reasoning: string;
  recommendation: string;
  relatedEvidence: EvidenceId[];
  status: FindingStatus;
  readonly createdAt: Date;
  updatedAt: Date;

  private constructor(props: FindingProps) {
    this.id = props.id;
    this.title = props.title;
    this.summary = props.summary;
    this.confidence = props.confidence;
    this.reasoning = props.reasoning;
    this.recommendation = props.recommendation;
    this.relatedEvidence = [...props.relatedEvidence];
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  /**
   * Creates a new Finding in Draft status.
   * confidence should be between 0 and 1.
   */
  static create(params: {
    title: string;
    summary: string;
    confidence: number;
    reasoning: string;
    recommendation: string;
    relatedEvidence?: EvidenceId[];
  }): Finding {
    const now = new Date();
    return new Finding({
      id: randomUUID(),
      title: params.title,
      summary: params.summary,
      confidence: params.confidence,
      reasoning: params.reasoning,
      recommendation: params.recommendation,
      relatedEvidence: params.relatedEvidence ?? [],
      status: FindingStatus.Draft,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Reconstitutes a Finding from persisted data.
   */
  static reconstitute(props: FindingProps): Finding {
    return new Finding(props);
  }

  /** Confirms this finding as valid. */
  confirm(): void {
    this.status = FindingStatus.Confirmed;
    this.updatedAt = new Date();
  }

  /** Rejects this finding. */
  reject(): void {
    this.status = FindingStatus.Rejected;
    this.updatedAt = new Date();
  }
}
