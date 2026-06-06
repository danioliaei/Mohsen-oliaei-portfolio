/* =========================================================================
   projects.ts — the project survey, plotted on the Projects timeline overlay
   (ProjectsOverlay). A flat data module, mirroring the shape of stations.ts.

   `elevation` (−0.4 .. 1.0) is the AUTHORED tip height: read left→right in
   date order, the tips trace two mountain massifs with a central below-axis
   valley — exactly like the WiFi-SSID data-art reference, translated into the
   warm-dusk identity. The list is pre-sorted oldest→newest so the entrance
   draws strictly left→right. Below-axis is reserved for the two 2020–2021
   study years (their lines hang BELOW the ember baseline).

   The fields beyond `elevation` (descriptor, place, tags) feed the
   accessible per-point label and the masthead's live coordinate readout.
   ========================================================================= */

export type Project = {
  id: string;
  title: string;
  /** the concise wall label shown at the tip at rest (kept short, like the
      reference's SSIDs); the full `title` is reserved for the masthead + a11y */
  short: string;
  /** "YYYY-MM" */
  date: string;
  /** authored tip height, −0.4 .. 1.0 (negative = below the axis) */
  elevation: number;
  descriptor: string;
  place: string;
  tags: string[];
};

export const PROJECTS: Project[] = [
  { id: "boomshahr-2014",   title: "Boomshahr Paydar — First BIM",        short: "Boomshahr",    date: "2014-09", elevation: 0.12,  descriptor: "First professional BIM modelling in ArchiCAD, alongside undergrad studies", place: "Tehran, Iran",       tags: ["ArchiCAD", "BIM", "Residential"] },
  { id: "tehran-tower-2015", title: "Tehran Mixed-Use Tower",             short: "Tehran Tower", date: "2015-06", elevation: 0.34,  descriptor: "Full ArchiCAD documentation set for a 14-storey mixed-use block",          place: "Tehran, Iran",       tags: ["ArchiCAD", "Documentation", "High-rise"] },
  { id: "facade-2016",      title: "Parametric Façade Study",             short: "Façade",       date: "2016-03", elevation: 0.52,  descriptor: "First Grasshopper definition — a shading façade driven by sun hours",      place: "Tehran, Iran",       tags: ["Grasshopper", "Façade", "Daylight"] },
  { id: "clinic-2016",      title: "Clinic Retrofit Coordination",        short: "Clinic",       date: "2016-11", elevation: 0.66,  descriptor: "Multidiscipline clash review on a healthcare retrofit, manual Navisworks", place: "Tehran, Iran",       tags: ["Navisworks", "Healthcare", "Clash"] },
  { id: "sheetset-2017",    title: "Revit Sheet-Set Automator",           short: "Sheet-Set",    date: "2017-05", elevation: 0.80,  descriptor: "First C# Revit add-in — batch sheet creation and titleblock placement",    place: "Tehran, Iran",       tags: ["C# / .NET", "Revit API", "Automation"] },
  { id: "stadium-2017",     title: "Stadium Roof Geometry",               short: "Stadium",      date: "2017-12", elevation: 0.92,  descriptor: "Tensile roof form-finding and panelisation in Rhino / Grasshopper",       place: "Tehran, Iran",       tags: ["Rhino", "Form-finding", "Structure"] },
  { id: "gigafactory-2018", title: "Gigafactory Pilot Coordination",      short: "Giga Pilot",   date: "2018-07", elevation: 0.74,  descriptor: "First taste of heavy-industry MEP coordination at scale",                  place: "Tehran, Iran",       tags: ["Navisworks", "Industrial", "MEP"] },
  { id: "energy-2018",      title: "Energy-Model Pipeline",               short: "Energy Model", date: "2018-12", elevation: 0.48,  descriptor: "Grasshopper → EnergyPlus pipeline feeding performance back to design",    place: "Tehran, Iran",       tags: ["Grasshopper", "Energy", "Computational"] },
  { id: "thesis-2020",      title: "M.Sc. — Geometry ↔ Performance",      short: "M.Sc.",        date: "2020-02", elevation: -0.22, descriptor: "Below-axis study — speculative computational-design master's research",   place: "Gothenburg, Sweden", tags: ["Research", "Computational", "Chalmers"] },
  { id: "daylight-2021",    title: "Daylight Optimisation Sketch",        short: "Daylight R&D", date: "2021-03", elevation: -0.34, descriptor: "The valley floor — an unbuilt R&D probe into automated daylight tuning",  place: "Gothenburg, Sweden", tags: ["Daylight", "Grasshopper", "R&D"] },
  { id: "covid-qa-2021",    title: "Remote Model-QA Tool",                short: "Model-QA",     date: "2021-08", elevation: 0.24,  descriptor: "Lightweight Python model-audit script written during lockdown",           place: "Gothenburg, Sweden", tags: ["Python", "Model QA", "Automation"] },
  { id: "healthcare-2022",  title: "Healthcare Revit Model",              short: "Healthcare",   date: "2022-04", elevation: 0.50,  descriptor: "Coordinated Revit model and IFC delivery for a hospital wing",            place: "Gothenburg, Sweden", tags: ["Revit", "IFC", "Healthcare"] },
  { id: "white-ifc-2022",   title: "White Arkitekter — IFC Delivery",     short: "White IFC",    date: "2022-10", elevation: 0.64,  descriptor: "Production Revit modelling and clean IFC handoffs for the design team",    place: "Gothenburg, Sweden", tags: ["Revit", "IFC", "Coordination"] },
  { id: "daylight-la-2023", title: "Daylight Studies — Collective Arch.", short: "Daylight LA",  date: "2023-04", elevation: 0.70, descriptor: "False-colour daylight + energy studies fed into the Revit model",          place: "Los Angeles, USA",   tags: ["Rhino", "Daylight", "Energy"] },
  { id: "northvolt-2023",   title: "Northvolt ISO 19650 Setup",           short: "Northvolt",    date: "2023-09", elevation: 0.86,  descriptor: "Stood up the information-management backbone on a gigafactory build",     place: "Skellefteå, Sweden", tags: ["ISO 19650", "BIM strategy", "Industrial"] },
  { id: "clashbot-2024",    title: "Navisworks Clash Bot",                short: "Clash Bot",    date: "2024-02", elevation: 0.93,  descriptor: "Automated clash-grouping add-in cutting weekly coordination to minutes",  place: "Skellefteå, Sweden", tags: ["Navisworks API", "C# / .NET", "Automation"] },
  { id: "training-2024",    title: "Coordination Training Programme",     short: "Training",     date: "2024-07", elevation: 0.58,  descriptor: "Mentoring curriculum that brought the modelling team up the curve",       place: "Skellefteå, Sweden", tags: ["Training", "Coordination", "Mentoring"] },
  { id: "neobuilt-2025",    title: "Neobuilt — Revit Add-in Suite",       short: "Neobuilt",     date: "2025-02", elevation: 0.88,  descriptor: "Founded the studio; shipped a suite of bespoke Revit / Navisworks tools", place: "Gothenburg, Sweden", tags: ["C# / .NET", "Revit API", "Product"] },
  { id: "stegra-bim-2025",  title: "Stegra BIM Strategy",                 short: "Stegra BIM",   date: "2025-04", elevation: 1.0,   descriptor: "The summit — authored BIM strategy for a green-steel megaproject",        place: "Stockholm, Sweden",  tags: ["BIM strategy", "ISO 19650", "Green steel"] },
  { id: "stegra-pbi-2025",  title: "Stegra Power BI Decision Boards",     short: "Power BI",     date: "2025-09", elevation: 0.94,  descriptor: "Live dashboards turning federated model data into project decisions",     place: "Stockholm, Sweden",  tags: ["Power BI", "Dashboard", "Strategy"] },
  { id: "api-layer-2026",   title: "Model-Data API Layer",                short: "Data API",     date: "2026-03", elevation: 0.62,  descriptor: "A Python service exposing live model metrics to any downstream tool",     place: "Stockholm, Sweden",  tags: ["Python", "API", "Automation"] },
];

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** decimal year for x-placement, e.g. "2025-04" → 2025.25 */
export const decimalYear = (date: string): number => {
  const [y, m] = date.split("-").map(Number);
  return y + (m - 1) / 12;
};

/** the vertical-date label, uppercase mono, e.g. "APR 2025" */
export const formatMonthYear = (date: string): string => {
  const [y, m] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

/** screen-reader date fragment, e.g. "April 2025" */
export const formatMonthYearLong = (date: string): string => {
  const [y, m] = date.split("-").map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
};

/** the plotted time window — a hair of padding past the first/last project */
export const TIME_MIN = 2014.0;
export const TIME_MAX = 2026.5;
