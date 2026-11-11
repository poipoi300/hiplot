import { expect, mock, spyOn, test } from "bun:test";
import type { Page } from "@playwright/test";
import { createBenchmarkAbort, withDeadline } from "../bench/deadline";

for (const failure of ["none", "attach", "interrupt", "close"] as const) {
  test(`attempt interruption owns shutdown (${failure})`, async () => {
    const events: string[] = [];
    const page = {
      context: () => ({
        newCDPSession: async () => {
          events.push("attach");
          if (failure === "attach") throw new Error("attach failed");
          return {
            send: async (command: string) => {
              events.push(command);
              if (failure === "interrupt") throw new Error("interrupt failed");
            },
          };
        },
        close: async () => {
          events.push("close");
          if (failure === "close") throw new Error("close failed");
        },
      }),
    } as unknown as Page;
    const killBrowser = async () => {
      await Bun.sleep(1);
      events.push("kill");
    };
    const result = createBenchmarkAbort(page, killBrowser).then(async (abort) => {
      expect(events).toEqual(["attach"]);
      await abort();
    });
    if (failure === "none") await result;
    else await expect(result).rejects.toThrow(`${failure} failed`);
    expect(events).toEqual(
      failure === "attach"
        ? ["attach", "kill"]
        : [
            "attach",
            "Runtime.terminateExecution",
            "close",
            ...(failure === "none" ? [] : ["kill"]),
          ],
    );
  });
}

for (const stalled of ["attach", "interrupt", "close"] as const) {
  test(`a pending ${stalled} escalates to awaited browser termination`, async () => {
    const pending = () => new Promise<never>(() => {});
    const killBrowser = mock(async () => {
      await Bun.sleep(5);
    });
    const page = {
      context: () => ({
        newCDPSession: async () => {
          if (stalled === "attach") return pending();
          return { send: async () => (stalled === "interrupt" ? pending() : undefined) };
        },
        close: async () => (stalled === "close" ? pending() : undefined),
      }),
    } as unknown as Page;
    const result = createBenchmarkAbort(page, killBrowser).then((abort) => abort());
    const outcome = await Promise.race([
      result.then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(1500).then(() => "still pending"),
    ]);
    expect(outcome).toBe("rejected");
    expect(killBrowser).toHaveBeenCalledTimes(1);
  });
}

test("completed and failed work clears its deadline without closing the context", async () => {
  const abort = mock(async () => {});
  expect(
    await withDeadline(
      async () => 42,
      100,
      () => "load",
      abort,
    ),
  ).toBe(42);
  await expect(
    withDeadline(
      async () => {
        throw new Error("load failed");
      },
      100,
      () => "load",
      abort,
    ),
  ).rejects.toThrow("load failed");
  expect(abort).not.toHaveBeenCalled();
});

test("a stalled evaluation reports the last stage and closes its owned context", async () => {
  const abort = mock(async () => {});
  await expect(
    withDeadline(
      () => new Promise<never>(() => {}),
      5,
      () => "load: inference",
      abort,
    ),
  ).rejects.toThrow("load: inference exceeded 5 ms");
  expect(abort).toHaveBeenCalledTimes(1);
});

test("a deadline waits for owned shutdown before returning control to cleanup", async () => {
  let closed = false;
  await expect(
    withDeadline(
      () => new Promise<never>(() => {}),
      5,
      () => "load",
      async () => {
        await Bun.sleep(5);
        closed = true;
      },
    ),
  ).rejects.toThrow("load exceeded 5 ms");
  expect(closed).toBe(true);
});

test("a cleanup failure remains visible rather than replacing the deadline", async () => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(
      withDeadline(
        () => new Promise<never>(() => {}),
        5,
        () => "load",
        async () => {
          throw new Error("closed pipe");
        },
      ),
    ).rejects.toThrow("load exceeded 5 ms");
    await Promise.resolve();
    expect(stderr).toHaveBeenCalledWith("Benchmark context cleanup failed: Error: closed pipe\n");
  } finally {
    stderr.mockRestore();
  }
});
