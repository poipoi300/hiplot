import { connectExactWorker, type ExactWorkerScope } from "./exact_runtime";

connectExactWorker(self as unknown as ExactWorkerScope);
