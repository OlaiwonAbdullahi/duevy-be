-- Avatars now live in ImageKit (public CDN) instead of the container's disk.
-- The file id lets a replaced avatar be deleted there.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatarFileId" TEXT;
