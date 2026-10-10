import {
  type Space,
  type Due,
  type User,
  type SpaceAuditLog,
  type Transaction,
  type Payout,
  type PayoutBeneficiary,
  type Notification,
  type Poll,
  type PollCategory,
  type Nominee,
  type AdminAuditLog,
  type Dispute,
  type AssistantConversation,
  type AssistantMessage,
  type Feedback,
} from '@prisma/client';

type UserWithSpaces = User & {
  spaceMemberships: { space: { name: string } }[];
  spaceReps: { space: { name: string } }[];
};

type PollWithTree = Poll & { categories: (PollCategory & { nominees: Nominee[] })[] };

export type SpaceMembershipView = 'member' | 'guest';

/** The `Transaction` ledger resource (§9). */
export function serializeTransaction(t: Transaction) {
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    detail: t.detail,
    amount: t.amount,
    method: t.method,
    status: t.status,
    reference: t.reference,
    createdAt: t.createdAt.toISOString(),
  };
}

/**
 * The `Payout` (withdrawal) resource. `amount` is the gross debited from the
 * space; `fee` is Duevy's withdrawal fee, deducted from it; `net` is what
 * reaches the beneficiary's bank. Status: pending | processing | success | failed | reversed.
 */
export function serializePayout(p: Payout) {
  const legacy = p.provider === 'anchor';
  const fee = legacy ? p.duevyFeeKobo + p.anchorFeeKobo + p.stampDutyKobo : p.feeKobo;
  const net = legacy ? p.netSentKobo : p.netKobo;
  return {
    id: p.id,
    amount: p.amount,
    fee,
    net,
    reference: p.reference,
    status: p.status,
    account: p.accountMasked,
    accountName: p.accountName,
    beneficiaryId: p.beneficiaryId,
    note: p.note,
    requestedById: p.requestedById,
    requestedAt: p.requestedAt.toISOString(),
    processingAt: p.processingAt?.toISOString() ?? null,
    settledAt: p.settledAt?.toISOString() ?? null,
    failedAt: p.failedAt?.toISOString() ?? null,
    reversedAt: p.reversedAt?.toISOString() ?? null,
    failureReason: p.failureReason,
    // Deprecated aliases kept for existing clients.
    duevyFee: fee,
    netSent: net,
  };
}

/** A payout beneficiary. The account number is always masked. */
export function serializeBeneficiary(b: PayoutBeneficiary) {
  return {
    id: b.id,
    label: b.label,
    bankCode: b.bankCode,
    bankName: b.bankName,
    accountNumber: b.accountNumberMasked,
    accountName: b.accountName,
    createdAt: b.createdAt.toISOString(),
  };
}

/** The admin `AppUser` resource (§14.2). */
export function serializeAppUser(u: UserWithSpaces) {
  const spaceNames = [
    ...u.spaceMemberships.map((m) => m.space.name),
    ...u.spaceReps.map((r) => r.space.name),
  ];
  const spaces = [...new Set(spaceNames)];
  return {
    id: u.id,
    role: u.role,
    name: u.name,
    email: u.email,
    department: spaces[0] ?? null,
    isSuspended: u.isSuspended,
    isDeactivated: u.isDeactivated,
    kycStatus: u.kycStatus,
    kycDocs: u.kycDocUrls,
    spaces,
  };
}

