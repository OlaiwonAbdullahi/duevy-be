/**
 * One-off: move avatars and poll images saved on the container's disk
 * (uploads/avatars, uploads/polls — served at /uploads/…) to ImageKit, and
 * point the database at the new CDN URLs. Needed before running more than one
 * API instance: a file on one container's disk is invisible to the others.
 *
 * Run where the uploads volume is mounted (the API container):
 *   docker compose exec api node dist/scripts/migrateUploads.js           # dry run: report only
 *   docker compose exec api node dist/scripts/migrateUploads.js --apply   # upload + rewrite
 *
 * Safe to re-run: migrated rows no longer match, and each row is rewritten
 * only if it still holds the old URL (a user who changed avatar meanwhile is
 * left alone). A missing file is reported and its row left unchanged. Local
 * files are NOT deleted; remove the volume once the app has run on the new
 * URLs for a while.
 */
import fs from "fs";
import path from "path";
import { db } from "../config/db";
import { getPublicImageStore, sniffDocumentType } from "../lib/storage";

const FILE_RE = /\/uploads\/(avatars|polls)\/([a-f0-9]{32}\.(?:jpg|png|webp))$/;

type Uploaded = { url: string; fileId: string };

export interface MigrateResult {
  avatars: number;
  categories: number;
  nominees: number;
  skipped: number;
}

export async function migrateUploads(opts: {
  apply: boolean;
  uploadsDir: string;
  log?: (msg: string) => void;
}): Promise<MigrateResult> {
  const APPLY = opts.apply;
  const UPLOADS = opts.uploadsDir;
  const warn = opts.log ?? console.warn;
  const uploaded = new Map<string, Uploaded | null>(); // a poll image can be shared by several rows

  async function moveFile(
    kind: "avatars" | "polls",
    name: string,
  ): Promise<Uploaded | null> {
    const key = `${kind}/${name}`;
    if (uploaded.has(key)) return uploaded.get(key)!;
    const file = path.join(UPLOADS, kind, name);
    let result: Uploaded | null = null;
    if (!fs.existsSync(file)) {
      warn(`  missing on disk: ${key}`);
    } else {
      const buffer = await fs.promises.readFile(file);
      if (!sniffDocumentType(buffer)) warn(`  not an image, skipped: ${key}`);
      else if (!APPLY) result = { url: `(would upload ${key})`, fileId: "" };
      else
        result = await getPublicImageStore().upload({
          buffer,
          fileName: name,
          folder: kind,
          tags: [kind === "avatars" ? "avatar" : "poll", "migrated"],
        });
    }
    uploaded.set(key, result);
    return result;
  }

  const counts: MigrateResult = {
    avatars: 0,
    categories: 0,
    nominees: 0,
    skipped: 0,
  };

  const users = await db.user.findMany({
    where: { avatarUrl: { contains: "/uploads/avatars/" } },
    select: { id: true, avatarUrl: true },
  });
  for (const u of users) {
    const m = u.avatarUrl!.match(FILE_RE);
    const moved = m ? await moveFile("avatars", m[2]!) : null;
    if (!moved) {
      counts.skipped++;
      continue;
    }
    if (APPLY) {
      const { count } = await db.user.updateMany({
        where: { id: u.id, avatarUrl: u.avatarUrl },
        data: { avatarUrl: moved.url, avatarFileId: moved.fileId },
      });
      if (count === 0) {
        counts.skipped++;
        continue;
      }
    }
    counts.avatars++;
  }

  const categories = await db.pollCategory.findMany({
    where: { imageUrl: { contains: "/uploads/polls/" } },
    select: { id: true, imageUrl: true },
  });
  for (const c of categories) {
    const m = c.imageUrl!.match(FILE_RE);
    const moved = m ? await moveFile("polls", m[2]!) : null;
    if (!moved) {
      counts.skipped++;
      continue;
    }
    if (APPLY)
      await db.pollCategory.updateMany({
        where: { id: c.id, imageUrl: c.imageUrl },
        data: { imageUrl: moved.url },
      });
    counts.categories++;
  }

  const nominees = await db.nominee.findMany({
    where: { imageUrl: { contains: "/uploads/polls/" } },
    select: { id: true, imageUrl: true },
  });
  for (const n of nominees) {
    const m = n.imageUrl!.match(FILE_RE);
    const moved = m ? await moveFile("polls", m[2]!) : null;
    if (!moved) {
      counts.skipped++;
      continue;
    }
    if (APPLY)
      await db.nominee.updateMany({
        where: { id: n.id, imageUrl: n.imageUrl },
        data: { imageUrl: moved.url },
      });
    counts.nominees++;
  }

  return counts;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(
    apply
      ? "APPLY: uploading and rewriting URLs"
      : "DRY RUN (pass --apply to write)",
  );
  const c = await migrateUploads({
    apply,
    uploadsDir: path.join(process.cwd(), "uploads"),
  });
  console.log(
    `${apply ? "moved" : "would move"}: ${c.avatars} avatars, ${c.categories} poll categories, ${c.nominees} nominees; skipped ${c.skipped}`,
  );
  await db.$disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
}
