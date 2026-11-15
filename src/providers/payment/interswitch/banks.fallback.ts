import type { Bank } from '../types';

/**
 * A curated list of Nigerian banks used ONLY when Interswitch's live
 * receiving-institutions endpoint is unavailable (the sandbox currently returns
 * a server-side 400 "error getting banks list"). Codes are NIBSS/NIP institution
 * codes — the de-facto standard for Nigerian inter-bank name-enquiry and
 * transfers. When the live endpoint works, its list supersedes this one.
 *
 * ⚠️ Verify these codes against the live receiving-institutions response once the
 * endpoint is enabled for this merchant, in case Interswitch expects its own
 * internal `code` instead of the NIP code for transfers.
 */
export const FALLBACK_BANKS: Bank[] = [
  { code: '044', name: 'Access Bank' },
  { code: '063', name: 'Access Bank (Diamond)' },
  { code: '035A', name: 'ALAT by Wema' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '562', name: 'Ekondo MFB' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank (FCMB)' },
  { code: '00103', name: 'Globus Bank' },
  { code: '058', name: 'Guaranty Trust Bank (GTBank)' },
  { code: '030', name: 'Heritage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '50211', name: 'Kuda Microfinance Bank' },
  { code: '565', name: 'Carbon' },
  { code: '50515', name: 'Moniepoint Microfinance Bank' },
  { code: '100004', name: 'OPay' },
  { code: '999991', name: 'PalmPay' },
  { code: '100002', name: 'Paga' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '100', name: 'SunTrust Bank' },
  { code: '302', name: 'TajBank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank for Africa (UBA)' },
  { code: '215', name: 'Unity Bank' },
  { code: '566', name: 'VFD Microfinance Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
];
