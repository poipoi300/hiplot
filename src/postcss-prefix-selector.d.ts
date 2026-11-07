// postcss-prefix-selector ships no type declarations (nor does DefinitelyTyped);
// this mirrors the options documented in its README and JSDoc.
declare module "postcss-prefix-selector" {
  import type { PluginCreator, Rule } from "postcss";

  interface PrefixSelectorOptions {
    prefix: string;
    exclude?: Array<string | RegExp>;
    ignoreFiles?: Array<string | RegExp>;
    includeFiles?: Array<string | RegExp>;
    skipGlobalSelectors?: boolean;
    transform?: (
      prefix: string,
      selector: string,
      prefixedSelector: string,
      filePath: string | undefined,
      rule: Rule,
    ) => string;
  }

  const prefixSelector: PluginCreator<PrefixSelectorOptions>;
  export default prefixSelector;
}
