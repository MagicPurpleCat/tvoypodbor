// Тонкая обёртка над window.Telegram.WebApp. Вне Telegram (dev в браузере) методы — no-op.

type BottomButton = {
  setParams(p: { text?: string; color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean; has_shine_effect?: boolean; position?: 'left' | 'right' | 'top' | 'bottom' }): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  show(): void;
  hide(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
};

interface WebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name: string; username?: string; photo_url?: string } };
  version: string;
  platform: string;
  isVersionAtLeast(v: string): boolean;
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  setBottomBarColor?(c: string): void;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  openLink(url: string, opts?: { try_instant_view?: boolean }): void;
  showPopup(p: { title?: string; message: string; buttons?: { id?: string; type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive'; text?: string }[] }, cb?: (id: string) => void): void;
  showConfirm(message: string, cb: (ok: boolean) => void): void;
  showAlert(message: string, cb?: () => void): void;
  MainButton: BottomButton;
  SecondaryButton?: BottomButton;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback: {
    impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(t: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  onEvent(e: string, cb: () => void): void;
}

declare global {
  interface Window { Telegram?: { WebApp: WebApp } }
}

export const tg: WebApp | undefined = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : undefined;
export const inTelegram = Boolean(tg);

export const COLORS = { bg: '#07080B', cta: '#00D46B', ctaText: '#07080B', secondary: '#4A55E2', white: '#FFFFFF' };

export function initTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.(); // не закрывать приложение свайпом при скролле списков
  tg.setHeaderColor(COLORS.bg);
  tg.setBackgroundColor(COLORS.bg);
  tg.setBottomBarColor?.(COLORS.bg);
}

/** Экран, с которого открыли приложение: startapp (прямая ссылка) или ?start= (web_app-кнопка в чате). */
export const startParam = (): string | undefined =>
  tg?.initDataUnsafe.start_param ?? new URLSearchParams(location.search).get('start') ?? undefined;

export const haptic = {
  tap: () => tg?.HapticFeedback.impactOccurred('light'),
  success: () => tg?.HapticFeedback.notificationOccurred('success'),
  error: () => tg?.HapticFeedback.notificationOccurred('error'),
  select: () => tg?.HapticFeedback.selectionChanged(),
};

export function openLink(url: string) {
  if (tg) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => (tg ? tg.showConfirm(message, resolve) : resolve(window.confirm(message))));
}

export function alert(message: string): Promise<void> {
  return new Promise((resolve) => (tg ? tg.showAlert(message, resolve) : (window.alert(message), resolve())));
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // старые WebView без Clipboard API
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
