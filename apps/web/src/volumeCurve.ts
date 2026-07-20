const USER_VOLUME_MAX = 2;
const ATTENUATION_EXPONENT = 3;

/**
 * Converts the persisted personal-volume value (0..2) to an audible gain.
 *
 * Values up to unity use a cubic curve: the slider keeps its familiar
 * 0..100% labels while its lower half provides useful attenuation. Boost
 * remains linear above 100%, so the existing 100..200% contract is intact.
 */
export function userVolumeToGain(value: number): number {
  const normalized = Number.isFinite(value)
    ? Math.max(0, Math.min(USER_VOLUME_MAX, value))
    : 1;

  return normalized <= 1
    ? Math.pow(normalized, ATTENUATION_EXPONENT)
    : normalized;
}
