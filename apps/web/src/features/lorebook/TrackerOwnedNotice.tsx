import { Icon } from "../../shared/ui/Icon";

/**
 * Why a tracker-owned entry is read-only in the editor, and where its content is read and
 * curated instead.
 */
export function TrackerOwnedNotice({ kind }: { kind: "index" | "thread" }) {
  return (
    <div className="lorebook-readonly-note" role="note">
      <p className="lorebook-readonly-title">
        <Icon name="shield" size={13} /> {kind === "index" ? "Thread Index: kept by the thread tracker" : "Thread entry: kept by the thread tracker"}
      </p>
      <p>
        {kind === "index"
          ? "The tracker keeps its ledger of every thread in this entry's comment and rewrites the text from it after each rolling diff, so this entry is read-only here."
          : "The tracker rewrites this entry from its ledger whenever the thread changes, so it is read-only here."}
        {" "}Read the threads from the Threads chip in the conversation's top bar.
      </p>
    </div>
  );
}
