import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import { apiRouter } from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { apiGeneralLimiter } from "./middleware/rate-limit";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // Behind reverse proxy (Square Cloud, nginx, Cloudflare). Hops from TRUST_PROXY.
  // Wrong value breaks rate-limit (clients can spoof X-Forwarded-For).
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        const allowed = [
          ...env.CORS_ORIGIN.split(",").map((o) => o.trim()),
          ...env.ADMIN_CORS_ORIGIN.split(",").map((o) => o.trim()),
        ].filter(Boolean);
        if (!origin || allowed.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use("/api", apiGeneralLimiter);

  app.get("/", (_req, res) => {
    res.json({
      name: "elloot-api",
      version: "0.1.0",
      docs: "/api/health",
    });
  });

  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
