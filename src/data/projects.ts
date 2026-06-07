/* =========================================================================
   projects.ts — the project survey, plotted on the Projects Dial overlay
   (ProjectsOverlay). A flat data module, mirroring the shape of stations.ts.

   `elevation` (−0.4 .. 1.0) is the AUTHORED tip height: read left→right in
   date order, the tips trace two mountain massifs with a central below-axis
   valley — exactly like the WiFi-SSID data-art reference, translated into the
   warm-dusk identity. The list is pre-sorted oldest→newest so the entrance
   draws strictly left→right. Below-axis is reserved for a few speculative
   study entries (their lines hang BELOW the ember baseline).

   `major` is a CURATED significance flag: true = flagship work = the Dial
   draws a LONGER spoke; false = a smaller script / study / retrofit = a
   SHORTER spoke, packed tight against its neighbours. Together with the
   densified mock set (~80 entries spanning 2014→2026) this makes the Projects
   Dial read like a radial astronomical calendar — hundreds of tight radial
   ticks fanning out, the major ones reaching further.

   Beyond `elevation`, only `place` is currently consumed downstream — it joins
   `title` + the formatted date in the per-point aria-label and the masthead's
   live coordinate readout. `descriptor` and `tags` are authored content kept
   for a future detail / tooltip surface; they are not rendered today. The Dial
   itself renders ONLY `short` (radial text); the rest lives in data.
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
  /** curated significance — true = flagship = LONGER Dial spoke */
  major: boolean;
  descriptor: string;
  place: string;
  tags: readonly string[];
};

