import { type BrushWorkerScope, connectBrushWorker } from "./brush_runtime";

connectBrushWorker(self as unknown as BrushWorkerScope);
