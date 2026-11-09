// Collapse extra spaces/tabs without destroying paragraph breaks.
// `\s` matches newlines, so a naive `\s{2,}` → `' '` turns a multi-paragraph
// offer into one run-on DM.
export function collapseInlineWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function applyFirstName(text, firstName) {
  return String(text ?? '').replace(/\{first_name\}/g, firstName ?? '');
}

export function prepareOutboundMessage(text, firstName) {
  return collapseInlineWhitespace(applyFirstName(text, firstName));
}


export function expandSpintax(text) {
  return String(text || '').replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, group) => {
    const variants = group.split('|').map(v => v.trim()).filter(Boolean);
    return variants.length ? variants[Math.floor(Math.random() * variants.length)] : group;
  });
}
