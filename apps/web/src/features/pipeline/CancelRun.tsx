import { CANCEL_RUN_CONFIRM, CANCEL_RUN_KEEP, CANCEL_RUN_TITLE, cancelRunConfirmBody, type CancelRunTarget } from "./pipelineUtils";
import { Dialog } from "../../shared/ui/Dialog";
import { Icon } from "../../shared/ui/Icon";

/**
 * The Cancel Run confirmation, shared by the activity bar, the run drawer and the campaign
 * editor's Pipeline tab. It stays mounted and returns nothing while closed. It sits above the run drawer (z 2200).
 */
export function CancelRunDialog({ target, busy, onConfirm, onKeep }: {
  target: CancelRunTarget | null;
  busy: boolean;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  return (
    <Dialog
      open={target != null}
      onClose={onKeep}
      label="Cancel pipeline run"
      title={CANCEL_RUN_TITLE}
      icon="alert"
      size="sm"
      zIndex={2300}
      footer={<>
        <button type="button" className="secondary-button" onClick={onKeep}>{CANCEL_RUN_KEEP}</button>
        <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>{CANCEL_RUN_CONFIRM}</button>
      </>}
    >
      {target ? <p className="muted">{cancelRunConfirmBody(target)}</p> : null}
    </Dialog>
  );
}

/**
 * A cancel the server refused: one line with a dismiss control. The bar keeps it, even with nothing live, until
 * it is dismissed or the next cancel replaces it; the run drawer shows it too.
 */
export function CancelRefusal({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="pipeline-bar-error" role="alert">
      <Icon name="alert" size={12} />
      <span className="pipeline-bar-error-text">{message}</span>
      <button type="button" className="ghost-button" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
