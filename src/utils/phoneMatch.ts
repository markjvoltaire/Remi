/** Strip to digits only. */
export function phoneDigitsKey(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** US: treat +1XXXXXXXXXX, 1XXXXXXXXXX, and XXXXXXXXXX as the same. Otherwise require exact digit match. */
function comparableDigits(digits: string): string {
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function phonesMatch(a: string, b: string): boolean {
  const ka = comparableDigits(phoneDigitsKey(a));
  const kb = comparableDigits(phoneDigitsKey(b));
  if (ka.length === 0 || kb.length === 0) return false;
  return ka === kb;
}
