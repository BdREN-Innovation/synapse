import { useEffect, useRef } from 'react';
import { useTheme, isDark } from '@librechat/client';

/**
 * Decorative, theme-aware network graph rendered behind the auth card —
 * echoes the Synapse logo's node-and-edge motif. Nodes drift slowly, warm
 * from purple toward orange near the cursor, and ripple outward on click.
 * Skips animation entirely under prefers-reduced-motion (static watermark only).
 */

const NODE_COUNT_PER_AREA = 1 / 22000; // nodes per px^2, clamped below
const MIN_NODES = 28;
const MAX_NODES = 56;
const HUB_CHANCE = 0.18;
const GRADIENT_NODE_CHANCE = 0.22;
const EDGE_DISTANCE = 170;
const HOVER_RADIUS = 140;
const MAX_DPR = 2;

const PURPLE = { r: 154, g: 39, b: 142 };
const PURPLE_DARK = { r: 176, g: 84, b: 160 };
const INDIGO = { r: 58, g: 58, b: 152 };
const ORANGE = { r: 245, g: 135, b: 31 };

type Node = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  isHub: boolean;
  isGradient: boolean;
  warmth: number;
};

type Ripple = {
  x: number;
  y: number;
  startedAt: number;
};

const RIPPLE_DURATION_MS = 900;
const RIPPLE_MAX_RADIUS = 260;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function mixColor(
  base: { r: number; g: number; b: number },
  target: { r: number; g: number; b: number },
  t: number,
) {
  return `rgb(${lerp(base.r, target.r, t)}, ${lerp(base.g, target.g, t)}, ${lerp(base.b, target.b, t)})`;
}

function createNodes(width: number, height: number): Node[] {
  const area = width * height;
  const count = Math.max(MIN_NODES, Math.min(MAX_NODES, Math.round(area * NODE_COUNT_PER_AREA)));
  const nodes: Node[] = [];
  for (let i = 0; i < count; i++) {
    const isHub = Math.random() < HUB_CHANCE;
    nodes.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      radius: isHub ? 14 + Math.random() * 10 : 4 + Math.random() * 7,
      isHub,
      isGradient: Math.random() < GRADIENT_NODE_CHANCE,
      warmth: 0,
    });
  }
  return nodes;
}

function NetworkBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { theme } = useTheme();
  const dark = isDark(theme);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) {
      return;
    }

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    let nodes: Node[] = [];
    const ripples: Ripple[] = [];
    const pointer = { x: -9999, y: -9999, active: false };
    let animationFrame = 0;
    let running = true;

    const purpleBase = dark ? PURPLE_DARK : PURPLE;
    const edgeAlphaScale = dark ? 0.5 : 0.32;
    const nodeAlphaScale = dark ? 0.85 : 0.6;

    function resize() {
      const rect = wrapper!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      nodes = createNodes(width, height);
    }

    function handlePointerMove(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
    }

    function handlePointerLeave() {
      pointer.active = false;
      pointer.x = -9999;
      pointer.y = -9999;
    }

    function handleClick(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      ripples.push({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        startedAt: performance.now(),
      });
    }

    function drawFrame(now: number) {
      ctx!.clearRect(0, 0, width, height);

      // Advance ripples, drop expired ones
      for (let i = ripples.length - 1; i >= 0; i--) {
        if (now - ripples[i].startedAt > RIPPLE_DURATION_MS) {
          ripples.splice(i, 1);
        }
      }

      for (const node of nodes) {
        if (!prefersReducedMotion) {
          node.x += node.vx;
          node.y += node.vy;
          if (node.x < -20) node.x = width + 20;
          if (node.x > width + 20) node.x = -20;
          if (node.y < -20) node.y = height + 20;
          if (node.y > height + 20) node.y = -20;

          if (pointer.active) {
            const dx = node.x - pointer.x;
            const dy = node.y - pointer.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist < HOVER_RADIUS) {
              const force = (1 - dist / HOVER_RADIUS) * 0.6;
              node.vx += (dx / dist) * force * 0.04;
              node.vy += (dy / dist) * force * 0.04;
              node.warmth = Math.max(node.warmth, 1 - dist / HOVER_RADIUS);
            }
          }

          for (const ripple of ripples) {
            const age = now - ripple.startedAt;
            const rippleRadius = (age / RIPPLE_DURATION_MS) * RIPPLE_MAX_RADIUS;
            const dx = node.x - ripple.x;
            const dy = node.y - ripple.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const band = Math.abs(dist - rippleRadius);
            if (band < 40) {
              const strength = (1 - age / RIPPLE_DURATION_MS) * (1 - band / 40);
              node.vx += (dx / dist) * strength * 0.5;
              node.vy += (dy / dist) * strength * 0.5;
              node.warmth = Math.max(node.warmth, strength);
            }
          }

          // gentle drag so velocity doesn't accumulate forever
          node.vx *= 0.96;
          node.vy *= 0.96;
          node.warmth *= 0.94;
        }
      }

      // Edges
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < EDGE_DISTANCE) {
            const proximity = 1 - dist / EDGE_DISTANCE;
            const warmth = Math.max(a.warmth, b.warmth);
            const color = mixColor(purpleBase, ORANGE, warmth);
            ctx!.strokeStyle = color;
            ctx!.globalAlpha = proximity * edgeAlphaScale * (0.4 + warmth * 0.6);
            ctx!.lineWidth = 1 + warmth * 1.5;
            ctx!.beginPath();
            ctx!.moveTo(a.x, a.y);
            ctx!.lineTo(b.x, b.y);
            ctx!.stroke();
          }
        }
      }

      // Nodes
      for (const node of nodes) {
        const color = mixColor(node.isGradient ? INDIGO : purpleBase, ORANGE, node.warmth);
        ctx!.globalAlpha = nodeAlphaScale * (node.isHub ? 1 : 0.85);
        ctx!.fillStyle = color;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, node.radius + node.warmth * 2, 0, Math.PI * 2);
        ctx!.fill();
      }

      ctx!.globalAlpha = 1;
    }

    function loop(now: number) {
      if (!running) {
        return;
      }
      drawFrame(now);
      if (!prefersReducedMotion) {
        animationFrame = requestAnimationFrame(loop);
      }
    }

    function handleVisibility() {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(animationFrame);
      } else if (!running) {
        running = true;
        animationFrame = requestAnimationFrame(loop);
      }
    }

    resize();
    animationFrame = requestAnimationFrame(loop);

    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', handleVisibility);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    canvas.addEventListener('click', handleClick);

    return () => {
      running = false;
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', handleVisibility);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('click', handleClick);
    };
  }, [dark]);

  return (
    <div ref={wrapperRef} className="absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
      <img
        src="assets/synapse-icon.svg"
        alt=""
        className="absolute left-1/2 top-1/2 w-[70vmin] max-w-none -translate-x-1/2 -translate-y-1/2 select-none opacity-[0.05] dark:opacity-[0.07]"
        draggable={false}
      />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}

export default NetworkBackground;
