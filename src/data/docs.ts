export interface DocSection {
  id: string;
  title: { vi: string; en: string };
  group: string;
}

export const docGroups = {
  vi: [
    {
      name: "Bắt đầu",
      sections: [
        { id: "introduction", title: { vi: "Giới thiệu", en: "Introduction" }, group: "Bắt đầu" },
        { id: "installation", title: { vi: "Cài đặt", en: "Installation" }, group: "Bắt đầu" },
      ],
    },
    {
      name: "Khái niệm cốt lõi",
      sections: [
        { id: "karpathy-mindset", title: { vi: "Karpathy Mindset", en: "Karpathy Mindset" }, group: "Khái niệm cốt lõi" },
        { id: "socratic-gate", title: { vi: "Socratic Gate", en: "Socratic Gate" }, group: "Khái niệm cốt lõi" },
        { id: "skills-system", title: { vi: "Hệ thống Skills", en: "Skills System" }, group: "Khái niệm cốt lõi" },
        { id: "dna-detection", title: { vi: "DNA Detection", en: "DNA Detection" }, group: "Khái niệm cốt lõi" },
        { id: "knowledge-base", title: { vi: "Knowledge Base", en: "Knowledge Base" }, group: "Khái niệm cốt lõi" },
        { id: "shared-context-brief", title: { vi: "Shared Context Brief", en: "Shared Context Brief" }, group: "Khái niệm cốt lõi" },
        { id: "content-source", title: { vi: "Content Source-of-Truth", en: "Content Source-of-Truth" }, group: "Khái niệm cốt lõi" },
        { id: "workflows-overview", title: { vi: "Workflows", en: "Workflows" }, group: "Khái niệm cốt lõi" },
      ],
    },
    {
      name: "Hướng dẫn",
      sections: [
        { id: "om-brainstorm", title: { vi: "om:brainstorm", en: "om:brainstorm" }, group: "Hướng dẫn" },
        { id: "om-equip", title: { vi: "om:equip", en: "om:equip" }, group: "Hướng dẫn" },
        { id: "om-plan", title: { vi: "om:plan", en: "om:plan" }, group: "Hướng dẫn" },
        { id: "om-cook", title: { vi: "om:cook", en: "om:cook" }, group: "Hướng dẫn" },
        { id: "om-check", title: { vi: "om:check", en: "om:check" }, group: "Hướng dẫn" },
        { id: "om-fix", title: { vi: "om:fix", en: "om:fix" }, group: "Hướng dẫn" },
        { id: "om-learn", title: { vi: "om:learn", en: "om:learn" }, group: "Hướng dẫn" },
        { id: "om-doc", title: { vi: "om:doc", en: "om:doc" }, group: "Hướng dẫn" },
        { id: "ide-cli-guides", title: { vi: "IDE & CLI Guides", en: "IDE & CLI Guides" }, group: "Hướng dẫn" },
      ],
    },
    {
      name: "CLI Reference",
      sections: [
        { id: "cli-commands", title: { vi: "Commands", en: "Commands" }, group: "CLI Reference" },
        { id: "ide-support", title: { vi: "IDE Support", en: "IDE Support" }, group: "CLI Reference" },
      ],
    },
  ],
  en: [
    {
      name: "Getting Started",
      sections: [
        { id: "introduction", title: { vi: "Giới thiệu", en: "Introduction" }, group: "Getting Started" },
        { id: "installation", title: { vi: "Cài đặt", en: "Installation" }, group: "Getting Started" },
      ],
    },
    {
      name: "Core Concepts",
      sections: [
        { id: "karpathy-mindset", title: { vi: "Karpathy Mindset", en: "Karpathy Mindset" }, group: "Core Concepts" },
        { id: "socratic-gate", title: { vi: "Socratic Gate", en: "Socratic Gate" }, group: "Core Concepts" },
        { id: "skills-system", title: { vi: "Hệ thống Skills", en: "Skills System" }, group: "Core Concepts" },
        { id: "dna-detection", title: { vi: "DNA Detection", en: "DNA Detection" }, group: "Core Concepts" },
        { id: "knowledge-base", title: { vi: "Knowledge Base", en: "Knowledge Base" }, group: "Core Concepts" },
        { id: "shared-context-brief", title: { vi: "Shared Context Brief", en: "Shared Context Brief" }, group: "Core Concepts" },
        { id: "content-source", title: { vi: "Content Source-of-Truth", en: "Content Source-of-Truth" }, group: "Core Concepts" },
        { id: "workflows-overview", title: { vi: "Workflows", en: "Workflows" }, group: "Core Concepts" },
      ],
    },
    {
      name: "Guide",
      sections: [
        { id: "om-brainstorm", title: { vi: "om:brainstorm", en: "om:brainstorm" }, group: "Guide" },
        { id: "om-equip", title: { vi: "om:equip", en: "om:equip" }, group: "Guide" },
        { id: "om-plan", title: { vi: "om:plan", en: "om:plan" }, group: "Guide" },
        { id: "om-cook", title: { vi: "om:cook", en: "om:cook" }, group: "Guide" },
        { id: "om-check", title: { vi: "om:check", en: "om:check" }, group: "Guide" },
        { id: "om-fix", title: { vi: "om:fix", en: "om:fix" }, group: "Guide" },
        { id: "om-learn", title: { vi: "om:learn", en: "om:learn" }, group: "Guide" },
        { id: "om-doc", title: { vi: "om:doc", en: "om:doc" }, group: "Guide" },
        { id: "ide-cli-guides", title: { vi: "IDE & CLI Guides", en: "IDE & CLI Guides" }, group: "Guide" },
      ],
    },
    {
      name: "CLI Reference",
      sections: [
        { id: "cli-commands", title: { vi: "Commands", en: "Commands" }, group: "CLI Reference" },
        { id: "ide-support", title: { vi: "IDE Support", en: "IDE Support" }, group: "CLI Reference" },
      ],
    },
  ],
};

export const allSections = (lang: "vi" | "en"): DocSection[] =>
  docGroups[lang].flatMap((g) =>
    g.sections.map((s) => ({ ...s, group: g.name }))
  );
