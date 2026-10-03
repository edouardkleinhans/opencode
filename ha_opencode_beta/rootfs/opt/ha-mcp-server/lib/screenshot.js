// Browser authentication and readiness for screenshots. Keep this module free
// of puppeteer imports so disabled screenshots do not load Chromium's client.
class ScreenshotError extends Error {}

export function buildScreenshotTarget(haCoreUrl, urlPath) {
  let base;
  try {
    base = new URL(haCoreUrl);
  } catch {
    throw new ScreenshotError("Screenshot requires a valid Home Assistant HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) {
    throw new ScreenshotError("Screenshot requires a direct Home Assistant HTTP(S) origin without credentials, a base path, or query parameters.");
  }
  if (typeof urlPath !== "string" || !urlPath.trim() || /[\x00-\x20\\]/.test(urlPath) ||
      urlPath.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(urlPath)) {
    throw new ScreenshotError("Screenshot url_path must be a Home Assistant page path, not an absolute URL.");
  }
  const target = new URL(urlPath.startsWith("/") ? urlPath : `/${urlPath}`, base.origin);
  checkPageUrl(target.href, base.origin);
  return target;
}

// Only origin/path are used in diagnostics: OAuth query strings and fragments
// can contain secrets. Never propagate browser exceptions containing full URLs.
function checkPageUrl(value, origin) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password) {
    throw new ScreenshotError("Screenshot navigation left the configured Home Assistant origin. Set HA's internal URL to its final, direct address.");
  }
  if (/^\/(?:auth(?:\/|$)|onboarding(?:\/|\.html$|$))/i.test(url.pathname)) {
    throw new ScreenshotError(`Home Assistant authentication/navigation failed at ${url.origin}${url.pathname}; no screenshot was captured. Check the HA access token and internal URL.`);
  }
  return url;
}

// Runs before page scripts, including on navigations and in child frames.
// Only the trusted top-level document receives the LLAT. HA itself owns both
// WebSocket and REST authentication; there are no transport monkey-patches.
function seedScreenshotAuth({ origin, token }) {
  if (window !== window.top || location.origin !== origin) return;
  window.__haScreenshot = { storageError: false };
  try {
    localStorage.setItem("hassTokens", JSON.stringify({
      hassUrl: location.origin,
      clientId: null,
      access_token: token,
      refresh_token: "",
      expires_in: 1800,
      expires: Date.now() + 1800000,
    }));
  } catch {
    window.__haScreenshot.storageError = true;
  }
}

// A synchronous polling function: never await hassConnection here, because it
// intentionally stays pending during an auth redirect. Puppeteer's timeout must
// still be able to terminate the wait. Only status, never auth data, leaves JS.
function screenshotPageState(origin) {
  if (location.origin !== origin) return { error: "origin" };
  if (/^\/(?:auth(?:\/|$)|onboarding(?:\/|\.html$|$))/i.test(location.pathname)) return { error: "login" };
  const state = window.__haScreenshot;
  if (state?.storageError) return { error: "storage" };
  if (!state) return false;
  const promise = window.hassConnection;
  if (promise && state.promise !== promise) {
    state.promise = promise;
    state.connection = null;
    state.authFailed = false;
    Promise.resolve(promise).then(
      (result) => {
        if (state.promise === promise) state.connection = result?.conn;
      },
      () => {
        if (state.promise === promise) state.authFailed = true;
      },
    );
  }
  if (state.authFailed) return { error: "connection" };
  if (!state.connection?.connected) return false;
  const app = document.querySelector("home-assistant");
  const main = app?.shadowRoot?.querySelector("home-assistant-main");
  if (!app?.hass || !main || document.getElementById("ha-launch-screen")) return false;
  const bounds = main.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0 ? { ready: true } : false;
}

function requireReady(state) {
  const errors = {
    origin: "Screenshot navigation left the configured Home Assistant origin.",
    login: "Home Assistant redirected to login or onboarding; no screenshot was captured.",
    storage: "Home Assistant screenshot authentication could not initialize browser localStorage.",
    connection: "Home Assistant frontend authentication/connection failed. Check the HA access token and connectivity.",
  };
  if (!state?.ready) {
    throw new ScreenshotError(errors[state?.error] || "Home Assistant frontend disconnected or became unready before capture.");
  }
}

/** Capture an authenticated HA page in a disposable context of a shared browser. */
export async function captureHomeAssistantPage(browser, {
  haCoreUrl, urlPath, token, width = 1280, height = 720,
  waitSeconds = 3, fullPage = false, timeoutMs = 30000,
}) {
  const target = buildScreenshotTarget(haCoreUrl, urlPath);
  if (!token) throw new ScreenshotError("Screenshot requires a Home Assistant access token.");
  let context;
  let page;
  let navigationError;
  let phase = "browser setup";
  try {
    context = await browser.createBrowserContext();
    page = await context.newPage();
    await page.setViewport({ width, height });
    await page.evaluateOnNewDocument(seedScreenshotAuth, { origin: target.origin, token });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      // Abort untrusted top-level redirects before any new document runs.
      // Third-party resources/frames are allowed, but receive no injected auth.
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        try {
          checkPageUrl(request.url(), target.origin);
        } catch (error) {
          navigationError ||= error;
          void request.abort().catch(() => {});
          return;
        }
      }
      void request.continue().catch(() => {});
    });
    page.on("response", (response) => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && response.status() >= 400) {
        navigationError ||= new ScreenshotError(`Home Assistant screenshot navigation failed with HTTP ${response.status()}.`);
      }
    });
    const checkNavigation = () => {
      if (navigationError) throw navigationError;
      return checkPageUrl(page.url(), target.origin);
    };

    phase = "page navigation";
    const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    checkNavigation();
    if (!response || !response.ok()) {
      throw new ScreenshotError("Home Assistant screenshot navigation did not return a successful document.");
    }

    phase = "authenticated frontend readiness";
    const ready = await page.waitForFunction(screenshotPageState, { polling: 100, timeout: timeoutMs }, target.origin);
    try {
      checkNavigation();
      requireReady(await ready.jsonValue());
    } finally {
      await ready.dispose();
    }

    // The configurable delay is extra time for cards/images after the frontend
    // is authenticated and visible, not a substitute for readiness.
    phase = "dynamic content rendering";
    const delay = Math.max(0, Math.min(waitSeconds, 15)) * 1000;
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    checkNavigation();
    requireReady(await page.evaluate(screenshotPageState, target.origin));

    phase = "image capture";
    const captureUrl = checkNavigation();
    const image = await page.screenshot({ type: "png", fullPage, encoding: "base64" });
    const finalUrl = checkNavigation();
    if (finalUrl.href !== captureUrl.href) {
      throw new ScreenshotError("Home Assistant navigated during screenshot capture; try again.");
    }
    requireReady(await page.evaluate(screenshotPageState, target.origin));
    return { image, requestedPath: target.pathname, finalPath: finalUrl.pathname };
  } catch (error) {
    if (navigationError) throw navigationError;
    if (error instanceof ScreenshotError) throw error;
    const reason = error?.name === "TimeoutError" ? "Timed out" : "Screenshot failed";
    throw new ScreenshotError(`${reason} during ${phase} at ${target.origin}${target.pathname}. Check the HA internal URL, access token, and frontend connectivity.`);
  } finally {
    // Closing a tab alone leaves cookies, localStorage and service workers in
    // the shared browser. Dispose the entire per-call context on every path.
    if (context) await context.close().catch(() => {});
  }
}
