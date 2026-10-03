// Called only after the proxy's socket-peer allowlist check. Core and Supervisor
// preserve Host through Ingress. Forwarded headers may originate with clients,
// so they are deliberately NOT evidence for the browser's request authority.
function validEditorIngressOrigin(headers, ingressPath, allowAnyRemote) {
  if (allowAnyRemote || !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+$/.test(ingressPath)) return false;
  if (typeof headers.origin !== "string" || typeof headers.host !== "string" ||
      /[\s,/@\\?#]/.test(headers.host) ||
      headers["sec-fetch-site"] !== "same-origin") return false;
  try {
    const origin = new URL(headers.origin);
    // Host alone cannot prove the external scheme after TLS termination. Require
    // the browser-controlled same-origin metadata as well; older/insecure clients
    // without it fail closed rather than trusting a caller's forwarded scheme.
    const authority = new URL(`${origin.protocol}//${headers.host}`);
    return ["http:", "https:"].includes(origin.protocol) && origin.origin === headers.origin &&
      !authority.username && !authority.password && authority.pathname === "/" &&
      authority.origin === origin.origin;
  } catch { return false; }
}

module.exports = { validEditorIngressOrigin };
