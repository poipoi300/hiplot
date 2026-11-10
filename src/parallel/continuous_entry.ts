import { ContinuousDensityEvaluator } from "./continuous_density";
import { ContinuousKernel } from "./continuous_grid";
import type { ContinuousImage, ContinuousRequest } from "./continuous_types";

export interface ContinuousWorkerScope {
  onmessage: ((event: MessageEvent<ContinuousRequest>) => Promise<void>) | null;
  postMessage: (
    message: { id: number; image?: ContinuousImage; error?: string },
    transfer: Transferable[],
  ) => void;
}

export function connectContinuousWorker(
  scope: ContinuousWorkerScope,
  createEvaluator: () => Pick<ContinuousDensityEvaluator, "render" | "renderCooperative"> = () =>
    new ContinuousDensityEvaluator(),
): void {
  const kernel = new ContinuousKernel();
  let evaluator: ReturnType<typeof createEvaluator> | null = null;
  let generation = 0;
  scope.onmessage = async ({ data }) => {
    const current = ++generation;
    const isCurrent = (): boolean => generation === current;
    try {
      evaluator ??= createEvaluator();
      // Requests carry deltas: even a superseded frame must update retained kernel state.
      // The obsolete cooperative continuation checks its generation before touching that state.
      const update = kernel.update(data);
      const image = data.draft
        ? evaluator.render(data, update)
        : await evaluator.renderCooperative(data, update, isCurrent);
      if (!isCurrent() || image === null) return;
      scope.postMessage({ id: data.id, image }, [image.pixels.buffer]);
    } catch (error) {
      if (!isCurrent()) return;
      scope.postMessage(
        { id: data.id, error: error instanceof Error ? error.message : String(error) },
        [],
      );
    }
  };
}

connectContinuousWorker(self as unknown as ContinuousWorkerScope);
