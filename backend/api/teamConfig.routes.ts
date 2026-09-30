/**
 * REST API - per-workspace team configuration.
 *
 * Currently: default Incident Commander (provisional assignment at declare).
 * Auth: same header convention as incidents routes (x-team-id/x-user-id);
 * writes require owner/admin (server-side, via membership resolver).
 */

import { Router, type Request, type Response } from "express";

import InstallationModel from "../models/Installation.model.js";
import type { IMembershipResolver } from "../domains/incident/IncidentRepository.js";
import { MembershipLevel, levelAtLeast } from "../domains/incident/IncidentRoles.js";
import { newCorrelationId, logger } from "../observability/logger.js";

export interface TeamConfigApiDeps {
  membership: IMembershipResolver;
}

export function createTeamConfigRouter(deps: TeamConfigApiDeps): Router {
  const router = Router();

  router.get("/config", async (req: Request, res: Response) => {
    try {
      const teamId = String(req.header("x-team-id") ?? "");
      const userId = String(req.header("x-user-id") ?? "");
      if (!teamId || !userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const doc = await InstallationModel.findOne({ teamId }).lean();
      res.json({ teamId, defaultCommanderId: doc?.defaultCommanderId ?? doc?.defaultLeadId ?? null });
    } catch (error) {
      logger.error("TeamConfigApi", "Failed", { reason: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "internal error" });
    }
  });

  const putDefaultCommander = async (req: Request, res: Response): Promise<void> => {
    try {
      const teamId = String(req.header("x-team-id") ?? "");
      const userId = String(req.header("x-user-id") ?? "");
      if (!teamId || !userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const level = await deps.membership.resolveLevel(teamId, userId);
      if (!levelAtLeast(level, MembershipLevel.Admin)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      // Input key is unchanged ({ userId }); only the stored field is canonical.
      const { userId: nextId } = req.body ?? {};
      if (!nextId || typeof nextId !== "string") {
        res.status(400).json({ error: "userId is required" });
        return;
      }
      const doc = await InstallationModel.findOneAndUpdate(
        { teamId },
        { $set: { defaultCommanderId: nextId } },
        { new: true },
      );
      if (!doc) {
        res.status(404).json({ error: "installation not found" });
        return;
      }
      res.json({ teamId, defaultCommanderId: nextId, correlationId: newCorrelationId() });
    } catch (error) {
      logger.error("TeamConfigApi", "Failed", { reason: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "internal error" });
    }
  };
  router.put("/config/default-commander", putDefaultCommander);
  // Legacy alias (deprecated): same handler, canonical response.
  router.put("/config/default-lead", putDefaultCommander);

  return router;
}
