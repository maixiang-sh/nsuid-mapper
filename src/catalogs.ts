/**
 * Which countries the `/apps` redirector can resolve at all.
 *
 * **An nsuid is per country.** Countries in the same publishing region usually
 * share one — most European countries return the same nsuid for a given game —
 * but that is a tendency, not a rule: some titles are listed separately per
 * country. Resolving `GB` and assuming `AU` matches will be right most of the
 * time and silently wrong the rest, so this module deliberately exposes no
 * "representative country" shortcut. Ask for the countries you actually want.
 *
 * What *is* stable is the negative: a country the redirector does not serve at
 * all. That is what this file records.
 */

/**
 * Countries Savanna serves but the `/apps` redirector cannot map.
 *
 * Not a sampling gap — checked against four different broad-release first-party
 * titles (Zelda, Mario Kart World, Mario Kart 8 Deluxe, Splatoon 3) across all
 * 92 Savanna countries on 2026-07-23. Every one of these failed for all four:
 *
 * - `KR` redirects to a generic storefront, never a product page.
 * - `CN` is a separate storefront (`nintendoswitch.com.cn`), not on this edge.
 * - `TW` returns a 200 SPA shell with no redirect.
 * - The rest — Southeast Asia, the Middle East, the Caribbean, Central and much
 *   of South America — return 404. Savanna answers for them; the redirector has
 *   no storefront behind it.
 *
 * `HK` is the one country in Nintendo's TWN region that does resolve, which is
 * why that region is not simply unreachable.
 */
export const UNMAPPABLE_COUNTRIES = [
  'AE',
  'AG',
  'AI',
  'AW',
  'BB',
  'BM',
  'BO',
  'BS',
  'BZ',
  'CN',
  'CR',
  'DM',
  'DO',
  'EC',
  'GD',
  'GF',
  'GP',
  'GT',
  'GY',
  'HN',
  'HT',
  'JM',
  'KN',
  'KR',
  'KY',
  'LC',
  'MQ',
  'MS',
  'MY',
  'NI',
  'PA',
  'PH',
  'PY',
  'SA',
  'SG',
  'SR',
  'SV',
  'TC',
  'TH',
  'TR',
  'TT',
  'TW',
  'UY',
  'VC',
  'VE',
  'VG',
  'VI',
] as const;

/**
 * The 45 countries that did resolve, for reference.
 *
 * Listing one does not promise a given title is sold there — only that the
 * redirector serves the country. A title absent from that storefront still
 * returns nothing.
 */
export const MAPPABLE_COUNTRIES = [
  'AR',
  'AT',
  'AU',
  'BE',
  'BG',
  'BR',
  'CA',
  'CH',
  'CL',
  'CO',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB',
  'GR',
  'HK',
  'HR',
  'HU',
  'IE',
  'IL',
  'IT',
  'JP',
  'LT',
  'LU',
  'LV',
  'MT',
  'MX',
  'NL',
  'NO',
  'NZ',
  'PE',
  'PL',
  'PT',
  'RO',
  'RU',
  'SE',
  'SI',
  'SK',
  'US',
  'ZA',
] as const;

/** A country verified to produce product redirects. */
export type MappableCountry = (typeof MAPPABLE_COUNTRIES)[number];

/** Content languages actually offered by Savanna across the mappable countries. */
export type SavannaLanguage = 'de' | 'en' | 'es' | 'fr' | 'it' | 'ja' | 'nl' | 'pt' | 'ru' | 'zh';

export interface CountryLanguageInfo {
  /** Default language listed in Savanna country configuration. */
  readonly defaultLanguage: SavannaLanguage;
  /** Available language codes listed by the country; product translations may differ. */
  readonly languages: readonly SavannaLanguage[];
}

/**
 * Savanna country language configuration for the redirector's verified countries.
 *
 * Derived from Savanna's country catalogue on 2026-07-21 and checked live for
 * all 45 countries on 2026-07-23. The GraphQL `language` variable is required
 * but not strictly validated: unavailable values can still return data. These
 * configured codes guide requests; they do not guarantee translated product text.
 * This 45-country mapping snapshot is not Savanna's full country support list.
 */
