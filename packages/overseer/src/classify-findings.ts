/**
 * Fail-closed taxonomy for review findings eligible for automatic remediation.
 *
 * To add a class, add a named entry with narrowly-scoped markers to
 * AUTO_FIXABLE_CLASSES and cover it with a positive and an ambiguous negative
 * test. Markers for judgment calls belong in NON_AUTO_MARKERS and always win.
 * A line that matches neither table makes the entire review non-auto.
 */
export const AUTO_FIXABLE_CLASSES = {
  build: [/'build'/i, /\bbuild(?:ing)?\b/i, /compil(?:e|er|ation)/i],
  test: [/'test'/i, /\btests?\b/i, /test failure/i],
  lint: [/'lint'/i, /\blint(?:er|ing)?\b/i, /formatting/i],
  'migration-ordering': [
    /'migration-ordering'/i,
    /migration[-_ ]order(?:ing)?/i,
    /migration.*(?:foreign key|constraint|parent|child|before|after)/i,
    /(?:foreign key|constraint|parent|child).*migration/i,
  ],
} as const;

export const NON_AUTO_MARKERS = {
  design: [/\bdesign\b/i, /architecture/i],
  scope: [/\bscope\b/i, /requirements?/i],
  governance: [/governance/i, /policy decision/i],
  security: [/security/i, /threat model/i, /authorization judgment/i],
  judgment: [/judg(?:e)?ment/i, /human decision/i, /product decision/i],
} as const;

export interface FindingClassification {
  autoFixable: boolean;
  classes: string[];
  nonAutoReasons: string[];
}

function findingLines(reviewBody: string): string[] {
  return reviewBody
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^[-*]\s+/, ''))
    .filter(line => line.length > 0)
    .filter(line => !/^(?:review|verdict|findings?)\s*:?$/i.test(line));
}

export function classifyFindings(reviewBody: string): FindingClassification {
  const lines = findingLines(reviewBody);
  const classes = new Set<string>();
  const nonAutoReasons = new Set<string>();

  if (lines.length === 0) nonAutoReasons.add('empty_review_body');

  for (const line of lines) {
    const nonAuto = Object.entries(NON_AUTO_MARKERS).find(([, markers]) =>
      markers.some(marker => marker.test(line))
    );
    if (nonAuto) {
      nonAutoReasons.add(nonAuto[0]);
      continue;
    }

    const auto = Object.entries(AUTO_FIXABLE_CLASSES).find(([, markers]) =>
      markers.some(marker => marker.test(line))
    );
    if (auto) classes.add(auto[0]);
    else nonAutoReasons.add(`unknown:${line.slice(0, 120)}`);
  }

  return {
    autoFixable: classes.size > 0 && nonAutoReasons.size === 0,
    classes: [...classes],
    nonAutoReasons: [...nonAutoReasons],
  };
}
