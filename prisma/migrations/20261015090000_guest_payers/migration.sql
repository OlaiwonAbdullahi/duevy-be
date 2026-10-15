-- Guest payers: people who pay a guest-enabled due (`dues.allowGuests`) with
-- just a name and email. They get a password-less user row so checkouts,
-- receipts and the ledger work unchanged; `isGuest` keeps them out of login
-- until they claim the email.
ALTER TABLE "users" ADD COLUMN "isGuest" BOOLEAN NOT NULL DEFAULT false;
