/**
 * CBN bank codes → display names. A pragmatic subset of the common Nigerian
 * banks; the client renders `bankName` from the resolved code (§10.2).
 */
export const BANKS: Record<string, string> = {
  '044': 'Access Bank',
  '023': 'Citibank',
  '063': 'Access Bank (Diamond)',
  '050': 'Ecobank',
  '070': 'Fidelity Bank',
  '011': 'First Bank of Nigeria',
  '214': 'First City Monument Bank',
  '058': 'Guaranty Trust Bank',
  '030': 'Heritage Bank',
  '301': 'Jaiz Bank',
  '082': 'Keystone Bank',
  '526': 'Parallex Bank',
  '076': 'Polaris Bank',
  '101': 'Providus Bank',
  '221': 'Stanbic IBTC Bank',
  '068': 'Standard Chartered Bank',
  '232': 'Sterling Bank',
  '100': 'SunTrust Bank',
  '032': 'Union Bank of Nigeria',
  '033': 'United Bank for Africa',
  '215': 'Unity Bank',
  '035': 'Wema Bank',
  '057': 'Zenith Bank',
  '999991': 'PalmPay',
  '999992': 'OPay',
  '50211': 'Kuda Bank',
  '565': 'Carbon',
  '51318': 'Moniepoint MFB',
};

export function resolveBankName(bankCode: string): string | null {
  return BANKS[bankCode] ?? null;
}
