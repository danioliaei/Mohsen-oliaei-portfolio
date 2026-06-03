/* =========================================================================
   EDIT YOUR TIMELINE HERE.  z = distance down the road (smaller = sooner).
   Keep them in ascending z order.  Add a year into `tag` when confirmed.
   ========================================================================= */
export interface Milestone {
  z: number;
  tag: string;
  title: string;
  sub: string[];
}

export const MILESTONES: Milestone[] = [
  {
    z: 1800,
    tag: "01 — Start",
    title: "BIM Specialist & Developer",
    sub: ["› Entered AEC / digital construction", "› ~5 years and counting"],
  },
  {
    z: 4800,
    tag: "02 — Founded",
    title: "Neobuilt AB",
    sub: ["› Founder & operator", "› Swedish BIM consultancy"],
  },
  {
    z: 7800,
    tag: "03 — Engagement",
    title: "IDOM · SSAB Transformation",
    sub: ["› Senior BIM Manager placement", "› via Neobuilt AB"],
  },
  {
    z: 10800,
    tag: "04 — Current",
    title: "Stegra",
    sub: ["› BIM Specialist / Developer"],
  },
  {
    z: 13800,
    tag: "05 — Next",
    title: "Senior Software Developer",
    sub: ["› BIM / AEC", "› Exploring · COWI, Gothenburg"],
  },
];
