interface ShownNotification {
  close(): void;
}

interface NotificationRegistration {
  getNotifications(): PromiseLike<ShownNotification[]>;
}

interface NotificationServiceWorker {
  getRegistration(): PromiseLike<NotificationRegistration | undefined>;
}

const SHOWN_NOTIFICATION_CLOSE_TIMEOUT_MS = 1_000;

function settleWithin<T>(value: PromiseLike<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, Math.max(0, timeoutMs));
    Promise.resolve(value).then((result) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(result);
    }, () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(fallback);
    });
  });
}

/** Close already displayed push banners without letting a stalled browser API delay logout/boot. */
export async function closeShownPushNotifications(
  timeoutMs = SHOWN_NOTIFICATION_CLOSE_TIMEOUT_MS,
  exactServiceWorker?: NotificationServiceWorker | null,
): Promise<void> {
  const serviceWorker = exactServiceWorker ?? (() => {
    try { return 'serviceWorker' in navigator ? navigator.serviceWorker : null; }
    catch { return null; }
  })();
  if (!serviceWorker) return;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let registrationAttempt: PromiseLike<NotificationRegistration | undefined>;
  try { registrationAttempt = serviceWorker.getRegistration(); } catch { return; }
  const registration = await settleWithin(registrationAttempt, Math.max(0, deadline - Date.now()), undefined);
  if (!registration) return;
  let notificationsAttempt: PromiseLike<ShownNotification[]>;
  try { notificationsAttempt = registration.getNotifications(); } catch { return; }
  const notifications = await settleWithin(notificationsAttempt, Math.max(0, deadline - Date.now()), []);
  for (const notification of notifications) {
    try { notification.close(); } catch { /** one stale banner must not block the rest */ }
  }
}
