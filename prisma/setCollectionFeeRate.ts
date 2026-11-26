/**
 * Set (or clear) a space's collection-fee rate override.
 *
 * The rate is in basis points: 130 = 1.3%, 150 = 1.5% (the default). Passing
 * `default` clears the override so the space falls back to COLLECTION_FEE_BPS.
 * The override applies whether the student pays the fee on top or the space
 * absorbs it — it changes the stored feeKobo, not who bears it.
 *
 * Run AFTER the 20261126120000_space_collection_fee_override migration is applied.
 *
 * List candidate department spaces (no change):
 *   npx tsx prisma/setCollectionFeeRate.ts --find "information system"
 * Set a space to 1.3%:
 *   npx tsx prisma/setCollectionFeeRate.ts --space <spaceId> --bps 130
 * Reset a space to the default:
 *   npx tsx prisma/setCollectionFeeRate.ts --space <spaceId> --bps default
 */
import { db } from '../src/config/db';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const find = arg('--find');
  if (find) {
    const spaces = await db.space.findMany({
      where: { name: { contains: find, mode: 'insensitive' } },
      select: { id: true, name: true, kind: true, school: true, collectionFeeBps: true },
      orderBy: { name: 'asc' },
    });
    console.log(`Spaces matching "${find}":`);
    for (const s of spaces) {
      const rate = s.collectionFeeBps == null ? '1.5% (default)' : `${(s.collectionFeeBps / 100).toFixed(2)}%`;
      console.log(`  ${s.id}  [${s.kind}]  ${s.name} — ${s.school}  → ${rate}`);
    }
    if (spaces.length === 0) console.log('  (none)');
    return;
  }

  const spaceId = arg('--space');
  const bpsRaw = arg('--bps');
  if (!spaceId || !bpsRaw) {
    console.error('Usage: --space <id> --bps <number|default>   (or --find <text> to list)');
    process.exit(1);
  }

  const bps = bpsRaw === 'default' ? null : Number(bpsRaw);
  if (bps !== null && (!Number.isInteger(bps) || bps < 0 || bps > 10_000)) {
    console.error(`Invalid --bps "${bpsRaw}": use an integer 0–10000, or "default".`);
    process.exit(1);
  }

  const before = await db.space.findUnique({ where: { id: spaceId }, select: { id: true, name: true, collectionFeeBps: true } });
  if (!before) {
    console.error(`No space with id ${spaceId}.`);
    process.exit(1);
  }

  const was = before.collectionFeeBps == null ? '1.5% (default)' : `${(before.collectionFeeBps / 100).toFixed(2)}%`;
  const now = bps == null ? '1.5% (default)' : `${(bps / 100).toFixed(2)}%`;
  await db.space.update({ where: { id: spaceId }, data: { collectionFeeBps: bps } });
  console.log(`"${before.name}" (${before.id}): ${was} → ${now}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
