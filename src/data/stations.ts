/* =========================================================================
   stations.ts — the seven career stations, shared between the ridgeline scene
   (RidgelineStage: radii, callout labels, survey highlight) and the focused
   role overlay (RoleOverlay: the dossier content).

   `radius` stays THE source of truth for the seven ring radii and must stay in
   sync with the RINGS arrays in gpu/ridgeline.ts (pickBand) and
   gpu/ridgelineShaders.ts (the WGSL contours): 720 hugs the summit … 5600 is
   the wide near-dune ring. Listed newest → oldest, present at the top.

   The `detail` block powers the click-to-focus overlay: a longer `summary`, a
   few `highlights`, `tools` chips, optional `media` plates (an empty plate
   renders as an elegant framed slot to drop a picture/video into later), and an
   optional `code` sample for the build-heavy roles.
   ========================================================================= */

export type RoleMedia = {
  kind: "image" | "video";
  // when `src` is omitted the overlay renders a framed "plate" placeholder —
  // a deliberate, surveyor-styled empty slot ready for a picture or clip.
  src?: string;
  poster?: string;
  alt: string;
  caption: string;
};

export type RoleCode = {
  lang: string; // display label for the language tab
  filename: string;
  code: string;
  note?: string;
};

export type StationDetail = {
  // a fuller lead for the focused dossier (RoleOverlay)
  summary: string;
  // a handful of concrete wins, rendered as a ticked survey list
  highlights: readonly string[];
  // tools / standards, rendered as hairline chips
  tools: readonly string[];
  // image / video plates (empty `src` → framed placeholder slot)
  media: readonly RoleMedia[];
  // one optional interactive code sample (copy-to-clipboard)
  code?: RoleCode;
};

export type Station = {
  radius: number;
  label: string;
  short: string;
  role: string;
  // ---- extended survey block (authored CV data) ------------------------------
  // The live desktop callout renders only `role` + `company` (with `short` as the
  // compact mobile label). The fields below — `dates`, `duration`, `place`,
  // `body`, `meta`, `cta` — are authored data retained for a fuller callout /
  // overlay; they are not rendered today. `duration` is "" for the education
  // stations; `place` is kept to city + country.
  company: string;
  dates: string;
  duration: string;
  place: string;
  body: string;
  meta: string;
  cta: string;
  detail: StationDetail;
};

