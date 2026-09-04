export function isCredentialLikeKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .split('_')
    .filter(Boolean);

  if (segments.includes('secret') || segments.includes('token')) {
    return true;
  }

  return segments.some((segment, index) => segment === 'api' && segments[index + 1] === 'key');
}
