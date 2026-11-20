-- A due's deadline is now optional (null = no deadline). Existing dues keep
-- their dates. Nothing else changes.
ALTER TABLE "dues" ALTER COLUMN "dueDate" DROP NOT NULL;
