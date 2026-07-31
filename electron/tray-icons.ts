import { nativeImage, type NativeImage } from "electron";

export type TrayIconKind =
  | "app"
  | "search"
  | "quick"
  | "overview"
  | "map"
  | "ai"
  | "move"
  | "history"
  | "ai-status"
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "moonshot"
  | "ollama"
  | "ai-config"
  | "theme"
  | "theme-aurora"
  | "theme-matrix"
  | "theme-calm"
  | "settings"
  | "exit";

export const trayIconKinds: TrayIconKind[] = [
  "app",
  "search",
  "quick",
  "overview",
  "map",
  "ai",
  "move",
  "history",
  "ai-status",
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "moonshot",
  "ollama",
  "ai-config",
  "theme",
  "theme-aurora",
  "theme-matrix",
  "theme-calm",
  "settings",
  "exit"
];

const iconSize = 16;

interface Point {
  x: number;
  y: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseColor(value: string): Rgb {
  const normalized = value.replace(/^#/, "");
  const hex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : normalized;
  const parsed = Number.parseInt(hex, 16);
  if (!Number.isFinite(parsed) || hex.length !== 6) {
    return { r: 74, g: 167, b: 168 };
  }
  return {
    r: (parsed >> 16) & 0xff,
    g: (parsed >> 8) & 0xff,
    b: parsed & 0xff
  };
}

function setPixel(buffer: Buffer, x: number, y: number, color: Rgb, alpha = 255): void {
  if (x < 0 || y < 0 || x >= iconSize || y >= iconSize) return;
  const index = (y * iconSize + x) * 4;
  // NativeImage 的原始位图采用 Chromium BGRA 字节序。
  buffer[index] = color.b;
  buffer[index + 1] = color.g;
  buffer[index + 2] = color.r;
  buffer[index + 3] = alpha;
}

function line(buffer: Buffer, from: Point, to: Point, color: Rgb): void {
  let x0 = from.x;
  let y0 = from.y;
  const dx = Math.abs(to.x - x0);
  const sx = x0 < to.x ? 1 : -1;
  const dy = -Math.abs(to.y - y0);
  const sy = y0 < to.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    setPixel(buffer, x0, y0, color);
    if (x0 === to.x && y0 === to.y) break;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x0 += sx;
    }
    if (twice <= dx) {
      error += dx;
      y0 += sy;
    }
  }
}

function polyline(buffer: Buffer, points: Point[], color: Rgb, close = false): void {
  for (let index = 1; index < points.length; index += 1) {
    line(buffer, points[index - 1], points[index], color);
  }
  if (close && points.length > 2) line(buffer, points[points.length - 1], points[0], color);
}

function rect(
  buffer: Buffer,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgb,
  fill = false
): void {
  if (fill) {
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        setPixel(buffer, column, row, color);
      }
    }
    return;
  }
  line(buffer, { x, y }, { x: x + width - 1, y }, color);
  line(buffer, { x: x + width - 1, y }, { x: x + width - 1, y: y + height - 1 }, color);
  line(buffer, { x: x + width - 1, y: y + height - 1 }, { x, y: y + height - 1 }, color);
  line(buffer, { x, y: y + height - 1 }, { x, y }, color);
}

function circle(buffer: Buffer, centerX: number, centerY: number, radius: number, color: Rgb): void {
  let x = radius;
  let y = 0;
  let error = 1 - x;
  while (x >= y) {
    [
      [centerX + x, centerY + y],
      [centerX + y, centerY + x],
      [centerX - y, centerY + x],
      [centerX - x, centerY + y],
      [centerX - x, centerY - y],
      [centerX - y, centerY - x],
      [centerX + y, centerY - x],
      [centerX + x, centerY - y]
    ].forEach(([pixelX, pixelY]) => setPixel(buffer, pixelX, pixelY, color));
    y += 1;
    if (error < 0) {
      error += 2 * y + 1;
    } else {
      x -= 1;
      error += 2 * (y - x) + 1;
    }
  }
}

