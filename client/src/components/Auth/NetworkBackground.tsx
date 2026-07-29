import { useEffect, useRef } from 'react';
import { useTheme, isDark } from '@librechat/client';

/**
 * Decorative, theme-aware neural network rendered behind the auth card —
 * echoes the Synapse logo's node-and-edge motif. Small nodes drift and breathe,
 * signals travel edge to edge like an impulse crossing a synapse, nodes warm
 * from purple toward orange near the cursor, and ripple outward on click.
 * Skips animation entirely under prefers-reduced-motion (static graph only).
 */

const NODE_COUNT_PER_AREA = 1 / 9000; // nodes per px^2, clamped below
const MIN_NODES = 70;
const MAX_NODES = 150;
const HUB_CHANCE = 0.14;
const GRADIENT_NODE_CHANCE = 0.22;
const EDGE_DISTANCE = 128;
const HOVER_RADIUS = 140;
const MAX_DPR = 2;

/** Dendrite-thin nodes: the network should read as connections, not as beads. */
const HUB_RADIUS_MIN = 2.6;
const HUB_RADIUS_RANGE = 1.8;
const NODE_RADIUS_MIN = 1.1;
const NODE_RADIUS_RANGE = 1.5;

/** Impulses travel at a fixed speed in px/ms so long and short edges read alike. */
const SIGNAL_SPEED_PX_MS = 0.048;
const SIGNAL_TARGET_COUNT = 26;
const SIGNAL_MAX_HOPS = 9;
const SIGNAL_SPAWN_INTERVAL_MS = 120;
const SIGNAL_CORE_RADIUS = 2.4;
const SIGNAL_HALO_RADIUS = 8;
const SIGNAL_TRAIL = 0.45;

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
  /** Desynchronises the breathing so the field never throbs as one block. */
  phase: number;
  /** Brief flare when an impulse arrives, decays each frame. */
  flash: number;
};

type Ripple = {
  x: number;
  y: number;
  startedAt: number;
};

