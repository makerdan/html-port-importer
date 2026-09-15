import { Router, type IRouter } from "express";
import healthRouter from "./health";
import importerRouter from "./importer";

const router: IRouter = Router();

router.use(healthRouter);
router.use(importerRouter);

export default router;
