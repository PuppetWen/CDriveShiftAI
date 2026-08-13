const scalableLength = /(-?(?:\d+\.?\d*|\.\d+))(px|vw)\b/g;

function scaleLengths(value: string): string {
  return value.replace(
    scalableLength,
    (_match, amount, unit) => `calc(${amount}${unit} * var(--text-scale, 1))`
  );
}

export function transformTextScaleCss(css: string): string {
  return css
    .replace(/(font-size\s*:\s*)([^;{}]+)(;)/gi, (_match, prefix, value, suffix) =>
      `${prefix}${scaleLengths(value)}${suffix}`
    )
    .replace(/(font\s*:\s*)([^;{}]+)(;)/gi, (_match, prefix, value, suffix) =>
      `${prefix}${scaleLengths(value)}${suffix}`
    )
    .replace(/(line-height\s*:\s*)(-?(?:\d+\.?\d*|\.\d+)px)(\s*;)/gi,
      (_match, prefix, value, suffix) => `${prefix}calc(${value} * var(--text-scale, 1))${suffix}`
    );
}

export function textScaleCssPlugin() {
  return {
    name: "cdriveshiftai-text-scale-css",
    enforce: "pre",
    transform(code: string, id: string) {
      if (!id.replaceAll("\\", "/").endsWith("/src/styles.css")) return null;
      return { code: transformTextScaleCss(code), map: null };
    }
  };
}
