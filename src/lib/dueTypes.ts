/** Must match the Prisma `DueType` enum. */
export const DUE_TYPES = [
  'handout',
  'departmental_due',
  'exam_levy',
  'lab_manual',
  'association_due',
  'departmental_wear',
  'trip_fee',
  'clearance',
  'other',
] as const;

export type DueTypeValue = (typeof DUE_TYPES)[number];

export const DUE_TYPE_LABELS: Record<DueTypeValue, string> = {
  handout: 'Handout',
  departmental_due: 'Departmental due',
  exam_levy: 'Exam levy',
  lab_manual: 'Lab manual',
  association_due: 'Association due',
  departmental_wear: 'Departmental wear',
  trip_fee: 'Trip fee',
  clearance: 'Clearance',
  other: 'Other',
};
