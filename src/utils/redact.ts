/**
 * Redact a phone number for safe logging (PII protection).
 * "+14155551234" → "***1234"
 */
export function redactPhone(phone: unknown): string {
  if (typeof phone !== 'string') return '***????';
  if (phone.length <= 4) return '****';
  return '***' + phone.slice(-4);
}
