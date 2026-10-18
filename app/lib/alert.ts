import type { AlertButton } from "@/components/custom-alert";

type ShowAlertFn = (title: string, message?: string, buttons?: AlertButton[]) => void;

let _fn: ShowAlertFn | null = null;

// 루트 레이아웃이 CustomAlert 호스트를 등록한다
export const registerAlertHost = (fn: ShowAlertFn) => { _fn = fn; };

// RN Alert.alert 대신 앱 디자인(CustomAlert)으로 띄운다.
// 바깥 터치·뒤로가기로는 닫히지 않는다(Android Alert 기본값과 같음). 버튼이 없으면 "확인" 하나.
export const showAlert: ShowAlertFn = (title, message, buttons) => {
  _fn?.(title, message, buttons);
};
