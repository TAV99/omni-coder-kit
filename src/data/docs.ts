export interface DocSection {
  id: string;
  title: string;
  group: string;
}

export const docGroups = [
  {
    name: "Getting Started",
    sections: [
      { id: "introduction", title: "Introduction", group: "Getting Started" },
      { id: "installation", title: "Installation", group: "Getting Started" },
    ],
  },
  {
    name: "Core Concepts",
    sections: [
      { id: "karpathy-mindset", title: "Karpathy Mindset", group: "Core Concepts" },
      { id: "socratic-gate", title: "Socratic Gate", group: "Core Concepts" },
      { id: "skills-system", title: "Skills System", group: "Core Concepts" },
      { id: "dna-detection", title: "DNA Detection", group: "Core Concepts" },
      { id: "workflows-overview", title: "Workflows", group: "Core Concepts" },
    ],
  },
  {
    name: "Guide",
    sections: [
      { id: "om-brainstorm", title: "om:brainstorm", group: "Guide" },
      { id: "om-equip", title: "om:equip", group: "Guide" },
      { id: "om-plan", title: "om:plan", group: "Guide" },
      { id: "om-cook", title: "om:cook", group: "Guide" },
      { id: "om-check", title: "om:check", group: "Guide" },
      { id: "om-fix", title: "om:fix", group: "Guide" },
      { id: "om-doc", title: "om:doc", group: "Guide" },
      { id: "ide-cli-guides", title: "IDE & CLI Guides", group: "Guide" },
    ],
  },
  {
    name: "CLI Reference",
    sections: [
      { id: "cli-commands", title: "Commands", group: "CLI Reference" },
      { id: "ide-support", title: "IDE Support", group: "CLI Reference" },
    ],
  },
] as const;

export const allSections: DocSection[] = docGroups.flatMap((g) =>
  g.sections.map((s) => ({ ...s, group: g.name }))
);
