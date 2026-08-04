import { useEffect, useRef } from "react";
import type { EffectMode } from "../types";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  phase: number;
}

function createParticles(count: number): Particle[] {
  return Array.from({ length: count }, () => ({
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.00011,
    vy: (Math.random() - 0.5) * 0.00011,
    radius: 0.65 + Math.random() * 1.75,
    alpha: 0.15 + Math.random() * 0.52,
    phase: Math.random() * Math.PI * 2
  }));
}

export function BackgroundFX({ mode }: { mode: EffectMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const particles = createParticles(48);
    let width = 0;
    let height = 0;
    let animation = 0;
    let timer = 0;
    let activeUntil = performance.now() + 6_000;

    const markInteractive = () => {
      const wasIdle = performance.now() >= activeUntil;
      activeUntil = performance.now() + 6_000;
      if (wasIdle && !document.hidden && !animation) {
        if (timer) window.clearTimeout(timer);
        timer = 0;
        animation = requestAnimationFrame(draw);
      }
    };

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.imageSmoothingEnabled = false;
    };

    const moveParticles = (speed = 1) => {
      for (const particle of particles) {
        particle.x = (particle.x + particle.vx * speed + 1) % 1;
        particle.y = (particle.y + particle.vy * speed + 1) % 1;
      }
    };

    const blockNoise = (column: number, row: number) => {
      const value = Math.sin(column * 12.9898 + row * 78.233) * 43_758.5453;
      return value - Math.floor(value);
    };

    const drawBlockWorld = (time: number) => {
      context.clearRect(0, 0, width, height);
      const tile = width < 1320 ? 24 : 30;
      const waterline = Math.floor((height * 0.61) / tile) * tile;
      const drift = reducedMotion ? 0 : time * 0.006;

      const sky = context.createLinearGradient(0, 0, 0, waterline);
      sky.addColorStop(0, "rgba(103, 196, 204, .46)");
      sky.addColorStop(0.58, "rgba(98, 181, 193, .29)");
      sky.addColorStop(1, "rgba(126, 190, 181, .2)");
      context.fillStyle = sky;
      context.fillRect(0, 0, width, waterline);

      context.save();
      const sunX = Math.floor(width * 0.82 / 12) * 12;
      const sunY = Math.floor(height * 0.14 / 12) * 12;
      context.fillStyle = "rgba(255, 226, 145, .06)";
      context.fillRect(sunX - 30, sunY - 30, 84, 84);
      context.fillStyle = "rgba(255, 231, 155, .2)";
      context.fillRect(sunX - 12, sunY - 12, 48, 48);
      context.restore();

      const clouds = [
        { y: height * 0.13, x: width * 0.08, speed: 0.45, scale: 1 },
        { y: height * 0.25, x: width * 0.5, speed: 0.28, scale: 0.82 },
        { y: height * 0.39, x: width * 0.24, speed: 0.2, scale: 0.65 }
      ];
      context.save();
      context.fillStyle = "rgba(250, 245, 218, .16)";
      for (const cloud of clouds) {
        const step = Math.max(8, Math.round(18 * cloud.scale));
        const travel = width + step * 12;
        const x =
          Math.floor((((cloud.x * width + drift * cloud.speed) % travel) - step * 6) / step) *
          step;
        const y = Math.floor(cloud.y / step) * step;
        context.fillRect(x, y, step * 6, step);
        context.fillRect(x + step, y - step, step * 3, step);
        context.fillRect(x + step * 2, y - step * 2, step * 2, step);
        context.fillRect(x + step * 5, y + step, step * 2, step);
      }
      context.restore();

      // Layered stair-step mountains and a broad lake bring the scene closer to
      // hand-drawn landscape pixel art while remaining fully original.
      const paintMountains = (
        base: number,
        amplitude: number,
        color: string,
        phase: number,
        step: number
      ) => {
        context.fillStyle = color;
        for (let x = -step; x < width + step; x += step) {
          const column = x / step;
          const ridge =
            base -
            Math.max(
              step,
              Math.round(
                (Math.sin(column * 0.31 + phase) +
                  Math.sin(column * 0.13 + phase * 1.7) * 0.75 +
                  1.8) *
                  amplitude
              ) * step
            );
          context.fillRect(x, ridge, step + 1, waterline - ridge);
        }
      };

      paintMountains(waterline, 16, "rgba(47, 124, 132, .15)", 1.4, 12);
      paintMountains(waterline + 8, 11, "rgba(44, 112, 116, .2)", 3.2, 14);
      paintMountains(waterline + 14, 7, "rgba(55, 112, 94, .22)", 5.1, 16);

      const lake = context.createLinearGradient(0, waterline, 0, height);
      lake.addColorStop(0, "rgba(71, 163, 178, .34)");
      lake.addColorStop(0.7, "rgba(44, 126, 143, .24)");
      lake.addColorStop(1, "rgba(30, 84, 98, .22)");
      context.fillStyle = lake;
      context.fillRect(0, waterline, width, height - waterline);

      context.save();
      context.fillStyle = "rgba(221, 239, 216, .13)";
      for (let line = 0; line < 11; line += 1) {
        const y = waterline + 12 + line * Math.max(9, Math.floor(tile * 0.48));
        const offset = Math.floor((drift * (0.2 + line * 0.025)) / 8) * 8;
        const segment = 36 + (line % 4) * 18;
        for (let x = -segment + (offset % (segment * 3)); x < width; x += segment * 3) {
          context.fillRect(x, y, segment, 2);
        }
      }
      context.restore();

      context.save();
      context.globalAlpha = 0.56;
      const columns = Math.ceil(width / tile) + 2;
      const rows = Math.ceil((height - waterline) / tile) + 2;
      for (let column = -1; column < columns; column += 1) {
        const leftShore = column < columns * 0.2;
        const rightShore = column > columns * 0.78;
        for (let row = 0; row < rows; row += 1) {
          const foreground = row >= rows - 2;
          if (!leftShore && !rightShore && !foreground) continue;
          const x = column * tile;
          const y = waterline + row * tile;
          if (y > height + tile) continue;
          const surface = row === 0 || (foreground && row === rows - 2);
          const rocky = row > 2 && blockNoise(column, row) > 0.66;
          context.fillStyle = surface
            ? blockNoise(column, row) > 0.5
              ? "#5f934d"
              : "#538342"
            : rocky
              ? blockNoise(column, row + 9) > 0.5
                ? "#59615d"
                : "#4a5452"
              : blockNoise(column, row + 3) > 0.5
                ? "#8d593d"
                : "#754a34";
          context.fillRect(x + 1, y + 1, tile - 2, tile - 2);
          context.fillStyle = surface
            ? "rgba(159, 205, 91, .68)"
            : "rgba(255, 255, 255, .055)";
          context.fillRect(x + 1, y + 1, tile - 2, Math.max(3, Math.round(tile * 0.17)));
          context.fillStyle = "rgba(0, 0, 0, .16)";
          context.fillRect(x + tile - 4, y + 4, 3, tile - 5);
          const speckle = blockNoise(column + 17, row + 31);
          context.fillStyle = surface
            ? "rgba(34, 70, 36, .34)"
            : rocky
              ? "rgba(20, 24, 20, .22)"
              : "rgba(40, 24, 14, .25)";
          context.fillRect(
            x + 5 + Math.floor(speckle * Math.max(tile - 12, 1)),
            y + 8 + Math.floor(blockNoise(column + 2, row + 7) * Math.max(tile - 16, 1)),
            3,
            3
          );
        }
      }
      context.restore();

      const trees = [
        { x: width * 0.08, y: waterline - tile * 1.8, scale: 1.05 },
        { x: width * 0.18, y: waterline - tile * 1.1, scale: 0.72 },
        { x: width * 0.82, y: waterline - tile * 1.55, scale: 0.92 },
        { x: width * 0.92, y: waterline - tile * 2.05, scale: 1.18 }
      ];
      context.save();
      context.globalAlpha = 0.5;
      for (const tree of trees) {
        const unit = Math.max(5, Math.round(9 * tree.scale));
        const x = Math.floor(tree.x / unit) * unit;
        const y = Math.floor(tree.y / unit) * unit;
        context.fillStyle = "#754329";
        context.fillRect(x, y, unit, unit * 4);
        context.fillStyle = "#2f6f47";
        context.fillRect(x - unit * 2, y - unit * 2, unit * 5, unit * 2);
        context.fillStyle = "#438454";
        context.fillRect(x - unit, y - unit * 3, unit * 3, unit * 2);
        context.fillStyle = "#72a958";
        context.fillRect(x, y - unit * 3, unit, unit);
      }
      context.restore();

      moveParticles(0.24);
      context.save();
      for (let index = 0; index < 22; index += 1) {
        const particle = particles[index];
        const size = index % 5 === 0 ? 4 : 2;
        const x = Math.floor((particle.x * width) / size) * size;
        const y = Math.floor((particle.y * waterline) / size) * size;
        const pulse = 0.45 + Math.sin(time * 0.001 + particle.phase) * 0.25;
        context.fillStyle = `rgba(245, 230, 174, ${Math.max(0.03, particle.alpha * pulse * 0.3)})`;
        context.fillRect(x, y, size, size);
      }
      context.restore();
    };

    const drawHudRing = (
      x: number,
      y: number,
      radius: number,
      rotation: number,
      color: string
    ) => {
      context.save();
      context.translate(x, y);
      context.rotate(rotation);
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.setLineDash([radius * 0.28, radius * 0.12]);
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.stroke();
      context.rotate(-rotation * 1.7);
      context.setLineDash([3, 9]);
      context.beginPath();
      context.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      context.moveTo(-radius * 1.15, 0);
      context.lineTo(-radius * 0.88, 0);
      context.moveTo(radius * 0.88, 0);
      context.lineTo(radius * 1.15, 0);
      context.stroke();
      context.restore();
    };

    const drawTechnology = (time: number) => {
      context.clearRect(0, 0, width, height);
      const horizon = height * 0.37;
      const rotation = time * 0.00009;

      context.save();
      const glow = context.createRadialGradient(
        width * 0.55,
        horizon,
        0,
        width * 0.55,
        horizon,
        Math.max(width, height) * 0.7
      );
      glow.addColorStop(0, "rgba(49, 113, 255, .11)");
      glow.addColorStop(0.42, "rgba(44, 234, 255, .035)");
      glow.addColorStop(1, "rgba(2, 5, 17, 0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      context.lineWidth = 1;
      for (let index = -15; index <= 15; index += 1) {
        const edgeX = width * 0.5 + index * Math.max(92, width / 12);
        const lineGradient = context.createLinearGradient(0, horizon, 0, height);
        lineGradient.addColorStop(0, "rgba(85, 225, 255, 0)");
        lineGradient.addColorStop(1, "rgba(85, 225, 255, .13)");
        context.strokeStyle = lineGradient;
        context.beginPath();
        context.moveTo(width * 0.5 + index * 2.8, horizon);
        context.lineTo(edgeX, height);
        context.stroke();
      }
      for (let index = 0; index < 17; index += 1) {
        const normalized = index / 16;
        const y = horizon + (height - horizon) * normalized ** 2;
        context.strokeStyle = `rgba(81, 222, 255, ${0.02 + normalized * 0.12})`;
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }

      const scanY = horizon + ((time * 0.035) % Math.max(height - horizon, 1));
      const scanGradient = context.createLinearGradient(0, scanY - 46, 0, scanY + 8);
      scanGradient.addColorStop(0, "rgba(71, 236, 255, 0)");
      scanGradient.addColorStop(0.86, "rgba(71, 236, 255, .055)");
      scanGradient.addColorStop(1, "rgba(137, 248, 255, .2)");
      context.fillStyle = scanGradient;
      context.fillRect(0, scanY - 46, width, 54);

      moveParticles(0.42);
      context.globalCompositeOperation = "screen";
      for (let first = 0; first < 30; first += 1) {
        const a = particles[first];
        const ax = a.x * width;
        const ay = a.y * height;
        for (let second = first + 1; second < 30; second += 1) {
          const b = particles[second];
          const bx = b.x * width;
          const by = b.y * height;
          const distance = Math.hypot(ax - bx, ay - by);
          if (distance > 165) continue;
          context.strokeStyle = `rgba(72, 222, 255, ${(1 - distance / 165) * 0.1})`;
          context.beginPath();
          context.moveTo(ax, ay);
          context.lineTo(bx, by);
          context.stroke();
        }
        const pulse = 0.55 + Math.sin(time * 0.0016 + a.phase) * 0.45;
        context.fillStyle = `rgba(99, 241, 255, ${0.18 + a.alpha * pulse})`;
        context.shadowColor = "#4ceaff";
        context.shadowBlur = 10;
        context.beginPath();
        context.arc(ax, ay, first % 6 === 0 ? 2.2 : 1.15, 0, Math.PI * 2);
        context.fill();
      }
      context.shadowBlur = 0;

      drawHudRing(width * 0.83, height * 0.24, 82, rotation, "rgba(88, 235, 255, .14)");
      drawHudRing(width * 0.17, height * 0.77, 118, -rotation * 0.72, "rgba(115, 113, 255, .11)");

      const pulseX = ((time * 0.055) % (width + 240)) - 120;
      const pulseGradient = context.createLinearGradient(pulseX - 80, 0, pulseX + 80, 0);
      pulseGradient.addColorStop(0, "rgba(82, 239, 255, 0)");
      pulseGradient.addColorStop(0.5, "rgba(82, 239, 255, .1)");
      pulseGradient.addColorStop(1, "rgba(82, 239, 255, 0)");
      context.fillStyle = pulseGradient;
      context.fillRect(pulseX - 80, 0, 160, height);
      context.restore();
    };

    const drawCrystal = (time: number) => {
      context.clearRect(0, 0, width, height);
      const phase = time * 0.00008;

      context.save();
      const bloom = [
        [0.18 + Math.sin(phase) * 0.025, 0.2, 360, "122, 221, 218", 0.1],
        [0.79, 0.3 + Math.cos(phase) * 0.025, 420, "133, 168, 219", 0.09],
        [0.54, 0.9, 390, "184, 157, 220", 0.065]
      ] as const;
      for (const [x, y, radius, color, alpha] of bloom) {
        const gradient = context.createRadialGradient(
          x * width,
          y * height,
          0,
          x * width,
          y * height,
          radius
        );
        gradient.addColorStop(0, `rgba(${color}, ${alpha})`);
        gradient.addColorStop(1, `rgba(${color}, 0)`);
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
      }

      context.strokeStyle = "rgba(84, 118, 136, .07)";
      context.lineWidth = 1;
      for (let row = 0; row < 8; row += 1) {
        context.beginPath();
        for (let x = -40; x <= width + 40; x += 28) {
          const y =
            height * (0.12 + row * 0.125) +
            Math.sin(x * 0.004 + row * 0.75 + phase * 1.2) * (13 + row * 1.5);
          if (x === -40) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }

      moveParticles(0.2);
      for (const particle of particles.slice(0, 24)) {
        const pulse = 0.5 + Math.sin(time * 0.0008 + particle.phase) * 0.5;
        context.beginPath();
        context.fillStyle = `rgba(74, 123, 146, ${0.035 + pulse * 0.045})`;
        context.arc(
          particle.x * width,
          particle.y * height,
          particle.radius * (3.2 + pulse * 2),
          0,
          Math.PI * 2
        );
        context.fill();
      }
      context.restore();
    };

    const drawEmber = (time: number) => {
      context.clearRect(0, 0, width, height);
      context.save();

      const core = context.createRadialGradient(
        width * 0.72,
        height * 0.22,
        0,
        width * 0.72,
        height * 0.22,
        Math.max(width, height) * 0.68
      );
      core.addColorStop(0, "rgba(255, 105, 35, .12)");
      core.addColorStop(0.42, "rgba(122, 42, 16, .045)");
      core.addColorStop(1, "rgba(11, 7, 5, 0)");
      context.fillStyle = core;
      context.fillRect(0, 0, width, height);

      const radius = 42;
      const rowHeight = Math.sqrt(3) * radius;
      context.lineWidth = 1;
      for (let row = -1; row < height / rowHeight + 2; row += 1) {
        for (let column = -1; column < width / (radius * 3) + 2; column += 1) {
          const centerX = column * radius * 3 + (row % 2 ? radius * 1.5 : 0);
          const centerY = row * rowHeight;
          const pulse = 0.028 + 0.018 * Math.sin(time * 0.0007 + row * 0.7 + column);
          context.strokeStyle = `rgba(255, 113, 42, ${pulse})`;
          context.beginPath();
          for (let side = 0; side < 6; side += 1) {
            const angle = (Math.PI / 3) * side;
            const x = centerX + Math.cos(angle) * radius;
            const y = centerY + Math.sin(angle) * radius;
            if (side === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
          context.closePath();
          context.stroke();
        }
      }

      const scanX = ((time * 0.045) % (width + 320)) - 160;
      const scan = context.createLinearGradient(scanX - 100, 0, scanX + 100, 0);
      scan.addColorStop(0, "rgba(255, 104, 32, 0)");
      scan.addColorStop(0.5, "rgba(255, 126, 48, .075)");
      scan.addColorStop(1, "rgba(255, 104, 32, 0)");
      context.fillStyle = scan;
      context.fillRect(scanX - 100, 0, 200, height);

      moveParticles(0.24);
      for (const [index, particle] of particles.slice(0, 24).entries()) {
        const pulse = 0.5 + Math.sin(time * 0.001 + particle.phase) * 0.5;
        context.fillStyle = `rgba(255, ${105 + (index % 3) * 22}, 54, ${0.045 + pulse * 0.11})`;
        context.shadowColor = "rgba(255, 93, 25, .75)";
        context.shadowBlur = index % 5 === 0 ? 12 : 5;
        context.fillRect(particle.x * width, particle.y * height, index % 5 === 0 ? 3 : 1.5, 1.5);
      }
      context.restore();
    };

    const drawIvory = (time: number) => {
      context.clearRect(0, 0, width, height);
      context.save();

      const wash = context.createLinearGradient(0, 0, width, height);
      wash.addColorStop(0, "rgba(255, 251, 244, .56)");
      wash.addColorStop(0.52, "rgba(246, 242, 234, .08)");
      wash.addColorStop(1, "rgba(195, 85, 60, .045)");
      context.fillStyle = wash;
      context.fillRect(0, 0, width, height);

      const phase = time * 0.00012;
      context.lineWidth = 1;
      for (let row = 0; row < 7; row += 1) {
        context.strokeStyle = `rgba(${row % 2 ? "96, 128, 145" : "194, 84, 61"}, ${0.035 + row * 0.004})`;
        context.beginPath();
        for (let x = -50; x <= width + 50; x += 32) {
          const y = height * (0.12 + row * 0.14) + Math.sin(x * 0.004 + row + phase) * 18;
          if (x === -50) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }

      moveParticles(0.12);
      for (const [index, particle] of particles.slice(0, 20).entries()) {
        const pulse = 0.5 + Math.sin(time * 0.0007 + particle.phase) * 0.5;
        context.beginPath();
        context.fillStyle = index % 3 === 0
          ? `rgba(195, 80, 57, ${0.025 + pulse * 0.035})`
          : `rgba(94, 126, 146, ${0.02 + pulse * 0.03})`;
        context.arc(particle.x * width, particle.y * height, 4 + particle.radius * 3, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    };

    const draw = (time: number) => {
      animation = 0;
      if (document.hidden) return;
      const interactive = document.hasFocus() && time < activeUntil;
      const frameInterval = reducedMotion ? 2_000 : interactive ? 40 : 2_000;
      const visualTime = reducedMotion ? 0 : time;
      if (mode === "aurora") drawBlockWorld(visualTime);
      else if (mode === "matrix") drawTechnology(visualTime);
      else if (mode === "calm") drawCrystal(visualTime);
      else if (mode === "ember") drawEmber(visualTime);
      else drawIvory(visualTime);
      timer = window.setTimeout(() => {
        timer = 0;
        animation = requestAnimationFrame(draw);
      }, frameInterval);
    };

    const updateVisibility = () => {
      const hidden = document.hidden;
      document.documentElement.classList.toggle("background-suspended", hidden);
      if (hidden) {
        if (animation) cancelAnimationFrame(animation);
        if (timer) window.clearTimeout(timer);
        animation = 0;
        timer = 0;
        return;
      }
      if (!animation) animation = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("focus", markInteractive);
    window.addEventListener("pointermove", markInteractive, { passive: true });
    window.addEventListener("pointerdown", markInteractive, { passive: true });
    window.addEventListener("keydown", markInteractive);
    document.addEventListener("visibilitychange", updateVisibility);
    updateVisibility();
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("focus", markInteractive);
      window.removeEventListener("pointermove", markInteractive);
      window.removeEventListener("pointerdown", markInteractive);
      window.removeEventListener("keydown", markInteractive);
      document.removeEventListener("visibilitychange", updateVisibility);
      document.documentElement.classList.remove("background-suspended");
      if (animation) cancelAnimationFrame(animation);
      if (timer) window.clearTimeout(timer);
    };
  }, [mode]);

  return (
    <>
      <canvas className="background-fx" ref={canvasRef} aria-hidden="true" />
      <div className={`fx-surface ${mode}`} aria-hidden="true" />
    </>
  );
}
