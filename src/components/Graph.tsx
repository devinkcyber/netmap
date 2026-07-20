import { useEffect, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { Core, EdgeSingular, ElementDefinition, NodeCollection, NodeSingular, StylesheetJson } from 'cytoscape';
import { useStore, hostMatchesFilters, subnetsOf } from '../store';
import { buildTopology, scanKey, type GraphNode } from '../lib/topology';
import { colorForHost, sizeForHost, statusColor } from '../lib/encodings';
import { isDomainController, adServices, domainsOf } from '../lib/ad';
import { credsForHost, hostsWithCreds } from '../lib/creds';
import { implantsForHost, beaconProgress, type SliverImplant } from '../lib/sliver';
import { bloodhoundHostUrl, bloodhoundName } from '../lib/bloodhound';
import { displayName, openPorts, subnetOf, type Host } from '../types';
import { loadJson, saveJson, on } from '../lib/bus';

interface TooltipState {
  x: number;
  y: number;
  host: Host;
}

const THEME = {
  dark: { edge: '#4a5a6f', edgeInferred: '#384556', label: '#e6edf4', labelSel: '#ffffff', bg: '#07080a', synth: '#39424e', ring: '#aab6c4' },
  light: { edge: '#9aa7b5', edgeInferred: '#bcc6d0', label: '#121820', labelSel: '#000000', bg: '#edeae3', synth: '#aab4bf', ring: '#4a5663' },
};

// Beacon countdown ring (drawn on the overlay canvas), matched to the BeaconTimer bar.
const BEACON_RING = '#5cc8ff';
const BEACON_TRACK = 'rgba(92,200,255,0.22)';
// Ligolo pivot indicator (drawn on the overlay canvas): pink chevrons flanking the node.
const LIGOLO_COLOR = '#e879c7';
// Selected-node highlight, matched to the amber UI accent (operator-terminal theme).
const SELECT_COLOR = '#ffb000';

function styles(theme: 'dark' | 'light'): StylesheetJson {
  const t = THEME[theme];
  return [
    {
      selector: 'node',
      style: {
        width: 'data(size)',
        height: 'data(size)',
        'background-color': 'data(color)',
        label: 'data(label)',
        'font-family': '"IBM Plex Mono", monospace',
        'font-size': 11,
        'font-weight': 'bold',
        color: t.label,
        'text-outline-width': 2.5,
        'text-outline-color': t.bg,
        'text-outline-opacity': 1,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 9,
        // show the full hostname/FQDN under each node — never truncate it
        'text-wrap': 'none',
        // thin separating moat between the fill and the always-on outline ring (below)
        'border-width': 2,
        'border-color': t.bg,
        'border-opacity': 1,
        'transition-property': 'background-color, border-color, border-width, opacity',
        'transition-duration': 150,
      },
    },
    { selector: 'node[kind = "host"]', style: { shape: 'ellipse' } },
    // Hosts carrying a Sliver implant get a thicker overlay ring — push the label down so it clears it.
    { selector: 'node.sliver-ring', style: { 'text-margin-y': 14 } },
    // Domain Controllers are marked by their hexagon shape alone — no colored border.
    // Their contrast/status ring is thickened after the outline rules below.
    { selector: 'node.dc', style: { shape: 'round-hexagon' } },
    // Ligolo pivots and live Sliver C2 implants (sessions/beacons) are all drawn on the
    // overlay canvas (see drawFrame) — pink chevrons and rings, no node glow.
    {
      selector: 'node[kind = "router"]',
      style: { shape: 'diamond', 'background-color': t.synth, 'background-opacity': 0.9 },
    },
    {
      selector: 'node[kind = "subnet"]',
      style: {
        shape: 'round-rectangle',
        'background-color': t.synth,
        'background-opacity': 0.25,
        'border-width': 1.5,
        'border-style': 'dashed',
        'border-color': t.synth,
        'font-size': 11,
      },
    },
    { selector: 'node[kind = "net"], node[kind = "scanner"]', style: { shape: 'round-hexagon', 'background-color': t.synth } },
    {
      // Always-on thin ring on every host node (including DCs), so a node reads against
      // the background even with no vault/note. node[statusColor] and node.auto-owned
      // override the color when the note carries a status.
      selector: 'node[kind = "host"]',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      style: { 'outline-width': 2.5, 'outline-style': 'solid', 'outline-color': t.ring, 'outline-offset': 1 } as any,
    },
    {
      // Node outline (separate from the border) carries the note-status ring, so it sits
      // outside the node's thin separating border. `outline-*` may be missing from the
      // cytoscape typings depending on version, so cast this one style dict.
      selector: 'node[statusColor]',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      style: { 'outline-width': 3, 'outline-style': 'solid', 'outline-color': 'data(statusColor)', 'outline-offset': 1 } as any,
    },
    {
      // Auto-owned (opt-in): a dashed owned-colored ring, only used when the note
      // sets no explicit status, so it never conflicts with node[statusColor].
      selector: 'node.auto-owned',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      style: { 'outline-width': 3, 'outline-style': 'dashed', 'outline-color': '#c774ff', 'outline-offset': 1 } as any,
    },
    {
      // Domain Controllers get a thicker contrast/status ring (the hexagon shape is the DC
      // marker now). Placed after the status/auto-owned rules so the width wins regardless
      // of note status; the ring color still comes from those rules.
      selector: 'node.dc',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      style: { 'outline-width': 4.5 } as any,
    },
    // The Ligolo pivot→subnet "tunnel" path AND the target-subnet outline are both drawn on the
    // overlay canvas (see drawFrame / applyLigoloReach), in the ligolo pink.
    {
      selector: 'node.selected',
      style: {
        'border-width': 3,
        'border-style': 'solid',
        'border-color': SELECT_COLOR,
        color: t.labelSel,
        'underlay-color': SELECT_COLOR,
        'underlay-opacity': 0.18,
        'underlay-padding': 8,
      },
    },
    {
      selector: 'edge',
      style: { width: 1.7, 'line-color': t.edge, 'curve-style': 'straight', 'transition-property': 'opacity', 'transition-duration': 150 },
    },
    { selector: 'edge[?inferred]', style: { 'line-style': 'dashed', 'line-color': t.edgeInferred } },
    { selector: 'edge.hilite', style: { 'line-color': SELECT_COLOR, width: 2.2 } },
    // The path from a Ligolo pivot to the subnet it unlocks, following existing edges (dashed pink).
    // Placed after edge.hilite so a segment that's both on the pivot path AND connected to the
    // selected node stays pink, rather than being overpainted by the orange selection highlight.
    { selector: 'edge.ligolo-path', style: { 'line-color': LIGOLO_COLOR, 'line-style': 'dashed', width: 3, opacity: 1 } },
    { selector: '.faded', style: { opacity: 0.1, 'text-opacity': 0 } },
  ];
}

function layoutOptions(name: string, nodeCount: number): cytoscape.LayoutOptions {
  switch (name) {
    case 'concentric':
      return {
        name: 'concentric',
        animate: false,
        // Rank by node role, not raw degree, so the rings form a clean hierarchy:
        // network/scanner hub at the center, subnets/routers in the middle ring, hosts
        // outside. Raw degree put busy subnets more central than the hub, which tangled
        // the rings and ran edges across the subnet CIDR nodes.
        concentric: (n) => {
          const kind = (n as NodeSingular).data('kind');
          if (kind === 'net' || kind === 'scanner') return 30;
          if (kind === 'subnet' || kind === 'router') return 20;
          return 10;
        },
        levelWidth: () => 5, // one ring per role rank (values spaced by 10)
        minNodeSpacing: 55, // more room around each node so edges clear the CIDR labels
        nodeDimensionsIncludeLabels: true,
        avoidOverlap: true,
      } as cytoscape.LayoutOptions;
    case 'breadthfirst':
      return {
        name: 'breadthfirst',
        animate: false,
        // Pack the tree as tightly as the labels allow. nodeDimensionsIncludeLabels makes
        // avoidOverlap measure each node's real FQDN label, so nodes sit just far enough
        // apart to keep labels from colliding — no more. That lets spacingFactor stay near
        // 1 (a hair of breathing room) instead of a big uniform multiplier, which also
        // shortens the parent→child edges.
        spacingFactor: 1.05,
        avoidOverlap: true,
        nodeDimensionsIncludeLabels: true,
        directed: false,
        padding: 20,
      } as cytoscape.LayoutOptions;
    default: {
      const isHub = (k: unknown) => k === 'net' || k === 'scanner';
      const touchesHub = (e: EdgeSingular) => isHub(e.source().data('kind')) || isHub(e.target().data('kind'));
      return {
        name: 'cose',
        animate: false,
        nodeRepulsion: () => 16000,
        // Long hub spokes + tight host clusters: give the hub edges a long ideal length and the
        // host edges a short one, so each subnet hangs off the hub as a compact ball. cose still
        // buries the biggest cluster's subnet on top of the hub, which spreadHubSpokes() fixes
        // deterministically after the layout settles.
        idealEdgeLength: (edge: EdgeSingular) => (touchesHub(edge) ? 320 : 70),
        numIter: nodeCount > 300 ? 500 : 1000,
        padding: 60,
      } as cytoscape.LayoutOptions;
    }
  }
}

export default function Graph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // Host nodes that currently carry a live beacon, with the beacon to phase the ring on.
  const beaconNodesRef = useRef<{ id: string; im: SliverImplant }[]>([]);
  // Host nodes with a live session — drawn as a full static ring (same style as the beacon ring).
  const sessionNodesRef = useRef<string[]>([]);
  // Host nodes flagged as Ligolo pivots — drawn as pink chevrons on the overlay canvas.
  const ligoloNodesRef = useRef<string[]>([]);
  // Target subnet node ids to outline pink (the pivot→subnet path itself is highlighted on the
  // real graph edges via the ligolo-path class in applyLigoloReach).
  const ligoloTargetNodesRef = useRef<string[]>([]);
  // Overlay animation loop control (runs only while there's something to draw).
  const overlayRafRef = useRef(0);
  const overlayRunningRef = useRef(false);
  const ensureOverlayLoopRef = useRef<(() => void) | null>(null);
  // Shift held → dragging a "parent" node drags its whole downstream group with it
  // (a subnet CIDR node's hosts in subnet view; a router/scanner's subtree in traceroute view).
  const shiftRef = useRef(false);
  const groupDragRef = useRef<{ id: string; group: NodeCollection; last: { x: number; y: number } } | null>(null);
  // Shift+click a subnet/router node arms it for scroll-to-rotate: the wheel then spins that
  // node's children (a subnet's hosts, a router's subtree) around it. Cleared on Esc, a
  // background click, or selecting another node.
  const rotatePivotRef = useRef<string | null>(null);
  const [rotating, setRotating] = useState<{ id: string; label: string } | null>(null);
  // Link mode: while set to a pivot IP, the next subnet-node tap links it as that pivot's target.
  const linkFromRef = useRef<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ip: string } | null>(null);

  const hosts = useStore((s) => s.hosts);
  const mode = useStore((s) => s.topologyMode);
  const mask = useStore((s) => s.mask);
  const layout = useStore((s) => s.layout);
  const colorBy = useStore((s) => s.colorBy);
  const theme = useStore((s) => s.theme);
  const filters = useStore((s) => s.filters);
  const selectedId = useStore((s) => s.selectedId);
  const noteStatusByIp = useStore((s) => s.noteStatusByIp);
  const users = useStore((s) => s.users);
  const ligoloByIp = useStore((s) => s.ligoloByIp);
  const sliverImplants = useStore((s) => s.sliverImplants);
  const sliverMatchOverride = useStore((s) => s.sliverMatchOverride);
  const sliverAutoOwned = useStore((s) => s.sliverAutoOwned);
  const toggleLigolo = useStore((s) => s.toggleLigolo);
  const ligoloTargetByIp = useStore((s) => s.ligoloTargetByIp);
  const clearLigoloTargets = useStore((s) => s.clearLigoloTargets);
  const dcOverrideByIp = useStore((s) => s.dcOverrideByIp);
  const toggleDcOverride = useStore((s) => s.toggleDcOverride);
  const bloodhoundUrl = useStore((s) => s.bloodhoundUrl);
  const noteBhIdByIp = useStore((s) => s.noteBhIdByIp);
  const select = useStore((s) => s.select);

  // ---- init once ----
  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current!,
      style: styles(useStore.getState().theme),
      wheelSensitivity: 0.5, // more responsive wheel zoom (was 0.25)
      minZoom: 0.1,
      maxZoom: 4,
      // We never use Cytoscape's native box-selection; leaving it on makes Shift+drag draw a
      // selection box instead of grabbing the node, which breaks Shift-drag to move a subnet group.
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (e) => {
      const n = e.target as NodeSingular;
      const kind = n.data('kind') as string;
      // Link mode: toggle a subnet the pivot unlocks. A pivot can unlock several subnets, so we
      // stay in link mode after each tap (Esc or a background click finishes). In subnet view tap
      // the subnet node; in traceroute view (no subnet nodes) tap any host in the target subnet.
      if (linkFromRef.current) {
        const pivot = linkFromRef.current;
        let cidr: string | null = null;
        if (kind === 'subnet') cidr = (n.id() as string).replace(/^subnet:/, '');
        else if (kind === 'host') cidr = subnetOf(n.id() as string, useStore.getState().mask);
        if (cidr && cidr !== 'other') {
          const wasLinked = (useStore.getState().ligoloTargetByIp[pivot] ?? []).includes(cidr);
          useStore.getState().toggleLigoloTarget(pivot, cidr);
          useStore.getState().showToast(
            wasLinked ? `Ligolo: ${pivot} ⊘ ${cidr} removed.` : `Ligolo: ${pivot} → ${cidr} unlocked.`,
          );
        } else {
          useStore.getState().showToast('Pick a subnet, or a host in one. Esc when done.');
        }
        return; // stay in link mode to toggle more subnets
      }
      // Shift+click a subnet or router arms it for scroll-to-rotate (spin its children). A Shift
      // *drag* still moves the group; only a click (no drag) arms rotation.
      const shiftHeld = (e.originalEvent as MouseEvent | undefined)?.shiftKey ?? shiftRef.current;
      if (shiftHeld && (kind === 'subnet' || kind === 'router')) {
        rotatePivotRef.current = n.id() as string;
        setRotating({ id: n.id() as string, label: (n.data('label') as string) || (n.id() as string) });
        cy.userZoomingEnabled(false); // the wheel now rotates instead of zooming, until disarmed
        select(n.id() as string);
        return;
      }
      disarmRotate();
      // Every node is selectable — selecting one highlights its connected edges and opens its
      // pane. For a subnet that's the edges to its hosts; for the scanner/network hub, its links
      // to the first hops/subnets (matching what arrow-key navigation can already reach).
      select(n.id() as string);
    });
    cy.on('tap', (e) => {
      if (e.target === cy) {
        if (linkFromRef.current) {
          linkFromRef.current = null;
          setLinkFrom(null);
        }
        disarmRotate();
        select(null);
      }
      setMenu(null);
    });
    // Right-click a host → context menu (e.g. toggle a Ligolo pivot flag).
    cy.on('cxttap', 'node[kind = "host"]', (e) => {
      const n = e.target as NodeSingular;
      const p = n.renderedPosition();
      setTooltip(null);
      setMenu({ x: p.x, y: p.y, ip: n.id() });
    });
    cy.on('cxttap', (e) => {
      if (e.target === cy) setMenu(null);
    });
    cy.on('dbltap', (e) => {
      if (e.target === cy) cy.animate({ fit: { eles: cy.elements(), padding: 60 }, duration: 250 });
    });
    cy.on('mouseover', 'node[kind = "host"]', (e) => {
      const n = e.target as NodeSingular;
      const host = n.data('host') as Host | undefined;
      if (!host) return;
      const p = n.renderedPosition();
      setTooltip({ x: p.x, y: p.y - (n.renderedHeight() / 2 + 12), host });
    });
    cy.on('mouseout mousedown', 'node', () => setTooltip(null));
    cy.on('pan zoom', () => {
      setTooltip(null);
      setMenu(null);
    });
    cy.on('dragfree', 'node', () => savePositions(cy));

    // Shift-drag a "parent" node → move a group of nodes along with it. On grab we capture that
    // group; on each drag tick we shift it by the same delta the grabbed node moved.
    //  • subnet CIDR node → its member hosts (subnet view)
    //  • router → its whole downstream subtree (traceroute view; edges run scanner → host)
    //  • scanner → only its directly-connected "initial" sub-nodes (first hops / attached hosts).
    //    Its full subtree is the entire graph, so a subtree drag would just pan everything; moving
    //    just the first level brings the scanner's immediate cluster, like a CIDR node's hosts.
    const GROUP_DRAG_SELECTOR = 'node[kind = "subnet"], node[kind = "router"], node[kind = "scanner"]';
    const groupFor = (n: NodeSingular): NodeCollection => {
      const kind = n.data('kind');
      if (kind === 'subnet') return n.neighborhood().nodes('[kind = "host"]');
      if (kind === 'scanner') return n.neighborhood().nodes(); // direct children only (its subtree is everything)
      return n.successors().nodes(); // router: its downstream subtree
    };
    cy.on('grab', GROUP_DRAG_SELECTOR, (e) => {
      // Read the modifier from the grab's own mouse event (robust); fall back to the key-tracked ref.
      const shiftHeld = (e.originalEvent as MouseEvent | undefined)?.shiftKey ?? shiftRef.current;
      if (!shiftHeld) return;
      const n = e.target as NodeSingular;
      groupDragRef.current = { id: n.id(), group: groupFor(n), last: { ...n.position() } };
    });
    cy.on('drag', GROUP_DRAG_SELECTOR, (e) => {
      const st = groupDragRef.current;
      const n = e.target as NodeSingular;
      if (!st || n.id() !== st.id) return;
      const p = n.position();
      const dx = p.x - st.last.x;
      const dy = p.y - st.last.y;
      st.group.forEach((h) => {
        h.position({ x: h.position('x') + dx, y: h.position('y') + dy });
      });
      st.last = { x: p.x, y: p.y };
    });
    cy.on('dragfree', GROUP_DRAG_SELECTOR, () => {
      groupDragRef.current = null; // save handled by the generic 'dragfree' on 'node'
    });

    // Scroll-to-rotate: while a subnet/router is armed (Shift+click), the wheel spins its children
    // around it instead of zooming (zoom is disabled on arm). Direction follows the wheel; the
    // per-tick angle scales with the delta and is clamped so trackpads and mice both feel sane.
    let rotateSaveTimer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (ev: WheelEvent) => {
      const pivotId = rotatePivotRef.current;
      if (!pivotId) return; // not armed → let Cytoscape zoom normally
      const pivot = cy.getElementById(pivotId);
      if (pivot.empty()) {
        disarmRotate();
        return;
      }
      ev.preventDefault();
      const group = groupFor(pivot);
      if (group.empty()) return;
      const c = pivot.position();
      const theta = Math.max(-0.2, Math.min(0.2, ev.deltaY * 0.0015)); // radians per tick, clamped
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      cy.batch(() => {
        group.forEach((m) => {
          const dx = m.position('x') - c.x;
          const dy = m.position('y') - c.y;
          m.position({ x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos });
        });
      });
      setTooltip(null);
      setMenu(null);
      clearTimeout(rotateSaveTimer);
      rotateSaveTimer = setTimeout(() => savePositions(cy), 300); // persist like a drag, debounced
    };
    const wheelEl = containerRef.current;
    wheelEl?.addEventListener('wheel', onWheel, { passive: false });

    const offFit = on('fit', () => cy.animate({ fit: { eles: cy.elements(), padding: 60 }, duration: 250 }));
    const offReset = on('reset-layout', () => positionNodes(cy, true)); // re-run layout, discard drags
    const offFocus = on('focus', (id) => {
      const n = cy.getElementById(id);
      if (n.nonempty()) {
        select(id);
        cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1.2), duration: 300 });
      }
    });
    const offExport = on('export-png', () => {
      const bg = THEME[useStore.getState().theme].bg;
      const uri = cy.png({ output: 'base64uri', full: true, scale: 2, bg });
      const a = document.createElement('a');
      a.href = uri;
      a.download = `netmap-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
    });

    // Keep the renderer sized to its real container (left-rail toggle, window resize).
    // The note panel is an overlay that doesn't change this size, so panel resizing
    // never triggers a graph re-render.
    const ro = new ResizeObserver(() => cy.resize());
    if (containerRef.current) ro.observe(containerRef.current);

    // Animated per-beacon countdown rings on a canvas overlay. The ring is a clock
    // face that fills clockwise from 12 o'clock as the beacon nears its next
    // check-in, phased on the same beaconProgress() the BeaconTimer bar uses. Drawn
    // every frame so it tracks pan/zoom/drag and stays in sync with the sidebar.
    const drawFrame = () => {
      const canvas = overlayRef.current;
      const cont = containerRef.current;
      if (!canvas || !cont) {
        overlayRunningRef.current = false;
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        overlayRunningRef.current = false;
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = cont.clientWidth;
      const h = cont.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const beacons = beaconNodesRef.current;
      const sessions = sessionNodesRef.current;
      const ligolos = ligoloNodesRef.current;
      const targetNodes = ligoloTargetNodesRef.current;
      if (beacons.length === 0 && sessions.length === 0 && ligolos.length === 0 && targetNodes.length === 0) {
        overlayRunningRef.current = false; // nothing to draw; canvas is cleared — pause the loop
        return;
      }
      // These adornments live in graph space, so their offsets/strokes scale with the zoom (like
      // node borders): renderedWidth() already scales, and the constant gaps are multiplied by `z`.
      // Without this, on zoom-out the fixed gaps dwarf the shrinking nodes and overlap neighbours.
      const z = cy.zoom();
      const lw = (base: number) => Math.max(0.75, base * z); // stroke widths, floored so they stay crisp
      // Pink outline around each unlocked (target) subnet node; the path to it is highlighted on
      // the real graph edges (ligolo-path class), not drawn here.
      for (const id of targetNodes) {
        const b = cy.getElementById(id);
        if (b.empty() || b.hasClass('faded')) continue;
        const pb = b.renderedPosition();
        const bw = b.renderedWidth();
        const bh = b.renderedHeight();
        const pad = 3 * z;
        ctx.strokeStyle = LIGOLO_COLOR;
        ctx.lineWidth = lw(2.5);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(pb.x - bw / 2 - pad, pb.y - bh / 2 - pad, bw + pad * 2, bh + pad * 2, 6 * z);
        else ctx.rect(pb.x - bw / 2 - pad, pb.y - bh / 2 - pad, bw + pad * 2, bh + pad * 2);
        ctx.stroke();
      }
      // Full static ring for session nodes — same style as the beacon ring, no sweep.
      for (const id of sessions) {
        const n = cy.getElementById(id);
        if (n.empty() || n.hasClass('faded')) continue;
        const p = n.renderedPosition();
        const rad = Math.max(n.renderedWidth(), n.renderedHeight()) / 2 + 7 * z;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.lineWidth = lw(4.5);
        ctx.strokeStyle = BEACON_RING;
        ctx.stroke();
      }
      for (const { id, im } of beacons) {
        const n = cy.getElementById(id);
        if (n.empty() || n.hasClass('faded')) continue;
        const p = n.renderedPosition();
        const rad = Math.max(n.renderedWidth(), n.renderedHeight()) / 2 + 7 * z;
        const progress = Math.min(1, Math.max(0, beaconProgress(im).progress));
        const start = -Math.PI / 2;
        const end = start + progress * Math.PI * 2;
        // faint full track — the "clock face"
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.lineWidth = lw(3.5);
        ctx.strokeStyle = BEACON_TRACK;
        ctx.stroke();
        // bright sweep, filling toward the next check-in
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, start, end);
        ctx.lineWidth = lw(4.5);
        ctx.lineCap = 'round';
        ctx.strokeStyle = BEACON_RING;
        ctx.stroke();
        // leading "hand" tip
        ctx.beginPath();
        ctx.arc(p.x + rad * Math.cos(end), p.y + rad * Math.sin(end), 2.8 * z, 0, Math.PI * 2);
        ctx.fillStyle = BEACON_RING;
        ctx.fill();
      }
      // Ligolo pivot: pink chevrons flanking the node, evoking traffic pivoting through it.
      // Sit them outside where a Sliver session/beacon ring would draw (halfMax + 7, ~1.5 stroke)
      // so the two encodings don't overlap on a host that has both.
      for (const id of ligolos) {
        const n = cy.getElementById(id);
        if (n.empty() || n.hasClass('faded')) continue;
        const p = n.renderedPosition();
        const rad = Math.max(n.renderedWidth(), n.renderedHeight()) / 2 + 13 * z;
        const armW = 5 * z;
        const armH = 6 * z;
        ctx.strokeStyle = LIGOLO_COLOR;
        ctx.lineWidth = lw(2.5);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const lx = p.x - rad; // left chevron ">", tip pointing at the node
        ctx.beginPath();
        ctx.moveTo(lx - armW, p.y - armH);
        ctx.lineTo(lx, p.y);
        ctx.lineTo(lx - armW, p.y + armH);
        ctx.stroke();
        const rx = p.x + rad; // right chevron "<", tip pointing at the node
        ctx.beginPath();
        ctx.moveTo(rx + armW, p.y - armH);
        ctx.lineTo(rx, p.y);
        ctx.lineTo(rx + armW, p.y + armH);
        ctx.stroke();
      }
      overlayRafRef.current = requestAnimationFrame(drawFrame);
    };
    const ensureOverlayLoop = () => {
      if (overlayRunningRef.current) return;
      overlayRunningRef.current = true;
      overlayRafRef.current = requestAnimationFrame(drawFrame);
    };
    ensureOverlayLoopRef.current = ensureOverlayLoop;
    ensureOverlayLoop();

    return () => {
      cancelAnimationFrame(overlayRafRef.current);
      overlayRunningRef.current = false;
      wheelEl?.removeEventListener('wheel', onWheel);
      clearTimeout(rotateSaveTimer);
      offFit();
      offReset();
      offFocus();
      offExport();
      ro.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- rebuild elements when data or encodings change ----
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const topo = buildTopology(hosts, mode, mask);
    const subnetIndex = new Map(subnetsOf(hosts, mask).map((s, i) => [s, i]));
    const domainIndex = new Map(domainsOf(hosts).map((d, i) => [d, i]));

    const els: ElementDefinition[] = [
      ...topo.nodes.map((n) => nodeDef(n, subnetIndex, domainIndex)),
      ...topo.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, inferred: !!e.inferred } })),
    ];

    cy.startBatch();
    cy.elements().remove();
    cy.add(els);
    topo.nodes.forEach((n) => {
      const el = cy.getElementById(n.id);
      if (n.kind === 'host' && n.host && isDomainController(n.host)) el.addClass('dc');
    });
    cy.endBatch();

    // Restore this view's saved arrangement, or run the layout for it.
    positionNodes(cy);
    applyFilters(cy);
    applySelection(cy, selectedId);
    applyLigoloReach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts, mode, mask, colorBy, noteStatusByIp]);

  // ---- DC override: update hexagon class + size + color in place (no rebuild/refit) ----
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const subnetIndex = new Map(subnetsOf(hosts, mask).map((s, i) => [s, i]));
    const domainIndex = new Map(domainsOf(hosts).map((d, i) => [d, i]));
    cy.batch(() => {
      cy.nodes('[kind = "host"]').forEach((n) => {
        const host = n.data('host') as Host | undefined;
        if (!host) return;
        n.toggleClass('dc', isDomainController(host));
        n.data('size', sizeForHost(host));
        n.data('color', colorForHost(host, colorBy, subnetIndex, subnetOf(host.ip, mask), domainIndex));
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dcOverrideByIp]);

  // ---- credential (🔑) / Ligolo (📡) label markers + Sliver implant ring sets on host nodes ----
  // Cheap: updates labels + marker classes in place and refreshes the beacon/session
  // node sets the overlay canvas draws rings from. No rebuild/refit.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const credIps = hostsWithCreds(hosts, users);
    const beaconNodes: { id: string; im: SliverImplant }[] = [];
    const sessionNodes: string[] = [];
    const ligoloNodes: string[] = [];
    cy.batch(() => {
      cy.nodes('[kind = "host"]').forEach((n) => {
        const host = n.data('host') as Host | undefined;
        if (!host) return;
        const isLigolo = !!ligoloByIp[host.ip];
        const live = implantsForHost(host, sliverImplants, sliverMatchOverride).filter((i) => !i.isDead);
        const hasSession = live.some((i) => i.kind === 'session');
        const beacon = live.find((i) => i.kind === 'beacon');
        // Sliver implants (session and beacon alike) are shown only by their ring on
        // the overlay canvas — no label marker or node glow.
        const markers = `${credIps.has(host.ip) ? '  🔑' : ''}${isLigolo ? '  📡' : ''}`;
        n.data('label', displayName(host) + markers);
        if (isLigolo) ligoloNodes.push(n.id());
        // Opt-in: a live session marks the host "owned" visually, unless the note
        // already sets an explicit status (which owns the status ring itself).
        n.toggleClass('auto-owned', sliverAutoOwned && hasSession && !noteStatusByIp[host.ip]);
        if (hasSession) sessionNodes.push(n.id());
        if (beacon && !hasSession) beaconNodes.push({ id: n.id(), im: beacon });
        // A session or beacon draws a ring on this node → nudge its label down to clear it.
        n.toggleClass('sliver-ring', hasSession || !!beacon);
      });
    });
    beaconNodesRef.current = beaconNodes;
    sessionNodesRef.current = sessionNodes;
    ligoloNodesRef.current = ligoloNodes;
    // Resume the overlay loop if it paused (or let it clear away removed adornments).
    ensureOverlayLoopRef.current?.();
     
  }, [users, hosts, ligoloByIp, sliverImplants, sliverMatchOverride, sliverAutoOwned, noteStatusByIp]);

  function nodeDef(n: GraphNode, subnetIndex: Map<string, number>, domainIndex: Map<string, number>): ElementDefinition {
    if (n.kind === 'host' && n.host) {
      const ring = statusColor(noteStatusByIp[n.host.ip]);
      return {
        data: {
          id: n.id,
          kind: n.kind,
          label: displayName(n.host),
          host: n.host,
          color: colorForHost(n.host, colorBy, subnetIndex, n.subnet, domainIndex),
          size: sizeForHost(n.host),
          ...(ring ? { statusColor: ring } : {}),
        },
      };
    }
    const size = n.kind === 'router' ? 26 : n.kind === 'subnet' ? 44 : 34;
    return { data: { id: n.id, kind: n.kind, label: n.label, color: THEME[theme].synth, size } };
  }

  // ---- explicit layout re-run when the user changes layout ----
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    const cy = cyRef.current;
    if (!cy || cy.nodes().empty()) return;
    positionNodes(cy);
    // Only re-run on an explicit layout change, not when positionNodes' identity churns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // ---- theme restyle ----
  useEffect(() => {
    cyRef.current?.style(styles(theme));
  }, [theme]);

  // Changing the topology view (mode/mask) rebuilds node ids, so any armed rotation pivot is
  // stale — disarm and restore zoom.
  useEffect(() => {
    disarmRotate();
  }, [mode, mask]);

  // ---- filters ----
  function applyFilters(cy: Core) {
    const { filters: f, mask: m, noteStatusByIp: statusMap, sliverImplants: imps, sliverMatchOverride: ov } = useStore.getState();
    const visible = new Set<string>();
    cy.nodes('[kind = "host"]').forEach((n) => {
      const host = n.data('host') as Host;
      // Only resolve live implants for the host when the Sliver filter is active.
      const live = f.sliver ? implantsForHost(host, imps, ov).filter((i) => !i.isDead) : [];
      const sliver = { session: live.some((i) => i.kind === 'session'), beacon: live.some((i) => i.kind === 'beacon') };
      if (hostMatchesFilters(host, f, m, statusMap, sliver)) visible.add(n.id());
    });
    cy.startBatch();
    cy.nodes().forEach((n) => {
      const kind = n.data('kind') as string;
      if (kind === 'host') {
        n.toggleClass('faded', !visible.has(n.id()));
      } else {
        // synthetic nodes fade only when none of their neighbors are visible
        const anyVisible = n.neighborhood('node[kind = "host"]').toArray().some((x) => visible.has(x.id()));
        const structural = kind === 'net' || kind === 'scanner';
        n.toggleClass('faded', !structural && !anyVisible);
      }
    });
    cy.edges().forEach((e) => {
      e.toggleClass('faded', e.source().hasClass('faded') || e.target().hasClass('faded'));
    });
    cy.endBatch();
  }
  useEffect(() => {
    if (cyRef.current) applyFilters(cyRef.current);
    // Re-apply when implants change so the Sliver filter tracks live sessions/beacons.
     
  }, [filters, noteStatusByIp, sliverImplants, sliverMatchOverride]);

  // ---- selection highlight ----
  function applySelection(cy: Core, id: string | null) {
    cy.nodes().removeClass('selected');
    cy.edges().removeClass('hilite');
    if (!id) return;
    const n = cy.getElementById(id);
    if (n.nonempty()) {
      n.addClass('selected');
      n.connectedEdges().addClass('hilite');
    }
  }
  useEffect(() => {
    if (cyRef.current) applySelection(cyRef.current, selectedId);
     
  }, [selectedId]);

  // ---- Ligolo pivot → unlocked subnet: highlight the target subnet + the pink tunnel path ----
  // Each active pivot with a linked subnet (ligoloTargetByIp) gets a pink "tunnel" line drawn from
  // the pivot to the reachable target. Only subnet CIDR nodes take the pink outline (targetNodes) —
  // in traceroute view (no subnet node) the target's member hosts get just the pink path, no
  // outline, since outlining every reachable host is too noisy.
  function applyLigoloReach() {
    const cy = cyRef.current;
    const { ligoloByIp: ligolo, ligoloTargetByIp: targets, topologyMode: tm, mask } = useStore.getState();
    const targetNodes: string[] = [];
    if (cy) {
      cy.batch(() => {
        cy.edges().removeClass('ligolo-path');
        for (const ip of Object.keys(targets)) {
          if (!ligolo[ip]) continue; // only for hosts still flagged as pivots
          const pivot = cy.getElementById(ip);
          if (pivot.empty()) continue;
          const highlightPathTo = (goal: NodeSingular) => {
            const res = cy.elements().aStar({ root: pivot, goal, directed: false });
            if (res.found) res.path.edges().addClass('ligolo-path');
          };
          // A pivot can unlock several subnets — light the tunnel path to each.
          for (const cidr of targets[ip]) {
            if (tm === 'subnet') {
              const subnetNode = cy.getElementById(`subnet:${cidr}`);
              if (subnetNode.empty()) continue;
              highlightPathTo(subnetNode); // pivot → its subnet → hub → target subnet
              targetNodes.push(`subnet:${cidr}`); // outline the target CIDR node
            } else {
              // Traceroute: no subnet node — light the path to each member host, but don't outline them.
              cy.nodes('[kind = "host"]').forEach((h) => {
                if (subnetOf(h.id(), mask) !== cidr || h.id() === ip) return;
                highlightPathTo(h);
              });
            }
          }
          // Also outline the subnet the pivot itself sits in — the "entry" subnet it bridges from.
          // Only meaningful in subnet view (its CIDR node); traceroute has no subnet node to outline.
          if (tm === 'subnet') {
            const own = subnetOf(ip, mask);
            if (own && own !== 'other' && cy.getElementById(`subnet:${own}`).nonempty()) {
              targetNodes.push(`subnet:${own}`);
            }
          }
        }
      });
    }
    ligoloTargetNodesRef.current = targetNodes;
    ensureOverlayLoopRef.current?.();
  }
  useEffect(() => {
    applyLigoloReach();
     
  }, [ligoloByIp, ligoloTargetByIp]);

  // Cancel link mode on Escape.
  useEffect(() => {
    if (!linkFrom) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        linkFromRef.current = null;
        setLinkFrom(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linkFrom]);

  // Keyboard: track Shift (for shift-drag group move) and arrow-key node navigation.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Shift') shiftRef.current = true;
      if (e.key === 'Escape' && rotatePivotRef.current) {
        disarmRotate();
        return;
      }
      if (!ARROW_DIR[e.key]) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      const cy = cyRef.current;
      if (!cy || cy.nodes().empty()) return;
      e.preventDefault();
      const cur = useStore.getState().selectedId;
      const target =
        cur && cy.getElementById(cur).nonempty()
          ? nearestInDirection(cy, cur, e.key)
          : cy.nodes('[kind = "host"]').not('.faded').first().id() || null; // no selection yet → start somewhere
      if (!target) return;
      select(target);
      // Pan to keep the newly selected node on-screen only when it's near/beyond the edge.
      const n = cy.getElementById(target);
      const bb = n.renderedBoundingBox();
      const m = 80;
      if (bb.x1 < m || bb.y1 < m || bb.x2 > cy.width() - m || bb.y2 > cy.height() - m) {
        cy.animate({ center: { eles: n }, duration: 150 });
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Shift') shiftRef.current = false;
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Position store key: per scan+view AND per layout, so each layout keeps its own
  // arrangement. Switching Tree → Circle → Tree restores the Tree you dragged rather
  // than re-running it.
  function posKey(): string {
    const { hosts: h, topologyMode: m, mask: mk, layout: ly } = useStore.getState();
    return `${scanKey(h, m, mk)}:${ly}`;
  }

  function savePositions(cy: Core) {
    const pos: Record<string, { x: number; y: number }> = {};
    cy.nodes().forEach((n) => {
      pos[n.id()] = { x: n.position('x'), y: n.position('y') };
    });
    saveJson(posKey(), pos);
  }

  // Disarm scroll-to-rotate: forget the armed pivot, hide the hint, and restore wheel zoom.
  function disarmRotate() {
    rotatePivotRef.current = null;
    setRotating(null);
    cyRef.current?.userZoomingEnabled(true);
  }

  // Nearest selectable node from `fromId` in an arrow-key direction: only nodes inside a 45° cone
  // ahead count, scored to prefer ones that are both close and well-aligned with the direction.
  const ARROW_DIR: Record<string, [number, number]> = {
    ArrowRight: [1, 0],
    ArrowLeft: [-1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  // Up/Down follow the tree — they prefer a *connected* parent/child in that direction (the logical
  // node above/below, even if it sits off to one side), and only fall back to a plain geometric pick
  // when the node has no connected neighbour that way. Left/Right stay geometric so they walk a row.
  // Navigable kinds match click-selection: host, router, subnet.
  function nearestInDirection(cy: Core, fromId: string, dir: string): string | null {
    const from = cy.getElementById(fromId);
    const dv = ARROW_DIR[dir];
    if (from.empty() || !dv) return null;
    const p = from.position();
    // includeHub also allows the network/scanner hub, so Up from a subnet can reach "network".
    const navigable = (n: NodeSingular, includeHub: boolean) => {
      if (n.hasClass('faded')) return false;
      const k = n.data('kind') as string;
      if (k === 'host' || k === 'router' || k === 'subnet') return true;
      return includeHub && (k === 'net' || k === 'scanner');
    };
    // Pick the best node ahead in `dir`. `cone` restricts to a ~45° wedge (for row-walking);
    // without it, any node in the direction counts (for following an edge to an off-centre parent).
    const pick = (nodes: NodeCollection, cone: boolean, includeHub: boolean): string | null => {
      let best: string | null = null;
      let bestScore = Infinity;
      nodes.forEach((n) => {
        if (n.id() === fromId || !navigable(n, includeHub)) return;
        const dx = n.position('x') - p.x;
        const dy = n.position('y') - p.y;
        const along = dx * dv[0] + dy * dv[1]; // distance in the arrow's direction
        const perp = Math.abs(dx * dv[1] - dy * dv[0]); // sideways offset from that direction
        if (along <= 1 || (cone && perp > along)) return;
        const score = along + perp * 2; // closest & most aligned wins
        if (score < bestScore) {
          bestScore = score;
          best = n.id();
        }
      });
      return best;
    };
    if (dir === 'ArrowUp' || dir === 'ArrowDown') {
      const connected = pick(from.neighborhood().nodes(), false, true); // logical parent/child (hub allowed)
      if (connected) return connected;
    }
    return pick(cy.nodes(), true, false); // row-walk / fallback — hub excluded
  }

  // Restore this view+layout's saved node positions if we have a (near-)complete set;
  // otherwise run the layout algorithm and persist the result. Persisting a fresh run
  // keeps every layout — including the non-deterministic force layout — stable when you
  // leave and return to it. Manual drags (saved on `dragfree`) are restored the same way.
  // force = true re-runs the layout from scratch, ignoring (and overwriting) any saved manual
  // arrangement — used by the "Reset view" command.
  function positionNodes(cy: Core, force = false) {
    const { layout: ly } = useStore.getState();
    const nodes = cy.nodes();
    const saved = force ? {} : loadJson<Record<string, { x: number; y: number }>>(posKey(), {});
    const savedCount = nodes.filter((n) => !!saved[n.id()]).length;
    let usedSaved = false;
    if (savedCount >= nodes.length * 0.9 && nodes.length > 0) {
      nodes.forEach((n) => {
        const p = saved[n.id()];
        if (p) n.position(p);
      });
      // Discard a save that spreads nodes pathologically far apart (corrupted/stale) and
      // re-run the layout instead, so a broken save can't leave the map absurdly spread out.
      const bb = cy.elements().boundingBox();
      usedSaved = Math.max(bb.w, bb.h) <= nodes.length * 600;
    }
    if (!usedSaved) {
      cy.layout(layoutOptions(ly, nodes.length)).run();
      if (ly === 'cose') spreadHubSpokes(cy); // guarantee long hub spokes (cose can't reliably)
      else if (ly === 'breadthfirst') tightenTreeRows(cy); // pack each parent's children together
    }
    cy.fit(cy.elements(), 60);
    if (!usedSaved) savePositions(cy);
  }

  // Tree view (both subnet and traceroute): breadthfirst spaces every node in a row by one uniform
  // column width (set by the widest FQDN label), so short-label nodes end up with big gaps and a
  // parent's children read as spread out. Re-pack each row using the nodes' own label widths — a
  // tight gap between siblings that share a parent, a wider gap where the group changes — so each
  // parent's children (a subnet's hosts, or a hop's hosts) sit close together and distinct groups
  // separate. Left-to-right packing can't overlap; the row stays centered where it was.
  function tightenTreeRows(cy: Core) {
    const GAP = 22; // between adjacent labels within one sibling group
    const GROUP_GAP = 70; // between different sibling groups
    const parentsOf = (n: NodeSingular) => n.neighborhood('node').filter((m) => (m as NodeSingular).position('y') < n.position('y') - 30);
    const sameGroup = (a: NodeSingular, b: NodeSingular) => parentsOf(a).intersection(parentsOf(b)).nonempty();
    // bucket nodes into rows by y (tolerating small variance)
    const rows = new Map<number, NodeSingular[]>();
    cy.nodes().forEach((n) => {
      const key = [...rows.keys()].find((k) => Math.abs(k - n.position('y')) < 40) ?? Math.round(n.position('y'));
      (rows.get(key) ?? rows.set(key, []).get(key)!).push(n);
    });
    rows.forEach((row) => {
      if (row.length < 2) return;
      row.sort((a, b) => a.position('x') - b.position('x'));
      const half = row.map((n) => n.boundingBox({ includeLabels: true }).w / 2);
      const center = (row[0].position('x') + row[row.length - 1].position('x')) / 2; // keep the row where it is
      const xs: number[] = [];
      let cur = 0;
      for (let i = 0; i < row.length; i++) {
        if (i > 0) cur += half[i - 1] + (sameGroup(row[i - 1], row[i]) ? GAP : GROUP_GAP) + half[i];
        xs.push(cur);
      }
      const shift = center - (xs[0] + xs[xs.length - 1]) / 2;
      row.forEach((n, i) => n.position('x', xs[i] + shift));
    });
  }

  // Force view only: cose reliably buries the biggest host cluster's subnet on top of the
  // central hub (net/scanner) even with long ideal edge lengths. After the layout settles,
  // push any hub neighbour that's still too close radially outward — carrying its own host
  // cluster with it — so every spoke off the hub reads as a long edge.
  function spreadHubSpokes(cy: Core) {
    const MIN_SPOKE = 340;
    const hubs = cy.nodes('[kind = "net"], [kind = "scanner"]');
    hubs.forEach((hub) => {
      const hp = hub.position();
      hub.neighborhood('node').forEach((sub) => {
        const dx = sub.position('x') - hp.x;
        const dy = sub.position('y') - hp.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d >= MIN_SPOKE) return;
        const sx = (dx / d) * (MIN_SPOKE - d);
        const sy = (dy / d) * (MIN_SPOKE - d);
        // the subnet plus its own (non-hub) neighbours = its host cluster; move it as one unit
        const cluster = sub.union(sub.neighborhood('node').difference(hubs));
        cluster.positions((n) => ({ x: n.position('x') + sx, y: n.position('y') + sy }));
      });
    });
  }

  const menuHost = menu ? hosts.find((h) => h.ip === menu.ip) : undefined;

  return (
    <div className="relative h-full w-full overflow-hidden" onContextMenu={(e) => e.preventDefault()}>
      <div ref={containerRef} className="h-full w-full" />
      {/* Animated beacon check-in rings render here, above the graph but below tooltips/menus. */}
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 z-10 h-full w-full" />
      {hosts.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="font-mono text-sm text-ink-3">No scan loaded.</p>
            <p className="mt-1 text-sm text-ink-3">
              Import an <span className="font-mono">nmap -oX</span> file to draw the map.
            </p>
          </div>
        </div>
      )}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-none border border-line bg-panel/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="flex items-center gap-1.5">
            <span className="font-mono font-medium text-ink-1">{displayName(tooltip.host)}</span>
            {isDomainController(tooltip.host) && (
              <span className="rounded-none border border-warn/50 px-1 text-[9px] font-semibold uppercase tracking-wide text-warn">DC</span>
            )}
          </div>
          <div className="font-mono text-ink-2">{tooltip.host.ip}</div>
          {tooltip.host.os && <div className="mt-0.5 text-ink-2">{tooltip.host.os}</div>}
          {adServices(tooltip.host).length > 0 && (
            <div className="mt-0.5 text-[12px] text-warn">AD: {adServices(tooltip.host).join(', ')}</div>
          )}
          {credsForHost(tooltip.host, users).length > 0 && (
            <div className="mt-0.5 text-[12px] text-accent">
              🔑 {credsForHost(tooltip.host, users).length} credential{credsForHost(tooltip.host, users).length === 1 ? '' : 's'}
            </div>
          )}
          {ligoloByIp[tooltip.host.ip] && <div className="mt-0.5 text-[12px]" style={{ color: '#e879c7' }}>📡 Ligolo pivot</div>}
          {(() => {
            const live = implantsForHost(tooltip.host, sliverImplants, sliverMatchOverride).filter((i) => !i.isDead);
            const s = live.filter((i) => i.kind === 'session').length;
            const b = live.filter((i) => i.kind === 'beacon').length;
            if (!s && !b) return null;
            return (
              <div className="mt-0.5 text-[12px]" style={{ color: '#ff6478' }}>
                {s ? `◉ ${s} Sliver session${s === 1 ? '' : 's'}` : ''}
                {s && b ? ' · ' : ''}
                {b ? `◌ ${b} beacon${b === 1 ? '' : 's'}` : ''}
              </div>
            );
          })()}
          <div className="mt-0.5 text-ink-3">
            {openPorts(tooltip.host).length} open
            {openPorts(tooltip.host).length > 0 && (
              <span className="font-mono"> · {openPorts(tooltip.host).slice(0, 5).map((p) => p.number).join(', ')}</span>
            )}
          </div>
        </div>
      )}
      {menu && (
        <div
          className="absolute z-30 min-w-[172px] overflow-hidden rounded-none border border-line bg-panel py-1 text-xs shadow-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          <div className="truncate px-3 py-1 font-mono text-[11px] text-ink-3">{menuHost ? displayName(menuHost) : menu.ip}</div>
          {menuHost && (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raise"
              onClick={() => {
                toggleDcOverride(menu.ip);
                setMenu(null);
              }}
            >
              <span aria-hidden className="text-[13px] leading-none" style={{ color: '#e3b341' }}>
                ⬢
              </span>
              {isDomainController(menuHost) ? 'Unmark Domain Controller' : 'Mark as Domain Controller'}
            </button>
          )}
          {menuHost && (
            <a
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raise"
              href={bloodhoundHostUrl(bloodhoundUrl, menuHost, noteBhIdByIp[menu.ip])}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenu(null)}
              title={
                noteBhIdByIp[menu.ip]
                  ? `Open ${noteBhIdByIp[menu.ip]} in BloodHound CE`
                  : `Search ${bloodhoundName(menuHost)} in BloodHound CE`
              }
            >
              <svg className="shrink-0 text-ink-1" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <ellipse cx="5.6" cy="11" rx="2.1" ry="2.8" />
                <ellipse cx="10" cy="7" rx="2.2" ry="3" />
                <ellipse cx="14.5" cy="7" rx="2.2" ry="3" />
                <ellipse cx="18.9" cy="11" rx="2.1" ry="2.8" />
                <path d="M12.3 12.6c-3.2 0-6.1 2.3-6.6 5.1-.36 1.95 1.15 3.5 3.1 3.3 1.25-.13 2.35-.85 3.5-.85s2.25.72 3.5.85c1.95.2 3.46-1.35 3.1-3.3-.5-2.8-3.4-5.1-6.6-5.1z" />
              </svg>
              Open in BloodHound
              <span aria-hidden className="ml-auto text-ink-3">
                ↗
              </span>
            </a>
          )}
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raise"
            onClick={() => {
              toggleLigolo(menu.ip);
              setMenu(null);
            }}
          >
            <span aria-hidden>📡</span>
            {ligoloByIp[menu.ip] ? 'Remove Ligolo agent' : 'Set Ligolo agent'}
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raise"
            onClick={() => {
              linkFromRef.current = menu.ip;
              setLinkFrom(menu.ip);
              setMenu(null);
            }}
          >
            <span aria-hidden style={{ color: '#e879c7' }}>
              🔗
            </span>
            {ligoloTargetByIp[menu.ip]?.length ? 'Add/remove unlocked subnets…' : 'Set unlocked subnets…'}
          </button>
          {!!ligoloTargetByIp[menu.ip]?.length && (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raise"
              onClick={() => {
                clearLigoloTargets(menu.ip);
                setMenu(null);
              }}
            >
              <span aria-hidden className="text-ink-3">
                ✕
              </span>
              Clear unlocked subnets ({ligoloTargetByIp[menu.ip].length})
            </button>
          )}
        </div>
      )}
      {linkFrom && (
        <div
          className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-none border bg-panel px-3 py-1.5 text-xs text-ink-1 shadow-lg"
          style={{ borderColor: 'rgba(232,121,199,0.6)' }}
        >
          {mode === 'subnet' ? 'Click subnets ' : 'Click a host in each subnet '}
          <span className="font-mono">{linkFrom}</span> unlocks
          {ligoloTargetByIp[linkFrom]?.length ? ` (${ligoloTargetByIp[linkFrom].length} linked)` : ''} · click again to
          remove · <span className="text-ink-3">Esc when done</span>
        </div>
      )}
      {rotating && !linkFrom && (
        <div
          className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-none border bg-panel px-3 py-1.5 text-xs text-ink-1 shadow-lg"
          style={{ borderColor: 'rgba(255,176,0,0.6)' }}
        >
          Rotating <span className="font-mono">{rotating.label}</span>’s children · scroll to spin ·{' '}
          <span className="text-ink-3">Esc or click away to stop</span>
        </div>
      )}
    </div>
  );
}
