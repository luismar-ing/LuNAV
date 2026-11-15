import { STRINGS } from "../lib/strings";
import { isCustomSiteId } from "../lib/virtualSite";

/**
 * B13 (decision A14): the APPROXIMATE label of a custom site, wherever its horizon or terrain is shown (site panel,
 * time left, the scene). Nothing for the five candidate sites.
 */
export function ApproxBadge({ siteId, testId = "approx-badge" }: { siteId: string | undefined; testId?: string }) {
  if (!isCustomSiteId(siteId)) return null;
  return (
    <span className="badge assumed" title={STRINGS.custom.approxScene} data-testid={testId}>
      {STRINGS.custom.approx}
    </span>
  );
}
