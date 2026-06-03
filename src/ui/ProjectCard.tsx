import { findProject } from "../data/world";
import { useStore } from "../store";

/** Boarding-pass style detail card for a focused project. */
export function ProjectCard() {
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const closeProject = useStore((s) => s.closeProject);

  const project = selectedProjectId ? findProject(selectedProjectId) : undefined;
  if (!project) return null;

  return (
    <div className="card-scrim">
      <article className="card" role="dialog" aria-label={project.label}>
        <button className="card__close" onClick={closeProject} aria-label="Close">
          ✕
        </button>
        <p className="card__kicker label">{project.scope}</p>
        <h2 className="card__title">{project.label}</h2>
        <dl className="card__grid">
          <dt>Role</dt>
          <dd>{project.role}</dd>
          <dt>Stack</dt>
          <dd>{project.stack}</dd>
          <dt>Year</dt>
          <dd className="mono">{project.year}</dd>
        </dl>
        <p className="card__blurb">{project.blurb}</p>
        <div className="card__actions">
          {project.href ? (
            <a
              className="card__cta card__cta--primary"
              href={project.href}
              target="_blank"
              rel="noreferrer"
            >
              Open <span aria-hidden="true">↗</span>
            </a>
          ) : null}
          <button className="card__cta" onClick={closeProject}>
            Close
          </button>
        </div>
      </article>
    </div>
  );
}
