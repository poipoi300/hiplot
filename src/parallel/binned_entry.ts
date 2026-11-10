import { BinnedKernel, type BinnedRequest } from "./binned";

const kernel = new BinnedKernel();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<BinnedRequest>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};
scope.onmessage = ({ data }) => {
  try {
    const image = kernel.render(data);
    scope.postMessage({ id: data.id, image }, [image.pixels.buffer]);
  } catch (error) {
    scope.postMessage(
      { id: data.id, error: error instanceof Error ? error.message : String(error) },
      [],
    );
  }
};
