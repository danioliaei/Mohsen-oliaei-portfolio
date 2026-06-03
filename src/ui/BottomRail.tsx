import { WORLDS, findNode } from "../data/world";
import { useStore } from "../store";

function useStatus(): string {
  const mode = useStore((s) => s.mode);
  const activeWorld = useStore((s) => s.activeWorld);
  const focusedNodeId = useStore((s) => s.focusedNodeId);

  if (mode === "orbit") return "ORBIT — SELECT A WORLD TO DESCEND";
  if (mode === "room") return "PARTILLE — WORKSPACE — SCREEN";
  const world = WORLDS[activeWorld];
  const node = focusedNodeId ? findNode(world, focusedNodeId) : null;
  const tail = node ? ` — ${node.label.toUpperCase()}` : "";
  return `${world.title.toUpperCase()}${tail}`;
}

export function BottomRail() {
  const status = useStatus();
  return (
    <footer className="rail rail--bottom">
      <span className="label rail__group">
        <span className="rail__dot" /> Lund · SE
      </span>
      <span className="label rail__center mono">{status}</span>
      <span className="label">Portfolio / 2026</span>
    </footer>
  );
}
