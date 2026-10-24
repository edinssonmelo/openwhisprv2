export const CONTACT_EMAIL = 'edinssonadrian@gmail.com';
export const RELEASE_MANIFEST = '/releases/latest.json';
export type Release = { version: string; file: string; bytes: number; sha256: string; architecture: 'arm64'; minimumMacOS: string; notarized: boolean };
export function validRelease(value: unknown): value is Release {
  const r = value as Release | null;
  return !!r && typeof r.version === 'string' && typeof r.file === 'string'
    && /^\/releases\/Openwhispr-[a-zA-Z0-9._-]+\.dmg$/.test(r.file)
    && r.architecture === 'arm64' && Number.isFinite(r.bytes) && r.bytes > 0
    && typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256)
    && typeof r.minimumMacOS === 'string' && typeof r.notarized === 'boolean';
}
