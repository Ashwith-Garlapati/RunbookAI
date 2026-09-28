/**
 * REST API - incident coordination endpoints.
 *
 * Conventions: JSON in/out, team scoping on every route, server-side auth via
 * IncidentCoordinator (never direct DB). Identity headers (x-team-id /
 * x-user-id) are a development stand-in — production must sit behind the
 * Slack-verified gateway or workspace SSO (see header comment).
 */

import { Router, type Request, type Response } from "express";

import type { IncidentCoordinator } from "../domains/incident/IncidentCoordinator.js";
import type { Incident } from "../domains/incident/Incident.js";
import { IncidentStatus } from "../domains/incident/IncidentStatus.js";
import { parseSeverity } from "../domains/incident/IncidentSeverity.js";
import { parseRole } from "../domains/incident/IncidentRoles.js";
import { IncidentAuthorizationError } from "../domains/incident/IncidentPermissions.js";
import { newCorrelationId, logger } from "../observability/logger.js";

export interface IncidentsApiDeps {
  coordinator: IncidentCoordinator;
}

interface Authed {
  teamId: string;
  actor: string;
  correlationId: string;
}

function auth(req: Request): Authed {
  const teamId = String(req.header("x-team-id") ?? "");
  const actor = String(req.header("x-user-id") ?? "");
  if (!teamId || !actor) {
    throw Object.assign(new Error("Missing x-team-id / x-user-id"), { status: 401 });
  }
  return { teamId, actor, correlationId: newCorrelationId() };
}

function serialize(incident: Incident): Record<string, unknown> {
  return { ...incident };
}

