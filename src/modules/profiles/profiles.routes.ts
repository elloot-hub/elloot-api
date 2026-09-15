import { Router } from "express";
import { withServiceTransaction } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { getPublicProfile } from "./profiles.service";

export const profilesRouter = Router();

/** Public seller/user profile page payload. */
profilesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const profile = await withServiceTransaction(async (tx) =>
      getPublicProfile(tx, id),
    );

    if (!profile) {
      throw new AppError(404, "Profile not found", "PROFILE_NOT_FOUND");
    }

    res.json(profile);
  }),
);
