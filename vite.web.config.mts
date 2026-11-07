import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import postcss from "postcss";
import prefixSelector from "postcss-prefix-selector";
import { defineConfig, type Plugin } from "vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import istanbul from "vite-plugin-istanbul";

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
  const packageName = process.env.HIPLOT_PACKAGE ?? "hiplot";
  return `bundle-${packageName}-${version}${isDebug ? "-dbg" : ""}`;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(src: string, dest: string) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyWebBundlesPlugin(entryName: string) {
  return {
    name: "copy-hiplot-web-bundles",
    writeBundle() {
      const distPath = path.resolve(__dirname, "npm-dist");
      const pyBuilt = path.resolve(__dirname, "hiplot", "static", "built");
      const installToFolders = [
        path.resolve(pyBuilt, ""),
        path.resolve(distPath, "streamlit_component"),
      ];

      if (entryName === "hiplot") {
        installToFolders.forEach((sc) => {
          copyFile(
            path.resolve(distPath, "hiplot.bundle.js"),
            path.resolve(sc, "hiplot.bundle.js"),
          );
        });
      }

      if (entryName === "hiplot_streamlit") {
        installToFolders.forEach((sc) => {
          copyFile(
            path.resolve(distPath, "hiplot_streamlit.bundle.js"),
            path.resolve(sc, "streamlit_component", "hiplot_streamlit.bundle.js"),
          );
          copyFile(
            path.resolve(__dirname, "src", "index_streamlit.html"),
            path.resolve(sc, "streamlit_component", "index.html"),
          );
        });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDebug = mode === "development";
  const collectCoverage = process.env.HIPLOT_COVERAGE === "1";
  const entryName = process.env.HIPLOT_WEB_NAME ?? "hiplot";
  const entryPath =
    process.env.HIPLOT_WEB_ENTRY ?? path.resolve(__dirname, "src", "hiplot_web.tsx");
  return {
    plugins: [
      scopeVendorCssVitePlugin(),
      react(),
      cssInjectedByJsPlugin(),
      copyWebBundlesPlugin(entryName),
      // tools/e2e_coverage.sh builds an instrumented bundle for the Playwright suite.
      ...(collectCoverage
        ? [
            istanbul({
              include: ["src/**/*.ts", "src/**/*.tsx"],
              exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
              extension: [".ts", ".tsx"],
              forceBuildInstrument: true,
              requireEnv: false,
            }),
          ]
        : []),
    ],
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
      target: "es2020",
      chunkSizeWarningLimit: 2000,
      // Fonts are inlined so the bundle, and pages embedding it, work offline.
      assetsInlineLimit: (file: string) => (file.endsWith(".woff2") ? true : undefined),
      rollupOptions: {
        input: entryPath,
        output: {
          format: "iife",
          name: "hiplot",
          entryFileNames: `${entryName}.bundle.js`,
          inlineDynamicImports: true,
        },
      },
    },
    css: {
      modules: {
        generateScopedName: isDebug ? "[local]_[hash:base64:5]" : "[hash:base64:5]",
      },
      postcss: {
        plugins: [
          // Keep rem-to-px conversion (previously applied to global CSS only).
          remToPxPlugin({
            propList: ["font", "font-size", "line-height", "letter-spacing", "padding*", "border*"],
          }),
        ],
      },
    },
  };
});