function drawIcon(buffer: Buffer, kind: TrayIconKind, color: Rgb): void {
  switch (kind) {
    case "app":
      rect(buffer, 2, 2, 12, 12, color);
      line(buffer, { x: 8, y: 4 }, { x: 8, y: 12 }, color);
      line(buffer, { x: 4, y: 8 }, { x: 12, y: 8 }, color);
      setPixel(buffer, 4, 4, color);
      setPixel(buffer, 11, 11, color);
      break;
    case "search":
      circle(buffer, 6, 6, 4, color);
      line(buffer, { x: 9, y: 9 }, { x: 14, y: 14 }, color);
      break;
    case "quick":
      polyline(
        buffer,
        [
          { x: 8, y: 1 },
          { x: 4, y: 8 },
          { x: 8, y: 8 },
          { x: 6, y: 15 },
          { x: 13, y: 6 },
          { x: 9, y: 6 }
        ],
        color,
        true
      );
      break;
    case "overview":
      rect(buffer, 2, 2, 5, 5, color);
      rect(buffer, 9, 2, 5, 5, color);
      rect(buffer, 2, 9, 5, 5, color);
      rect(buffer, 9, 9, 5, 5, color);
      break;
    case "map":
      polyline(
        buffer,
        [
          { x: 1, y: 3 },
          { x: 5, y: 1 },
          { x: 10, y: 4 },
          { x: 15, y: 1 },
          { x: 15, y: 13 },
          { x: 10, y: 15 },
          { x: 5, y: 12 },
          { x: 1, y: 15 }
        ],
        color
      );
      line(buffer, { x: 5, y: 1 }, { x: 5, y: 12 }, color);
      line(buffer, { x: 10, y: 4 }, { x: 10, y: 15 }, color);
      break;
    case "ai":
      rect(buffer, 3, 4, 10, 9, color);
      line(buffer, { x: 8, y: 1 }, { x: 8, y: 4 }, color);
      setPixel(buffer, 6, 8, color);
      setPixel(buffer, 10, 8, color);
      line(buffer, { x: 6, y: 11 }, { x: 10, y: 11 }, color);
      break;
    case "move":
      line(buffer, { x: 1, y: 5 }, { x: 13, y: 5 }, color);
      polyline(buffer, [{ x: 10, y: 2 }, { x: 13, y: 5 }, { x: 10, y: 8 }], color);
      line(buffer, { x: 15, y: 11 }, { x: 3, y: 11 }, color);
      polyline(buffer, [{ x: 6, y: 8 }, { x: 3, y: 11 }, { x: 6, y: 14 }], color);
      break;
    case "history":
      circle(buffer, 8, 8, 6, color);
      line(buffer, { x: 8, y: 4 }, { x: 8, y: 8 }, color);
      line(buffer, { x: 8, y: 8 }, { x: 11, y: 10 }, color);
      line(buffer, { x: 1, y: 3 }, { x: 1, y: 7 }, color);
      line(buffer, { x: 1, y: 3 }, { x: 5, y: 3 }, color);
      break;
    case "ai-status":
      circle(buffer, 8, 8, 6, color);
      polyline(buffer, [{ x: 4, y: 8 }, { x: 7, y: 11 }, { x: 12, y: 5 }], color);
      break;
    case "openai":
      circle(buffer, 8, 8, 5, color);
      circle(buffer, 8, 8, 2, color);
      line(buffer, { x: 8, y: 1 }, { x: 8, y: 4 }, color);
      line(buffer, { x: 8, y: 12 }, { x: 8, y: 15 }, color);
      break;
    case "anthropic":
      polyline(buffer, [{ x: 2, y: 14 }, { x: 7, y: 2 }, { x: 12, y: 14 }], color);
      polyline(buffer, [{ x: 6, y: 14 }, { x: 11, y: 2 }, { x: 15, y: 14 }], color);
      line(buffer, { x: 5, y: 9 }, { x: 12, y: 9 }, color);
      break;
    case "gemini":
      polyline(
        buffer,
        [
          { x: 8, y: 1 },
          { x: 10, y: 6 },
          { x: 15, y: 8 },
          { x: 10, y: 10 },
          { x: 8, y: 15 },
          { x: 6, y: 10 },
          { x: 1, y: 8 },
          { x: 6, y: 6 }
        ],
        color,
        true
      );
      break;
    case "deepseek":
      polyline(
        buffer,
        [
          { x: 1, y: 10 },
          { x: 4, y: 6 },
          { x: 8, y: 8 },
          { x: 12, y: 4 },
          { x: 15, y: 7 },
          { x: 12, y: 12 },
          { x: 6, y: 13 }
        ],
        color
      );
      setPixel(buffer, 12, 7, color);
      break;
    case "moonshot":
      circle(buffer, 8, 8, 6, color);
      circle(buffer, 11, 6, 5, color);
      line(buffer, { x: 9, y: 1 }, { x: 14, y: 3 }, color);
      line(buffer, { x: 10, y: 14 }, { x: 14, y: 11 }, color);
      break;
    case "ollama":
      rect(buffer, 4, 5, 8, 9, color);
      line(buffer, { x: 5, y: 5 }, { x: 3, y: 1 }, color);
      line(buffer, { x: 11, y: 5 }, { x: 13, y: 1 }, color);
      setPixel(buffer, 6, 9, color);
      setPixel(buffer, 10, 9, color);
      line(buffer, { x: 6, y: 12 }, { x: 10, y: 12 }, color);
      break;
    case "ai-config":
      rect(buffer, 2, 4, 12, 8, color);
      line(buffer, { x: 5, y: 2 }, { x: 5, y: 4 }, color);
      line(buffer, { x: 11, y: 2 }, { x: 11, y: 4 }, color);
      circle(buffer, 8, 8, 2, color);
      break;
    case "theme":
      circle(buffer, 7, 8, 6, color);
      setPixel(buffer, 5, 5, color);
      setPixel(buffer, 9, 4, color);
      setPixel(buffer, 11, 8, color);
      setPixel(buffer, 5, 11, color);
      break;
    case "theme-aurora":
      rect(buffer, 1, 10, 14, 5, color, true);
      polyline(buffer, [{ x: 2, y: 10 }, { x: 5, y: 5 }, { x: 7, y: 10 }], color);
      polyline(buffer, [{ x: 7, y: 10 }, { x: 11, y: 2 }, { x: 15, y: 10 }], color);
      break;
    case "theme-matrix":
      [2, 5, 8, 11, 14].forEach((x, index) => {
        line(buffer, { x, y: index % 2 === 0 ? 1 : 4 }, { x, y: 14 }, color);
        setPixel(buffer, x, 3 + ((index * 3) % 9), color, 110);
      });
      break;
    case "theme-calm":
      polyline(
        buffer,
        [
          { x: 8, y: 1 },
          { x: 14, y: 7 },
          { x: 10, y: 15 },
          { x: 4, y: 15 },
          { x: 2, y: 7 }
        ],
        color,
        true
      );
      line(buffer, { x: 5, y: 7 }, { x: 11, y: 7 }, color);
      break;
    case "settings":
      circle(buffer, 8, 8, 5, color);
      circle(buffer, 8, 8, 2, color);
      [1, 4, 11, 14].forEach((value) => {
        setPixel(buffer, value, 8, color);
        setPixel(buffer, 8, value, color);
      });
      break;
    case "exit":
      rect(buffer, 2, 2, 8, 12, color);
      line(buffer, { x: 7, y: 8 }, { x: 15, y: 8 }, color);
      polyline(buffer, [{ x: 12, y: 5 }, { x: 15, y: 8 }, { x: 12, y: 11 }], color);
      break;
  }
}

export function createTrayMenuIcon(
  kind: TrayIconKind,
  color = "#4aa7a8"
): NativeImage {
  const bitmap = Buffer.alloc(iconSize * iconSize * 4);
  drawIcon(bitmap, kind, parseColor(color));
  return nativeImage.createFromBitmap(bitmap, {
    width: iconSize,
    height: iconSize,
    scaleFactor: 1
  });
}
