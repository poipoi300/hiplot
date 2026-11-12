import { ContinuousDensityEvaluator } from "./continuous_density";
import { ContinuousRuntime } from "./continuous_runtime";
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
  const runtime = new ContinuousRuntime(createEvaluator);
  let generation = 0;
  scope.onmessage = async ({ data }) => {
    const current = ++generation;
    const isCurrent = (): boolean => generation === current;
    try {
      // Requests carry deltas: even a superseded frame must update retained kernel state.
      // The obsolete cooperative continuation checks its generation before touching that state.
      const image = data.draft
        ? runtime.render(data)
        : await runtime.renderCooperative(data, isCurrent);
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
