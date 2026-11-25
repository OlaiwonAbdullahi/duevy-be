import type { SpaceKind } from '@prisma/client';

/**
 * Space vocabulary — the human-facing nouns for each kind of space, in one
 * place. A faculty runs on exactly the same machinery as a department (same
 * Space, rep, wallet, dues, public paywall); only the words change. This is the
 * first real consumer of `Space.kind` — for copy only, never for money logic.
 *
 * Call these with `space.kind` wherever a user-facing "department"/"rep" string
 * is emitted (serializers, emails, receipts), instead of hardcoding a noun.
 */

type Vocab = {
  /** The space itself: "department", "faculty", … */
  collective: string;
  /** The person who runs it: "rep", "faculty exec", … */
  leader: string;
  /** How someone belongs: "member". Faculties collect publicly, so "payer". */
  participant: string;
};

const VOCAB: Record<SpaceKind, Vocab> = {
  department: { collective: 'department', leader: 'rep', participant: 'member' },
  association: { collective: 'association', leader: 'rep', participant: 'member' },
  club: { collective: 'club', leader: 'rep', participant: 'member' },
  faculty: { collective: 'faculty', leader: 'faculty exec', participant: 'payer' },
};

function vocab(kind: SpaceKind): Vocab {
  return VOCAB[kind] ?? VOCAB.department;
}

/** The space's collective noun, e.g. "department" or "faculty". */
export function collectiveLabel(kind: SpaceKind): string {
  return vocab(kind).collective;
}

/** The space's leader noun, e.g. "rep" or "faculty exec". */
export function leaderLabel(kind: SpaceKind): string {
  return vocab(kind).leader;
}

/** The space's participant noun, e.g. "member" or "payer". */
export function participantLabel(kind: SpaceKind): string {
  return vocab(kind).participant;
}

/**
 * Whether people join this kind of space with a join code. Faculties collect
 * only through public pay links — nobody joins — so their join code is hidden.
 */
export function isJoinable(kind: SpaceKind): boolean {
  return kind !== 'faculty';
}
