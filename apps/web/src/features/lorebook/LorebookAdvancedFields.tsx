import { NumericInput } from "../../shared/ui/NumericInput";

/** The entry fields behind the editor's "Advanced settings" toggle. */
export type AdvancedEntryValues = {
  insertionOrder: number;
  scanDepth: number;
  selectiveLogic: string;
  probability: number;
  sticky: number;
  cooldown: number;
  delay: number;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
};

type Bounds = { min?: number; max?: number };
/** Min/max per numeric dial, read off the contract by the panel. */
export type AdvancedEntryBounds = Record<"insertionOrder" | "scanDepth" | "probability" | "sticky" | "cooldown" | "delay", Bounds>;

type Props = {
  values: AdvancedEntryValues;
  bounds: AdvancedEntryBounds;
  onChange: (patch: Partial<AdvancedEntryValues>) => void;
  /** Tracker-owned entries: the values are shown, every control is disabled. */
  readOnly?: boolean;
};

/**
 * The lorebook editor's advanced block. There is no Position control:
 * context assembly never reads an entry's position, so the field only
 * suggested a placement that does not happen. The stored value still round-trips on save
 * (`buildEntryPayload`), and import/export keep it.
 */
export function LorebookAdvancedFields({ values, bounds, onChange, readOnly = false }: Props) {
  return (
    <div className="lorebook-advanced">
      <div className="lorebook-advanced-grid">
        <label>
          <span className="lorebook-field-label">Insertion order</span>
          <NumericInput value={values.insertionOrder} onChange={(v) => onChange({ insertionOrder: v })} {...bounds.insertionOrder} disabled={readOnly} />
        </label>
        <label>
          <span className="lorebook-field-label">Scan depth</span>
          <NumericInput value={values.scanDepth} onChange={(v) => onChange({ scanDepth: v })} {...bounds.scanDepth} disabled={readOnly} />
        </label>
        <label>
          <span className="lorebook-field-label">Selective logic</span>
          <select value={values.selectiveLogic} onChange={(e) => onChange({ selectiveLogic: e.target.value })} disabled={readOnly}>
            <option value="and_any">AND ANY</option>
            <option value="and_all">AND ALL</option>
            <option value="not_all">NOT ALL</option>
            <option value="not_any">NOT ANY</option>
          </select>
        </label>
        <label>
          <span className="lorebook-field-label">Probability %</span>
          <NumericInput value={values.probability} onChange={(v) => onChange({ probability: v })} {...bounds.probability} disabled={readOnly} />
        </label>
        <label>
          <span className="lorebook-field-label">Sticky turns</span>
          <NumericInput value={values.sticky} onChange={(v) => onChange({ sticky: v })} {...bounds.sticky} disabled={readOnly} />
        </label>
        <label>
          <span className="lorebook-field-label">Cooldown turns</span>
          <NumericInput value={values.cooldown} onChange={(v) => onChange({ cooldown: v })} {...bounds.cooldown} disabled={readOnly} />
        </label>
        <label>
          <span className="lorebook-field-label">Delay turns</span>
          <NumericInput value={values.delay} onChange={(v) => onChange({ delay: v })} {...bounds.delay} disabled={readOnly} />
        </label>
      </div>
      <div className="lorebook-advanced-checks">
        <label className="lorebook-toggle">
          <input type="checkbox" checked={values.excludeRecursion} onChange={(e) => onChange({ excludeRecursion: e.target.checked })} disabled={readOnly} />
          <span>Exclude from recursion</span>
        </label>
        <label className="lorebook-toggle">
          <input type="checkbox" checked={values.preventRecursion} onChange={(e) => onChange({ preventRecursion: e.target.checked })} disabled={readOnly} />
          <span>Prevent recursion</span>
        </label>
        <label className="lorebook-toggle">
          <input type="checkbox" checked={values.delayUntilRecursion} onChange={(e) => onChange({ delayUntilRecursion: e.target.checked })} disabled={readOnly} />
          <span>Delay until recursion</span>
        </label>
      </div>
    </div>
  );
}
