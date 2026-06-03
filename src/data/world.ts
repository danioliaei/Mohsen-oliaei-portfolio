/* ============================================================================
   Single source of truth for the two worlds.

   NOTE (see DECISIONS.md / brief §11): project & site copy below is DRAFT
   placeholder keyed to Mohsèn's history. Stegra and Northvolt are real and used
   intentionally — anything potentially NDA-sensitive must be reviewed before a
   public deploy. The whole engine is driven from this file; editing copy here is
   the supported way to refine content.
   ========================================================================== */

export type Theme = "dark" | "light";

export type IsoKind = "steel" | "battery" | "tower" | "office" | "module";

export interface Project {
  id: string;
  label: string;
  role: string;
  /** " · " separated stack list. */
  stack: string;
  /** "2024", "2023–24", or "—". */
  year: string;
  scope: string;
  blurb: string;
  /** optional live link / demo. */
  href?: string;
  iso?: IsoKind;
}

/** A place on a globe. */
export interface GeoNode {
  id: string;
  label: string;
  sub?: string;
  lat: number;
  lng: number;
  children?: GeoNode[];
  /** leaf payload. */
  project?: Project;
}

export interface World {
  id: "built" | "digital";
  /** e.g. "The Built World". */
  title: string;
  /** e.g. "BIM Coordination · field & federation". */
  subtitle: string;
  hub: { lat: number; lng: number };
  nodes: GeoNode[];
}

export const BUILT: World = {
  id: "built",
  title: "The Built World",
  subtitle: "BIM Coordination · field & federation",
  hub: { lat: 59, lng: 15 },
  nodes: [
    {
      id: "sweden",
      label: "Sweden",
      sub: "4 sites",
      lat: 62,
      lng: 15,
      children: [
        {
          id: "gbg",
          label: "Gothenburg",
          lat: 57.71,
          lng: 11.97,
          project: {
            id: "gbg",
            label: "Gothenburg — infrastructure",
            role: "BIM Developer",
            stack: "Dynamo · Python · IFC 4.3",
            year: "2023",
            scope: "Parametrics · QTO",
            blurb:
              "Parametric infrastructure tooling and automated quantity take-off for a long-span project.",
            iso: "office",
          },
        },
        {
          id: "sthlm",
          label: "Stockholm",
          lat: 59.33,
          lng: 18.07,
          project: {
            id: "sthlm",
            label: "Stockholm — high-rise",
            role: "BIM Developer",
            stack: "Revit API (C#) · Navisworks",
            year: "2024",
            scope: "Coordination · automation",
            blurb:
              "Plug-in driven coordination and model audits across a high-rise federated model.",
            iso: "tower",
          },
        },
        {
          id: "skelleftea",
          label: "Skellefteå",
          lat: 64.75,
          lng: 20.95,
          project: {
            id: "northvolt",
            label: "Northvolt — battery gigafactory",
            role: "BIM Coordinator",
            stack: "Navisworks · Revit MEP · Synchro",
            year: "2023",
            scope: "MEP coordination · 4D",
            blurb:
              "Dense MEP coordination and 4D sequencing across battery-gigafactory halls.",
            iso: "battery",
          },
        },
        {
          id: "boden",
          label: "Boden",
          lat: 65.82,
          lng: 21.69,
          project: {
            id: "stegra",
            label: "Stegra — green steel",
            role: "BIM Coordinator / Developer",
            stack: "Revit · Navisworks · Solibri · C#",
            year: "2024–25",
            scope: "Coordination · QA · scan-to-BIM",
            blurb:
              "Federated coordination, clash resolution and scan-to-BIM as-builts for a green-steel plant.",
            iso: "steel",
          },
        },
      ],
    },
    {
      id: "iran",
      label: "Iran",
      sub: "origin",
      lat: 32,
      lng: 53,
      children: [
        {
          id: "tehran",
          label: "Tehran",
          lat: 35.7,
          lng: 51.4,
          project: {
            id: "tehran",
            label: "Tehran — origin",
            role: "Education · early work",
            stack: "Revit · AutoCAD",
            year: "—",
            scope: "Foundations",
            blurb:
              "Where it began — architectural education and first steps into BIM.",
            iso: "office",
          },
        },
      ],
    },
    {
      id: "usa",
      label: "USA",
      sub: "remote",
      lat: 39,
      lng: -98,
      children: [
        {
          id: "usa-remote",
          label: "Remote · USA",
          lat: 40.7,
          lng: -74,
          project: {
            id: "usa-remote",
            label: "Remote · USA",
            role: "Remote collaboration",
            stack: "Speckle · Web · IFC.js",
            year: "—",
            scope: "openBIM · web",
            blurb:
              "Remote openBIM collaboration and web-viewer work with US-based teams.",
            iso: "office",
          },
        },
      ],
    },
  ],
};

