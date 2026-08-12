let claimed = false;

export function claimPrivateCacheDegradationNotice(): boolean {
  if (claimed) return false;
  claimed = true;
  return true;
}