export const MAPPABLE_COUNTRY_LANGUAGES = {
  AR: { defaultLanguage: 'es', languages: ['en', 'es'] },
  AT: { defaultLanguage: 'de', languages: ['de'] },
  AU: { defaultLanguage: 'en', languages: ['en'] },
  BE: { defaultLanguage: 'nl', languages: ['fr', 'nl'] },
  BG: { defaultLanguage: 'en', languages: ['en'] },
  BR: { defaultLanguage: 'pt', languages: ['en', 'pt'] },
  CA: { defaultLanguage: 'en', languages: ['en', 'fr'] },
  CH: { defaultLanguage: 'de', languages: ['fr', 'de', 'it'] },
  CL: { defaultLanguage: 'es', languages: ['en', 'es'] },
  CO: { defaultLanguage: 'es', languages: ['en', 'es'] },
  CY: { defaultLanguage: 'en', languages: ['en'] },
  CZ: { defaultLanguage: 'en', languages: ['en'] },
  DE: { defaultLanguage: 'de', languages: ['de'] },
  DK: { defaultLanguage: 'en', languages: ['en'] },
  EE: { defaultLanguage: 'en', languages: ['en'] },
  ES: { defaultLanguage: 'es', languages: ['es'] },
  FI: { defaultLanguage: 'en', languages: ['en'] },
  FR: { defaultLanguage: 'fr', languages: ['fr'] },
  GB: { defaultLanguage: 'en', languages: ['en'] },
  GR: { defaultLanguage: 'en', languages: ['en'] },
  HK: { defaultLanguage: 'zh', languages: ['zh'] },
  HR: { defaultLanguage: 'en', languages: ['en'] },
  HU: { defaultLanguage: 'en', languages: ['en'] },
  IE: { defaultLanguage: 'en', languages: ['en'] },
  IL: { defaultLanguage: 'en', languages: ['en'] },
  IT: { defaultLanguage: 'it', languages: ['it'] },
  JP: { defaultLanguage: 'ja', languages: ['ja'] },
  LT: { defaultLanguage: 'en', languages: ['en'] },
  LU: { defaultLanguage: 'fr', languages: ['fr', 'de'] },
  LV: { defaultLanguage: 'en', languages: ['en'] },
  MT: { defaultLanguage: 'en', languages: ['en'] },
  MX: { defaultLanguage: 'es', languages: ['en', 'es'] },
  NL: { defaultLanguage: 'nl', languages: ['nl'] },
  NO: { defaultLanguage: 'en', languages: ['en'] },
  NZ: { defaultLanguage: 'en', languages: ['en'] },
  PE: { defaultLanguage: 'es', languages: ['en', 'es'] },
  PL: { defaultLanguage: 'en', languages: ['en'] },
  PT: { defaultLanguage: 'pt', languages: ['pt'] },
  RO: { defaultLanguage: 'en', languages: ['en'] },
  RU: { defaultLanguage: 'ru', languages: ['ru'] },
  SE: { defaultLanguage: 'en', languages: ['en'] },
  SI: { defaultLanguage: 'en', languages: ['en'] },
  SK: { defaultLanguage: 'en', languages: ['en'] },
  US: { defaultLanguage: 'en', languages: ['en', 'es'] },
  ZA: { defaultLanguage: 'en', languages: ['en'] },
} as const satisfies Record<MappableCountry, CountryLanguageInfo>;

const UNMAPPABLE = new Set<string>(UNMAPPABLE_COUNTRIES);
const COUNTRY_LANGUAGES: Partial<Record<string, CountryLanguageInfo>> = MAPPABLE_COUNTRY_LANGUAGES;

/**
 * Whether the redirector serves this country.
 *
 * Unknown codes return `true`: the list is a snapshot, and refusing a country
 * upstream may have since added would be worse than letting the request find
 * out. Only the measured dead ends are reported as unmappable.
 */
export function isMappable(country: string): boolean {
  return !UNMAPPABLE.has(country.trim().toUpperCase());
}

/** Configured language codes for one verified-mappable country. */
export function getCountryLanguageInfo(country: string): CountryLanguageInfo | undefined {
  return COUNTRY_LANGUAGES[country.trim().toUpperCase()];
}

/** Whether a language appears in this mapping country's configuration snapshot. */
export function isCountryLanguageSupported(country: string, language: string): boolean {
  const info = getCountryLanguageInfo(country);
  return Boolean(info?.languages.includes(language.trim().toLowerCase() as SavannaLanguage));
}
