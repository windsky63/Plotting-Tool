/**
 * Replace the numeric weld-number token while preserving every character
 * before and after it. Prefer the token whose numeric value matches the
 * structured weld number, so digits in a prefix are not changed by mistake.
 */
export const replaceWeldDisplayNumber = (displayNumber, oldNumber, nextNumber) => {
  const display = String(displayNumber ?? oldNumber ?? '');
  const target = Number(oldNumber);
  const replacement = String(nextNumber);
  const matches = Array.from(display.matchAll(/\d+/g));
  const matched = Number.isFinite(target)
    ? matches.find(item => Number(item[0]) === target)
    : matches[0];

  if (!matched || !Number.isFinite(Number(matched.index))) return replacement;
  const index = Number(matched.index);
  return `${display.slice(0, index)}${replacement}${display.slice(index + matched[0].length)}`;
};

/** Split the visible weld label around the numeric token represented by the
 * structured weld number. The serialized key is safe even when either side
 * is empty and lets adjustment sequences distinguish F12, E12 and F12-A. */
export const getWeldDisplayAffixes = (displayNumber, weldNumber) => {
  const display = String(displayNumber ?? weldNumber ?? '');
  const target = Number(weldNumber);
  const matches = Array.from(display.matchAll(/\d+/g));
  const matched = Number.isFinite(target)
    ? matches.find(item => Number(item[0]) === target)
    : matches[0];
  if (!matched || !Number.isFinite(Number(matched.index))) return null;
  const index = Number(matched.index);
  const prefix = display.slice(0, index);
  const suffix = display.slice(index + matched[0].length);
  return {
    prefix,
    suffix,
    key: JSON.stringify([prefix, suffix])
  };
};

// Text such as F1-23A2 is ambiguous when both an affix and the weld number
// contain digits.  New/editable annotations persist the three parts
// separately, so always prefer that metadata over reparsing visible text.
export const getStoredWeldDisplayAffixes = weld => {
  const prefix = weld?.prefix ?? weld?.weldData?.prefix;
  const suffix = weld?.suffix ?? weld?.weldData?.suffix;
  if (prefix === undefined && suffix === undefined) return null;
  const normalizedPrefix = String(prefix ?? '');
  const normalizedSuffix = String(suffix ?? '');
  return {
    prefix: normalizedPrefix,
    suffix: normalizedSuffix,
    key: JSON.stringify([normalizedPrefix, normalizedSuffix])
  };
};

export const getWeldDisplayAffixKey = weld => (
  getStoredWeldDisplayAffixes(weld)?.key ?? getWeldDisplayAffixes(
    weld?.displayNumber ?? weld?.text,
    weld?.weldNumber ?? weld?.number
  )?.key ?? null
);

/** Single display source shared by the lightweight preview and final export. */
export const getCanonicalWeldDisplayNumber = weld => {
  if (weld?.isNumberless === true) return '';
  const display = weld?.displayNumber;
  const number = weld?.weldNumber ?? weld?.number;
  if (number === undefined || number === null || String(number) === '') return '';
  const storedAffixes = getStoredWeldDisplayAffixes(weld);
  if (storedAffixes) {
    return `${storedAffixes.prefix}${number}${storedAffixes.suffix}`;
  }
  if (display === undefined || display === null || String(display) === '') return number;

  const displayText = String(display);
  const numericTokens = Array.from(displayText.matchAll(/\d+/g));
  if (numericTokens.some(token => Number(token[0]) === Number(number))) return display;

  // A stale preview value may retain the correct affixes but an obsolete
  // numeric token (for example F42 after the structured number became 26).
  // Replace it only when there is one unambiguous numeric token; with multiple
  // tokens, prefer explicit prefix/suffix metadata and otherwise fall back to
  // the structured number instead of guessing which digit group is the weld.
  if (numericTokens.length === 1) {
    const token = numericTokens[0];
    const index = Number(token.index);
    return `${displayText.slice(0, index)}${number}${displayText.slice(index + token[0].length)}`;
  }
  if (weld?.prefix !== undefined || weld?.suffix !== undefined) {
    return `${weld?.prefix || ''}${number}${weld?.suffix || ''}`;
  }
  return number;
};
