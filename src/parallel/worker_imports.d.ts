declare module "*?worker&inline" {
  const InlineWorker: { new (options?: WorkerOptions): Worker };
  export default InlineWorker;
}
