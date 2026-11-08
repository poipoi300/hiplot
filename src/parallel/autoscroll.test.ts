import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  autoscrollSpeed,
  DEAD_ZONE_PX,
  type FrameScheduler,
  HorizontalAutoscroll,
} from "./autoscroll";

/** Frames run only when the test advances time. */
class ManualFrames implements FrameScheduler {
  private callbacks = new Map<number, (time: number) => void>();
  private next = 1;
  request(callback: (time: number) => void): number {
    this.callbacks.set(this.next, callback);
    return this.next++;
  }
  cancel(handle: number): void {
    this.callbacks.delete(handle);
  }
  run(time: number): void {
    const due = Array.from(this.callbacks.values());
    this.callbacks.clear();
    for (const callback of due) {
      callback(time);
    }
  }
  get pending(): number {
    return this.callbacks.size;
  }
}

function mouse(type: string, button: number, clientX: number): MouseEvent {
  return new MouseEvent(type, { button, clientX, bubbles: true, cancelable: true });
}

let target: HTMLElement;
let frames: ManualFrames;
let scrolled: number;
let activity: boolean[];
let scrollable: boolean;
let autoscroll: HorizontalAutoscroll;

beforeEach(() => {
  document.body.innerHTML = "";
  target = document.createElement("div");
  document.body.append(target);
  frames = new ManualFrames();
  scrolled = 0;
  activity = [];
  scrollable = true;
  autoscroll = new HorizontalAutoscroll(
    target,
    (pixels) => {
      scrolled += pixels;
    },
    () => scrollable,
    (active) => activity.push(active),
    frames,
  );
});

afterEach(() => {
  autoscroll.dispose();
});

let clock = 0;
/** Runs frames 100 ms apart. */
function runFrames(count: number): void {
  for (let i = 0; i < count; ++i) {
    clock += 100;
    frames.run(clock);
  }
}

describe("middle-click autoscroll speed", () => {
  test("nothing within the dead zone, then faster with distance, signed by side", () => {
    expect(autoscrollSpeed(DEAD_ZONE_PX)).toBe(0);
    expect(autoscrollSpeed(-DEAD_ZONE_PX)).toBe(0);
    expect(autoscrollSpeed(DEAD_ZONE_PX + 10)).toBeGreaterThan(0);
    expect(autoscrollSpeed(DEAD_ZONE_PX + 20)).toBe(2 * autoscrollSpeed(DEAD_ZONE_PX + 10));
    expect(autoscrollSpeed(-DEAD_ZONE_PX - 10)).toBe(-autoscrollSpeed(DEAD_ZONE_PX + 10));
  });
});

describe("middle-click autoscroll", () => {
  test("a middle press starts it and keeps the browser autoscroll from starting", () => {
    const press = mouse("mousedown", 1, 100);
    target.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(autoscroll.active).toBe(true);
    expect(activity).toEqual([true]);
  });

  test("other buttons, or axes that fit the plot, start nothing", () => {
    target.dispatchEvent(mouse("mousedown", 0, 100));
    expect(autoscroll.active).toBe(false);
    scrollable = false;
    const press = mouse("mousedown", 1, 100);
    target.dispatchEvent(press);
    expect(autoscroll.active).toBe(false);
    expect(press.defaultPrevented).toBe(false);
  });

  test("scrolls toward the pointer side, by whole pixels, at the speed for its distance", () => {
    target.dispatchEvent(mouse("mousedown", 1, 100));
    document.dispatchEvent(mouse("mousemove", 1, 100 + DEAD_ZONE_PX + 10));
    runFrames(11);
    expect(scrolled).toBe(Math.trunc(autoscrollSpeed(DEAD_ZONE_PX + 10)));
    document.dispatchEvent(mouse("mousemove", 1, 100 - DEAD_ZONE_PX - 10));
    scrolled = 0;
    runFrames(11);
    expect(scrolled).toBeLessThan(0);
  });

  test("releasing after moving out of the dead zone stops", () => {
    target.dispatchEvent(mouse("mousedown", 1, 100));
    document.dispatchEvent(mouse("mousemove", 1, 140));
    document.dispatchEvent(mouse("mouseup", 1, 140));
    expect(autoscroll.active).toBe(false);
    expect(frames.pending).toBe(0);
    expect(activity).toEqual([true, false]);
  });

  test("releasing without moving keeps scrolling until the next click, which does nothing else", () => {
    target.dispatchEvent(mouse("mousedown", 1, 100));
    document.dispatchEvent(mouse("mouseup", 1, 100));
    document.dispatchEvent(mouse("mouseup", 0, 100));
    expect(autoscroll.active).toBe(true);
    document.dispatchEvent(mouse("mousemove", 1, 200));
    runFrames(3);
    expect(scrolled).toBeGreaterThan(0);
    let reachedTarget = false;
    target.addEventListener("mousedown", () => {
      reachedTarget = true;
    });
    const click = mouse("mousedown", 0, 200);
    target.dispatchEvent(click);
    expect(autoscroll.active).toBe(false);
    expect(click.defaultPrevented).toBe(true);
    expect(reachedTarget).toBe(false);
  });

  test("a press while the button is held starts no second session", () => {
    target.dispatchEvent(mouse("mousedown", 1, 100));
    target.dispatchEvent(mouse("mousedown", 0, 100));
    expect(autoscroll.active).toBe(true);
    expect(activity).toEqual([true]);
  });

  test("Escape, leaving the window and disposing all stop it", () => {
    target.dispatchEvent(mouse("mousedown", 1, 100));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(autoscroll.active).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(autoscroll.active).toBe(false);

    target.dispatchEvent(mouse("mousedown", 1, 100));
    window.dispatchEvent(new Event("blur"));
    expect(autoscroll.active).toBe(false);

    target.dispatchEvent(mouse("mousedown", 1, 100));
    autoscroll.dispose();
    expect(autoscroll.active).toBe(false);
    target.dispatchEvent(mouse("mousedown", 1, 100));
    expect(autoscroll.active).toBe(false);
  });
});
