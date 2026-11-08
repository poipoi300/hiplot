/*
 * Middle-click autoscroll along the axes. The plot scrolls virtually (see
 * ParallelPlot.scrollLeft), so the browser's own autoscroll finds nothing to
 * scroll sideways and scrolls the page instead. This one works as browsers'
 * does, horizontally: press the middle button and move away from where it was
 * pressed to scroll, faster the further the pointer is. Releasing after moving
 * stops; releasing without moving keeps scrolling until the next click or
 * Escape.
 */

/** Pointer distance from the press, in pixels, that scrolls nothing. */
export const DEAD_ZONE_PX = 8;
/** Scroll speed per pixel of distance beyond the dead zone, in pixels per second. */
const SPEED_PER_PX = 8;

/** Scroll speed in pixels per second for a pointer `distance` pixels right of the press. */
export function autoscrollSpeed(distance: number): number {
  const beyond = Math.abs(distance) - DEAD_ZONE_PX;
  return beyond <= 0 ? 0 : Math.sign(distance) * beyond * SPEED_PER_PX;
}

export interface FrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
}

const ANIMATION_FRAMES: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

interface Session {
  originX: number;
  pointerX: number;
  /** Whether the pointer left the dead zone while the button was held. */
  moved: boolean;
  held: boolean;
  frame: number;
  lastTime: number | null;
  /** Scrolled distance not yet applied, under a pixel. */
  pending: number;
}

export class HorizontalAutoscroll {
  private session: Session | null = null;

  /**
   * @param target the element a middle press starts autoscroll on
   * @param scrollBy scrolls the axes by a number of pixels
   * @param canScroll whether the axes are wider than the plot
   * @param onActiveChange told when autoscroll starts and stops, to show its cursor
   */
  constructor(
    private readonly target: HTMLElement,
    private readonly scrollBy: (pixels: number) => void,
    private readonly canScroll: () => boolean,
    private readonly onActiveChange: (active: boolean) => void,
    private readonly frames: FrameScheduler = ANIMATION_FRAMES,
  ) {
    target.addEventListener("mousedown", this.onTargetMouseDown);
  }

  get active(): boolean {
    return this.session !== null;
  }

  dispose(): void {
    this.stop();
    this.target.removeEventListener("mousedown", this.onTargetMouseDown);
  }

  private onTargetMouseDown = (event: MouseEvent): void => {
    if (event.button !== 1 || this.session !== null || !this.canScroll()) {
      return;
    }
    // Keeps the browser's autoscroll, which would scroll the page, from starting.
    event.preventDefault();
    this.session = {
      originX: event.clientX,
      pointerX: event.clientX,
      moved: false,
      held: true,
      frame: this.frames.request(this.step),
      lastTime: null,
      pending: 0,
    };
    const owner = this.target.ownerDocument;
    owner.addEventListener("mousemove", this.onMouseMove);
    owner.addEventListener("mouseup", this.onMouseUp);
    // Capture: the click that ends autoscroll does nothing else.
    owner.addEventListener("mousedown", this.onDocumentMouseDown, true);
    owner.addEventListener("keydown", this.onKeyDown);
    owner.defaultView?.addEventListener("blur", this.stop);
    this.onActiveChange(true);
  };

  private onMouseMove = (event: MouseEvent): void => {
    const session = mustHave(this.session);
    session.pointerX = event.clientX;
    if (session.held && Math.abs(session.pointerX - session.originX) > DEAD_ZONE_PX) {
      session.moved = true;
    }
  };

  private onMouseUp = (event: MouseEvent): void => {
    const session = mustHave(this.session);
    if (event.button !== 1 || !session.held) {
      return;
    }
    session.held = false;
    if (session.moved) {
      this.stop();
    }
  };

  private onDocumentMouseDown = (event: MouseEvent): void => {
    if (mustHave(this.session).held) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.stop();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.stop();
    }
  };

  private step = (time: number): void => {
    const session = mustHave(this.session);
    if (session.lastTime !== null) {
      const seconds = (time - session.lastTime) / 1000;
      // Scroll offsets are whole pixels: the fraction carries to the next frame.
      session.pending += autoscrollSpeed(session.pointerX - session.originX) * seconds;
      const pixels = Math.trunc(session.pending);
      if (pixels !== 0) {
        session.pending -= pixels;
        this.scrollBy(pixels);
      }
    }
    session.lastTime = time;
    session.frame = this.frames.request(this.step);
  };

  private stop = (): void => {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.session = null;
    this.frames.cancel(session.frame);
    const owner = this.target.ownerDocument;
    owner.removeEventListener("mousemove", this.onMouseMove);
    owner.removeEventListener("mouseup", this.onMouseUp);
    owner.removeEventListener("mousedown", this.onDocumentMouseDown, true);
    owner.removeEventListener("keydown", this.onKeyDown);
    owner.defaultView?.removeEventListener("blur", this.stop);
    this.onActiveChange(false);
  };
}

/** Listeners are only attached during a session, so one always exists when they run. */
function mustHave(session: Session | null): Session {
  if (session === null) {
    throw new Error("Autoscroll listener ran without a session");
  }
  return session;
}
