import baseStyle from '../ofm-dark.json';
import { buildRadarStyle, MAP_FONTS, MAP_PALETTE, radarMapStyle } from '../style';

type Layer = { id: string; type: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> };
type Style = { version: number; glyphs?: string; sprite?: string; sources: Record<string, unknown>; layers: Layer[] };

const built = radarMapStyle as unknown as Style;
const layer = (id: string): Layer => {
  const found = built.layers.find((l) => l.id === id);
  if (!found) throw new Error(`нет слоя ${id}`);
  return found;
};

/** «#RRGGBB» → [r, g, b]; для проверок «темнее чем» и «зеленее чем». */
function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`не hex: ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}
const luma = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe('палитра радара', () => {
  it('перекрашивает фон, воду и парки', () => {
    expect(layer('background').paint?.['background-color']).toBe(MAP_PALETTE.background);
    expect(MAP_PALETTE.background).toBe('#07070C');
    expect(layer('water').paint?.['fill-color']).toBe(MAP_PALETTE.water);
    expect(MAP_PALETTE.water).toBe('#0B1026');
    expect(layer('landuse_park').paint?.['fill-color']).toBe(MAP_PALETTE.park);
  });

  it('парк — очень тёмный зелёно-серый', () => {
    const [r, g, b] = rgb(MAP_PALETTE.park);
    expect(luma(MAP_PALETTE.park)).toBeLessThan(28);
    // зелени больше, чем красного и синего, но перевес небольшой — иначе получится трава, а не фон
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(g - r).toBeLessThan(16);
  });

  it('дороги низкоконтрастные и уходят в серо-фиолетовый', () => {
    for (const id of ['highway_minor', 'highway_major_inner', 'highway_major_subtle']) {
      const color = layer(id).paint?.['line-color'];
      expect(typeof color).toBe('string');
      const road = color as string;
      // светлее фона, но ненамного: карта — подложка под точки
      expect(luma(road)).toBeGreaterThan(luma(MAP_PALETTE.background));
      expect(luma(road) - luma(MAP_PALETTE.background)).toBeLessThan(30);
      const [r, g, b] = rgb(road);
      expect(b).toBeGreaterThanOrEqual(r);
      expect(b).toBeGreaterThanOrEqual(g);
    }
  });

  it('подписи приглушены и с ореолом под цвет фона', () => {
    expect(MAP_PALETTE.label).toBe('#62627A');
    for (const id of ['place_other', 'place_town', 'place_country_major', 'water_name']) {
      const paint = layer(id).paint ?? {};
      expect(luma(paint['text-color'] as string)).toBeLessThan(luma('#8A8AA0'));
      expect(paint['text-halo-color']).toBe(MAP_PALETTE.labelHalo);
      expect(paint['text-halo-width']).toBeGreaterThan(0);
    }
  });

  it('текстура леса убрана, остаётся заливка', () => {
    const wood = layer('landcover_wood');
    expect(wood.paint?.['fill-color']).toBe(MAP_PALETTE.wood);
    expect(wood.paint).not.toHaveProperty('fill-pattern');
  });

  it('названия мест берутся по-русски, когда они есть', () => {
    expect(layer('place_city').layout?.['text-field']).toEqual(['coalesce', ['get', 'name:ru'], ['get', 'name']]);
  });
});

describe('источники и шрифты', () => {
  it('сохраняет адреса OpenFreeMap: тайлы по TileJSON, не по датированной сборке', () => {
    expect(built.glyphs).toBe('https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf');
    expect(built.sprite).toBe('https://tiles.openfreemap.org/sprites/ofm_f384/ofm');
    const omt = built.sources.openmaptiles as { type: string; url?: string; tiles?: string[] };
    expect(omt.type).toBe('vector');
    expect(omt.url).toBe('https://tiles.openfreemap.org/planet');
    expect(omt.tiles).toBeUndefined();
    // датированная сборка планеты (…/planet/20250601…) сломается через месяц
    expect(JSON.stringify(built.sources)).not.toMatch(/planet\/20\d{6}/);
  });

  it('оставляет только гарнитуры Noto Sans', () => {
    const allowed = new Set<string>(Object.values(MAP_FONTS));
    for (const l of built.layers) {
      const fonts = l.layout?.['text-font'];
      if (fonts === undefined) continue;
      expect(Array.isArray(fonts)).toBe(true);
      for (const f of fonts as string[]) expect(allowed.has(f)).toBe(true);
    }
  });

  it('чужую гарнитуру сводит к Noto той же насыщенности', () => {
    const source = {
      version: 8,
      sources: {},
      layers: [
        { id: 'a', type: 'symbol', layout: { 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] } },
        { id: 'b', type: 'symbol', layout: { 'text-font': ['Metropolis Italic'] } },
        { id: 'c', type: 'symbol', layout: { 'text-font': ['Roboto'] } },
        { id: 'd', type: 'symbol', layout: { 'text-font': ['Noto Sans Regular', 'Whatever'] } },
      ],
    };
    const out = buildRadarStyle(source) as unknown as Style;
    expect(out.layers[0]!.layout?.['text-font']).toEqual([MAP_FONTS.bold]);
    expect(out.layers[1]!.layout?.['text-font']).toEqual([MAP_FONTS.italic]);
    expect(out.layers[2]!.layout?.['text-font']).toEqual([MAP_FONTS.regular]);
    expect(out.layers[3]!.layout?.['text-font']).toEqual([MAP_FONTS.regular]);
  });
});

describe('чистота', () => {
  it('не меняет исходный стиль', () => {
    const before = JSON.stringify(baseStyle);
    buildRadarStyle();
    expect(JSON.stringify(baseStyle)).toBe(before);
    expect((baseStyle as unknown as Style).layers[0]!.paint?.['background-color']).not.toBe(MAP_PALETTE.background);
  });

  it('даёт одинаковый результат при каждом вызове', () => {
    expect(JSON.stringify(buildRadarStyle())).toBe(JSON.stringify(buildRadarStyle()));
    expect(buildRadarStyle()).not.toBe(radarMapStyle);
  });

  it('сохраняет все слои подложки и их порядок', () => {
    const source = baseStyle as unknown as Style;
    expect(built.layers.map((l) => l.id)).toEqual(source.layers.map((l) => l.id));
    expect(built.version).toBe(8);
  });
});
