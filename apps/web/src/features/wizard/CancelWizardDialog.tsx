import { CANCEL_RUN_CONFIRM, CANCEL_RUN_KEEP } from "../pipeline/pipelineUtils";
import { Dialog } from "../../shared/ui/Dialog";
import { CANCEL_WIZARD_TITLE, cancelWizardConfirmBody, type CancelWizardTarget } from "./wizardUtils";

/**
 * The Cancel Wizard confirmation, shared by the shell's wizard activity panel, the
 * campaign panel's Wizard tab and the review dialog. It stays mounted and returns nothing while closed, and sits above
 * the review dialog and the campaign panel (z 300, as the panel's other confirmations).
 */
export function CancelWizardDialog({ target, busy, onConfirm, onKeep }: {
  target: CancelWizardTarget | null;
  busy: boolean;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  return (
    <Dialog
      open={target != null}
      onClose={onKeep}
      label="Cancel wizard run"
      title={CANCEL_WIZARD_TITLE}
      icon="alert"
      size="sm"
      zIndex={300}
      footer={<>
        <button type="button" className="secondary-button" onClick={onKeep}>{CANCEL_RUN_KEEP}</button>
        <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>{CANCEL_RUN_CONFIRM}</button>
      </>}
    >
      {target ? <p className="muted">{cancelWizardConfirmBody(target.name)}</p> : null}
    </Dialog>
  );
}