// The Digital World descends to a room + screen rather than a factory.
export const DIGITAL: World = {
  id: "digital",
  title: "The Digital World",
  subtitle: "BIM Development · tools & automation",
  hub: { lat: 54, lng: 9 },
  nodes: [
    {
      id: "europe",
      label: "Europe",
      lat: 54,
      lng: 9,
      children: [
        {
          id: "sweden-d",
          label: "Sweden",
          lat: 60,
          lng: 15,
          children: [
            {
              id: "gbg-d",
              label: "Gothenburg",
              lat: 57.71,
              lng: 11.97,
              children: [
                {
                  id: "partille",
                  label: "Partille",
                  lat: 57.74,
                  lng: 12.11,
                  children: [
                    {
                      id: "room",
                      label: "My room",
                      sub: "workspace",
                      lat: 57.74,
                      lng: 12.11,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export const DIGITAL_PROJECTS: Project[] = [
  {
    id: "revit",
    label: "Revit API toolkit",
    role: "BIM Developer",
    stack: "C# · Revit API · WPF",
    year: "2024",
    scope: "Tooling",
    iso: "module",
    blurb:
      "A library of C# add-ins automating sheet setup, parameter management and model audits.",
  },
  {
    id: "dynamo",
    label: "Dynamo automation",
    role: "Computational Designer",
    stack: "Dynamo · Python",
    year: "2023",
    scope: "Automation",
    iso: "module",
    blurb:
      "Reusable Dynamo / Python graphs for batch geometry, data sync and QA — packaged for non-coders.",
  },
  {
    id: "webifc",
    label: "Web IFC viewer",
    role: "BIM Developer",
    stack: "IFC.js · Speckle · TypeScript",
    year: "2024",
    scope: "Web",
    iso: "module",
    blurb:
      "A lightweight browser IFC + point-cloud viewer with Speckle for sharing live models.",
  },
];

export const WORLDS: Record<World["id"], World> = {
  built: BUILT,
  digital: DIGITAL,
};

/* ---- Navigation helpers ----------------------------------------------------*/

/** Depth-first lookup of a node by id within a world. */
export function findNode(world: World, id: string): GeoNode | undefined {
  const walk = (nodes: GeoNode[]): GeoNode | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const hit = walk(n.children);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(world.nodes);
}

/** Resolve a project by id across both worlds' leaves and the digital gallery. */
export function findProject(id: string): Project | undefined {
  for (const world of Object.values(WORLDS)) {
    const walk = (nodes: GeoNode[]): Project | undefined => {
      for (const n of nodes) {
        if (n.project?.id === id) return n.project;
        if (n.children) {
          const hit = walk(n.children);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    const hit = walk(world.nodes);
    if (hit) return hit;
  }
  return DIGITAL_PROJECTS.find((p) => p.id === id);
}

/** Highlight country index for the focus spotlight — must match the
 *  NAME_TO_INDEX map in scene/geoCache.ts. 1 = Sweden · 2 = Iran · 3 = USA. */
const COUNTRY_HL: Record<string, number> = {
  sweden: 1,
  iran: 2,
  usa: 3,
  "sweden-d": 1,
};

/** Highlight index of the focused node's country ancestor (0 if none). Lets the
 *  globe spotlight the country you've descended into. */
export function focusCountryIndex(world: World, id: string | null): number {
  if (!id) return 0;
  for (const n of pathToNode(world, id)) {
    const v = COUNTRY_HL[n.id];
    if (v) return v;
  }
  return 0;
}

/** Path of nodes from the world root down to (and including) `id`. */
export function pathToNode(world: World, id: string): GeoNode[] {
  const stack: GeoNode[] = [];
  const found: GeoNode[] = [];
  const walk = (nodes: GeoNode[]): boolean => {
    for (const n of nodes) {
      stack.push(n);
      if (n.id === id) {
        found.push(...stack);
        return true;
      }
      if (n.children && walk(n.children)) return true;
      stack.pop();
    }
    return false;
  };
  walk(world.nodes);
  return found;
}
