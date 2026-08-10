const GEOMETRY_PRECISION = 1_000;

export function meetsMinimumTarget(value, minimum = 44) {
  return Math.round(value * GEOMETRY_PRECISION) / GEOMETRY_PRECISION >= minimum;
}
