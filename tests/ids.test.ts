import { describe, expect, test } from 'bun:test';
import {
  deriveBaseApplicationIdFromDlcAppId,
  isAppId,
  isCatalogId,
  itemKindFromNsuid,
  normalizeRegion,
  parseAcdIndex,
  parseAppId,
} from '../src/ids.ts';
import {
  buildAppIdUrl,
  extractNsuidFromLocation,
  parseStorefrontPath,
} from '../src/upstreams/redirector.ts';

describe('appId', () => {
  test('accepts 16-hex (case-insensitive)', () => {
    expect(isAppId('0100453019aa8000')).toBe(true);
    expect(isAppId('0100453019AA8000')).toBe(true);
    expect(isAppId('0100')).toBe(false);
    expect(isAppId('gggggggggggggggg')).toBe(false);
  });

  test('parseAppId lowercases', () => {
    expect(parseAppId('0100453019AA8000')).toBe('0100453019aa8000');
  });

  test('derives HAC and BEE base application ids from DLC content ids', () => {
    expect(deriveBaseApplicationIdFromDlcAppId('0100616025B6D002')).toBe('0100616025b6c000');
    expect(deriveBaseApplicationIdFromDlcAppId('01006f80023273e8')).toBe('01006f8002326000');
    expect(deriveBaseApplicationIdFromDlcAppId('040074a01bf13001')).toBe('040074a01bf12000');
    expect(deriveBaseApplicationIdFromDlcAppId('0400f1c021179160')).toBe('0400f1c021178000');
  });

  test('rejects a base application id as a DLC content id', () => {
    expect(() => deriveBaseApplicationIdFromDlcAppId('0400f1c021178000')).toThrow(
      'not in the DLC/AOC range',
    );
  });
});

describe('nsuid helpers', () => {
  test('catalog id + kind', () => {
    expect(isCatalogId('70010000088831')).toBe(true);
    expect(itemKindFromNsuid('70010000088831')).toBe('title');
    expect(itemKindFromNsuid('70050000072807')).toBe('dlc');
    expect(itemKindFromNsuid('70070000011832')).toBe('bundle');
  });
});

describe('normalizeRegion', () => {
  test('uppercases alpha-2', () => {
    expect(normalizeRegion('jp')).toBe('JP');
    expect(normalizeRegion('HK')).toBe('HK');
  });

  test('rejects invalid', () => {
    expect(() => normalizeRegion('JPN')).toThrow();
    expect(() => normalizeRegion('1')).toThrow();
  });
});

describe('buildAppIdUrl', () => {
  test('canonical without acdIndex', () => {
    expect(buildAppIdUrl('0100453019aa8000', 'jp')).toBe(
      'https://ec.nintendo.com/apps/0100453019aa8000/JP',
    );
  });

  test('acdIndex=0 omitted; acdIndex>0 included', () => {
    expect(buildAppIdUrl('0100453019aa8000', 'JP', { acdIndex: 0 })).toBe(
      'https://ec.nintendo.com/apps/0100453019aa8000/JP',
    );
    expect(buildAppIdUrl('0100453019aa8000', 'JP', { acdIndex: 1 })).toBe(
      'https://ec.nintendo.com/apps/0100453019aa8000/JP?acdIndex=1',
    );
  });

  test('rejects invalid acdIndex values instead of silently clamping', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseAcdIndex(value)).toThrow();
      expect(() => buildAppIdUrl('0100453019aa8000', 'JP', { acdIndex: value })).toThrow();
    }
  });
});

describe('extractNsuidFromLocation', () => {
  test('storefront relative path', () => {
    expect(extractNsuidFromLocation('/JP/ja/titles/70010000088831')).toBe('70010000088831');
    expect(extractNsuidFromLocation('/HK/zh/aocs/70050000072807')).toBe('70050000072807');
  });

  test('US pos-redirect', () => {
    expect(
      extractNsuidFromLocation('https://www.nintendo.com/pos-redirect/70010000088832?l=en&c=US'),
    ).toBe('70010000088832');
  });

  test('Europe redirect query', () => {
    expect(
      extractNsuidFromLocation(
        'https://www.nintendo-europe.com/redirect/?nsuid=70010000088833&country=GB&language=en',
      ),
    ).toBe('70010000088833');
    expect(
      extractNsuidFromLocation('https://www.nintendo.com/en-gb/example?NSUID=70010000088833'),
    ).toBe('70010000088833');
    expect(
      extractNsuidFromLocation('https://example.com/redirect?id=70010000088833'),
    ).toBeUndefined();
  });

  test('generic store page → undefined', () => {
    expect(extractNsuidFromLocation('https://www.nintendo.com/kr/games/switch2')).toBeUndefined();
  });
});

describe('parseStorefrontPath', () => {
  test('titles path', () => {
    expect(parseStorefrontPath('/JP/ja/titles/70010000088831')).toEqual({
      region: 'JP',
      language: 'ja',
      pathKind: 'titles',
      nsuid: '70010000088831',
    });
  });

  test('absolute EU → unknown path kind + nsuid from query', () => {
    const p = parseStorefrontPath(
      'https://www.nintendo-europe.com/redirect/?nsuid=70010000088833&country=DE&language=de',
    );
    expect(p.pathKind).toBe('unknown');
    expect(p.nsuid).toBe('70010000088833');
  });
});