type Signal = {
  from: number;
  to: number;
  /** Progress along the current edge, 0..1. */
  t: number;
  hops: number;
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
      vx: (Math.random() - 0.5) * 0.16,
      vy: (Math.random() - 0.5) * 0.16,
      radius: isHub
        ? HUB_RADIUS_MIN + Math.random() * HUB_RADIUS_RANGE
        : NODE_RADIUS_MIN + Math.random() * NODE_RADIUS_RANGE,
      isHub,
      isGradient: Math.random() < GRADIENT_NODE_CHANCE,
      warmth: 0,
      phase: Math.random() * Math.PI * 2,
      flash: 0,
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
    /** Rebuilt in place every frame from the same pass that draws the edges, so
     *  impulses can only ever travel along a connection the user can see. */
    let neighbors: number[][] = [];
    const signals: Signal[] = [];
    const ripples: Ripple[] = [];
    const pointer = { x: -9999, y: -9999, active: false };
    let animationFrame = 0;
    let running = true;
    let lastNow = 0;
    let lastSpawn = 0;

    const purpleBase = dark ? PURPLE_DARK : PURPLE;
    const edgeAlphaScale = dark ? 0.42 : 0.34;
    const nodeAlphaScale = dark ? 0.85 : 0.62;

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
      neighbors = nodes.map(() => []);
      signals.length = 0;
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

    /** Picks a continuation that is not the edge the impulse just crossed, so a
     *  signal propagates outward instead of bouncing between two nodes. */
    function pickNextHop(current: number, previous: number): number {
      const options = neighbors[current];
      if (!options || options.length === 0) {
        return -1;
      }
      if (options.length === 1) {
        return options[0] === previous ? -1 : options[0];
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = options[Math.floor(Math.random() * options.length)];
        if (candidate !== previous) {
          return candidate;
        }
      }
      return -1;
    }

    /** Retries because a randomly chosen node is often an isolated one at the
     *  edge of the field; giving up after one miss starves the population. */
    function spawnSignal() {
      for (let attempt = 0; attempt < 12; attempt++) {
        const start = Math.floor(Math.random() * nodes.length);
        const next = pickNextHop(start, -1);
        if (next !== -1) {
          signals.push({ from: start, to: next, t: Math.random() * 0.4, hops: 0 });
          return;
        }
      }
    }

    function advanceSignals(delta: number) {
      for (let i = signals.length - 1; i >= 0; i--) {
        const signal = signals[i];
        const a = nodes[signal.from];
        const b = nodes[signal.to];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.sqrt(dx * dx + dy * dy) || 1;

        signal.t += (SIGNAL_SPEED_PX_MS * delta) / length;

        if (signal.t < 1) {
          continue;
        }

        b.flash = 1;
        signal.hops++;
        const next = signal.hops >= SIGNAL_MAX_HOPS ? -1 : pickNextHop(signal.to, signal.from);
        if (next === -1) {
          signals.splice(i, 1);
          continue;
        }
        signal.from = signal.to;
        signal.to = next;
        signal.t = 0;
      }
    }

    function drawSignals() {
      for (const signal of signals) {
        const a = nodes[signal.from];
        const b = nodes[signal.to];
        const x = lerp(a.x, b.x, signal.t);
        const y = lerp(a.y, b.y, signal.t);

        /** Comet tail behind the head, fading to nothing at its far end, so the
         *  impulse reads as travelling rather than as a free-floating dot. */
        const tailT = Math.max(0, signal.t - SIGNAL_TRAIL);
        const tailX = lerp(a.x, b.x, tailT);
        const tailY = lerp(a.y, b.y, tailT);
        const trail = ctx!.createLinearGradient(tailX, tailY, x, y);
        trail.addColorStop(0, `rgba(${ORANGE.r}, ${ORANGE.g}, ${ORANGE.b}, 0)`);
        trail.addColorStop(1, `rgba(${ORANGE.r}, ${ORANGE.g}, ${ORANGE.b}, ${dark ? 0.75 : 0.62})`);
        ctx!.globalAlpha = 1;
        ctx!.strokeStyle = trail;
        ctx!.lineWidth = 1.6;
        ctx!.lineCap = 'round';
        ctx!.beginPath();
        ctx!.moveTo(tailX, tailY);
        ctx!.lineTo(x, y);
        ctx!.stroke();

        ctx!.fillStyle = mixColor(ORANGE, ORANGE, 0);
        ctx!.globalAlpha = dark ? 0.22 : 0.2;
        ctx!.beginPath();
        ctx!.arc(x, y, SIGNAL_HALO_RADIUS, 0, Math.PI * 2);
        ctx!.fill();

        ctx!.globalAlpha = dark ? 0.95 : 0.92;
        ctx!.beginPath();
        ctx!.arc(x, y, SIGNAL_CORE_RADIUS, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
    }

    function drawFrame(now: number) {
      const delta = lastNow === 0 ? 16 : Math.min(now - lastNow, 48);
      lastNow = now;

      ctx!.clearRect(0, 0, width, height);

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
          node.flash *= 0.9;
        }
      }

      // Edges, and the adjacency the impulses follow
      for (let i = 0; i < nodes.length; i++) {
        neighbors[i].length = 0;
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= EDGE_DISTANCE) {
            continue;
          }

          neighbors[i].push(j);
          neighbors[j].push(i);

          const proximity = 1 - dist / EDGE_DISTANCE;
          const warmth = Math.max(a.warmth, b.warmth);
          ctx!.strokeStyle = mixColor(purpleBase, ORANGE, warmth);
          ctx!.globalAlpha = proximity * edgeAlphaScale * (0.4 + warmth * 0.6);
          ctx!.lineWidth = 0.7 + warmth;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.stroke();
        }
      }

      if (!prefersReducedMotion) {
        advanceSignals(delta);
        if (signals.length < SIGNAL_TARGET_COUNT && now - lastSpawn > SIGNAL_SPAWN_INTERVAL_MS) {
          lastSpawn = now;
          /** Refill in small batches: impulses die whenever they reach a node
           *  with nowhere new to go, which one-per-interval cannot keep up with. */
          const batch = Math.min(4, SIGNAL_TARGET_COUNT - signals.length);
          for (let i = 0; i < batch; i++) {
            spawnSignal();
          }
        }
      }

      // Nodes
      for (const node of nodes) {
        const breath = prefersReducedMotion ? 1 : 1 + Math.sin(now * 0.0011 + node.phase) * 0.16;
        const excite = Math.max(node.warmth, node.flash);
        const color = mixColor(node.isGradient ? INDIGO : purpleBase, ORANGE, excite);
        const radius = node.radius * breath + excite * 1.4;

        if (node.isHub || excite > 0.05) {
          ctx!.globalAlpha = nodeAlphaScale * 0.16 * (1 + excite);
          ctx!.fillStyle = color;
          ctx!.beginPath();
          ctx!.arc(node.x, node.y, radius * 3.2, 0, Math.PI * 2);
          ctx!.fill();
        }

        ctx!.globalAlpha = nodeAlphaScale * (node.isHub ? 1 : 0.82);
        ctx!.fillStyle = color;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx!.fill();
      }

      if (!prefersReducedMotion) {
        drawSignals();
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
        lastNow = 0;
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
        className="absolute left-1/2 top-1/2 w-[34vmin] max-w-none -translate-x-1/2 -translate-y-1/2 select-none opacity-[0.04] dark:opacity-[0.06]"
        draggable={false}
      />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}

export default NetworkBackground;