export const PROJECTS: readonly Project[] = [
  { id: "boomshahr-2014",      title: "Boomshahr Paydar — First BIM",         short: "Boomshahr",    date: "2014-09", elevation: 0.12,  major: false, descriptor: "First professional BIM modelling in ArchiCAD, alongside undergrad studies", place: "Tehran, Iran",       tags: ["ArchiCAD", "BIM", "Residential"] },
  { id: "office-fitout-2014",  title: "Office Fit-out Set",                   short: "Fit-out",      date: "2014-11", elevation: 0.10,  major: false, descriptor: "Tenant fit-out documentation, first taste of working drawings",         place: "Tehran, Iran",       tags: ["ArchiCAD", "Documentation", "Interiors"] },
  { id: "villa-darband-2014",  title: "Darband Villa Documentation",          short: "Darband",      date: "2014-12", elevation: 0.18,  major: false, descriptor: "Hillside villa construction set, hand-checked sections in ArchiCAD",     place: "Tehran, Iran",       tags: ["ArchiCAD", "Documentation", "Residential"] },
  { id: "school-block-2015",   title: "School Block Layout Kit",              short: "School Kit",   date: "2015-02", elevation: 0.22,  major: false, descriptor: "Reusable classroom layout families for a public-school programme",       place: "Tehran, Iran",       tags: ["Revit", "Families", "Education"] },
  { id: "apartment-vol-2015",  title: "Apartment Volume Study",               short: "Apt Volume",   date: "2015-04", elevation: 0.26,  major: false, descriptor: "Massing and volume options for a residential infill block",              place: "Tehran, Iran",       tags: ["SketchUp", "Massing", "Residential"] },
  { id: "tehran-tower-2015",   title: "Tehran Mixed-Use Tower",               short: "Tehran Tower", date: "2015-06", elevation: 0.34,  major: false, descriptor: "Full ArchiCAD documentation set for a 14-storey mixed-use block",         place: "Tehran, Iran",       tags: ["ArchiCAD", "Documentation", "High-rise"] },
  { id: "bazaar-survey-2015",  title: "Grand Bazaar Point-Cloud Survey",      short: "Bazaar Scan",  date: "2015-09", elevation: 0.40,  major: true,  descriptor: "Point-cloud-to-BIM survey of a historic bazaar wing for retrofit",       place: "Tehran, Iran",       tags: ["Scan-to-BIM", "Heritage", "Revit"] },
  { id: "door-schedule-2015",  title: "Door & Window Schedule Macro",         short: "Schedules",    date: "2015-10", elevation: 0.14,  major: false, descriptor: "Macro auto-building door/window schedules from model data",             place: "Tehran, Iran",       tags: ["VBA", "Schedules", "Automation"] },
  { id: "titleblock-2015",     title: "Titleblock Standardiser",              short: "Titleblock",   date: "2015-12", elevation: 0.16,  major: false, descriptor: "Dynamo graph normalising titleblocks across a messy project set",        place: "Tehran, Iran",       tags: ["Dynamo", "Standards", "Automation"] },
  { id: "facade-2016",         title: "Parametric Façade Study",              short: "Façade",       date: "2016-03", elevation: 0.52,  major: false, descriptor: "First Grasshopper definition — a shading façade driven by sun hours",     place: "Tehran, Iran",       tags: ["Grasshopper", "Façade", "Daylight"] },
  { id: "site-grading-2016",   title: "Site Grading Optimiser",               short: "Grading",      date: "2016-05", elevation: 0.34,  major: false, descriptor: "Cut-and-fill balancing study for a sloped campus site",                  place: "Tehran, Iran",       tags: ["Grasshopper", "Civil", "Optimisation"] },
  { id: "mosque-dome-2016",    title: "Mosque Dome Panelisation",             short: "Dome",         date: "2016-06", elevation: 0.46,  major: false, descriptor: "Grasshopper panelisation of a double-curved dome for fabrication",       place: "Isfahan, Iran",      tags: ["Grasshopper", "Geometry", "Fabrication"] },
  { id: "quantity-2016",       title: "Quantity Take-off Macro",              short: "Take-off",     date: "2016-09", elevation: 0.28,  major: false, descriptor: "Excel-VBA macro pulling schedules into a cost-estimation template",      place: "Tehran, Iran",       tags: ["VBA", "Quantities", "Estimation"] },
  { id: "rail-depot-2016",     title: "Rail Depot Modelling",                 short: "Rail Depot",   date: "2016-10", elevation: 0.62,  major: true,  descriptor: "Coordinated structure and services model for a light-rail depot",        place: "Tehran, Iran",       tags: ["Revit", "Infrastructure", "Coordination"] },
  { id: "clinic-2016",         title: "Clinic Retrofit Coordination",         short: "Clinic",       date: "2016-11", elevation: 0.66,  major: false, descriptor: "Multidiscipline clash review on a healthcare retrofit, manual Navisworks", place: "Tehran, Iran",       tags: ["Navisworks", "Healthcare", "Clash"] },
  { id: "metro-station-2017",  title: "Metro Station Coordination",           short: "Metro",        date: "2017-02", elevation: 0.72,  major: true,  descriptor: "Federated MEP + structure model for a deep metro interchange box",       place: "Tehran, Iran",       tags: ["Navisworks", "Infrastructure", "Coordination"] },
  { id: "view-template-2017",  title: "View Template Enforcer",               short: "Views",        date: "2017-04", elevation: 0.30,  major: false, descriptor: "Add-in enforcing view templates and graphic standards on save",         place: "Tehran, Iran",       tags: ["Revit API", "Standards", "Automation"] },
  { id: "sheetset-2017",       title: "Revit Sheet-Set Automator",            short: "Sheet-Set",    date: "2017-05", elevation: 0.80,  major: true,  descriptor: "First C# Revit add-in — batch sheet creation and titleblock placement",   place: "Tehran, Iran",       tags: ["C# / .NET", "Revit API", "Automation"] },
  { id: "shading-louvre-2017", title: "Adaptive Louvre Wall",                 short: "Louvre",       date: "2017-08", elevation: 0.54,  major: false, descriptor: "Sun-tracking louvre wall study, Grasshopper + Ladybug analysis",         place: "Tehran, Iran",       tags: ["Grasshopper", "Ladybug", "Façade"] },
  { id: "hospital-coord-2017", title: "Hospital MEP Coordination",            short: "Hospital",     date: "2017-10", elevation: 0.70,  major: false, descriptor: "Full discipline clash coordination on a regional hospital build",        place: "Tehran, Iran",       tags: ["Navisworks", "Healthcare", "Coordination"] },
  { id: "stadium-2017",        title: "Stadium Roof Geometry",                short: "Stadium",      date: "2017-12", elevation: 0.92,  major: true,  descriptor: "Tensile roof form-finding and panelisation in Rhino / Grasshopper",      place: "Tehran, Iran",       tags: ["Rhino", "Form-finding", "Structure"] },
  { id: "param-stair-2018",    title: "Parametric Stair Generator",           short: "Stair Gen",    date: "2018-03", elevation: 0.42,  major: false, descriptor: "Dynamo stair generator with code-compliant rise/run checking",          place: "Tehran, Iran",       tags: ["Dynamo", "Revit", "Automation"] },
  { id: "warehouse-mep-2018",  title: "Warehouse MEP Routing",                short: "Warehouse",    date: "2018-05", elevation: 0.50,  major: false, descriptor: "Clash-free MEP routing for a large logistics warehouse shell",           place: "Tehran, Iran",       tags: ["Revit MEP", "Routing", "Coordination"] },
  { id: "gigafactory-2018",    title: "Gigafactory Pilot Coordination",       short: "Giga Pilot",   date: "2018-07", elevation: 0.74,  major: true,  descriptor: "First taste of heavy-industry MEP coordination at scale",                 place: "Tehran, Iran",       tags: ["Navisworks", "Industrial", "MEP"] },
  { id: "param-truss-2018",    title: "Parametric Truss Family",              short: "Truss",        date: "2018-09", elevation: 0.44,  major: false, descriptor: "Flexible Revit truss family driven by span and load parameters",         place: "Tehran, Iran",       tags: ["Revit", "Families", "Structure"] },
  { id: "ifc-export-2018",     title: "IFC Export Validator",                 short: "IFC Check",    date: "2018-10", elevation: 0.36,  major: false, descriptor: "Python validator catching broken IFC exports before handoff",            place: "Tehran, Iran",       tags: ["Python", "IFC", "Model QA"] },
  { id: "energy-2018",         title: "Energy-Model Pipeline",                short: "Energy Model", date: "2018-12", elevation: 0.48,  major: true,  descriptor: "Grasshopper → EnergyPlus pipeline feeding performance back to design",    place: "Tehran, Iran",       tags: ["Grasshopper", "Energy", "Computational"] },
  { id: "bridge-form-2019",    title: "Pedestrian Bridge Form-Finding",       short: "Bridge",       date: "2019-03", elevation: 0.60,  major: false, descriptor: "Funicular pedestrian-bridge study with Karamba structural feedback",      place: "Tehran, Iran",       tags: ["Karamba", "Grasshopper", "Structure"] },
  { id: "model-audit-2019",    title: "Model Naming Audit Script",            short: "Audit",        date: "2019-04", elevation: 0.32,  major: false, descriptor: "Batch script flagging non-conforming element and family names",          place: "Tehran, Iran",       tags: ["Python", "Model QA", "Standards"] },
  { id: "room-data-2019",      title: "Room Data Sheet Sync",                 short: "Room Data",    date: "2019-06", elevation: 0.30,  major: false, descriptor: "Two-way sync between Revit room data and an external requirements sheet", place: "Tehran, Iran",       tags: ["Dynamo", "Data", "Automation"] },
  { id: "tower-panel-2019",    title: "Tower Curtain-Wall Panelling",         short: "Curtain",      date: "2019-09", elevation: 0.56,  major: false, descriptor: "Rationalised curtain-wall panelling for a twisting office tower",        place: "Tehran, Iran",       tags: ["Grasshopper", "Façade", "High-rise"] },
  { id: "sheet-batch-2019",    title: "Batch Sheet Exporter",                 short: "Exporter",     date: "2019-10", elevation: 0.34,  major: false, descriptor: "One-click batch PDF/DWG sheet exporter with naming rules",               place: "Tehran, Iran",       tags: ["Revit API", "Export", "Automation"] },
  { id: "relocation-2019",     title: "Relocation Portfolio Prep",            short: "Portfolio",    date: "2019-12", elevation: 0.20,  major: false, descriptor: "Computational-design portfolio assembled ahead of the move to Sweden",   place: "Tehran, Iran",       tags: ["Portfolio", "Computational", "Career"] },
  { id: "thesis-2020",         title: "M.Sc. — Geometry ↔ Performance",       short: "M.Sc.",        date: "2020-02", elevation: -0.22, major: true,  descriptor: "Below-axis study — speculative computational-design master's research",   place: "Gothenburg, Sweden", tags: ["Research", "Computational", "Chalmers"] },
  { id: "topo-opt-2020",       title: "Topology-Optimised Slab Sketch",       short: "Topo Opt",     date: "2020-04", elevation: -0.18, major: false, descriptor: "Below-axis probe into topology-optimised concrete slab geometry",        place: "Gothenburg, Sweden", tags: ["Research", "Structure", "R&D"] },
  { id: "studio-tooling-2020", title: "Studio Grasshopper Toolkit",           short: "GH Toolkit",   date: "2020-05", elevation: 0.32,  major: false, descriptor: "Shared cluster library standardising the studio's Grasshopper workflows", place: "Gothenburg, Sweden", tags: ["Grasshopper", "Toolkit", "Standards"] },
  { id: "timber-grid-2020",    title: "Timber Gridshell Study",               short: "Gridshell",    date: "2020-08", elevation: 0.44,  major: false, descriptor: "CLT gridshell geometry study with bending-active member checking",       place: "Gothenburg, Sweden", tags: ["Timber", "Grasshopper", "Structure"] },
  { id: "schedule-sync-2020",  title: "Schedule-to-Excel Sync",               short: "Excel Sync",   date: "2020-10", elevation: 0.30,  major: false, descriptor: "Round-trip sync keeping Revit schedules and project Excel in step",      place: "Gothenburg, Sweden", tags: ["pyRevit", "Data", "Automation"] },
  { id: "wind-comfort-2020",   title: "Wind-Comfort Pre-Check",               short: "Wind",         date: "2020-11", elevation: -0.30, major: false, descriptor: "Below-axis CFD pre-check screening massing for pedestrian wind comfort",  place: "Gothenburg, Sweden", tags: ["CFD", "Environmental", "R&D"] },
  { id: "perf-dashboard-2020", title: "Performance-Driven Dashboard",         short: "Perf Board",   date: "2020-12", elevation: 0.50,  major: true,  descriptor: "Linked daylight, energy and area metrics into a live design dashboard",  place: "Gothenburg, Sweden", tags: ["Grasshopper", "Power BI", "Computational"] },
  { id: "daylight-2021",       title: "Daylight Optimisation Sketch",         short: "Daylight R&D", date: "2021-03", elevation: -0.34, major: false, descriptor: "The valley floor — an unbuilt R&D probe into automated daylight tuning",  place: "Gothenburg, Sweden", tags: ["Daylight", "Grasshopper", "R&D"] },
  { id: "facade-opt-2021",     title: "Façade Cost-Energy Optimiser",         short: "Opt Engine",   date: "2021-06", elevation: 0.52,  major: true,  descriptor: "Multi-objective optimiser balancing façade cost against energy demand",   place: "Gothenburg, Sweden", tags: ["Galapagos", "Optimisation", "Energy"] },
  { id: "covid-qa-2021",       title: "Remote Model-QA Tool",                 short: "Model-QA",     date: "2021-08", elevation: 0.24,  major: false, descriptor: "Lightweight Python model-audit script written during lockdown",          place: "Gothenburg, Sweden", tags: ["Python", "Model QA", "Automation"] },
  { id: "param-mass-2021",     title: "Parametric Massing Explorer",          short: "Massing",      date: "2021-09", elevation: 0.48,  major: true,  descriptor: "Interactive massing explorer wiring options to area and daylight metrics", place: "Gothenburg, Sweden", tags: ["Grasshopper", "Massing", "Computational"] },
  { id: "dashboard-v1-2021",   title: "Project KPI Dashboard v1",             short: "KPI v1",       date: "2021-11", elevation: 0.46,  major: false, descriptor: "First Power BI board surfacing model-health metrics to PMs",             place: "Gothenburg, Sweden", tags: ["Power BI", "Dashboard", "Model health"] },
  { id: "param-roof-2022",     title: "Parametric Roof Drainage",             short: "Drainage",     date: "2022-01", elevation: 0.38,  major: false, descriptor: "Grasshopper roof-fall solver routing to outlets within slope limits",    place: "Gothenburg, Sweden", tags: ["Grasshopper", "Drainage", "Automation"] },
  { id: "healthcare-2022",     title: "Healthcare Revit Model",               short: "Healthcare",   date: "2022-04", elevation: 0.50,  major: false, descriptor: "Coordinated Revit model and IFC delivery for a hospital wing",           place: "Gothenburg, Sweden", tags: ["Revit", "IFC", "Healthcare"] },
  { id: "clash-rules-2022",    title: "Clash Rule-Set Library",               short: "Clash Rules",  date: "2022-07", elevation: 0.56,  major: false, descriptor: "Curated Navisworks rule sets cutting false-positive clashes by half",    place: "Gothenburg, Sweden", tags: ["Navisworks", "Clash", "Standards"] },
  { id: "level-of-info-2022",  title: "Level-of-Information Matrix",          short: "LOIN",         date: "2022-09", elevation: 0.52,  major: false, descriptor: "Authored a level-of-information-need matrix for the project's BEP",       place: "Gothenburg, Sweden", tags: ["ISO 19650", "LOIN", "BIM strategy"] },
  { id: "white-ifc-2022",      title: "White Arkitekter — IFC Delivery",      short: "White IFC",    date: "2022-10", elevation: 0.64,  major: true,  descriptor: "Production Revit modelling and clean IFC handoffs for the design team",   place: "Gothenburg, Sweden", tags: ["Revit", "IFC", "Coordination"] },
  { id: "naming-std-2022",     title: "ISO 19650 Naming Pilot",               short: "Naming",       date: "2022-12", elevation: 0.42,  major: false, descriptor: "Trial information-naming standard rolled out on a pilot project",         place: "Gothenburg, Sweden", tags: ["ISO 19650", "Standards", "BIM strategy"] },
  { id: "la-massing-2023",     title: "LA Tower Massing Study",               short: "LA Massing",   date: "2023-02", elevation: 0.58,  major: false, descriptor: "Early massing-and-zoning option study for a downtown mixed-use tower",   place: "Los Angeles, USA",   tags: ["Rhino", "Massing", "Zoning"] },
  { id: "daylight-la-2023",    title: "Daylight Studies — Collective Arch.",  short: "Daylight LA",  date: "2023-04", elevation: 0.70,  major: true,  descriptor: "False-colour daylight + energy studies fed into the Revit model",         place: "Los Angeles, USA",   tags: ["Rhino", "Daylight", "Energy"] },
  { id: "facade-fab-2023",     title: "Façade Fabrication Sheets",            short: "Fab Sheets",   date: "2023-06", elevation: 0.50,  major: false, descriptor: "Grasshopper-to-shop-drawing pipeline for a unitised façade",            place: "Los Angeles, USA",   tags: ["Grasshopper", "Fabrication", "Façade"] },
  { id: "seismic-coord-2023",  title: "Seismic Bracing Coordination",         short: "Seismic",      date: "2023-07", elevation: 0.62,  major: false, descriptor: "Coordinated seismic bracing against MEP routes on a California build",   place: "Los Angeles, USA",   tags: ["Navisworks", "Seismic", "Coordination"] },
  { id: "campus-master-2023",  title: "Campus Masterplan Model",              short: "Masterplan",   date: "2023-08", elevation: 0.74,  major: true,  descriptor: "Federated masterplan model coordinating phasing across a tech campus",   place: "Los Angeles, USA",   tags: ["Rhino", "Masterplan", "Coordination"] },
  { id: "northvolt-2023",      title: "Northvolt ISO 19650 Setup",            short: "Northvolt",    date: "2023-09", elevation: 0.86,  major: true,  descriptor: "Stood up the information-management backbone on a gigafactory build",     place: "Skellefteå, Sweden", tags: ["ISO 19650", "BIM strategy", "Industrial"] },
  { id: "cde-setup-2023",      title: "Common Data Environment Setup",        short: "CDE",          date: "2023-11", elevation: 0.68,  major: false, descriptor: "Configured the CDE, workflows and permissions for a multi-tier supply chain", place: "Skellefteå, Sweden", tags: ["CDE", "ISO 19650", "Workflow"] },
  { id: "clashbot-2024",       title: "Navisworks Clash Bot",                 short: "Clash Bot",    date: "2024-02", elevation: 0.93,  major: true,  descriptor: "Automated clash-grouping add-in cutting weekly coordination to minutes", place: "Skellefteå, Sweden", tags: ["Navisworks API", "C# / .NET", "Automation"] },
  { id: "param-found-2024",    title: "Foundation Layout Generator",          short: "Foundations",  date: "2024-03", elevation: 0.58,  major: false, descriptor: "Parametric pile-cap and footing layout across a large process hall",      place: "Skellefteå, Sweden", tags: ["Dynamo", "Foundations", "Automation"] },
  { id: "model-health-2024",   title: "Model-Health Power BI",                short: "Health BI",    date: "2024-04", elevation: 0.66,  major: false, descriptor: "Power BI board tracking warnings, file size and sync health per model",  place: "Skellefteå, Sweden", tags: ["Power BI", "Model health", "Dashboard"] },
  { id: "rebar-auto-2024",     title: "Rebar Detailing Automation",           short: "Rebar",        date: "2024-05", elevation: 0.54,  major: false, descriptor: "Dynamo-driven rebar placement for repetitive industrial foundations",    place: "Skellefteå, Sweden", tags: ["Dynamo", "Rebar", "Automation"] },
  { id: "param-steel-2024",    title: "Steel Connection Detailer",            short: "Steel",        date: "2024-06", elevation: 0.60,  major: false, descriptor: "Parametric steel-connection detailing for a process-hall frame",         place: "Skellefteå, Sweden", tags: ["Grasshopper", "Steel", "Fabrication"] },
  { id: "training-2024",       title: "Coordination Training Programme",      short: "Training",     date: "2024-07", elevation: 0.58,  major: false, descriptor: "Mentoring curriculum that brought the modelling team up the curve",      place: "Skellefteå, Sweden", tags: ["Training", "Coordination", "Mentoring"] },
  { id: "deliverable-auto-2024", title: "Deliverable Packaging Bot",          short: "Packaging",    date: "2024-08", elevation: 0.50,  major: false, descriptor: "Bot assembling, naming and zipping ISO-19650 deliverable packages",      place: "Skellefteå, Sweden", tags: ["Python", "ISO 19650", "Automation"] },
  { id: "pipe-iso-2024",       title: "Pipe Spool ISO Generator",             short: "Pipe ISO",     date: "2024-09", elevation: 0.62,  major: true,  descriptor: "Add-in auto-generating piping isometrics from the federated model",       place: "Skellefteå, Sweden", tags: ["Revit API", "Piping", "Automation"] },
  { id: "logistics-4d-2024",   title: "4D Site Logistics Sequence",           short: "4D Site",      date: "2024-11", elevation: 0.72,  major: false, descriptor: "Time-linked logistics model sequencing crane and laydown areas",         place: "Skellefteå, Sweden", tags: ["4D", "Navisworks", "Logistics"] },
  { id: "neobuilt-2025",       title: "Neobuilt — Revit Add-in Suite",        short: "Neobuilt",     date: "2025-02", elevation: 0.88,  major: true,  descriptor: "Founded the studio; shipped a suite of bespoke Revit / Navisworks tools", place: "Gothenburg, Sweden", tags: ["C# / .NET", "Revit API", "Product"] },
  { id: "param-cladding-2025", title: "Cladding Set-out Tool",                short: "Cladding",     date: "2025-03", elevation: 0.60,  major: false, descriptor: "Set-out tool placing cladding panels and exporting fixing schedules",     place: "Gothenburg, Sweden", tags: ["Grasshopper", "Façade", "Fabrication"] },
  { id: "stegra-bim-2025",     title: "Stegra BIM Strategy",                  short: "Stegra BIM",   date: "2025-04", elevation: 1.0,   major: true,  descriptor: "The summit — authored BIM strategy for a green-steel megaproject",        place: "Stockholm, Sweden",  tags: ["BIM strategy", "ISO 19650", "Green steel"] },
  { id: "param-equip-2025",    title: "Process-Equipment Parametrics",        short: "Equipment",    date: "2025-06", elevation: 0.70,  major: false, descriptor: "Parametric process-equipment families with live datasheet linkage",      place: "Stockholm, Sweden",  tags: ["Revit", "Families", "Industrial"] },
  { id: "twin-pilot-2025",     title: "Digital-Twin Data Pilot",              short: "Twin Pilot",   date: "2025-07", elevation: 0.78,  major: true,  descriptor: "Pilot linking the federated model to live operations sensor data",       place: "Stockholm, Sweden",  tags: ["Digital Twin", "Data", "Python"] },
  { id: "stegra-pbi-2025",     title: "Stegra Power BI Decision Boards",      short: "Power BI",     date: "2025-09", elevation: 0.94,  major: true,  descriptor: "Live dashboards turning federated model data into project decisions",    place: "Stockholm, Sweden",  tags: ["Power BI", "Dashboard", "Strategy"] },
  { id: "qto-pipeline-2025",   title: "Quantity-Takeoff Pipeline",            short: "QTO Pipe",     date: "2025-10", elevation: 0.66,  major: false, descriptor: "Automated quantity extraction feeding cost and carbon models",          place: "Stockholm, Sweden",  tags: ["Python", "Quantities", "Automation"] },
  { id: "iso-audit-2025",      title: "ISO 19650 Audit Toolkit",              short: "ISO Audit",    date: "2025-12", elevation: 0.74,  major: false, descriptor: "Scripted audit checking deliverables against the information standard",    place: "Stockholm, Sweden",  tags: ["ISO 19650", "Audit", "Python"] },
  { id: "param-acoustic-2026", title: "Acoustic Ceiling Optimiser",           short: "Acoustic",     date: "2026-01", elevation: 0.56,  major: false, descriptor: "Grasshopper study tuning ceiling baffles against reverberation targets",  place: "Stockholm, Sweden",  tags: ["Grasshopper", "Acoustics", "Optimisation"] },
  { id: "api-layer-2026",      title: "Model-Data API Layer",                 short: "Data API",     date: "2026-03", elevation: 0.62,  major: true,  descriptor: "A Python service exposing live model metrics to any downstream tool",     place: "Stockholm, Sweden",  tags: ["Python", "API", "Automation"] },
  { id: "auto-coord-2026",     title: "Auto-Coordination Report",             short: "Auto Report",  date: "2026-04", elevation: 0.68,  major: false, descriptor: "Scheduled job generating weekly coordination reports from clash data",    place: "Stockholm, Sweden",  tags: ["Python", "Navisworks", "Reporting"] },
  { id: "carbon-dash-2026",    title: "Embodied-Carbon Dashboard",            short: "Carbon",       date: "2026-06", elevation: 0.80,  major: true,  descriptor: "Power BI board joining quantities to an embodied-carbon dataset",        place: "Stockholm, Sweden",  tags: ["Power BI", "Carbon", "Sustainability"] },
];

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** decimal year for x-placement, e.g. "2025-04" → 2025.25 */
export const decimalYear = (date: string): number => {
  const [y, m] = date.split("-").map(Number);
  return y + (m - 1) / 12;
};

/** screen-reader date fragment, e.g. "April 2025" */
export const formatMonthYearLong = (date: string): string => {
  const [y, m] = date.split("-").map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
};

/** the plotted time window — a hair of padding past the first/last project */
export const TIME_MIN = 2014.0;
export const TIME_MAX = 2026.5;
