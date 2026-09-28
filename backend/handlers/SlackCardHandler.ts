/**
 * Slack Card Handler
 *
 * Drives the incident card lifecycle from domain events:
 *
 *   InvestigationResolved → update the card to Resolved
 *   RunbookAttached       → unpin the card (runbook generated after resolution)
 *
 * The card lifecycle is event-driven, NOT trigger-driven:
 *   - Slash-created investigations never get a card (no slackCardTs metadata).
 *   - The card is never posted, pinned, or unpinned from the trigger path.
 *
 * Only reads metadata already stored on the investigation (slackChannelId,
 * slackCardTs). Never logs secrets.
 */

import type { IDomainEvent, IEventHandler } from "../domains/investigation/interfaces.js";
import type { Investigation } from "../domains/investigation/Investigation.js";
import type { InvestigationService } from "../domains/investigation/InvestigationService.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";
import type { SlackIncidentCardService } from "../services/SlackIncidentCardService.js";

export class SlackCardHandler implements IEventHandler {
  constructor(
    private readonly _cardService: SlackIncidentCardService,
    private readonly _investigationService: InvestigationService,
  ) {}

  async handle(event: IDomainEvent): Promise<void> {
    if (event.eventType === "InvestigationResolved") {
      await this.withCard(event.investigationId, async (investigation, channelId, cardTs) => {
        await this._cardService.updateInvestigationCard({
          channelId,
          timestamp: cardTs,
          title: investigation.title,
          investigationId: investigation.id,
          status: InvestigationStatus.Resolved,
        });
      });
      return;
    }

    if (event.eventType === "RunbookAttached") {
      await this.withCard(event.investigationId, (_, channelId, cardTs) =>
        this._cardService.unpinInvestigationCard(channelId, cardTs),
      );
    }
  }

  private async withCard(
    investigationId: string,
    action: (
      investigation: Investigation,
      channelId: string,
      cardTs: string,
    ) => Promise<void>,
  ): Promise<void> {
    const investigation = await this._investigationService.getInvestigation(investigationId);
    const channelId = investigation.metadata.slackChannelId as string | undefined;
    const cardTs = investigation.metadata.slackCardTs as string | undefined;

    // Investigations created via the slash command have no card - nothing to do.
    if (!channelId || !cardTs) {
      return;
    }

    await action(investigation, channelId, cardTs);
  }
}
