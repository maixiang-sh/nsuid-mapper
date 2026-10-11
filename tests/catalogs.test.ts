/**
 * Country coverage and the per-call country cap.
 *
 * The coverage lists are a measurement (all 92 Savanna countries, four
 * broad-release titles, 2026-07-23), not a definition. They record which
 * countries the redirector serves — deliberately *not* which countries share an
 * nsuid, because that varies by title and encoding it would invite silent
 * misses.
 */
import { describe, expect, test } from 'bun:test';
import {
  MAPPABLE_COUNTRY_LANGUAGES,
  MAPPABLE_COUNTRIES,
  UNMAPPABLE_COUNTRIES,
  isKnownMappable,
} from '../src/catalogs.ts';
import {
  MAX_REGIONS_PER_MAP,
  NsuidMapper,
  contextFor,
  getCountryLanguageInfo,
  isCountryLanguageSupported,
  isMappable,
} from '../src/index.ts';

describe('country coverage', () => {
  test('the two lists are disjoint and cover the 92 Savanna countries', () => {
    const mappable = new Set<string>(MAPPABLE_COUNTRIES);
    for (const c of UNMAPPABLE_COUNTRIES) expect(mappable.has(c)).toBe(false);
    expect(MAPPABLE_COUNTRIES.length + UNMAPPABLE_COUNTRIES.length).toBe(92);
    expect(MAPPABLE_COUNTRIES.length).toBe(45);
  });

  test('the measured dead ends are reported unmappable', () => {
    for (const c of ['KR', 'CN', 'TW', 'TH', 'SG', 'AE']) {
      expect(isMappable(c)).toBe(false);
    }
  });

  test('an unknown country is allowed through rather than pre-rejected', () => {
    // The list is a snapshot. Refusing a country Nintendo may have added since
    // would be a worse failure than letting the request find out.
    expect(isMappable('ZZ')).toBe(true);
    expect(isKnownMappable('ZZ')).toBe(false);
  });

  test('lookups are case- and whitespace-insensitive', () => {
    expect(isMappable(' kr ')).toBe(false);
    expect(isKnownMappable('gb')).toBe(true);
  });

  test('every mappable country has valid language metadata', () => {
    expect(Object.keys(MAPPABLE_COUNTRY_LANGUAGES).sort()).toEqual([...MAPPABLE_COUNTRIES].sort());
    for (const country of MAPPABLE_COUNTRIES) {
      const info = getCountryLanguageInfo(country)!;
      expect(info.languages).toContain(info.defaultLanguage);
      expect(contextFor(country)).toEqual({
        country,
        language: info.defaultLanguage,
      });
    }
  });

  test('language lookup exposes only effective localized variants', () => {
    expect(getCountryLanguageInfo(' ch ')).toEqual({
      defaultLanguage: 'de',
      languages: ['fr', 'de', 'it'],
    });
    expect(isCountryLanguageSupported('US', 'es')).toBe(true);
    expect(isCountryLanguageSupported(' us ', ' EN ')).toBe(true);
    expect(isCountryLanguageSupported('JP', 'en')).toBe(false);
    expect(getCountryLanguageInfo('KR')).toBeUndefined();
    expect(getCountryLanguageInfo('ZZ')).toBeUndefined();
  });
});

describe('per-call country cap', () => {
  const mapper = () =>
    new NsuidMapper({
      fetch: (async () => {
        throw new Error('stubbed fetch');
      }) as unknown as typeof fetch,
    });

  test('rejects more countries than the cap, naming the limit', async () => {
    const nine = ['JP', 'US', 'GB', 'HK', 'CA', 'DE', 'FR', 'AU', 'NZ'];
    expect(nine.length).toBe(MAX_REGIONS_PER_MAP + 1);

    const error = await mapper()
      .mapNsuid('70010000095202', { from: 'JP', to: nine })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain(String(MAX_REGIONS_PER_MAP));
  });

  test('counts after de-duplication, not before', async () => {
    // Eight distinct countries written twice is still eight, and must not be
    // rejected for a length the request does not really have.
    const doubled = ['JP', 'US', 'GB', 'HK', 'JP', 'US', 'GB', 'HK'];
    const error = await mapper()
      .mapNsuid('70010000095202', { from: 'JP', to: doubled })
      .catch((reason: unknown) => reason);

    // It fails on the stubbed fetch, not on the cap.
    expect(error).not.toBeInstanceOf(TypeError);
  });

  test('rejects an empty target list', async () => {
    const error = await mapper()
      .mapNsuid('70010000095202', { from: 'JP', to: [] })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
  });
});
