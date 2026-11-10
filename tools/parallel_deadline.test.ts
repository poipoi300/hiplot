import { expect, mock, spyOn, test } from "bun:test";
import { withDeadline } from "../bench/deadline";

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
