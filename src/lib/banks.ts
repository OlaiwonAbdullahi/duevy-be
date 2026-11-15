import { env } from '../config/env';
import type { Bank } from '../providers/payment/types';

/**
 * Presentation shape for a bank in the UI (web dashboard chat + bank pickers):
 * the raw code/name plus a stable slug and a logo URL the frontend can render.
 *
 * Logos are served by the frontend from `${FRONTEND_URL}/bank-logos/<slug>.svg`
 * (reusing FRONTEND_URL, no third-party CDN dependency). The frontend drops the
 * logo assets there; a missing file just renders the fallback/initials.
 */
export interface BankCard {
  code: string;
  name: string;
  slug: string;
  logo: string;
}

/** Deterministic, filename-safe slug from a bank name (parentheticals dropped). */
export function bankSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'bank'
  );
}

const LOGO_BASE = `${env.FRONTEND_URL.replace(/\/+$/, '')}/bank-logos`;

export function toBankCard(bank: Bank): BankCard {
  const slug = bankSlug(bank.name);
  return { code: bank.code, name: bank.name, slug, logo: `${LOGO_BASE}/${slug}.svg` };
}

export function toBankCards(banks: Bank[]): BankCard[] {
  return banks.map(toBankCard);
}
