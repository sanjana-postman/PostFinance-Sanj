/** Lowercase alphanumeric-and-hyphen, truncated to fit every downstream naming constraint this
 * gets embedded in — K8s namespace names (63-char DNS-1123 labels, with room for the longer of
 * "-staging"/8 chars) are the tightest. Keep this the ONLY sanitizer in the whole platform (the
 * reference repo kept two, in bash and TypeScript, that could drift out of sync — don't repeat
 * that mistake). */
export function sanitizeSeName(raw: string): string {
  // If given an email (some AWS SSO configs use the email address as the session name, which
  // this feeds into via detectSeNameFromAwsIdentity in onboard.ts), use only the local part —
  // "graham.king@postman.com" should become "graham-king", not a mangled mash of the local part
  // and the domain's dots.
  const localPart = raw.includes('@') ? raw.split('@')[0] : raw;
  const cleaned = localPart
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20)
    .replace(/-+$/, '');
  if (!cleaned) {
    throw new Error(`"${raw}" sanitizes to an empty SE name — use a name with at least one letter or digit.`);
  }
  return cleaned;
}
