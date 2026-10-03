import type { DriveListResponse, DriveRecord } from "@tracyhill-rp/contracts";

import { castCardLines } from "../drives/drivesPanelUtils";
import { Icon } from "../../shared/ui/Icon";
import { QueryError } from "../../shared/ui/QueryError";

/** The chat's drive-sheet read, as react-query holds it. */
export type DrivesQuery = {
  data: DriveListResponse | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

export type CastCard = { name: string; unaware: boolean; rec: DriveRecord };

type Props = {
  query: DrivesQuery;
  /** The present characters (aware first) that hold a drive sheet. */
  cards: CastCard[];
  /** The aware present characters, for the cards' dispositions. */
  presentAware: string[];
  onEditSheet: (name: string) => void;
};

/**
 * The body of the chat's Cast popover: each present character's agenda card. A first read that failed shows the failure
 * alone with Retry, never "No present characters have drive sheets."; a failed re-read keeps the last read's cards with
 * the failure above them.
 */
export function CastCardsContent({ query, cards, presentAware, onEditSheet }: Props) {
  if (!query.data) {
    return query.isError
      ? <QueryError query={query} label="Unable to load the drive sheets" />
      : <p style={{ margin: 0, color: "var(--text2)" }}>Loading the drive sheets…</p>;
  }
  return (
    <div className="cast-popover-card">
      <QueryError query={query} label="Unable to refresh the drive sheets (showing the last read)" />
      {cards.length === 0 ? (
        <p style={{ margin: 0, color: "var(--text2)" }}>No present characters have drive sheets.</p>
      ) : cards.map(({ name, unaware, rec }) => {
        return (
          <div key={name} className={`cast-card${unaware ? " is-unaware" : ""}`}>
            <div className="cast-card-name"><Icon name="masks" size={13} /> {name}{unaware && <span className="muted small-copy">unaware</span>}</div>
            {castCardLines(name, rec.sheet, unaware, presentAware).map((line, i) => (
              <div key={i} className={line.kind === "line" ? "cast-card-line" : line.kind === "muted" ? "cast-card-line is-muted" : `cast-card-want${line.kind === "held" ? " is-on-hold" : ""}`}>{line.text}</div>
            ))}
            <button className="ghost-button small" onClick={() => onEditSheet(name)}>Edit sheet →</button>
          </div>
        );
      })}
    </div>
  );
}