export function createIncidentsRouter(deps: IncidentsApiDeps): Router {
  const router = Router();
  const { coordinator } = deps;

  const fail = (res: Response, error: unknown): void => {
    if (error instanceof IncidentAuthorizationError) {
      res.status(403).json({ error: "forbidden", operation: error.operation });
      return;
    }
    const withStatus = error as { status?: number; message?: string };
    if (withStatus?.status === 401) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const message = error instanceof Error ? error.message : "unknown error";
    if (/not found/i.test(message)) {
      res.status(404).json({ error: message });
      return;
    }
    if (/Invalid|required|Only |Cannot |already/i.test(message)) {
      res.status(400).json({ error: message });
      return;
    }
    logger.error("IncidentsApi", "Failed", { reason: message });
    res.status(500).json({ error: "internal error" });
  };

  router.post("/", async (req: Request, res: Response) => {
    try {
      const a = auth(req);
      const { title, description, affectedService, severity } = req.body ?? {};
      if (!title || typeof title !== "string") {
        res.status(400).json({ error: "title is required" });
        return;
      }
      const parsed = severity !== undefined ? parseSeverity(severity) : undefined;
      if (severity !== undefined && !parsed) {
        res.status(400).json({ error: "invalid severity (critical|major|minor)" });
        return;
      }
      const incident = await coordinator.declare({
        teamId: a.teamId,
        title,
        description,
        affectedService,
        ...(parsed ? { severity: parsed } : {}),
        reporterId: a.actor,
        correlationId: a.correlationId,
      });
      res.status(201).json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/", async (req: Request, res: Response) => {
    try {
      const a = auth(req);
      const incidents = await coordinator.listOpen(a.teamId);
      res.json(incidents.map((i) => serialize(i as unknown as Parameters<typeof serialize>[0])));
    } catch (error) {
      fail(res, error);
    }
  });

  const load = async (req: Request): Promise<{ a: Authed; id: string }> => {
    const a = auth(req);
    const id = String(req.params.id ?? "");
    if (!id) throw Object.assign(new Error("Missing id"), { status: 400 });
    return { a, id };
  };

  router.get("/:id", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const incident = await coordinator.get(id, a.teamId);
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/:id", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const { title } = req.body ?? {};
      if (title === undefined) {
        res.status(400).json({ error: "nothing to update (title supported)" });
        return;
      }
      const incident = await coordinator.rename({ ...a }, id, String(title));
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/status", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const status = String(req.body?.status ?? "").toLowerCase() as IncidentStatus;
      if (!Object.values(IncidentStatus).includes(status)) {
        res.status(400).json({ error: "invalid status" });
        return;
      }
      const incident = await coordinator.changeStatus({ ...a }, id, status);
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/severity", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const parsed = parseSeverity(req.body?.severity);
      if (!parsed) {
        res.status(400).json({ error: "invalid severity (critical|major|minor)" });
        return;
      }
      const incident = await coordinator.setSeverity({ ...a }, id, parsed);
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/roles", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const role = parseRole(req.body?.role);
      const assignee = String(req.body?.assignee ?? "");
      if (!role || !assignee) {
        res.status(400).json({ error: "role and assignee are required" });
        return;
      }
      const incident = await coordinator.assignRole({ ...a }, id, role, assignee);
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/:id/roles/:role", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const role = parseRole(req.params.role);
      if (!role) {
        res.status(400).json({ error: "invalid role" });
        return;
      }
      const incident = await coordinator.unassignRole({ ...a }, id, role);
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/actions", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const { title, description, assignee, priority } = req.body ?? {};
      if (!title) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      const incident = await coordinator.createAction({ ...a }, id, {
        title: String(title),
        ...(description ? { description: String(description) } : {}),
        assignee: assignee ? String(assignee) : null,
        ...(priority ? { priority: String(priority) } : {}),
      });
      res.status(201).json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/:id/actions/:actionId", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const incident = await coordinator.updateAction({ ...a }, id, String(req.params.actionId), {
        ...(req.body?.status ? { status: String(req.body.status).toUpperCase() as never } : {}),
        ...(req.body?.assignee !== undefined ? { assignee: req.body.assignee ? String(req.body.assignee) : null } : {}),
        ...(req.body?.title !== undefined ? { title: String(req.body.title) } : {}),
      });
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/follow-ups", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const { title, description, assignee } = req.body ?? {};
      if (!title) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      const incident = await coordinator.createFollowUp({ ...a }, id, {
        title: String(title),
        ...(description ? { description: String(description) } : {}),
        assignee: assignee ? String(assignee) : null,
      });
      res.status(201).json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch("/:id/follow-ups/:followUpId", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const incident = await coordinator.updateFollowUp({ ...a }, id, String(req.params.followUpId), {
        ...(req.body?.status ? { status: String(req.body.status).toUpperCase() as never } : {}),
      });
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/updates", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const { situation, changed, impact, nextStep } = req.body ?? {};
      if (!situation || !changed || !impact || !nextStep) {
        res.status(400).json({ error: "situation, changed, impact, nextStep are required" });
        return;
      }
      const incident = await coordinator.postUpdate(
        { ...a },
        id,
        { situation: String(situation), changed: String(changed), impact: String(impact), nextStep: String(nextStep) },
      );
      res.status(201).json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/:id/timeline", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const incident = await coordinator.get(id, a.teamId);
      res.json(incident.timeline);
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/:id/activity", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const incident = await coordinator.get(id, a.teamId);
      res.json(incident.activity);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/escalations", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const { toUser, reason } = req.body ?? {};
      if (!toUser || !reason) {
        res.status(400).json({ error: "toUser and reason are required" });
        return;
      }
      const incident = await coordinator.escalate({ ...a }, id, String(toUser), String(reason));
      res.status(201).json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/handover", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const { newCommander } = req.body ?? {};
      if (!newCommander) {
        res.status(400).json({ error: "newCommander is required" });
        return;
      }
      const incident = await coordinator.handover({ ...a }, id, String(newCommander));
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/message-refs", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const { channelId, messageTs, threadTs, author, text, permalink } = req.body ?? {};
      if (!channelId || !messageTs || !author) {
        res.status(400).json({ error: "channelId, messageTs, author are required" });
        return;
      }
      const incident = await coordinator.addMessageRef({ ...a }, id, {
        channelId: String(channelId),
        messageTs: String(messageTs),
        threadTs: threadTs ? String(threadTs) : null,
        author: String(author),
        text: String(text ?? ""),
        permalink: permalink ? String(permalink) : null,
      });
      res.status(201).json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/resolve", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const { summary, affectedService, mitigation } = req.body ?? {};
      if (!summary) {
        res.status(400).json({ error: "summary is required" });
        return;
      }
      const incident = await coordinator.resolve(
        { ...a },
        id,
        {
          summary: String(summary),
          ...(affectedService ? { affectedService: String(affectedService) } : {}),
          ...(mitigation ? { mitigation: String(mitigation) } : {}),
        },
      );
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/cancel", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const { reason } = req.body ?? {};
      if (!reason) {
        res.status(400).json({ error: "reason is required" });
        return;
      }
      const incident = await coordinator.cancel({ ...a }, id, String(reason));
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:id/close", async (req: Request, res: Response) => {
    try {
      const { a, id } = await load(req);
      const incident = await coordinator.close({ ...a }, id);
      res.json(serialize(incident));
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
