import { useEffect, useRef } from 'react';
import { useTheme, isDark } from '@librechat/client';

/**
 * Decorative, theme-aware neural network rendered behind the auth card.
 *
 * Nodes are grouped into clusters rather than scattered at random: each cluster
 * is a small constellation orbiting a hub, and hubs are wired to their nearest
 * neighbours by longer bridges. Uniform scatter produces arbitrary triangles
 * that read as noise, whereas lobes joined by pathways read as a network —
 * which is the point of the motif.
 *
 * Impulses in three colours travel the graph, crossing bridges between clusters
 * so data is visibly moving between regions rather than flickering in place.
 * Under prefers-reduced-motion the graph is drawn once and left still.
 */

const CLUSTERS_PER_AREA = 1 / 110000;
const MIN_CLUSTERS = 4;
const MAX_CLUSTERS = 12;
const CLUSTER_NODES_MIN = 7;
const CLUSTER_NODES_RANGE = 8;
const CLUSTER_RADIUS_MIN = 52;
const CLUSTER_RADIUS_RANGE = 44;
/** Clusters sway around a fixed home point, so the layout never wanders off. */
const CLUSTER_DRIFT = 16;
const INTRA_EDGE_DISTANCE = 84;
const BRIDGES_PER_CLUSTER = 2;
/** A pathway spanning the whole viewport reads as a stray line rather than a
 *  connection, so hubs further apart than this are left unlinked. */
const MAX_BRIDGE_DISTANCE = 380;
const HOVER_RADIUS = 150;
const MAX_DPR = 2;

const HUB_RADIUS_MIN = 2.8;
const HUB_RADIUS_RANGE = 1.6;
const NODE_RADIUS_MIN = 1.1;
const NODE_RADIUS_RANGE = 1.4;

/** Impulses travel at a fixed speed in px/ms so long and short edges read alike. */
const SIGNAL_SPEED_PX_MS = 0.045;
const SIGNAL_TARGET_COUNT = 18;
const SIGNAL_MAX_HOPS = 14;
const SIGNAL_SPAWN_INTERVAL_MS = 110;
const SIGNAL_CORE_RADIUS = 2.4;
const SIGNAL_HALO_RADIUS = 8;
const SIGNAL_TRAIL = 0.5;

const PURPLE = { r: 154, g: 39, b: 142 };
const PURPLE_DARK = { r: 176, g: 84, b: 160 };
const INDIGO = { r: 58, g: 58, b: 152 };
const ORANGE = { r: 245, g: 135, b: 31 };
const TEAL = { r: 32, g: 178, b: 190 };
const MAGENTA = { r: 226, g: 62, b: 152 };

/** Three data colours so concurrent impulses stay tellable apart. */
const SIGNAL_COLORS = [ORANGE, TEAL, MAGENTA];

type Rgb = { r: number; g: number; b: number };

type Cluster = {
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  radius: number;
  phase: number;
};

type Node = {
  cluster: number;
  /** Orbit around the cluster hub — keeps the constellation legible. */
  angle: number;
  angleSpeed: number;
  orbit: number;
  x: number;
  y: number;
  /** Displacement from pointer and ripples, springs back to the orbit. */
  ox: number;
  oy: number;
  ovx: number;
  ovy: number;
  radius: number;
  isHub: boolean;
  isGradient: boolean;
  warmth: number;
  phase: number;
  flash: number;
};

type Ripple = { x: number; y: number; startedAt: number };

type Signal = {
  from: number;
  to: number;
  t: number;
  hops: number;
  color: Rgb;
};

const RIPPLE_DURATION_MS = 900;
const RIPPLE_MAX_RADIUS = 260;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function mixColor(base: Rgb, target: Rgb, t: number) {
  return `rgb(${lerp(base.r, target.r, t)}, ${lerp(base.g, target.g, t)}, ${lerp(base.b, target.b, t)})`;
}

function rgba(color: Rgb, alpha: number) {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

/**
 * Lays clusters on a jittered grid. A grid keeps them from piling up while the
 * jitter stops the result from looking like a lattice.
 */
function createClusters(width: number, height: number): Cluster[] {
  const target = Math.max(
    MIN_CLUSTERS,
    Math.min(MAX_CLUSTERS, Math.round(width * height * CLUSTERS_PER_AREA)),
  );
  const cols = Math.max(2, Math.round(Math.sqrt(target * (width / Math.max(height, 1)))));
  const rows = Math.max(2, Math.ceil(target / cols));
  const cellW = width / cols;
  const cellH = height / rows;

  const cells: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: (c + 0.5) * cellW + (Math.random() - 0.5) * cellW * 0.7,
        y: (r + 0.5) * cellH + (Math.random() - 0.5) * cellH * 0.7,
      });
    }
  }

  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  return cells.slice(0, Math.min(target, cells.length)).map((cell) => ({
    homeX: cell.x,
    homeY: cell.y,
    x: cell.x,
    y: cell.y,
    radius: CLUSTER_RADIUS_MIN + Math.random() * CLUSTER_RADIUS_RANGE,
    phase: Math.random() * Math.PI * 2,
  }));
}

