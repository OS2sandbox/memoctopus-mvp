import type { Template, TemplateStructure } from '@/types';

export const DEFAULT_TEMPLATES: Template[] = [
  {
    id: 'tmpl-bestyrelsesmøde',
    name: 'Bestyrelsesmøde',
    description: 'Standard skabelon til bestyrelsesmøder med beslutningspunkter og opfølgning',
    isDefault: true,
    structure: {
      sections: [
        { key: 'deltagere', label: 'Deltagere', required: true },
        { key: 'dagsorden', label: 'Dagsorden', required: true },
        { key: 'beslutninger', label: 'Beslutninger', required: true },
        { key: 'handlepunkter', label: 'Handlepunkter', required: false },
        { key: 'næste_møde', label: 'Næste møde', required: false },
      ],
    } as TemplateStructure,
  },
  {
    id: 'tmpl-personalemøde',
    name: 'Personalemøde',
    description: 'Til personalemøder og medarbejdersamtaler',
    isDefault: false,
    structure: {
      sections: [
        { key: 'deltagere', label: 'Deltagere', required: true },
        { key: 'punkter', label: 'Drøftede punkter', required: true },
        { key: 'aftaler', label: 'Aftaler og opfølgning', required: true },
        { key: 'næste_møde', label: 'Næste møde', required: false },
      ],
    } as TemplateStructure,
  },
  {
    id: 'tmpl-forældresamtale',
    name: 'Forældresamtale',
    description: 'Til skole-hjem samtaler og forældremøder',
    isDefault: false,
    structure: {
      sections: [
        { key: 'deltagere', label: 'Deltagere', required: true },
        { key: 'fagligt', label: 'Fagligt', required: true },
        { key: 'trivsel', label: 'Trivsel og sociale forhold', required: true },
        { key: 'aftaler', label: 'Aftaler', required: true },
      ],
    } as TemplateStructure,
  },
  {
    id: 'tmpl-projektmøde',
    name: 'Projektmøde',
    description: 'Til projekt- og arbejdsmøder med statusopdateringer',
    isDefault: false,
    structure: {
      sections: [
        { key: 'deltagere', label: 'Deltagere', required: true },
        { key: 'status', label: 'Status', required: true },
        { key: 'beslutninger', label: 'Beslutninger', required: true },
        { key: 'opgaver', label: 'Opgaver og ansvar', required: true },
        { key: 'næste_møde', label: 'Næste møde', required: false },
      ],
    } as TemplateStructure,
  },
];

export function getTemplates(): Template[] {
  return DEFAULT_TEMPLATES;
}
