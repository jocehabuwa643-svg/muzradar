import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import baseStyle from './ofm-dark.json';

/**
 * Палитра подложки. Карта — фон для точек слушателей, поэтому всё приглушено:
 * дороги и подписи на пару ступеней светлее фона, акцентов нет.
 */
export const MAP_PALETTE = {
  background: '#07070C',
  water: '#0B1026',
  waterway: '#0E1430',
  waterLabel: '#3E4775',
  ice: '#0C0C14',
  residential: '#0B0B12',
  wood: '#0C1411',
  park: '#0E1613',
  building: '#0D0D16',
  buildingOutline: '#151520',
  roadPath: '#1A1A27',
  roadMinor: '#15151F',
  roadMajor: '#1B1B29',
  roadMajorSubtle: '#212130',
  roadCasing: 'rgba(58,58,82,0.55)',
  motorway: '#201E30',
  motorwayFar: 'rgba(98,98,122,0.45)',
  motorwayCasing: 'rgba(76,70,110,0.6)',
  rail: '#1C1C29',
  airport: '#0B0B12',
  airportLine: '#15151F',
  boundary: '#2A2A3B',
  label: '#62627A',
  labelMinor: '#52526A',
  labelMajor: '#76768E',
  labelHalo: 'rgba(7,7,12,0.85)',
} as const;

/** OpenFreeMap отдаёт только эти гарнитуры; любая другая — пустые подписи. */
export const MAP_FONTS = {
  regular: 'Noto Sans Regular',
  bold: 'Noto Sans Bold',
  italic: 'Noto Sans Italic',
} as const;

const ALLOWED_FONTS: readonly string[] = Object.values(MAP_FONTS);

// Русские названия, где они есть в OSM; иначе местное имя. Двуязычные подписи шумят на тёмной карте.
const RU_NAME = ['coalesce', ['get', 'name:ru'], ['get', 'name']] as const;

type Paint = Record<string, unknown>;

interface RawLayer {
  id: string;
  type: string;
  paint?: Paint;
  layout?: Paint;
  [key: string]: unknown;
}

interface RawStyle {
  version: number;
  sources: Record<string, unknown>;
  layers: RawLayer[];
  [key: string]: unknown;
}

interface Rule {
  test: (layer: RawLayer) => boolean;
  paint?: Paint;
  layout?: Paint;
  /** Свойства paint, которые надо убрать (например, текстура леса). */
  drop?: readonly string[];
}

const byId =
  (...ids: string[]) =>
  (l: RawLayer) =>
    ids.includes(l.id);
const byPrefix =
  (...prefixes: string[]) =>
  (l: RawLayer) =>
    prefixes.some((p) => l.id.startsWith(p));

const P = MAP_PALETTE;

const labelPaint = (color: string): Paint => ({
  'text-color': color,
  'text-halo-color': P.labelHalo,
  'text-halo-width': 1.2,
  'text-halo-blur': 0.5,
});

