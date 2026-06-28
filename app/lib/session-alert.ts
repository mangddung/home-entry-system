type ShowAlertFn = (title: string, message: string, onConfirm: () => void) => void;

let _fn: ShowAlertFn | null = null;

export const registerSessionAlert = (fn: ShowAlertFn) => { _fn = fn; };
export const triggerSessionAlert = (title: string, message: string, onConfirm: () => void) => {
  _fn?.(title, message, onConfirm);
};
