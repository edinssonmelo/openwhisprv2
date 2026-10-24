export type Language = 'en' | 'es';
export const LATAM_COUNTRIES = new Set(['AR','BO','BR','CL','CO','CR','CU','DO','EC','SV','GT','HT','HN','MX','NI','PA','PY','PE','PR','UY','VE','GF','GP','MQ','BL','MF','BZ','GY','SR']);
const LATAM_ZONES = /^(America\/(Argentina\/|Mexico_City$|Cancun$|Merida$|Monterrey$|Matamoros$|Mazatlan$|Chihuahua$|Ojinaga$|Ciudad_Juarez$|Hermosillo$|Tijuana$|Bahia_Banderas$|Bogota$|Lima$|Guayaquil$|Caracas$|La_Paz$|Santiago$|Punta_Arenas$|Asuncion$|Montevideo$|Sao_Paulo$|Fortaleza$|Recife$|Bahia$|Belem$|Manaus$|Cuiaba$|Campo_Grande$|Porto_Velho$|Boa_Vista$|Rio_Branco$|Araguaina$|Maceio$|Santarem$|Noronha$|Costa_Rica$|Guatemala$|El_Salvador$|Tegucigalpa$|Managua$|Panama$|Havana$|Santo_Domingo$|Puerto_Rico$|Port-au-Prince$|Cayenne$|Guadeloupe$|Martinique$|Belize$|Guyana$|Paramaribo$)|Pacific\/Easter$)/;
export function chooseLanguage(country: string | undefined, timezone: string, saved: string | null): Language {
  if (saved === 'es' || saved === 'en') return saved;
  const normalized = country?.trim().toUpperCase();
  if (normalized && /^[A-Z]{2}$/.test(normalized) && normalized !== 'XX' && normalized !== 'T1') {
    return LATAM_COUNTRIES.has(normalized) ? 'es' : 'en';
  }
  return LATAM_ZONES.test(timezone) ? 'es' : 'en';
}
export function savedLanguage(): string | null {
  try { return localStorage.getItem('openwhispr-language'); } catch { return null; }
}
