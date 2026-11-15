// The part on the sheet: STLs on the A1's 256 mm bed (Z up, front is -Y),
// a light shaded body with dark feature lines, standing clear of the dark sheet.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

const BED = 256;
const EDGE_ANGLE = 18; // degrees between faces before an edge is drawn

export interface LoadedPart {
  label: string; // "" for a single-part export, else the part label ("body", "lid") or colour name
  geometry: THREE.BufferGeometry;
  size: THREE.Vector3; // mm
  color?: string; // "#rrggbb" for a piece of a multicolour print
}

export type PartsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  /** `assembled`: the parts are colour pieces of one object, shown where they are; `size` is the whole. */
  | { status: "ready"; parts: LoadedPart[]; assembled: boolean; size: THREE.Vector3 };

export interface PartSource {
  url: string;
  label?: string; // default: taken from the file name
  color?: string;
}

/**
 * Fetch and parse a part's STLs; geometry is shared by the viewer and the title block.
 * `version` changes when the part is re-exported: the old part stays on screen until the
 * new one has loaded, and each set of geometry is freed once it is replaced.
 */
export function useParts(sources: PartSource[], groupName: string, version: number): PartsState {
  const [state, setState] = useState<PartsState>({ status: "loading" });
  const key = sources.map((s) => `${s.url}#${s.color ?? ""}`).join("|");
  const shownKey = useRef<string | undefined>(undefined);

  // Free the previous parts' geometry when they are replaced or the view goes away.
  useEffect(() => {
    if (state.status !== "ready") return;
    return () => state.parts.forEach((p) => p.geometry.dispose());
  }, [state]);

  useEffect(() => {
    if (!sources.length) {
      setState({ status: "error", message: "This part has no STL." });
      return;
    }
    let cancelled = false;
    // A different part shows "loading"; a re-export of the same one keeps the old view meanwhile.
    if (shownKey.current !== key) setState({ status: "loading" });
    const loader = new STLLoader();
    Promise.all(
      sources.map(async ({ url: u, label: given, color }) => {
        const res = await fetch(`${u}?v=${version}`);
        if (!res.ok) throw new Error(`Could not read ${u.split("/").pop()} (${res.status}).`);
        const geometry = loader.parse(await res.arrayBuffer());
        geometry.computeVertexNormals(); // flat: STL triangles share no vertices
        geometry.computeBoundingBox();
        const size = geometry.boundingBox!.getSize(new THREE.Vector3());
        const file = u.split("/").pop()!.replace(/\.stl$/i, "");
        const label = given ?? (file === groupName ? "" : file.slice(groupName.length + 1));
        return { label, geometry, size, color };
      }),
    ).then(
      (parts) => {
        if (cancelled) return parts.forEach((p) => p.geometry.dispose());
        const assembled = parts.some((p) => p.color);
        const all = new THREE.Box3();
        for (const p of parts) all.union(p.geometry.boundingBox!);
        shownKey.current = key;
        setState({ status: "ready", parts, assembled, size: all.getSize(new THREE.Vector3()) });
      },
      (e: Error) => {
        if (cancelled) return;
        shownKey.current = undefined;
        setState({ status: "error", message: e.message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, groupName, version]);

  return state;
}

/** A print colour as shown on the dark sheet: true hue, but black lifted to charcoal so it stays visible. */
function printColor(hex: string): THREE.Color {
  const c = new THREE.Color(hex); // sRGB hex, converted to linear by three's colour management
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (hsl.l < 0.08) c.setHSL(hsl.h, hsl.s, 0.08);
  return c;
}

/** Resolve a CSS colour token to sRGB for three.js (Chromium keeps oklch() as written). */
function tokenColor(el: Element, name: string): THREE.Color {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.fillStyle = getComputedStyle(el).getPropertyValue(name).trim();
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

/**
 * One WebGL renderer for the app's lifetime. Each renderer holds a GPU context, and a context
 * isn't freed when its renderer is disposed, so making one per part view leaked GPU memory.
 */
let sharedRenderer: THREE.WebGLRenderer | undefined;
function getRenderer(): THREE.WebGLRenderer {
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    sharedRenderer.setPixelRatio(window.devicePixelRatio);
    sharedRenderer.domElement.setAttribute("aria-hidden", "true");
  }
  return sharedRenderer;
}

export function StlViewer({ parts, assembled = false }: { parts: LoadedPart[]; assembled?: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  // A layout effect, so its cleanup runs while the canvas is still in the page. OrbitControls
  // removes its document key listener from the canvas's root node; after React has detached
  // the view that root is the detached div, the listener stays on the document, and it keeps
  // this view's scene and the part's geometry alive (about 20 MB per view of a large part).
  useLayoutEffect(() => {
    const el = host.current!;
    const ink = tokenColor(el, "--color-ink");
    // A light body that stands clear of the dark sheet, outlined in the sheet's own dark.
    const body = tokenColor(el, "--color-ink-2");
    const edge = tokenColor(el, "--color-paper-3");
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    const renderer = getRenderer();
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 5000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(ink, tokenColor(el, "--color-muted"), 1.6));
    const sun = new THREE.DirectionalLight(ink, 1.9);
    sun.position.set(150, -250, 400);
    scene.add(sun);

    // The bed, as an outline on the sheet.
    const bed = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(BED, BED)),
      new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.35 }),
    );
    scene.add(bed);

    // Lay separate parts out left to right like the PNG preview; colour pieces stay where they are.
    // Either way the whole is centred on the bed below. Parts are placed by moving their meshes,
    // so the loaded geometry is drawn as is (useParts owns and frees it).
    const group = new THREE.Group();
    const owned: { dispose(): void }[] = [];
    let x = 0;
    const floor = Math.min(...parts.map((p) => p.geometry.boundingBox!.min.z));
    for (const p of parts) {
      const g = p.geometry;
      const b = g.boundingBox!;
      const piece = new THREE.Group();
      if (assembled) piece.position.set(0, 0, -floor);
      else piece.position.set(x - b.min.x, -(b.min.y + b.max.y) / 2, -b.min.z);
      x += p.size.x + 10;
      const mat = new THREE.MeshStandardMaterial({
        color: p.color ? printColor(p.color) : body,
        roughness: 0.65,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      piece.add(new THREE.Mesh(g, mat));
      owned.push(mat);
      // Feature lines would clutter a colour relief (and are slow on its dense mesh): plain parts only.
      if (!p.color) {
        const edges = new THREE.EdgesGeometry(g, EDGE_ANGLE);
        const lineMat = new THREE.LineBasicMaterial({ color: edge, transparent: true, opacity: 0.7 });
        piece.add(new THREE.LineSegments(edges, lineMat));
        owned.push(edges, lineMat);
      }
      group.add(piece);
    }
    scene.add(group);
    const box = new THREE.Box3().setFromObject(group);
    const centre = box.getCenter(new THREE.Vector3());
    group.position.x -= centre.x;
    group.position.y -= centre.y;

    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 10);
    const target = new THREE.Vector3(0, 0, size.z / 2);
    const dir = new THREE.Vector3(0.55, -1, 0.7).normalize();
    controls.target.copy(target);

    // Fit the parts in whichever of the view's width or height is tighter.
    const fit = () => {
      const vHalf = (camera.fov * Math.PI) / 360;
      const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
      const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.1;
      camera.position.copy(target).addScaledVector(dir, dist);
      controls.update();
    };

    // Refit whenever the pane changes size, until the user moves the view themselves.
    let moved = false;
    controls.addEventListener("start", () => (moved = true));
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!moved) fit();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    let frame = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      owned.forEach((o) => o.dispose());
      bed.geometry.dispose();
      (bed.material as THREE.Material).dispose();
      renderer.renderLists.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [parts, assembled]);

  return (
    <div className="viewer" ref={host} role="img" aria-label="3D view of the part. Drag to orbit, right-drag to pan, scroll to zoom.">
      <ul className="viewer-hint" aria-hidden="true">
        <li>Drag to orbit</li>
        <li>Right-drag to pan</li>
        <li>Scroll to zoom</li>
      </ul>
    </div>
  );
}
