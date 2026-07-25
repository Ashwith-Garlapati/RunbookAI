/**
 * Investigation Domain - Runbook Reference Value Object
 *
 * Stores the metadata for a generated runbook associated with an investigation.
 * The actual runbook content is stored externally (e.g., GitHub).
 * This reference tracks version, status, and links.
 *
 * AI generation of runbooks is NOT implemented here — this is a domain placeholder.
 */

import { randomUUID } from "node:crypto";

import type { RunbookId } from "./types.js";

export enum RunbookStatus {
  Pending = "pending",
  Generated = "generated",
  Approved = "approved",
  Published = "published",
}

export interface RunbookReferenceProps {
  readonly id: RunbookId;
  readonly version: number;
  readonly status: RunbookStatus;
  readonly generatedAt: Date;
  readonly githubUrl?: string | undefined;
}

export class RunbookReference {
  readonly id: RunbookId;
  readonly version: number;
  status: RunbookStatus;
  readonly generatedAt: Date;
  githubUrl: string | undefined;

  private constructor(props: RunbookReferenceProps) {
    this.id = props.id;
    this.version = props.version;
    this.status = props.status;
    this.generatedAt = props.generatedAt;
    this.githubUrl = props.githubUrl;
  }

  /**
   * Creates a new RunbookReference in Pending status.
   */
  static create(params?: { githubUrl?: string }): RunbookReference {
    return new RunbookReference({
      id: randomUUID(),
      version: 1,
      status: RunbookStatus.Pending,
      generatedAt: new Date(),
      githubUrl: params?.githubUrl,
    });
  }

  /**
   * Reconstitutes a RunbookReference from persisted data.
   */
  static reconstitute(props: RunbookReferenceProps): RunbookReference {
    return new RunbookReference(props);
  }

  /** Marks the runbook as generated. */
  markGenerated(): void {
    this.status = RunbookStatus.Generated;
  }

  /** Approves the runbook content. */
  approve(): void {
    this.status = RunbookStatus.Approved;
  }

  /** Publishes the runbook and stores its GitHub URL. */
  publish(githubUrl: string): void {
    this.status = RunbookStatus.Published;
    this.githubUrl = githubUrl;
  }
}
