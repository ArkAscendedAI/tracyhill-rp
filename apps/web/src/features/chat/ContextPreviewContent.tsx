import { Icon } from "../../shared/ui/Icon";
import type { ContextPreviewView } from "./contextPreviewView";
import { describeReply } from "./contextPreviewView";

type Props = {
  view: ContextPreviewView | null;
  /** Shown when there is no view (or it holds no rows). */
  emptyText: string;
  /** The composer model's display label for a stored snapshot. */
  composerLabel?: string;
};

const SOURCE_LABEL: Record<string, string> = { "scene-present": "scene", "cold-inflate": "cold", "cold-keyword": "cold-kw" };

/**
 * The body of the Context Preview popover: notes, hit counts and the scored entry list. One
 * component for the live stream and for a reply's stored snapshot, which adds a line
 * saying which reply it belongs to and how many dropped rows it kept.
 */
export function ContextPreviewContent({ view, emptyText, composerLabel }: Props) {
  const keptDropped = view ? view.preview.filter((e) => !e.included).length : 0;
  return (
    <>
      {view?.reply ? (
        <p className="ctx-preview-origin">
          Stored with the {describeReply(view.reply)}{composerLabel ? ` · composer ${composerLabel}` : ""}.
          {view.droppedTotal !== null && view.droppedTotal > keptDropped ? ` Shows the ${keptDropped} highest-scoring of ${view.droppedTotal} dropped entries.` : ""}
        </p>
      ) : null}
      {view && (view.notes.length > 0 || view.infoNotes.length > 0) ? (
        <div className="ctx-preview-notes">
          {view.notes.map((note, i) => (
            <div key={i} className="ctx-preview-note"><Icon name="alert" size={12} /> {note}</div>
          ))}
          {view.infoNotes.map((note, i) => (
            <div key={`info-${i}`} className="ctx-preview-note ctx-preview-note-info">ℹ {note}</div>
          ))}
        </div>
      ) : null}
      {view && view.preview.length > 0 ? (
        <>
          <div className="ctx-preview-summary">
            <span className="ctx-stat"><span className="ctx-stat-val">{view.debug?.keywordHits ?? 0}</span> keyword</span>
            <span className="ctx-stat"><span className="ctx-stat-val">{view.debug?.semanticHits ?? 0}</span> semantic</span>
            <span className="ctx-stat"><span className="ctx-stat-val">{view.debug?.researcherHits ?? 0}</span> researcher</span>
            {(view.debug?.absentContacts ?? 0) > 0 ? (
              <span className="ctx-stat"><span className="ctx-stat-val">{view.debug?.absentContacts}</span> absent contacts</span>
            ) : null}
            {(view.debug?.coldInflations ?? 0) > 0 ? (
              <span className="ctx-stat cold-inflate"><span className="ctx-stat-val">{view.debug?.coldInflations}</span> inflated</span>
            ) : null}
            {(view.debug?.droppedForBudget ?? 0) > 0 ? (
              <span className="ctx-stat dropped"><span className="ctx-stat-val">{view.debug?.droppedForBudget}</span> dropped</span>
            ) : null}
          </div>
          <div className="ctx-preview-entries">
            {[...view.preview].sort((a, b) => b.score - a.score).map((entry) => (
              <div key={entry.entryId} className={`ctx-preview-entry${entry.included ? "" : " dropped"}`}>
                <span className={`ctx-source-pill ${entry.source}`}>{SOURCE_LABEL[entry.source] ?? entry.source}</span>
                <span className="entry-name" title={entry.name}>{entry.name}</span>
                {entry.tag ? <span className="entry-tag">{entry.tag}</span> : null}
                <span className="entry-score">{entry.score}</span>
                <span className="entry-tokens">{entry.tokenCost}t</span>
                <span className={`entry-status ${entry.included ? "included" : "excluded"}`}><Icon name={entry.included ? "check" : "x"} size={10} /></span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p style={{ margin: 0, color: "var(--text2)" }}>{emptyText}</p>
      )}
    </>
  );
}
