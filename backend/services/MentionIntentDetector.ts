/**
 * Mention Intent Detector
 *
 * Classifies the text of a @RunbookAI mention into one of:
 *   - investigate : create a new investigation (or reuse an active one)
 *   - question    : answer using current thread / linked investigation context
 *   - resolve     : mark the linked investigation as resolved (explicit only)
 *   - reopen      : reopen a resolved investigation (explicit only)
 *   - help        : show supported commands
 *   - unknown     : cannot be classified (never mutates anything)
 *
 * Detection is deterministic and classifies by INTENT / phrase meaning, not
 * raw keyword matching. The critical rule: anything phrased as a QUESTION is
 * ALWAYS read-only. "is it resolved yet?" is a question - it never resolves.
 *
 * Classification order (first match wins):
 *   1. help        - explicit help requests (checked before questions so that
 *                    "how do I use this" / "what can you do?" stay help)
 *   2. question    - interrogative sentences + information-request phrases
 *   3. resolve     - explicit imperatives (resolve / mark resolved / close)
 *   4. reopen      - explicit imperatives (reopen / unresolve)
 *   5. investigate - explicit imperatives (investigate / start investigation)
 *   6. unknown     - everything else (clarification is asked, nothing mutated)
 *
 * No AI call is made at classification time.
 */

export enum MentionIntent {
  Investigate = "investigate",
  Question = "question",
  Resolve = "resolve",
  Reopen = "reopen",
  Help = "help",
  Unknown = "unknown",
}

export interface MentionIntentResult {
  readonly intent: MentionIntent;
}

const HELP_PATTERNS: RegExp[] = [
  /\bhelp\b/i,
  /what can you do/i,
  /how (do|does).*(use|work)/i,
  /show (me )?(the )?commands/i,
];

/**
 * Questions are read-only. Matched BEFORE resolve/reopen/investigate so that
 * "is it resolved yet?" can never resolve anything.
 */
const QUESTION_PATTERNS: RegExp[] = [
  // Interrogative openings: yes/no and wh- questions
  /^(is|are|was|were|did|does|do|has|have|can|could|will|would|should|what|who|when|where|why|how)\b/i,
  // Explicit question mark
  /\?/,
  // Information-request phrases (summarize / brief / status / ...)
  /\b(summarize|summary|recap|overview|brief)\b/i,
  /\b(give me|tell me|show me)\b/i,
  /\b(status|progress|update|going on|happening)\b/i,
  /\bwhat happened\b/i,
  /\bwhat caused\b/i,
  /\bwhat changed\b/i,
  /\b(explain|describe)\b/i,
];

/**
 * Resolve is an EXPLICIT command only. Passive statements like "is it
 * resolved?" are caught by QUESTION_PATTERNS before these rules run.
 */
const RESOLVE_PATTERNS: RegExp[] = [
  /\b(resolve|resolving) (this|it|the|that)\b/i,
  /\bmark (this|it|the|that) (as )?resolved\b/i,
  /\bclose (this|the) (investigation|incident)\b/i,
  // Bare statement of fact: "the investigation resolved" - the user is
  // declaring it resolved, which is an explicit resolve command, NOT a
  // question. Interrogative forms ("is the incident resolved?") never
  // reach these rules.
  /\b(investigation|incident) resolved\b/i,
];

const REOPEN_PATTERNS: RegExp[] = [
  /\breopen(ed|ing)?\b/i,
  /\bunresolve\b/i,
  /\bmark (this|it|the|that) unresolved\b/i,
];

const INVESTIGATE_PATTERNS: RegExp[] = [
  /\binvestigat(e|ing)\b/i,
  /\b(start|open|create|begin|launch) (an? |a |the )?(new )?(incident |issue )?(investigation|dig)\b/i,
  /\bstart investigating\b/i,
];

export class MentionIntentDetector {
  /**
   * Classifies mention text into an intent using deterministic rules.
   *
   * @param text - the mention text with the @RunbookAI mention removed
   */
  detect(text: string): MentionIntentResult {
    const normalized = text.trim();

    // Empty / whitespace-only / pure-mention text is not a command at all.
    if (normalized.length === 0) {
      return { intent: MentionIntent.Unknown };
    }

    // Punctuation-only or symbol-only text carries no intent.
    if (!/[a-zA-Z0-9]/.test(normalized)) {
      return { intent: MentionIntent.Unknown };
    }

    if (this.matchesAny(normalized, HELP_PATTERNS)) {
      return { intent: MentionIntent.Help };
    }

    // Questions are ALWAYS read-only: resolve/reopen/investigate may never
    // trigger from a question.
    if (this.matchesAny(normalized, QUESTION_PATTERNS)) {
      return { intent: MentionIntent.Question };
    }

    // Explicit commands only:
    if (this.matchesAny(normalized, RESOLVE_PATTERNS)) {
      return { intent: MentionIntent.Resolve };
    }

    if (this.matchesAny(normalized, REOPEN_PATTERNS)) {
      return { intent: MentionIntent.Reopen };
    }

    if (this.matchesAny(normalized, INVESTIGATE_PATTERNS)) {
      return { intent: MentionIntent.Investigate };
    }

    // Nothing matched - the request is ambiguous. Return Unknown so the
    // caller can ask for clarification WITHOUT mutating anything.
    return { intent: MentionIntent.Unknown };
  }

  private matchesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(text));
  }
}
