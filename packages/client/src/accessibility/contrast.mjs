function expandHex(hex) {
  const normalized = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized;
  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    return `#${[...normalized.slice(1)].map((channel) => channel.repeat(2)).join("")}`;
  }
  throw new TypeError(`Expected a three- or six-digit hex color, received: ${hex}`);
}

function channels(hex) {
  const expanded = expandHex(hex);
  return [1, 3, 5].map((index) => Number.parseInt(expanded.slice(index, index + 2), 16));
}

export function relativeLuminance(hex) {
  const linear = channels(hex).map((channel) => channel / 255).map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

export function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

export function compositeHex(foreground, background, alpha) {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError(`Alpha must be between 0 and 1, received: ${alpha}`);
  }
  const foregroundChannels = channels(foreground);
  const backgroundChannels = channels(background);
  const blended = foregroundChannels.map((channel, index) => (
    Math.round((channel * alpha) + (backgroundChannels[index] * (1 - alpha)))
  ));
  return `#${blended.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function meetsContrast(first, second, minimum) {
  return contrastRatio(first, second) >= minimum;
}
