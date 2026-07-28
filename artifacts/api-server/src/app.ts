import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorMiddleware } from "./lib/error-middleware";
import { authProxyRouter, requireAuth } from "./lib/better-auth";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());

// Better Auth reverse proxy — mounted BEFORE the body parsers so the exact
// request bytes forward upstream (express.json() would consume them).
app.use("/api/auth", authProxyRouter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Every app API requires a valid session, except routes that can't carry a
// user bearer token: cron jobs (guarded by CRON_SECRET) and the Google OAuth
// browser redirects (protected by their own signed state).
const PUBLIC_API_PATHS = [/^\/cron\//, /^\/integrations\/gmail\/connect$/, /^\/integrations\/gmail\/callback$/];
app.use(
  "/api",
  (req: Request, res: Response, next: NextFunction) => {
    if (PUBLIC_API_PATHS.some((rx) => rx.test(req.path))) return next();
    void requireAuth(req, res, next);
  },
  router,
);
app.use(errorMiddleware);

export default app;
