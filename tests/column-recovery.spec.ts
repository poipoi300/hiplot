import type { Page } from "@playwright/test";
import type { HiPlot } from "../src/component";
import { Experiment, type HiPlotExperiment, ParamType } from "../src/types";
import { expect, test } from "./fixtures";

interface HiPlotWindow {
  hiplot_last_instance: HiPlot;
}

async function loadExperiment(page: Page, experiment: HiPlotExperiment, query = ""): Promise<void> {
  await page.route("**/data?uri=column-recovery", (route) =>
    route.fulfill({ json: { experiment } }),
  );
  await page.goto(`/${query}`);
  const input = page.getByPlaceholder("Experiments to load");
  await input.fill("column-recovery");
  await input.press("Enter");
  await expect(page.locator("svg g.dimension").first()).toBeAttached();
}

for (const source of ["inferred", "hint", "saved"] as const) {
  test(`${source} numeric columns without finite values warn while plots and table render`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const experiment = Experiment.from_iterable(
      Array.from({ length: 30 }, (_, index) => ({
        score: index,
        learning_rate: index / 100 + 0.01,
        load_checkpoint: [null, "None", "NA"][index % 3],
      })),
    );
    if (source === "hint") {
      experiment.parameters_definition = {
        load_checkpoint: {
          type: ParamType.NUMERIC,
          colors: null,
          colormap: null,
          force_value_min: null,
          force_value_max: null,
          label_css: null,
          label_html: null,
        },
      };
    }
    experiment.colorby = "load_checkpoint";
    experiment.display_data = { XY: { axis_x: "load_checkpoint", axis_y: "score" } };
    const query = source === "saved" ? '?hip.params.load_checkpoint.type="numeric"' : "";
    await loadExperiment(page, experiment, query);
    await expect(page.getByTestId("toast")).toHaveCount(1);
    await expect(page.getByTestId("toast")).toContainText('Column "load_checkpoint"');
    await expect(page.getByTestId("toast")).toContainText("no finite numeric values");
    await expect(page.locator(".pplot-label[data-dimension='score']")).toBeAttached();
    await expect(page.locator(".pplot-label[data-dimension='learning_rate']")).toBeAttached();
    await expect(page.getByRole("img", { name: /XY scatter plot/ })).toBeAttached();
    await expect(page.locator("table tbody tr")).not.toHaveCount(0);
    await expect(page.getByText(/display could not be drawn/)).toHaveCount(0);
    await expect(page.getByTestId("toast")).not.toContainText("was restored");
    expect(errors).toEqual([]);
  });
}

for (const source of ["interactive", "saved"] as const) {
  test(`${source} filtering to missing values warns and restoring rows recovers the numeric scale`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await loadExperiment(
      page,
      Experiment.from_iterable(
        Array.from({ length: 30 }, (_, index) => ({
          score: index,
          sparse: index < 5 ? null : index,
        })),
      ),
      source === "saved"
        ? `?hip.filters=${encodeURIComponent(JSON.stringify([{ type: "Range", data: { col: "score", type: "numeric", min: 0, max: 4 } }]))}`
        : "",
    );
    if (source === "interactive") {
      await page.evaluate(() => {
        const instance = (window as unknown as HiPlotWindow).hiplot_last_instance;
        instance.setSelected(
          instance.state.rows_filtered.filter((row) => row.sparse === null),
          null,
        );
      });
      await page.evaluate(() =>
        (window as unknown as HiPlotWindow).hiplot_last_instance.filterRows(true),
      );
    }
    await expect(page.getByTestId("toast")).toContainText('Column "sparse"');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as HiPlotWindow).hiplot_last_instance.state.params_def.sparse.type,
        ),
      )
      .toBe("categorical");
    await page.evaluate(() =>
      (window as unknown as HiPlotWindow).hiplot_last_instance.restoreAllRows(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as HiPlotWindow).hiplot_last_instance.state.params_def.sparse.type,
        ),
      )
      .toBe("numeric");
    await expect(page.locator(".pplot-label[data-dimension='sparse']")).toBeAttached();
    await expect(page.getByText(/display could not be drawn/)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
