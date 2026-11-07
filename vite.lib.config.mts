import path from "node:path";
import react from "@vitejs/plugin-react";
import postcss from "postcss";
import prefixSelector from "postcss-prefix-selector";
import { defineConfig, type Plugin } from "vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

// Vite plugin that scopes vendor CSS (Bootstrap, DataTables) under hiplot theme classes
// so styles don't leak into parent applications
function scopeVendorCssVitePlugin(): Plugin {
  const vendorPatterns = [/node_modules[/\\]bootstrap/, /node_modules[/\\]datatables\.net/];

  const processor = postcss([
    prefixSelector({
      prefix: ":is(.hip_thm--dark, .hip_thm--light)",
      transform: (prefix, selector, prefixedSelector) => {
        // Replace root-level selectors with our theme prefix
        if (selector === ":root" || selector === "html" || selector === "body") {
          return prefix;
        }
        // Handle universal selector - scope it
        if (selector === "*" || selector.startsWith("*,") || selector.startsWith("*, ")) {
          return selector.replace(/^\*/, `${prefix} *`);
        }
        return prefixedSelector;
      },
    }),
  ]);

  return {
    name: "scope-vendor-css",
    async transform(code, id) {
      // Only process CSS files from vendor packages
      if (!id.endsWith(".css") || !vendorPatterns.some((p) => p.test(id))) {
        return null;
      }
      const result = await processor.process(code, { from: id });
      return { code: result.css, map: result.map?.toString() };
    },
  };
}

type RemToPxOptions = {
  propList: string[];
  rootValue?: number;
};

function remToPxPlugin(options: RemToPxOptions) {
  const rootValue = options.rootValue ?? 16;
  const propList = options.propList;
  const matchesProp = (prop: string) =>
    propList.some((pattern) =>
      pattern.endsWith("*") ? prop.startsWith(pattern.slice(0, -1)) : prop === pattern,
    );
  const remRegex = /(-?\d*\.?\d+)rem\b/g;
  return {
    postcssPlugin: "rem-to-px",
    Declaration(decl: { prop: string; value: string }) {
      if (!matchesProp(decl.prop) || !decl.value.includes("rem")) {
        return;
      }
      decl.value = decl.value.replace(remRegex, (_match, num) => {
        const px = parseFloat(num) * rootValue;
        return `${Number.isNaN(px) ? num : px}px`;
      });
    },
  };
}
remToPxPlugin.postcss = true;

function packageNameFull(isDebug: boolean): string {
  const version = process.env.HIPLOT_VERSION ?? "0.0.0";
  return `lib-hiplot-${version}${isDebug ? "-dbg" : ""}`;
}

export default defineConfig(({ mode }) => {
  const isDebug = mode === "development";
  return {
    plugins: [scopeVendorCssVitePlugin(), react(), cssInjectedByJsPlugin()],
    resolve: {
      dedupe: ["jquery"],
    },
    define: {
      HIPLOT_PACKAGE_NAME_FULL: JSON.stringify(packageNameFull(isDebug)),
      define: "undefined",
    },
    build: {
      outDir: "npm-dist",
      emptyOutDir: false,
      sourcemap: true,
      target: "es2017",
      chunkSizeWarningLimit: 2000,
      lib: {
        entry: path.resolve(__dirname, "src", "hiplot.tsx"),
        name: "hiplot",
        formats: ["umd"],
        fileName: () => "hiplot.lib.js",
      },
      rollupOptions: {
        external: ["react"],
        output: {
          globals: {
            react: "React",
          },
        },
      },
    },
    css: {
      modules: {
        generateScopedName: isDebug ? "[local]_[hash:base64:5]" : "[hash:base64:5]",
      },
      postcss: {
        plugins: [
          remToPxPlugin({
            propList: ["font", "font-size", "line-height", "letter-spacing", "padding*", "border*"],
          }),
        ],
      },
    },
  };
});