function createNodes(clusters: Cluster[]): Node[] {
  const nodes: Node[] = [];
  for (let c = 0; c < clusters.length; c++) {
    const count = CLUSTER_NODES_MIN + Math.floor(Math.random() * CLUSTER_NODES_RANGE);
    for (let i = 0; i < count; i++) {
      const isHub = i === 0;
      nodes.push({
        cluster: c,
        angle: Math.random() * Math.PI * 2,
        angleSpeed: (Math.random() - 0.5) * 0.00035,
        /** sqrt keeps satellites evenly spread over the disc, not bunched middle. */
        orbit: isHub ? 0 : Math.sqrt(Math.random()) * clusters[c].radius,
        x: clusters[c].x,
        y: clusters[c].y,
        ox: 0,
        oy: 0,
        ovx: 0,
        ovy: 0,
        radius: isHub
          ? HUB_RADIUS_MIN + Math.random() * HUB_RADIUS_RANGE
          : NODE_RADIUS_MIN + Math.random() * NODE_RADIUS_RANGE,
        isHub,
        isGradient: Math.random() < 0.24,
        warmth: 0,
        phase: Math.random() * Math.PI * 2,
        flash: 0,
      });
    }
  }
  return nodes;
}

/** Wires each hub to its nearest neighbouring hubs — the long pathways. */
function createBridges(nodes: Node[], clusters: Cluster[]): Array<[number, number]> {
  const hubs: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].isHub) {
      hubs.push(i);
    }
  }

  const seen = new Set<string>();
  const bridges: Array<[number, number]> = [];

  for (const hub of hubs) {
    const others = hubs
      .filter((other) => other !== hub)
      .map((other) => {
        const a = clusters[nodes[hub].cluster];
        const b = clusters[nodes[other].cluster];
        return { other, dist: Math.hypot(a.homeX - b.homeX, a.homeY - b.homeY) };
      })
      .filter(({ dist }) => dist <= MAX_BRIDGE_DISTANCE)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, BRIDGES_PER_CLUSTER);

    for (const { other } of others) {
      const key = hub < other ? `${hub}:${other}` : `${other}:${hub}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      bridges.push([hub, other]);
    }
  }

  return bridges;
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
    let clusters: Cluster[] = [];
    let nodes: Node[] = [];
    let bridges: Array<[number, number]> = [];
    let neighbors: number[][] = [];
    const signals: Signal[] = [];
    const ripples: Ripple[] = [];
    const pointer = { x: -9999, y: -9999, active: false };
    let animationFrame = 0;
    let running = true;
    let lastNow = 0;
    let lastSpawn = 0;

    const purpleBase = dark ? PURPLE_DARK : PURPLE;
    const edgeAlphaScale = dark ? 0.5 : 0.4;
    const bridgeAlphaScale = dark ? 0.3 : 0.24;
    const nodeAlphaScale = dark ? 0.85 : 0.64;

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

      clusters = createClusters(width, height);
      nodes = createNodes(clusters);
      bridges = createBridges(nodes, clusters);
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

    function pickNextHop(current: number, previous: number): number {
      const options = neighbors[current];
      if (!options || options.length === 0) {
        return -1;
      }
      if (options.length === 1) {
        return options[0] === previous ? -1 : options[0];
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = options[Math.floor(Math.random() * options.length)];
        if (candidate !== previous) {
          return candidate;
        }
      }
      return -1;
    }

    function spawnSignal() {
      for (let attempt = 0; attempt < 12; attempt++) {
        const start = Math.floor(Math.random() * nodes.length);
        const next = pickNextHop(start, -1);
        if (next !== -1) {
          signals.push({
            from: start,
            to: next,
            t: Math.random() * 0.4,
            hops: 0,
            color: SIGNAL_COLORS[Math.floor(Math.random() * SIGNAL_COLORS.length)],
          });
          return;
        }
      }
    }

    function advanceSignals(delta: number) {
      for (let i = signals.length - 1; i >= 0; i--) {
        const signal = signals[i];
        const a = nodes[signal.from];
        const b = nodes[signal.to];
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;

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

        const tailT = Math.max(0, signal.t - SIGNAL_TRAIL);
        const tailX = lerp(a.x, b.x, tailT);
        const tailY = lerp(a.y, b.y, tailT);
        const trail = ctx!.createLinearGradient(tailX, tailY, x, y);
        trail.addColorStop(0, rgba(signal.color, 0));
        trail.addColorStop(1, rgba(signal.color, dark ? 0.8 : 0.68));
        ctx!.globalAlpha = 1;
        ctx!.strokeStyle = trail;
        ctx!.lineWidth = 1.7;
        ctx!.lineCap = 'round';
        ctx!.beginPath();
        ctx!.moveTo(tailX, tailY);
        ctx!.lineTo(x, y);
        ctx!.stroke();

        ctx!.fillStyle = rgba(signal.color, 1);
        ctx!.globalAlpha = dark ? 0.24 : 0.2;
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

    function drawEdge(a: Node, b: Node, proximity: number, scale: number) {
      const warmth = Math.max(a.warmth, b.warmth);
      ctx!.strokeStyle = mixColor(purpleBase, ORANGE, warmth);
      ctx!.globalAlpha = proximity * scale * (0.45 + warmth * 0.55);
      ctx!.lineWidth = 0.7 + warmth;
      ctx!.beginPath();
      ctx!.moveTo(a.x, a.y);
      ctx!.lineTo(b.x, b.y);
      ctx!.stroke();
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

      for (const cluster of clusters) {
        if (prefersReducedMotion) {
          continue;
        }
        cluster.x = cluster.homeX + Math.sin(now * 0.00007 + cluster.phase) * CLUSTER_DRIFT;
        cluster.y = cluster.homeY + Math.cos(now * 0.00009 + cluster.phase) * CLUSTER_DRIFT;
      }

      for (const node of nodes) {
        const cluster = clusters[node.cluster];

        if (!prefersReducedMotion) {
          node.angle += node.angleSpeed * delta;

          if (pointer.active) {
            const dx = node.x - pointer.x;
            const dy = node.y - pointer.y;
            const dist = Math.hypot(dx, dy) || 1;
            if (dist < HOVER_RADIUS) {
              const force = (1 - dist / HOVER_RADIUS) * 0.9;
              node.ovx += (dx / dist) * force;
              node.ovy += (dy / dist) * force;
              node.warmth = Math.max(node.warmth, 1 - dist / HOVER_RADIUS);
            }
          }

          for (const ripple of ripples) {
            const age = now - ripple.startedAt;
            const rippleRadius = (age / RIPPLE_DURATION_MS) * RIPPLE_MAX_RADIUS;
            const dx = node.x - ripple.x;
            const dy = node.y - ripple.y;
            const dist = Math.hypot(dx, dy) || 1;
            const band = Math.abs(dist - rippleRadius);
            if (band < 40) {
              const strength = (1 - age / RIPPLE_DURATION_MS) * (1 - band / 40);
              node.ovx += (dx / dist) * strength * 6;
              node.ovy += (dy / dist) * strength * 6;
              node.warmth = Math.max(node.warmth, strength);
            }
          }

          node.ovx *= 0.9;
          node.ovy *= 0.9;
          node.ox = (node.ox + node.ovx) * 0.93;
          node.oy = (node.oy + node.ovy) * 0.93;
          node.warmth *= 0.94;
          node.flash *= 0.9;
        }

        node.x = cluster.x + Math.cos(node.angle) * node.orbit + node.ox;
        node.y = cluster.y + Math.sin(node.angle) * node.orbit + node.oy;
      }

      for (let i = 0; i < nodes.length; i++) {
        neighbors[i].length = 0;
      }

      // Intra-cluster edges: only same-cluster pairs, so lobes stay distinct.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (nodes[i].cluster !== nodes[j].cluster) {
            continue;
          }
          const dist = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
          if (dist >= INTRA_EDGE_DISTANCE) {
            continue;
          }
          neighbors[i].push(j);
          neighbors[j].push(i);
          drawEdge(nodes[i], nodes[j], 1 - dist / INTRA_EDGE_DISTANCE, edgeAlphaScale);
        }
      }

      // Bridges: always drawn, regardless of length — they are the pathways.
      for (const [from, to] of bridges) {
        neighbors[from].push(to);
        neighbors[to].push(from);
        drawEdge(nodes[from], nodes[to], 1, bridgeAlphaScale);
      }

      if (!prefersReducedMotion) {
        advanceSignals(delta);
        if (signals.length < SIGNAL_TARGET_COUNT && now - lastSpawn > SIGNAL_SPAWN_INTERVAL_MS) {
          lastSpawn = now;
          const batch = Math.min(4, SIGNAL_TARGET_COUNT - signals.length);
          for (let i = 0; i < batch; i++) {
            spawnSignal();
          }
        }
      }

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
        className="absolute left-1/2 top-1/2 w-[70vmin] max-w-none -translate-x-1/2 -translate-y-1/2 select-none opacity-[0.05] dark:opacity-[0.07]"
        draggable={false}
      />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}

export default NetworkBackground;