export const STATIONS: readonly Station[] = [
  {
    radius: 720,
    label: "STEGRA · STOCKHOLM · 2025",
    short: "STEGRA '25",
    role: "BIM Specialist",
    company: "Stegra",
    dates: "Feb 2025 – Present",
    duration: "1 yr 5 mos",
    place: "Stockholm, Sweden",
    body: "Shaping BIM strategy and building the Power BI dashboards that keep the project legible. Trains stakeholders and supports the coordination team.",
    meta: "Now · BIM strategy, Power BI",
    cta: "View role",
    detail: {
      summary:
        "Shaping BIM strategy for a greenfield green-steel build, and standing up the Power BI dashboards that keep a vast project legible to everyone who touches it — from coordinators to client-side stakeholders.",
      highlights: [
        "Author the project's BIM strategy and information standards",
        "Build Power BI dashboards that turn model data into decisions",
        "Train stakeholders and back up the coordination team day to day",
      ],
      tools: ["BIM strategy", "Power BI", "ISO 19650", "Stakeholder training"],
      media: [
        { kind: "image", alt: "Power BI project dashboard", caption: "Power BI — project health at a glance" },
        { kind: "image", alt: "Federated coordination model", caption: "Federated model review" },
      ],
    },
  },
  {
    radius: 1300,
    label: "NEOBUILT · GOTHENBURG · 2025",
    short: "NEOBUILT '25",
    role: "BIM Developer · Founder",
    company: "Neobuilt AB",
    dates: "Feb 2025 – Present",
    duration: "1 yr 5 mos",
    place: "Gothenburg, Sweden",
    body: "Founded a practice building bespoke tooling on the Revit and Navisworks APIs, turning repetitive modelling work into automation.",
    meta: "Now · C#/.NET, Python, Revit API",
    cta: "View role",
    detail: {
      summary:
        "Founded a practice that builds bespoke tooling on the Revit and Navisworks APIs — turning the repetitive, error-prone parts of modelling and coordination into automation that teams actually keep using.",
      highlights: [
        "Founded the studio and set its product direction",
        "Ship C#/.NET add-ins on the Revit & Navisworks APIs",
        "Automate clash workflows and model QA with Python",
      ],
      tools: ["C# / .NET", "Python", "Revit API", "Navisworks API", "Automation"],
      media: [
        { kind: "image", alt: "Revit add-in interface", caption: "A shipped Revit add-in" },
        { kind: "video", alt: "Automation before / after", caption: "Before / after — minutes, not hours" },
      ],
      code: {
        lang: "C#",
        filename: "PlaceWallsOnGrids.cs",
        note: "A taste of the add-in work — illustrative.",
        code: `// Drop a wall on every grid line — a small Revit add-in command.
[Transaction(TransactionMode.Manual)]
public class PlaceWallsOnGrids : IExternalCommand
{
    public Result Execute(ExternalCommandData data, ref string msg, ElementSet els)
    {
        var doc = data.Application.ActiveUIDocument.Document;
        var level = new FilteredElementCollector(doc)
            .OfClass(typeof(Level)).Cast<Level>().First();

        using var tx = new Transaction(doc, "Place walls on grids");
        tx.Start();
        foreach (var grid in new FilteredElementCollector(doc)
                     .OfClass(typeof(Grid)).Cast<Grid>())
            Wall.Create(doc, grid.Curve, level.Id, structural: false);
        tx.Commit();

        return Result.Succeeded;
    }
}`,
      },
    },
  },
  {
    radius: 1980,
    label: "NORTHVOLT · SKELLEFTEÅ · 2023",
    short: "NORTHVOLT '23",
    role: "BIM Coordinator",
    company: "Northvolt",
    dates: "Sep 2023 – Dec 2024",
    duration: "1 yr 4 mos",
    place: "Skellefteå, Sweden",
    body: "Ran ISO 19650 information management and clash coordination across disciplines, with heavy emphasis on mentoring and training the wider team.",
    meta: "2023–2024 · ISO 19650, Navisworks",
    cta: "View role",
    detail: {
      summary:
        "Ran ISO 19650 information management and cross-discipline clash coordination on a gigafactory build — with a heavy emphasis on mentoring and bringing the wider team up the curve.",
      highlights: [
        "Owned ISO 19650 information management end to end",
        "Drove clash coordination across disciplines in Navisworks",
        "Mentored and trained the wider modelling team",
      ],
      tools: ["ISO 19650", "Navisworks", "Clash coordination", "Mentoring"],
      media: [
        { kind: "image", alt: "Clash detection matrix", caption: "Clash matrix across disciplines" },
        { kind: "image", alt: "Coordination session", caption: "Weekly coordination review" },
      ],
    },
  },
  {
    radius: 2750,
    label: "COLLECTIVE ARCHITECTURE · LOS ANGELES · 2023",
    short: "COLLECTIVE '23",
    role: "BIM Modeler",
    company: "Office for Collective Architecture",
    dates: "Jan 2023 – Sep 2023",
    duration: "9 mos",
    place: "Los Angeles, USA",
    body: "Drove energy and daylight studies in Rhino and Grasshopper, feeding the analysis back into the architectural model.",
    meta: "2023 · Rhino, Grasshopper",
    cta: "View role",
    detail: {
      summary:
        "Drove energy and daylight studies in Rhino and Grasshopper, feeding the analysis straight back into the architectural model so performance shaped the design instead of the other way round.",
      highlights: [
        "Energy & daylight studies in Rhino / Grasshopper",
        "Closed the loop between analysis and the design model",
      ],
      tools: ["Rhino", "Grasshopper", "Energy analysis", "Daylight studies"],
      media: [
        { kind: "image", alt: "Daylight analysis study", caption: "Daylight study, false-colour" },
        { kind: "image", alt: "Grasshopper definition", caption: "The Grasshopper graph behind it" },
      ],
    },
  },
  {
    radius: 3600,
    label: "WHITE ARKITEKTER · GOTHENBURG · 2022",
    short: "WHITE ARK. '22",
    role: "BIM Modeler",
    company: "White Arkitekter",
    dates: "Jan 2022 – Dec 2022",
    duration: "1 yr",
    place: "Gothenburg, Sweden",
    body: "Modelled Revit healthcare projects and prepared the IFC deliveries the wider design team relied on.",
    meta: "2022 · Revit, IFC",
    cta: "View role",
    detail: {
      summary:
        "Modelled Revit healthcare projects and prepared the IFC deliveries the wider design team relied on — precise, coordinated, and built to hand off cleanly.",
      highlights: [
        "Revit modelling on healthcare projects",
        "Prepared coordinated IFC deliveries for the design team",
      ],
      tools: ["Revit", "IFC", "Healthcare", "Coordination"],
      media: [
        { kind: "image", alt: "Revit healthcare model", caption: "Healthcare model, sectioned" },
        { kind: "image", alt: "IFC delivery", caption: "Coordinated IFC export" },
      ],
    },
  },
  {
    radius: 4550,
    label: "CHALMERS · GOTHENBURG · 2020",
    short: "CHALMERS '20",
    role: "M.Sc. Architectural Engineering",
    company: "Chalmers University of Technology",
    dates: "2020 – 2023",
    duration: "",
    place: "Gothenburg, Sweden",
    body: "A master's grounded in computational design, exploring geometry and performance through Rhino and Grasshopper.",
    meta: "2020–2023 · Computational design, Rhino",
    cta: "View studies",
    detail: {
      summary:
        "A master's grounded in computational design — exploring how geometry and performance inform each other, mostly through Rhino and Grasshopper.",
      highlights: [
        "M.Sc. Architectural Engineering",
        "Computational design: geometry ↔ performance",
        "Rhino / Grasshopper as the everyday toolkit",
      ],
      tools: ["Computational design", "Rhino", "Grasshopper", "Geometry & performance"],
      media: [
        { kind: "image", alt: "Thesis geometry study", caption: "Thesis geometry study" },
        { kind: "image", alt: "Parametric model", caption: "Parametric performance model" },
      ],
    },
  },
  {
    radius: 5600,
    label: "SHAHID BEHESHTI · TEHRAN · 2014",
    short: "SHAHID B. '14",
    role: "B.Sc. Architectural Engineering",
    company: "Shahid Beheshti University",
    dates: "2014 – 2019",
    duration: "",
    place: "Tehran, Iran",
    body: "Where it began — undergraduate studies alongside the first BIM modelling at Boomshahr Paydar, the start of the whole climb.",
    meta: "2014–2019 · ArchiCAD, first BIM",
    cta: "View studies",
    detail: {
      summary:
        "Where it began — undergraduate architectural engineering alongside the first BIM modelling at Boomshahr Paydar in ArchiCAD. The start of the whole climb.",
      highlights: [
        "B.Sc. Architectural Engineering",
        "First professional BIM modelling (ArchiCAD)",
        "The starting point of an eight-year climb",
      ],
      tools: ["ArchiCAD", "First BIM", "Architectural engineering"],
      media: [
        { kind: "image", alt: "Early ArchiCAD model", caption: "First BIM model, ArchiCAD" },
      ],
    },
  },
];
