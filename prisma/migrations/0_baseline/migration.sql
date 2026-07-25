-- CreateEnum
CREATE TYPE "Role" AS ENUM ('student', 'rep', 'admin');

-- CreateEnum
CREATE TYPE "RepApplicationStatus" AS ENUM ('none', 'pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AdminSubRole" AS ENUM ('super_admin', 'compliance_officer', 'support_lead');

-- CreateEnum
CREATE TYPE "SpaceKind" AS ENUM ('department', 'association', 'faculty', 'club');

-- CreateEnum
CREATE TYPE "SpaceMembershipKind" AS ENUM ('member', 'guest');

-- CreateEnum
CREATE TYPE "RepRole" AS ENUM ('lead', 'co');

-- CreateEnum
CREATE TYPE "EmblemHue" AS ENUM ('emerald', 'indigo', 'amber', 'rose', 'slate');

-- CreateEnum
CREATE TYPE "SpaceTheme" AS ENUM ('emerald', 'ocean', 'royal', 'crimson', 'tangerine');

-- CreateEnum
CREATE TYPE "DueCategory" AS ENUM ('levy', 'dinner', 'handout', 'welfare', 'sport');

-- CreateEnum
CREATE TYPE "RepDueStatus" AS ENUM ('draft', 'active', 'closed');

-- CreateEnum
CREATE TYPE "PayMethod" AS ENUM ('wallet', 'card', 'online');

-- CreateEnum
CREATE TYPE "PaymentGatewayName" AS ENUM ('paystack', 'monnify');

-- CreateEnum
CREATE TYPE "TxnType" AS ENUM ('due', 'topup', 'referral', 'withdrawal', 'refund', 'vote', 'card_verification');

-- CreateEnum
CREATE TYPE "TxnStatus" AS ENUM ('completed', 'pending', 'failed');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "PollStatus" AS ENUM ('draft', 'active', 'closed');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('pending', 'joined', 'paid');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('due_reminder', 'payment_received', 'join_request', 'payout_completed', 'poll_milestone', 'referral_earned', 'system');

-- CreateEnum
CREATE TYPE "NotificationTone" AS ENUM ('brand', 'amber', 'rose');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('unverified', 'pending', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'under_review', 'resolved');

-- CreateEnum
CREATE TYPE "DisputeType" AS ENUM ('payment_not_reflecting', 'non_remittance', 'refund_request');

-- CreateEnum
CREATE TYPE "RiskTier" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('pending', 'paid', 'voided', 'clawed_back');

-- CreateEnum
CREATE TYPE "ReportScope" AS ENUM ('financial_summary', 'space_collection', 'rep_performance', 'full_ledger');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('csv', 'pdf');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('generating', 'ready', 'expired');

-- CreateEnum
CREATE TYPE "SpaceJoinRequestStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('payout_requested', 'due_published', 'due_closed', 'due_created', 'poll_created', 'members_approved', 'profile_updated', 'rep_invited', 'rep_removed', 'code_regenerated', 'lead_transferred', 'space_archived');

-- CreateEnum
CREATE TYPE "AssistantIntent" AS ENUM ('pay_dues', 'join_department', 'check_balance', 'view_history', 'contact_rep', 'fund_wallet', 'create_due', 'rep_summary', 'unknown');

-- CreateEnum
CREATE TYPE "AssistantRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "passwordHash" TEXT,
    "phone" TEXT,
    "avatarUrl" TEXT,
    "role" "Role" NOT NULL DEFAULT 'student',
    "repApplicationStatus" "RepApplicationStatus" NOT NULL DEFAULT 'none',
    "adminSubRole" "AdminSubRole",
    "matricNo" TEXT,
    "level" TEXT,
    "notificationPrefs" JSONB,
    "referralCode" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'unverified',
    "kycDocUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendedReason" TEXT,
    "isDeactivated" BOOLEAN NOT NULL DEFAULT false,
    "deactivatedReason" TEXT,
    "termsAcceptedAt" TIMESTAMP(3),
    "termsVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "device" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "device" TEXT,
    "ip" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short" TEXT NOT NULL,
    "kind" "SpaceKind" NOT NULL,
    "hue" "EmblemHue" NOT NULL DEFAULT 'emerald',
    "theme" "SpaceTheme" NOT NULL DEFAULT 'emerald',
    "about" TEXT,
    "faculty" TEXT,
    "school" TEXT NOT NULL,
    "joinCode" TEXT NOT NULL,
    "requireApproval" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "payoutsFrozen" BOOLEAN NOT NULL DEFAULT false,
    "frozenReason" TEXT,
    "paystackSubaccountCode" TEXT,
    "subaccountGateway" "PaymentGatewayName",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "kind" "SpaceMembershipKind" NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_reps" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "role" "RepRole" NOT NULL DEFAULT 'co',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_reps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_join_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "status" "SpaceJoinRequestStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "space_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rep_applications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT,
    "spaceName" TEXT NOT NULL,
    "spaceShort" TEXT NOT NULL,
    "spaceKind" "SpaceKind" NOT NULL,
    "school" TEXT NOT NULL,
    "faculty" TEXT,
    "theme" "SpaceTheme" NOT NULL,
    "coRepInvites" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "referralCode" TEXT,
    "status" "RepApplicationStatus" NOT NULL DEFAULT 'pending',
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rep_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_audit_logs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dues" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "amount" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "category" "DueCategory" NOT NULL,
    "status" "RepDueStatus" NOT NULL DEFAULT 'draft',
    "allowGuests" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "lastRemindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "due_payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dueId" TEXT NOT NULL,
    "txnId" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" TEXT NOT NULL,
    "amountPaid" INTEGER NOT NULL,
    "monnifyFee" INTEGER NOT NULL,
    "duevyFee" INTEGER NOT NULL,
    "netToSpace" INTEGER NOT NULL,

    CONSTRAINT "due_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cards" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerToken" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "expiry" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TxnType" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "status" "TxnStatus" NOT NULL DEFAULT 'pending',
    "reference" TEXT NOT NULL,
    "spaceId" TEXT,
    "refundOfTxnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_payments" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankCodeGateway" "PaymentGatewayName",
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountNumberMasked" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "cooldownUntil" TIMESTAMP(3),
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'processing',
    "accountMasked" TEXT NOT NULL,
    "note" TEXT,
    "failureReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polls" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "deadline" TIMESTAMP(3) NOT NULL,
    "status" "PollStatus" NOT NULL DEFAULT 'draft',
    "membersOnly" BOOLEAN NOT NULL DEFAULT true,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "amountPerVote" INTEGER NOT NULL DEFAULT 0,
    "slug" TEXT NOT NULL,
    "totalVotes" INTEGER NOT NULL DEFAULT 0,
    "revenue" INTEGER NOT NULL DEFAULT 0,
    "coverImageUrl" TEXT,
    "themeColor" TEXT,
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_categories" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "poll_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nominees" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "bio" TEXT,
    "code" TEXT,
    "votes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "nominees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_votes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nomineeId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amountPaid" INTEGER NOT NULL DEFAULT 0,
    "txnRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "poll_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'pending',
    "reward" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "dueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "tone" "NotificationTone" NOT NULL DEFAULT 'brand',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "href" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "type" "DisputeType" NOT NULL,
    "openedById" TEXT NOT NULL,
    "openedByName" TEXT NOT NULL,
    "openedByEmail" TEXT NOT NULL,
    "department" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "slaDays" INTEGER NOT NULL DEFAULT 3,
    "txnReference" TEXT,
    "description" TEXT NOT NULL,
    "studentEvidence" JSONB,
    "repEvidence" JSONB,
    "claimedById" TEXT,
    "resolution" TEXT,
    "refundTxnId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_permissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userManagement" BOOLEAN NOT NULL DEFAULT false,
    "payouts" BOOLEAN NOT NULL DEFAULT false,
    "disputes" BOOLEAN NOT NULL DEFAULT false,
    "overrides" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "admin_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "ip" TEXT,
    "device" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "activePaymentGateway" "PaymentGatewayName" NOT NULL DEFAULT 'paystack',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_flags" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "referrerName" TEXT NOT NULL,
    "referredName" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "FlagStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "scope" "ReportScope" NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'generating',
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "spaceId" TEXT,
    "downloadUrl" TEXT,
    "fileSize" INTEGER,
    "generatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AssistantRole" NOT NULL,
    "content" TEXT NOT NULL,
    "intent" "AssistantIntent",
    "params" JSONB,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_tokenHash_idx" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "email_verifications_token_key" ON "email_verifications"("token");

-- CreateIndex
CREATE INDEX "email_verifications_token_idx" ON "email_verifications"("token");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_tokenHash_key" ON "password_resets"("tokenHash");

-- CreateIndex
CREATE INDEX "password_resets_tokenHash_idx" ON "password_resets"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_joinCode_key" ON "spaces"("joinCode");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_paystackSubaccountCode_key" ON "spaces"("paystackSubaccountCode");

-- CreateIndex
CREATE INDEX "space_memberships_spaceId_idx" ON "space_memberships"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "space_memberships_userId_spaceId_key" ON "space_memberships"("userId", "spaceId");

-- CreateIndex
CREATE INDEX "space_reps_spaceId_idx" ON "space_reps"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "space_reps_userId_spaceId_key" ON "space_reps"("userId", "spaceId");

-- CreateIndex
CREATE INDEX "space_join_requests_spaceId_idx" ON "space_join_requests"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "space_join_requests_userId_spaceId_key" ON "space_join_requests"("userId", "spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "rep_applications_userId_key" ON "rep_applications"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "rep_applications_spaceId_key" ON "rep_applications"("spaceId");

-- CreateIndex
CREATE INDEX "space_audit_logs_spaceId_createdAt_idx" ON "space_audit_logs"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "dues_spaceId_idx" ON "dues"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "due_payments_txnId_key" ON "due_payments"("txnId");

-- CreateIndex
CREATE UNIQUE INDEX "due_payments_reference_key" ON "due_payments"("reference");

-- CreateIndex
CREATE INDEX "due_payments_dueId_idx" ON "due_payments"("dueId");

-- CreateIndex
CREATE UNIQUE INDEX "due_payments_userId_dueId_key" ON "due_payments"("userId", "dueId");

-- CreateIndex
CREATE UNIQUE INDEX "cards_providerToken_key" ON "cards"("providerToken");

-- CreateIndex
CREATE INDEX "cards_userId_idx" ON "cards"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reference_key" ON "transactions"("reference");

-- CreateIndex
CREATE INDEX "transactions_userId_createdAt_idx" ON "transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_refundOfTxnId_idx" ON "transactions"("refundOfTxnId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_payments_reference_key" ON "pending_payments"("reference");

-- CreateIndex
CREATE INDEX "pending_payments_reference_idx" ON "pending_payments"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_spaceId_key" ON "bank_accounts"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_reference_key" ON "payouts"("reference");

-- CreateIndex
CREATE INDEX "payouts_spaceId_idx" ON "payouts"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "polls_slug_key" ON "polls"("slug");

-- CreateIndex
CREATE INDEX "polls_spaceId_idx" ON "polls"("spaceId");

-- CreateIndex
CREATE INDEX "poll_categories_pollId_idx" ON "poll_categories"("pollId");

-- CreateIndex
CREATE INDEX "nominees_categoryId_idx" ON "nominees"("categoryId");

-- CreateIndex
CREATE INDEX "poll_votes_userId_categoryId_idx" ON "poll_votes"("userId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referredId_key" ON "referrals"("referredId");

-- CreateIndex
CREATE INDEX "referrals_referrerId_idx" ON "referrals"("referrerId");

-- CreateIndex
CREATE UNIQUE INDEX "discount_codes_code_key" ON "discount_codes"("code");

-- CreateIndex
CREATE INDEX "discount_codes_userId_idx" ON "discount_codes"("userId");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "disputes_status_idx" ON "disputes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "admin_permissions_userId_key" ON "admin_permissions"("userId");

-- CreateIndex
CREATE INDEX "admin_audit_logs_actorId_idx" ON "admin_audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "admin_audit_logs_createdAt_idx" ON "admin_audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "referral_flags_status_idx" ON "referral_flags"("status");

-- CreateIndex
CREATE INDEX "reports_requestedById_idx" ON "reports"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_key" ON "idempotency_keys"("key");

-- CreateIndex
CREATE INDEX "idempotency_keys_key_idx" ON "idempotency_keys"("key");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

-- CreateIndex
CREATE INDEX "assistant_conversations_userId_updatedAt_idx" ON "assistant_conversations"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "assistant_messages_conversationId_createdAt_idx" ON "assistant_messages"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_reps" ADD CONSTRAINT "space_reps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_reps" ADD CONSTRAINT "space_reps_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_join_requests" ADD CONSTRAINT "space_join_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_join_requests" ADD CONSTRAINT "space_join_requests_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rep_applications" ADD CONSTRAINT "rep_applications_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_audit_logs" ADD CONSTRAINT "space_audit_logs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dues" ADD CONSTRAINT "dues_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "due_payments" ADD CONSTRAINT "due_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "due_payments" ADD CONSTRAINT "due_payments_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "dues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "due_payments" ADD CONSTRAINT "due_payments_txnId_fkey" FOREIGN KEY ("txnId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_refundOfTxnId_fkey" FOREIGN KEY ("refundOfTxnId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polls" ADD CONSTRAINT "polls_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_categories" ADD CONSTRAINT "poll_categories_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nominees" ADD CONSTRAINT "nominees_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "poll_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_nomineeId_fkey" FOREIGN KEY ("nomineeId") REFERENCES "nominees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_permissions" ADD CONSTRAINT "admin_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

