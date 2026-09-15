import express, { type ErrorRequestHandler, type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { importerAccess } from "./middlewares/importerAccess";

const app: Express = express();
app.set("trust proxy", 1);

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
app.use("/api/importer", importerAccess);
app.use(express.json({ limit: "16mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const problem = error as { status?: number; type?: string };
  if (problem.type === "entity.parse.failed") {
    res.status(400).json({ status: "Failed", message: "Request body is not valid JSON." });
    return;
  }
  if (problem.type === "entity.too.large" || problem.status === 413) {
    res.status(413).json({ status: "Failed", message: "Request body exceeds the size limit." });
    return;
  }
  logger.error({ err: error }, "Unhandled API error");
  res.status(500).json({ status: "Failed", message: "Internal server error." });
};

app.use(jsonErrorHandler);

export default app;
