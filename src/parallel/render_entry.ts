import { connectRenderWorker, type RenderWorkerScope } from "./render_runtime";

connectRenderWorker(self as unknown as RenderWorkerScope);
