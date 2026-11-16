// Calls this deployment's API with the owner key saved on this device, and
// reports whether the deployment is the read-only demo.
(function () {
  const TOKEN_KEY = "mousing:owner-key";

  function token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      // Private browsing can refuse storage; the key then lasts for this page only.
    }
  }

  function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const key = token();
    if (key) headers.set("Authorization", `Bearer ${key}`);
    return fetch(path, { ...options, headers });
  }

  let modeRequest = null;
  function mode() {
    modeRequest ??= fetch("/api/mode")
      .then((res) => res.json())
      .catch(() => ({ demo: false, repo_url: "https://github.com/m4ndolore/mousing" }));
    return modeRequest;
  }

  globalThis.Mousing = { api, token, setToken, mode };
})();
