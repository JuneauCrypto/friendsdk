/* Line-art 3D versions of the on-chain land props: white solids with black edges,
 * echoing the monochrome Rare Friends renderer, with the signal-green accent. */
import * as THREE from "three";

const white = new THREE.MeshLambertMaterial({ color: 0xffffff });
const grey = new THREE.MeshLambertMaterial({ color: 0xd9d9d9 });
const black = new THREE.MeshLambertMaterial({ color: 0x111111 });
const signal = new THREE.MeshLambertMaterial({ color: 0xccff00 });
const line = new THREE.LineBasicMaterial({ color: 0x000000 });
const geoCache = new Map<string, { g: THREE.BufferGeometry; e: THREE.EdgesGeometry }>();

function cached(key: string, make: () => THREE.BufferGeometry) {
  let c = geoCache.get(key);
  if (!c) { const g = make(); c = { g, e: new THREE.EdgesGeometry(g, 25) }; geoCache.set(key, c); }
  return c;
}
/** A solid with crisp black outlines. */
function part(kind: "box" | "cyl" | "cone" | "oct", size: [number, number, number], pos: [number, number, number], mat: THREE.Material = white, rotY = 0) {
  const [a, b, c] = size;
  const { g, e } = cached(`${kind}:${a}:${b}:${c}`, () =>
    kind === "box" ? new THREE.BoxGeometry(a, b, c)
    : kind === "cyl" ? new THREE.CylinderGeometry(a, a, b, 10)
    : kind === "cone" ? new THREE.ConeGeometry(a, b, 6)
    : new THREE.OctahedronGeometry(a));
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(g, mat); group.add(mesh);
  const edges = new THREE.LineSegments(e, line); group.add(edges);
  group.position.set(...pos); group.rotation.y = rotY;
  if (kind === "oct") group.scale.set(1, b / a, 1);
  return group;
}

export function makeProp(name: string): THREE.Group {
  const g = new THREE.Group();
  const base = name.replace(/-tiny$/, "");
  const add = (...parts: THREE.Object3D[]) => parts.forEach(p => g.add(p));
  switch (base) {
    case "tree":
      add(part("box", [0.18, 0.7, 0.18], [0, 0.35, 0], grey),
        part("box", [0.9, 0.5, 0.9], [0, 0.9, 0]), part("box", [0.62, 0.4, 0.62], [0, 1.32, 0]), part("box", [0.3, 0.25, 0.3], [0, 1.62, 0]));
      break;
    case "sprout": case "flower":
      add(part("box", [0.06, 0.4, 0.06], [0, 0.2, 0], grey), part("box", [0.24, 0.08, 0.1], [0.1, 0.32, 0]),
        part("box", [0.2, 0.2, 0.2], [0, 0.46, 0], base === "flower" ? signal : white));
      break;
    case "bench":
      add(part("box", [0.9, 0.08, 0.34], [0, 0.34, 0]), part("box", [0.9, 0.3, 0.06], [0, 0.55, -0.16]),
        part("box", [0.06, 0.34, 0.3], [-0.38, 0.17, 0], grey), part("box", [0.06, 0.34, 0.3], [0.38, 0.17, 0], grey));
      break;
    case "bookcase":
      add(part("box", [0.8, 1.4, 0.36], [0, 0.7, 0]));
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) g.add(part("box", [0.14, 0.3, 0.05], [-0.26 + c * 0.17, 0.32 + r * 0.42, 0.17], (r + c) % 3 ? black : signal));
      break;
    case "book-stack":
      for (let i = 0; i < 3; i++) g.add(part("box", [0.5 - i * 0.06, 0.1, 0.36], [0, 0.05 + i * 0.1, 0], i === 1 ? grey : white, i * 0.3));
      break;
    case "rock":
      add(part("box", [0.6, 0.32, 0.5], [0, 0.16, 0], white, 0.4), part("box", [0.34, 0.2, 0.3], [0.12, 0.4, 0.05], grey, 0.9));
      break;
    case "crystal":
      add(part("oct", [0.28, 0.9, 0.28], [0, 0.55, 0], white), part("oct", [0.15, 0.45, 0.15], [0.28, 0.3, 0.1], signal));
      break;
    case "tank":
      add(part("cyl", [0.38, 0.9, 0], [0, 0.45, 0]), part("cyl", [0.2, 0.12, 0], [0, 0.96, 0], grey));
      break;
    case "vent":
      add(part("box", [0.5, 0.4, 0.5], [0, 0.2, 0], grey));
      for (let i = 0; i < 3; i++) g.add(part("box", [0.4, 0.04, 0.52], [0, 0.12 + i * 0.1, 0], black));
      break;
    case "terminal":
      add(part("box", [0.5, 0.9, 0.36], [0, 0.45, 0]), part("box", [0.36, 0.26, 0.04], [0, 0.66, 0.19], signal));
      break;
    case "pipe":
      { const p = part("cyl", [0.14, 1.2, 0], [0, 0.3, 0], grey); p.rotation.z = Math.PI / 2; add(p, part("box", [0.16, 0.3, 0.16], [-0.5, 0.15, 0])); }
      break;
    case "buoy":
      add(part("cyl", [0.26, 0.4, 0], [0, 0.2, 0], white), part("cone", [0.2, 0.5, 0], [0, 0.65, 0], signal), part("box", [0.04, 0.3, 0.04], [0, 1.0, 0], black));
      break;
    case "reeds":
      for (let i = 0; i < 4; i++) g.add(part("box", [0.05, 0.5 + (i % 2) * 0.2, 0.05], [-0.15 + i * 0.1, 0.3, (i % 2) * 0.1], grey));
      break;
    case "antenna":
      add(part("box", [0.08, 1.4, 0.08], [0, 0.7, 0], grey), part("box", [0.4, 0.06, 0.06], [0, 1.2, 0]), part("box", [0.12, 0.12, 0.12], [0, 1.45, 0], signal));
      break;
    case "crate": case "supply-basket":
      add(part("box", [0.6, 0.5, 0.6], [0, 0.25, 0]), part("box", [0.62, 0.06, 0.62], [0, 0.35, 0], grey));
      break;
    default:
      add(part("box", [0.5, 0.5, 0.5], [0, 0.25, 0]), part("box", [0.2, 0.2, 0.2], [0, 0.6, 0], signal));
  }
  if (/-tiny$/.test(name)) g.scale.setScalar(0.6);
  return g;
}

