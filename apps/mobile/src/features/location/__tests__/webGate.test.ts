import { approxFromAccuracy, permissionToGate, positionErrorGate } from '../gate.web';

describe('web location gate', () => {
  it('maps unsupported and denied browser geolocation to blocking states', () => {
    expect(permissionToGate('unsupported')).toBe('blocked');
    expect(permissionToGate('denied')).toBe('blocked');
    expect(permissionToGate('prompt')).toBe('undetermined');
    expect(positionErrorGate(2)).toBe('services_off');
  });

  it('uses coarse fixes as approx instead of a false precise pin', () => {
    expect(approxFromAccuracy(500)).toBe(false);
    expect(approxFromAccuracy(501)).toBe(true);
    expect(approxFromAccuracy(2500)).toBe(true);
    expect(approxFromAccuracy(null)).toBe(false);
  });

  it('explains browser recovery instead of offering Android settings', () => {
    jest.mock('react-native-reanimated', () => ({ __esModule: true, default: { View: 'View' }, FadeIn: { duration: jest.fn() } }));
    const { locationGateCopy } = require('../LocationGate') as typeof import('../LocationGate');
    const copy = locationGateCopy('blocked', 'web');
    expect(copy.action).toBe('Проверить снова');
    expect(copy.reason).toContain('настройках сайта');
  });
});