/** The `Dispute` resource (§14.6), with derived `ageDays`. */
export function serializeDispute(d: Dispute) {
  const ageDays = Math.floor((Date.now() - d.createdAt.getTime()) / (24 * 60 * 60 * 1000));
  return {
    id: d.id,
    type: d.type,
    openedBy: d.openedByName,
    email: d.openedByEmail,
    department: d.department,
    status: d.status,
    slaDays: d.slaDays,
    ageDays,
    breached: ageDays > d.slaDays,
    txnReference: d.txnReference,
    description: d.description,
    studentEvidence: d.studentEvidence,
    repEvidence: d.repEvidence,
    resolution: d.resolution,
    refundTxnId: d.refundTxnId,
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

/** An admin audit-log row (§14.9). */
export function serializeAdminAuditLog(l: AdminAuditLog) {
  return {
    id: l.id,
    actor: l.actorName,
    role: l.role,
    action: l.action,
    target: l.target,
    ip: l.ip,
    device: l.device,
    severity: l.severity,
    createdAt: l.createdAt.toISOString(),
  };
}

/** The `Notification` resource (§13). */
export function serializeNotification(n: Notification) {
  return {
    id: n.id,
    kind: n.kind,
    tone: n.tone,
    title: n.title,
    detail: n.detail,
    href: n.href,
    read: n.read,
    createdAt: n.createdAt.toISOString(),
  };
}

/**
 * The `Poll` resource (§11). `showVotes` controls whether nominee tallies are
 * exposed — always true for reps/results; for voters only after the poll closes.
 */
export function serializePoll(poll: PollWithTree, opts: { showVotes: boolean; includeRevenue?: boolean }) {
  return {
    id: poll.id,
    spaceId: poll.spaceId,
    title: poll.title,
    description: poll.description,
    deadline: poll.deadline.toISOString().slice(0, 10),
    status: poll.status,
    membersOnly: poll.membersOnly,
    paid: poll.paid,
    amountPerVote: poll.amountPerVote,
    coverImageUrl: poll.coverImageUrl,
    themeColor: poll.themeColor,
    slug: poll.slug,
    totalVotes: poll.totalVotes,
    ...(opts.includeRevenue ? { revenue: poll.revenue } : {}),
    categories: poll.categories.map((c) => ({
      id: c.id,
      title: c.title,
      imageUrl: c.imageUrl,
      nominees: c.nominees.map((n) => ({
        id: n.id,
        name: n.name,
        imageUrl: n.imageUrl,
        bio: n.bio,
        code: n.code,
        ...(opts.showVotes ? { votes: n.votes } : {}),
      })),
    })),
  };
}

/**
 * Shape the public `Space` resource (§4). `membership` is viewer-relative and
 * omitted on admin reads; `memberCount` comes from an aggregate the caller runs.
 */
export function serializeSpace(
  space: Space,
  opts: { memberCount: number; membership?: SpaceMembershipView },
) {
  return {
    id: space.id,
    name: space.name,
    short: space.short,
    kind: space.kind,
    hue: space.hue,
    about: space.about,
    faculty: space.faculty,
    school: space.school,
    institution: space.institution,
    memberCount: opts.memberCount,
    theme: space.theme,
    createdAt: space.createdAt.toISOString(),
    ...(opts.membership ? { membership: opts.membership } : {}),
  };
}

/** The rep-facing `RepDue` resource (§7) — Due plus progress counters. */
export function serializeRepDue(due: Due, opts: { paidCount: number; memberCount: number }) {
  return {
    id: due.id,
    spaceId: due.spaceId,
    title: due.title,
    note: due.note,
    amount: due.amount,
    dueDate: due.dueDate.toISOString().slice(0, 10),
    type: due.category,
    category: due.category, // deprecated alias of `type`
    status: due.status,
    assignedRepId: due.assignedRepId,
    paidCount: opts.paidCount,
    memberCount: opts.memberCount,
    publishedAt: due.publishedAt?.toISOString() ?? null,
    closedAt: due.closedAt?.toISOString() ?? null,
    createdAt: due.createdAt.toISOString(),
  };
}

/** A `Student` row (§5.1) — a space member with the fields the roster shows. */
export function serializeStudent(
  user: Pick<User, 'id' | 'name' | 'matricNo' | 'level' | 'email'>,
  joinedAt: Date,
) {
  return {
    id: user.id,
    name: user.name,
    matricNo: user.matricNo,
    level: user.level,
    email: user.email,
    joinedAt: joinedAt.toISOString(),
  };
}

/** An audit-log row (§5.8). */
export function serializeAuditLog(log: SpaceAuditLog) {
  return {
    id: log.id,
    action: log.action,
    description: log.description,
    actor: { id: log.actorId, name: log.actorName, role: log.actorRole },
    createdAt: log.createdAt.toISOString(),
  };
}

/** A Duey conversation row for the history list — preview only, not the full transcript. */
export function serializeAssistantConversation(
  c: AssistantConversation,
  preview: { content: string; createdAt: Date } | null,
) {
  return {
    id: c.id,
    preview: preview?.content ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** A single turn within a Duey conversation transcript. */
export function serializeAssistantMessage(m: AssistantMessage) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    intent: m.intent,
    confidence: m.confidence,
    createdAt: m.createdAt.toISOString(),
  };
}

/** A feedback submission (admin inbox; the submitter gets the same shape back). */
export function serializeFeedback(f: Feedback) {
  return {
    id: f.id,
    category: f.category,
    message: f.message,
    page: f.page,
    userAgent: f.userAgent,
    status: f.status,
    adminNote: f.adminNote,
    resolvedAt: f.resolvedAt?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
    user: { id: f.userId, name: f.userName, email: f.userEmail, role: f.userRole },
  };
}
