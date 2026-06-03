import { Fragment } from "react";
import { WORLDS, pathToNode } from "../data/world";
import { useStore } from "../store";

/** Home / The Built World / Sweden / Boden — each crumb flies the camera back up. */
export function Breadcrumb() {
  const mode = useStore((s) => s.mode);
  const activeWorld = useStore((s) => s.activeWorld);
  const focusedNodeId = useStore((s) => s.focusedNodeId);
  const goHome = useStore((s) => s.goHome);
  const enterWorld = useStore((s) => s.enterWorld);
  const focusNode = useStore((s) => s.focusNode);

  if (mode === "orbit") return null;

  const world = WORLDS[activeWorld];
  const path = focusedNodeId ? pathToNode(world, focusedNodeId) : [];

  const crumbs = [
    { id: "__home", label: "Home", onClick: goHome, current: false },
    {
      id: "__world",
      label: world.title,
      onClick: enterWorld,
      current: path.length === 0,
    },
    ...path.map((n, i) => ({
      id: n.id,
      label: n.label,
      onClick: () => focusNode(n.id),
      current: i === path.length - 1,
    })),
  ];

  return (
    <nav className="breadcrumb label" aria-label="Breadcrumb">
      {crumbs.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <span className="breadcrumb__sep" aria-hidden="true">/</span>}
          <button
            className={`breadcrumb__item${c.current ? " breadcrumb__item--current" : ""}`}
            onClick={c.onClick}
            aria-current={c.current ? "page" : undefined}
          >
            {c.label}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
