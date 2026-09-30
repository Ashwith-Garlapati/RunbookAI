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
 * slackCardTs, team). Never logs secrets.
 *
 * The card service is built per event from the workspace-authorized client:
 * event-driven handlers have no per-event Bolt client, and the
 * startup-global bolt.client carries no token under Socket Mode.
 */

import type { IDomainEvent, IEventHandler } from "../domains/investigation/interfaces.js";
import type { Investigation } from "../domains/investigation/Investigation.js";
import type { InvestigationService } from "../domains/investigation/InvestigationService.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";
import { SlackIncidentCardService } from "../services/SlackIncidentCardService.js";
import type { SlackClientProvider } from "../slack/slackClientProvider.js";

export class SlackCardHandler implements IEventHandler {
  constructor(
    private readonly _clients: SlackClientProvider,
    private readonly _investigationService: InvestigationService,
  ) {}

  async handle(event: IDomainEvent): Promise<void> {
    if (event.eventType === "InvestigationResolved") {
      await this.withCard(event.investigationId, async (cardService, investigation, channelId, cardTs) => {
        await cardService.updateInvestigationCard({
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
      await this.withCard(event.investigationId, async (cardService, _, channelId, cardTs) =>
        cardService.unpinInvestigationCard(channelId, cardTs),
      );
    }
  }

  private async withCard(
    investigationId: string,
    action: (
      cardService: SlackIncidentCardService,
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

    const teamId =
      (investigation.metadata.teamId as string | undefined) ??
      (investigation.metadata.slackTeamId as string | undefined);
    if (!teamId) {
      return;
    }

    const cardService = new SlackIncidentCardService(await this._clients.forTeam(teamId));
    await action(cardService, investigation, channelId, cardTs);
  }
}
