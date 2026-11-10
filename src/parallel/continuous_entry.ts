import { ContinuousDensityEvaluator } from "./continuous_density";
import { ContinuousKernel } from "./continuous_grid";
import type { ContinuousRequest } from "./continuous_types";

const kernel = new ContinuousKernel();
let evaluator: ContinuousDensityEvaluator | null = null;
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ContinuousRequest>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};
scope.onmessage = ({ data }) => {
  try {
    evaluator ??= new ContinuousDensityEvaluator();
    const update = kernel.update(data);
    const image = evaluator.render(data, update);
    scope.postMessage({ id: data.id, image }, [image.pixels.buffer]);
  } catch (error) {
    scope.postMessage(
      { id: data.id, error: error instanceof Error ? error.message : String(error) },
      [],
    );
  }
};
