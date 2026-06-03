/* =========================================================================
   THE PROFESSIONAL PATH — stations along the road, laid out on a TIMELINE.

   Each phase carries its real duration (`durYears`). The road length it
   occupies is proportional to that duration, so a long degree is a long
   stretch of road and a short assignment is a short one. Phases are placed
   end-to-end in chronological order.

   `kind` gives every phase its OWN road colour:
     "education"  → amber / gold
     "career"     → professional orange  (the working road)
     "teaching"   → pedagogical teal      (training · mentoring · leadership)
   ========================================================================= */
export type MilestoneKind = "education" | "career" | "teaching";

interface RawPhase {
  kind: MilestoneKind;
  durYears: number;
  tag: string;
  title: string;
  sub: string[];
}

// chronological order, earliest first
const RAW: RawPhase[] = [
  {
    kind: "education",
    durYears: 4.4, // Sep 2014 – Feb 2019
    tag: "2014 — 2019 · Tehran",
    title: "Foundations",
    sub: [
      "B.Sc. Architectural Engineering — Shahid Beheshti",
      "First BIM models at Boomshahr Paydar (ArchiCAD)",
    ],
  },
  {
    kind: "education",
    durYears: 2.8, // Sep 2020 – Jun 2023
    tag: "2020 — 2023 · Gothenburg",
    title: "M.Sc. — Chalmers University",
    sub: [
      "Architectural Engineering",
      "Computational design · Rhino + Grasshopper",
    ],
  },
  {
    kind: "career",
    durYears: 1.0, // Jan – Dec 2022
    tag: "2022 · Gothenburg",
    title: "White Arkitekter — BIM Modeler",
    sub: [
      "Revit modeling · healthcare projects",
      "IFC coordination & weekly submissions",
    ],
  },
  {
    kind: "career",
    durYears: 0.7, // Jan – Sep 2023
    tag: "2023 · Los Angeles",
    title: "Office for Collective Architecture",
    sub: [
      "BIM Modeler · mixed-use development",
      "Energy & daylight analysis · Rhino + Grasshopper",
    ],
  },
  {
    kind: "teaching",
    durYears: 1.3, // Sep 2023 – Dec 2024
    tag: "2023 — 2024 · Skellefteå",
    title: "Northvolt — BIM Coordinator",
    sub: [
      "ISO 19650 · clash coordination · Northvolt Ett",
      "Trained & mentored cross-functional teams",
      "Led design reviews & BIM kick-offs",
    ],
  },
  {
    kind: "career",
    durYears: 1.4, // Feb 2025 – present
    tag: "2025 — now · Gothenburg",
    title: "Neobuilt — BIM Developer",
    sub: [
      "Founder · custom BIM automation tools",
      "C# / .NET / Python · Revit & Navisworks APIs",
    ],
  },
  {
    kind: "teaching",
    durYears: 1.4, // Feb 2025 – present
    tag: "2025 — now · Stockholm",
    title: "Stegra — BIM Specialist",
    sub: [
      "Re-defining Stegra's BIM strategy · Power BI KPIs",
      "Training stakeholders & supporting coordinators",
      "Authoring BIM requirements (EIR · LOIN · AIR)",
    ],
  },
];

// ---- timeline layout -----------------------------------------------------
const SCALE = 1300; // road units per year (be generous)
const FLOOR = 1100; // shortest a phase can be, so brief stints stay readable
const GAP = 650; // breathing room between phases
const START = 1000; // road before the first station

export interface Milestone {
  z: number; // card anchor (middle of the phase band)
  kind: MilestoneKind;
  tag: string;
  title: string;
  sub: string[];
}

export interface Phase {
  zStart: number;
  zEnd: number;
  kind: MilestoneKind;
}

const _milestones: Milestone[] = [];
const _phases: Phase[] = [];
{
  let cursor = START;
  for (const r of RAW) {
    const len = Math.max(FLOOR, r.durYears * SCALE);
    const zStart = cursor;
    const zEnd = cursor + len;
    _milestones.push({
      z: zStart + len * 0.5,
      kind: r.kind,
      tag: r.tag,
      title: r.title,
      sub: r.sub,
    });
    _phases.push({ zStart, zEnd, kind: r.kind });
    cursor = zEnd + GAP;
  }
}

export const MILESTONES: Milestone[] = _milestones;
export const PHASES: Phase[] = _phases;

/** Total road length the camera travels (a little past the final station). */
export const TRAVEL: number = _phases[_phases.length - 1].zEnd + 1600;
