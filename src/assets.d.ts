// Vite resolves imported SVG files to their URL.
declare module "*.svg" {
  const url: string;
  export default url;
}