// Порядок важен: срабатывает первое подходящее правило.
const RULES: readonly Rule[] = [
  { test: byId('background'), paint: { 'background-color': P.background } },
  { test: byId('water'), paint: { 'fill-color': P.water } },
  { test: byId('waterway'), paint: { 'line-color': P.waterway } },
  { test: byId('water_name'), paint: labelPaint(P.waterLabel), layout: { 'text-field': RU_NAME } },
  { test: byPrefix('landcover_ice', 'landcover_glacier'), paint: { 'fill-color': P.ice } },
  { test: byId('landuse_residential'), paint: { 'fill-color': P.residential } },
  { test: byId('landcover_wood'), paint: { 'fill-color': P.wood }, drop: ['fill-pattern'] },
  { test: byId('landuse_park'), paint: { 'fill-color': P.park } },
  { test: byId('building'), paint: { 'fill-color': P.building, 'fill-outline-color': P.buildingOutline } },
  { test: byId('aeroway-taxiway'), paint: { 'line-color': P.airportLine } },
  { test: byId('aeroway-runway-casing'), paint: { 'line-color': P.roadCasing } },
  { test: byId('aeroway-area'), paint: { 'fill-color': P.airport } },
  { test: byId('aeroway-runway'), paint: { 'line-color': P.airport } },
  { test: byId('road_area_pier'), paint: { 'fill-color': P.background } },
  { test: byId('road_pier'), paint: { 'line-color': P.background } },
  { test: byId('highway_path'), paint: { 'line-color': P.roadPath, 'line-opacity': 0.8 } },
  { test: byId('highway_minor'), paint: { 'line-color': P.roadMinor } },
  { test: byId('highway_major_casing'), paint: { 'line-color': P.roadCasing } },
  { test: byId('highway_major_inner'), paint: { 'line-color': P.roadMajor } },
  { test: byId('highway_major_subtle'), paint: { 'line-color': P.roadMajorSubtle } },
  { test: byId('highway_motorway_casing'), paint: { 'line-color': P.motorwayCasing } },
  {
    test: byId('highway_motorway_inner'),
    paint: { 'line-color': ['interpolate', ['linear'], ['zoom'], 5.8, P.motorwayFar, 6, P.motorway] },
  },
  { test: byId('highway_motorway_subtle'), paint: { 'line-color': P.roadMinor } },
  { test: byPrefix('road_oneway'), paint: { 'icon-opacity': 0.25 } },
  { test: (l) => l.id.startsWith('railway') && l.id.endsWith('_dashline'), paint: { 'line-color': P.background } },
  { test: byPrefix('railway'), paint: { 'line-color': P.rail } },
  { test: byId('highway_name_other'), paint: labelPaint(P.labelMinor), layout: { 'text-field': RU_NAME } },
  { test: byId('highway_name_motorway'), paint: labelPaint(P.labelMinor) },
  { test: byPrefix('boundary_'), paint: { 'line-color': P.boundary } },
  {
    test: byId('place_other', 'place_suburb', 'place_village'),
    paint: { ...labelPaint(P.labelMinor), 'icon-opacity': 0.35 },
    layout: { 'text-field': RU_NAME },
  },
  {
    test: byId('place_town', 'place_city', 'place_city_large'),
    paint: { ...labelPaint(P.labelMajor), 'icon-opacity': 0.35 },
    layout: { 'text-field': RU_NAME },
  },
  { test: byPrefix('place_'), paint: labelPaint(P.label), layout: { 'text-field': RU_NAME } },
];

/** Любой text-font сводится к Noto Sans той же насыщенности. */
function notoOnly(fonts: unknown): string[] {
  const list = Array.isArray(fonts) ? fonts.filter((f): f is string => typeof f === 'string') : [];
  const kept = list.filter((f) => ALLOWED_FONTS.includes(f));
  if (kept.length > 0) return kept;
  const joined = list.join(' ').toLowerCase();
  if (joined.includes('bold')) return [MAP_FONTS.bold];
  if (joined.includes('italic')) return [MAP_FONTS.italic];
  return [MAP_FONTS.regular];
}

function recolorLayer(layer: RawLayer): RawLayer {
  const rule = RULES.find((r) => r.test(layer));
  let paint = layer.paint ? { ...layer.paint } : undefined;
  let layout = layer.layout ? { ...layer.layout } : undefined;

  if (rule) {
    if (rule.paint) paint = { ...paint, ...rule.paint };
    for (const key of rule.drop ?? []) if (paint) delete paint[key];
    if (rule.layout && layer.type === 'symbol') layout = { ...layout, ...rule.layout };
  }
  if (layout && 'text-font' in layout) layout['text-font'] = notoOnly(layout['text-font']);

  const out: RawLayer = { ...layer };
  if (paint) out.paint = paint;
  if (layout) out.layout = layout;
  return out;
}

/**
 * Фирменный тёмный стиль из снимка OpenFreeMap `dark`.
 * Источники, глифы и спрайт остаются на tiles.openfreemap.org: тайлы берутся по TileJSON,
 * поэтому смена датированной сборки планеты ничего не ломает. Вход не мутируется.
 */
export function buildRadarStyle(source: unknown = baseStyle): StyleSpecification {
  const base = source as RawStyle;
  const style = {
    ...base,
    name: 'muzradar-dark',
    sources: cloneJson(base.sources),
    layers: base.layers.map(recolorLayer),
  };
  return style as unknown as StyleSpecification;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Готовый стиль: считается один раз при импорте. */
export const radarMapStyle: StyleSpecification = buildRadarStyle();
