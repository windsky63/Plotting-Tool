const CLIENT_ID_KEY = 'luotu_audit_client_id';
const ERP_USER_KEY = 'luotu_audit_erp_user';

let cachedErpUser = '';

try {
  cachedErpUser = String(window.localStorage.getItem(ERP_USER_KEY) || '').trim().toLowerCase();
} catch {
  cachedErpUser = '';
}

// Ctrl+F5 recreates the JavaScript context, so restore the signed ERP session
// before sending new audit events.  The last server-verified user is retained
// as a fallback when an old SSO cookie has just expired.
const identityReady = typeof window === 'undefined'
  ? Promise.resolve('')
  : fetch('/api/sso/me', { cache: 'no-store', credentials: 'same-origin' })
      .then(response => response.ok ? response.json() : null)
      .then(result => {
        const erpUser = String(result?.user?.erpUser || '').trim().toLowerCase();
        if (result?.authenticated && erpUser) {
          cachedErpUser = erpUser;
          try {
            window.localStorage.setItem(ERP_USER_KEY, erpUser);
          } catch {
            // Audit identity persistence must not affect the app workflow.
          }
        }
        return cachedErpUser;
      })
      .catch(() => cachedErpUser);

const getClientId = () => {
  try {
    let clientId = window.localStorage.getItem(CLIENT_ID_KEY);
    if (!clientId) {
      clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(CLIENT_ID_KEY, clientId);
    }
    return clientId;
  } catch {
    return '';
  }
};

const compact = value => {
  if (value === undefined || typeof value === 'function') return undefined;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value).slice(0, 500);
  }
};

const pendingEvents = [];
let flushTimer = null;

const flushAuditEvents = () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pendingEvents.length) return;

  // Keep each beacon comfortably below the common 64 KiB keepalive limit.
  const events = pendingEvents.splice(0, 40);
  const json = JSON.stringify({ events });
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([json], { type: 'application/json' });
      if (navigator.sendBeacon('/api/admin/audit/event', blob)) {
        if (pendingEvents.length) flushTimer = setTimeout(flushAuditEvents, 1000);
        return;
      }
    }
    fetch('/api/admin/audit/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true
    }).catch(() => {});
  } catch {
    // Audit delivery must never affect annotation work.
  }
  if (pendingEvents.length) flushTimer = setTimeout(flushAuditEvents, 1000);
};

const enqueueAuditEvent = body => {
  pendingEvents.push(body);
  if (pendingEvents.length >= 40) {
    flushAuditEvents();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushAuditEvents, 1000);
  }
};

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushAuditEvents);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAuditEvents();
  });
}

export const auditLogService = {
  log(action, payload = {}) {
    if (!action || typeof window === 'undefined') return;

    const body = {
      action,
      clientId: getClientId(),
      timestamp: new Date().toISOString()
    };

    Object.entries(payload).forEach(([key, value]) => {
      const normalized = compact(value);
      if (normalized !== undefined) {
        body[key] = normalized;
      }
    });

    const send = () => {
      if (cachedErpUser && !body.erpUser) {
        body.erpUser = cachedErpUser;
      }
      enqueueAuditEvent(body);
    };

    // Queue events emitted during the first moments after a hard refresh until
    // /api/sso/me has restored the ERP identity.
    identityReady.finally(send);
  }
};

export default auditLogService;
