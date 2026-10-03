import { useState } from "react";

import { Icon } from "../../shared/ui/Icon";
import { importReportItemsShown, type ImportReport } from "./lorebookPanelUtils";

/**
 * An import's result with every error or warning listed. The list is
 * open by default and collapses; the notice stays until dismissed, since a long list is read
 * while the imported entries are checked. A long list renders its first 200 items and a
 * "Show N more" button: the importer's list has no cap.
 */
export function ImportReportNotice({ report, onDismiss }: { report: ImportReport; onDismiss: () => void }) {
  // The report the reader expanded; a new report starts collapsed again.
  const [expandedFor, setExpandedFor] = useState<ImportReport | null>(null);
  const count = report.items.length;
  const { shown, hidden } = importReportItemsShown(report.items, expandedFor === report);
  return (
    <div className="lorebook-report" role="status">
      <div className="lorebook-report-head">
        <span>{report.headline}{count === 0 ? "." : ""}</span>
        <button type="button" className="ghost-button lorebook-report-close" onClick={onDismiss} aria-label="Dismiss import report" title="Dismiss">
          <Icon name="x" size={12} />
        </button>
      </div>
      {count > 0 ? (
        <details open>
          <summary>{count} {report.noun}{count === 1 ? "" : "s"}</summary>
          <ul>
            {shown.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
          {hidden > 0 ? (
            <button type="button" className="ghost-button lorebook-report-more" onClick={() => setExpandedFor(report)}>
              Show {hidden} more {report.noun}{hidden === 1 ? "" : "s"}
            </button>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
