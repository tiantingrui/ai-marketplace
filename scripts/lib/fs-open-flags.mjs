export function buildTrustedReadOpenFlags(constants = {}) {
  const readOnly = constants.O_RDONLY ?? 0;
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  return readOnly | noFollow;
}
