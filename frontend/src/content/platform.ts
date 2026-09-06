/**
 * Reviewed public product data. Keeping this in Git makes changes auditable and
 * prevents the public research surface becoming an unmoderated CMS.
 */
export const team = [
  {
    name: 'Francisco Javier Cavero López',
    role: 'Maintainer · repository contributor',
    affiliation: 'Universidad de Sevilla',
    initials: 'FC',
    links: {
      orcid: 'https://orcid.org/0009-0004-2453-8814',
      github: 'https://github.com/javiercavlop',
      scholar: 'https://scholar.google.es/citations?user=vDBqkIkAAAAJ',
      profile: 'https://prisma.us.es/investigador/8488',
    },
  },
  {
    name: 'José Antonio Parejo Maestre',
    role: 'Research advisor · repository contributor',
    affiliation: 'Universidad de Sevilla',
    initials: 'JP',
    links: {
      orcid: 'https://orcid.org/0000-0002-4708-4606',
      github: 'https://github.com/japarejo',
      scholar: 'https://scholar.google.es/citations?user=1vZmkFIAAAAJ',
      profile: 'https://prisma.us.es/investigador/3163',
    },
  },
] as const;

export const researchCorpus = [
  { year: 2020, title: 'A Web Service Composition Method Based on OpenAPI Semantic Annotations', authors: 'A. Netedu et al.', venue: 'Service-Oriented Computing', doi: '10.1007/978-3-030-34986-8_25', corpus: 'Transport agency' },
  { year: 2018, title: 'A Practical Approach to Services Composition Through Light Semantic Descriptions', authors: 'M. Cremaschi et al.', venue: 'Service-Oriented Computing', doi: '10.1007/978-3-319-99819-0_10', corpus: 'Textbook access' },
  { year: 2014, title: 'Context-aware Generic Service Discovery and Service Composition', authors: 'Y. Zhang et al.', venue: 'IEEE Mobile Services', doi: '10.1109/MobServ.2014.27', corpus: 'Entertainment planner' },
  { year: 2009, title: 'RESTful Web service composition with BPEL for REST', authors: 'C. Pautasso', venue: 'Data & Knowledge Engineering', doi: '10.1016/j.datak.2009.02.016', corpus: 'RESTful e-commerce' },
  { year: 2003, title: 'Conversation Specification: A New Approach to Design and Analysis of E-Service Composition', authors: 'T. Bultan et al.', venue: 'WWW', doi: '10.1145/775152.775210', corpus: 'Warehouse conversation' },
  { year: 2002, title: 'Declarative Composition and Peer-to-Peer Provisioning of Dynamic Web Services', authors: 'B. Benatallah et al.', venue: 'IEEE ICDE', doi: '10.1109/ICDE.2002.994738', corpus: 'SELF-SERV travel' },
] as const;

export const fundingEntities = [
  { name: 'SCORE Lab', scope: 'Research software ecosystem', url: 'https://score.us.es' },
  { name: 'Agencia Estatal de Investigación', scope: 'Spanish research funding ecosystem', url: 'https://www.aei.gob.es' },
  { name: 'Universidad de Sevilla', scope: 'Institutional identity and research context', url: 'https://www.us.es' },
  { name: 'Junta de Andalucía', scope: 'Andalusian research funding ecosystem', url: 'https://www.juntadeandalucia.es' },
] as const;

export const relatedProjects = [
  { name: 'OpenBinding', kind: 'Core platform', period: 'Active', role: 'BIM language, execution, collaboration and reproducibility', url: 'https://github.com/isa-group/OpenBinding' },
  { name: 'SPHERE', kind: 'Reference platform', period: 'Active', role: 'Product and administration patterns adapted for binding analysis', url: 'https://github.com/SCORELabUS/SPHERE' },
  { name: 'SPACE', kind: 'Runtime dependency', period: 'v1.5', role: 'Contracts, plan configuration and usage enforcement', url: 'https://github.com/isa-group/SPACE' },
  { name: 'Pricing4SaaS', kind: 'Research ecosystem', period: 'Active', role: 'Pricing2Yaml, validation and pricing-driven operation', url: 'https://github.com/isa-group' },
] as const;

export const contributionTracks = [
  { title: 'Uncertainty-aware binding profile', level: 'TFG · TFM', tags: ['BIM', 'Optimization'], description: 'Design a separately versioned BIM Profile for uncertain QoS, scenario aggregation and risk measures without weakening qos-binding/v1 determinism.' },
  { title: 'Engine reproducibility benchmark', level: 'TFG · Research', tags: ['Engines', 'Experiments'], description: 'Build comparative studies that measure Pareto quality, convergence and stability across exact and evolutionary engine revisions.' },
  { title: 'Accessible BPMN binding workbench', level: 'TFG', tags: ['Frontend', 'Accessibility'], description: 'Improve keyboard-first graph authoring, diagnostics and synchronized BPMN/JSON inspection with WCAG AA evidence.' },
  { title: 'Federated engine conformance kit', level: 'TFM · Research', tags: ['Federation', 'Testing'], description: 'Extend the engine contract verifier with adversarial fixtures, compatibility properties and reproducible certification reports.' },
  { title: 'Binding corpus provenance', level: 'Research', tags: ['Datasets', 'Reproducibility'], description: 'Curate literature-derived composition cases while explicitly separating published facts from illustrative QoS values.' },
] as const;
