import { render, screen } from '@testing-library/react-native';

jest.mock('maplibre-gl', () => ({
  __esModule: true,
  default: {},
  Map: jest.fn(),
  Marker: jest.fn(),
  AttributionControl: jest.fn(),
  NavigationControl: jest.fn(),
}));

import { RadarMap } from '../RadarMap.web';

it('renders the web radar without native MapLibre commands', () => {
  render(
    <RadarMap
      mode="live"
      listeners={[]}
      clusters={[]}
      selectedId={null}
      showUserLocation={false}
      onSelect={() => undefined}
      onMapPress={() => undefined}
      onViewportChange={() => undefined}
    />,
  );
  expect(screen.getByTestId('radar-map')).toBeTruthy();
});