/** Tiny tiling floor texture matching the on-chain Floor trait. */
export function floorTexture(floor: string) {
  const c = document.createElement("canvas"); c.width = c.height = 8;
  const x = c.getContext("2d")!;
  x.fillStyle = "#fff"; x.fillRect(0, 0, 8, 8); x.fillStyle = "#c9c9c9";
  const f = floor.toLowerCase();
  if (f.includes("dither")) { for (let i = 0; i < 8; i += 4) for (let j = 0; j < 8; j += 4) { x.fillRect(i, j, 1, 1); x.fillRect(i + 2, j + 2, 1, 1); } }
  else if (f.includes("hatch")) { for (let i = 0; i < 8; i++) x.fillRect(i, (8 - i) % 8, 1, 1); }
  else if (f.includes("cross") || f.includes("grid")) { x.fillRect(0, 0, 8, 1); x.fillRect(0, 0, 1, 8); }
  else { x.fillRect(0, 0, 1, 1); }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Docks items: our own goods, drawn in colour so they read as add-ons on top of the monochrome land. */
const c = (hex: number) => new THREE.MeshLambertMaterial({ color: hex });
const WOOD = c(0xb9844f), RED = c(0xe2574c), STONE = c(0xe8e4dc), WATER = c(0x5fb3e6), GLOW = new THREE.MeshBasicMaterial({ color: 0xfff2a8 });
export function makeDecor(item: string): THREE.Group {
  const g = new THREE.Group();
  const add = (...p: THREE.Object3D[]) => p.forEach(o => g.add(o));
  switch (item) {
    case "lantern":
      add(part("box", [0.08, 1.1, 0.08], [0, 0.55, 0], black), part("box", [0.26, 0.3, 0.26], [0, 1.2, 0], GLOW), part("box", [0.32, 0.06, 0.32], [0, 1.38, 0], black));
      break;
    case "flowerbed":
      add(part("box", [0.9, 0.2, 0.9], [0, 0.1, 0], WOOD));
      for (let i = 0; i < 5; i++) g.add(part("box", [0.16, 0.16, 0.16], [-0.3 + (i % 3) * 0.3, 0.3, -0.2 + Math.floor(i / 3) * 0.4], [RED, signal, c(0xff7eb6)][i % 3]));
      break;
    case "fountain":
      add(part("cyl", [0.48, 0.28, 0], [0, 0.14, 0], STONE), part("cyl", [0.38, 0.06, 0], [0, 0.3, 0], WATER), part("cyl", [0.08, 0.7, 0], [0, 0.55, 0], STONE), part("cyl", [0.22, 0.08, 0], [0, 0.88, 0], WATER));
      break;
    case "windmill": {
      add(part("box", [0.7, 1.5, 0.7], [0, 0.75, 0], STONE), part("cone", [0.55, 0.5, 0], [0, 1.75, 0], RED));
      const blades = new THREE.Group(); blades.position.set(0, 1.3, 0.4); blades.userData.spin = true;
      blades.add(part("box", [1.8, 0.14, 0.04], [0, 0, 0], WOOD), part("box", [0.14, 1.8, 0.04], [0, 0, 0], WOOD));
      g.add(blades);
      break;
    }
    case "lighthouse":
      for (let i = 0; i < 5; i++) g.add(part("cyl", [0.42 - i * 0.04, 0.5, 0], [0, 0.25 + i * 0.5, 0], i % 2 ? RED : STONE));
      add(part("box", [0.4, 0.35, 0.4], [0, 2.7, 0], GLOW), part("cone", [0.34, 0.4, 0], [0, 3.08, 0], RED));
      break;
    default:
      add(part("box", [0.5, 0.5, 0.5], [0, 0.25, 0], signal));
  }
  return g;
}
