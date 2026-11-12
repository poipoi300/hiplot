import { ContinuousDensityEvaluator } from "./continuous_density";
import { ContinuousKernel } from "./continuous_grid";
import type { ContinuousImage, ContinuousRequest } from "./continuous_types";

/** The same retained kernel and evaluator serve local and worker execution. */
export class ContinuousRuntime {
  private readonly kernel = new ContinuousKernel();
  private evaluator:
    | (Pick<ContinuousDensityEvaluator, "render" | "renderCooperative"> &
        Partial<Pick<ContinuousDensityEvaluator, "dispose">>)
    | null = null;

  constructor(
    private readonly createEvaluator: () => NonNullable<ContinuousRuntime["evaluator"]> = () =>
      new ContinuousDensityEvaluator(),
  ) {}

  render(request: ContinuousRequest): ContinuousImage {
    this.evaluator ??= this.createEvaluator();
    return this.evaluator.render(request, this.kernel.update(request));
  }

  async renderCooperative(
    request: ContinuousRequest,
    isCurrent: () => boolean,
  ): Promise<ContinuousImage | null> {
    this.evaluator ??= this.createEvaluator();
    // Every delta applies before a superseded cooperative continuation can resume.
    const update = this.kernel.update(request);
    return this.evaluator.renderCooperative(request, update, isCurrent);
  }

  dispose(): void {
    this.evaluator?.dispose?.();
  }
}
