// injected.js
(function () {
    // Skip iframes and any sandbox/utility paths that log the fenced-frame warning
    const href = location.href;
    if (window.top !== window.self) return;
    if (/ssiframe\.html|authwall|login|captcha/i.test(href)) return;

    console.log("🔌 LinkedIn Job Stats injector (+prefetch +cache)");

    let currentJobId = null;
    let domObserver = null;
    let enforcerStop = null;
    let fetchAbort = null;
    let requestSeq = 0;
    let statsReadyForJob = null; // jobId that currently has fetched stats

    // 🔥 Small in-memory cache
    const cache = new Map(); // jobId -> { applies, views, ts }
    const CACHE_TTL_MS = 5 * 60 * 1000;

    function getFromCache(jobId) {
        const it = cache.get(jobId);
        if (!it) return null;
        if (Date.now() - it.ts > CACHE_TTL_MS) {
            cache.delete(jobId);
            return null;
        }
        return it; // {applies, views, ts}
    }
    function setCache(jobId, applies, views) {
        cache.set(jobId, { applies, views, ts: Date.now() });
    }

    function getCsrfToken() {
        const m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
        return m ? m[1] : null;
    }

    function getJobIdFromUrl() {
        let m = window.location.pathname.match(/\/jobs\/view\/(\d+)/);
        if (m) return m[1];
        m = window.location.search.match(/[?&]currentJobId=(\d+)/);
        return m ? m[1] : null;
    }

    // ex: "Over 100 people clicked apply", "100+ people applied"
    const APPLY_TEXT_RE = /\b(?:over\s*)?\d+\+?\s*people\s*(?:clicked\s*apply|applied)\b/i;

    function findApplyLeafSpan(root) {
        const spans = root.querySelectorAll(
            'span.tvm_text, span.tvm__text, span[class*="tvm_text"], span[class*="tvm__text"], .jobs-unified-top-card__primary-description span, .job-details-jobs-unified-top-card__tertiary-description-container span'
        );
        for (const s of spans) {
            if (s.children.length === 0) {
                const txt = (s.textContent || "").trim();
                if (APPLY_TEXT_RE.test(txt)) return s;
            }
        }
        return null;
    }

    // Revert any prior injections (used on navigation before new stats arrive)
    function resetInjectedText() {
        const injected = document.querySelectorAll('[data-li-stats-injected="1"]');
        for (const node of injected) {
            const original = node.dataset.liStatsOriginal;
            if (original != null) node.textContent = original;
            delete node.dataset.liStatsInjected;
            delete node.dataset.liStatsJob;
            delete node.dataset.liStatsOriginal;
        }
    }

    function tryReplaceInDoc(applies, views, jobId) {
        if (statsReadyForJob !== jobId) return false; // don't inject until we have stats (cache or fresh)

        const containers = document.querySelectorAll(
            ".job-details-jobs-unified-top-card__primary-description-container, .job-details-jobs-unified-top-card__tertiary-description-container, .jobs-unified-top-card__primary-description"
        );

        let replaced = false;
        for (const c of containers) {
            const leaf = findApplyLeafSpan(c);
            if (!leaf) continue;

            if (jobId !== currentJobId) return false; // safety

            const newText = `Applies: ${applies} • Views: ${views}`;

            if (!leaf.dataset.liStatsInjected) {
                // save original text so we can restore on next navigation
                leaf.dataset.liStatsOriginal = leaf.textContent || "";
            }

            if (leaf.dataset.liStatsJob !== jobId || leaf.textContent !== newText) {
                leaf.textContent = newText;
                leaf.dataset.liStatsInjected = "1";
                leaf.dataset.liStatsJob = jobId;
            }
            replaced = true;
        }
        return replaced;
    }

    function startObserver(applies, views, jobId) {
        // stop previous observer/enforcer
        if (domObserver) domObserver.disconnect();
        domObserver = null;
        if (enforcerStop) enforcerStop.active = false;
        enforcerStop = null;

        domObserver = new MutationObserver(() => {
            tryReplaceInDoc(applies, views, jobId);
        });
        if (document.body) {
            domObserver.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
            });
        }

        // short enforcer to squash early re-hydrates (only after stats are ready)
        enforcerStop = { active: true };
        const start = performance.now();
        (function enforce(now) {
            if (!enforcerStop.active || jobId !== currentJobId) return;
            tryReplaceInDoc(applies, views, jobId);
            if (now - start < 1500) requestAnimationFrame(enforce);
            else enforcerStop.active = false;
        })(start);

        // immediate try
        tryReplaceInDoc(applies, views, jobId);

        // safety: disconnect after 15s
        setTimeout(() => {
            if (domObserver) {
                domObserver.disconnect();
                domObserver = null;
            }
        }, 15000);
    }

    function fetchStats(jobId, { priority = "high" } = {}) {
        // cancel previous in-flight fetch
        if (fetchAbort) fetchAbort.abort();
        fetchAbort = new AbortController();
        const seq = ++requestSeq;

        const deco = "com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65";
        const flavors =
            "List(TOP_APPLICANT,IN_NETWORK,COMPANY_RECRUIT,SCHOOL_RECRUIT,HIDDEN_GEM,ACTIVELY_HIRING_COMPANY)";
        const url =
            `/voyager/api/jobs/jobPostings/${jobId}` +
            `?decorationId=${deco}` +
            `&topN=1` +
            `&topNRequestedFlavors=${encodeURIComponent(flavors)}`;

        const token = getCsrfToken();
        if (!token) {
            console.warn("❌ CSRF token not found");
            return;
        }

        // hint to browser this is important; harmless if ignored
        const headers = {
            "Csrf-Token": token,
            "X-RestLi-Protocol-Version": "2.0.0",
            Accept: "application/json",
            // 'Priority': 'u=1, i' // (some browsers) – leaving commented; not needed
        };

        fetch(url, {
            credentials: "same-origin",
            signal: fetchAbort.signal,
            headers,
            // keepalive helps if user switches super fast
            keepalive: true,
            // @ts-ignore: not standard everywhere, but safe if present
            priority
        })
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then((json) => {
                // drop if job changed or a newer request finished
                if (jobId !== currentJobId || seq !== requestSeq) return;

                const applies = json.applies != null ? json.applies : "N/A";
                const views = json.views != null ? json.views : "N/A";

                // update cache, mark stats ready, inject
                setCache(jobId, applies, views);
                statsReadyForJob = jobId;
                startObserver(applies, views, jobId);
            })
            .catch((err) => {
                if (err.name === "AbortError") return;
                console.warn("❌ fetchStats error", err);
            });
    }

    // ⚡ Prefetch helpers
    function extractJobIdFromHref(href) {
        if (!href) return null;
        let m = href.match(/\/jobs\/view\/(\d+)/);
        if (m) return m[1];
        m = href.match(/[?&]currentJobId=(\d+)/);
        if (m) return m[1];
        return null;
    }

    const prefetched = new Set();
    function prefetchJob(jobId) {
        if (!jobId || prefetched.has(jobId) || cache.has(jobId)) return;
        prefetched.add(jobId);

        // lightweight prefetch: fetch without touching DOM; cache result
        const deco = "com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65";
        const flavors =
            "List(TOP_APPLICANT,IN_NETWORK,COMPANY_RECRUIT,SCHOOL_RECRUIT,HIDDEN_GEM,ACTIVELY_HIRING_COMPANY)";
        const url =
            `/voyager/api/jobs/jobPostings/${jobId}` +
            `?decorationId=${deco}` +
            `&topN=1` +
            `&topNRequestedFlavors=${encodeURIComponent(flavors)}`;

        const token = getCsrfToken();
        if (!token) return;

        fetch(url, {
            credentials: "same-origin",
            headers: {
                "Csrf-Token": token,
                "X-RestLi-Protocol-Version": "2.0.0",
                Accept: "application/json",
            },
            keepalive: true
        })
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => {
                if (!json) return;
                const applies = json.applies != null ? json.applies : "N/A";
                const views = json.views != null ? json.views : "N/A";
                setCache(jobId, applies, views);
            })
            .catch(() => {});
    }

    // Prefetch on hover/touch of job links/cards in the left rail
    function attachPrefetchListeners() {
        const handler = (evt) => {
            const a = evt.target.closest
                ? evt.target.closest('a[href*="/jobs/view/"], a[href*="currentJobId="]')
                : null;
            if (!a) return;
            const jid = extractJobIdFromHref(a.getAttribute("href"));
            if (jid) prefetchJob(jid);
        };
        document.addEventListener("mouseover", handler, { passive: true });
        document.addEventListener("touchstart", handler, { passive: true });
    }

    function onLocationChange() {
        setTimeout(() => {
            const jobId = getJobIdFromUrl();
            if (!jobId) return;

            if (jobId !== currentJobId) {
                currentJobId = jobId;
                statsReadyForJob = null;

                // 1) restore original text to avoid stale numbers
                resetInjectedText();

                // 2) if cached, inject instantly (feels instant)
                const cached = getFromCache(jobId);
                if (cached) {
                    statsReadyForJob = jobId;
                    startObserver(cached.applies, cached.views, jobId);
                    // also refresh in background to keep cache warm (no DOM write until back)
                    fetchStats(jobId, { priority: "low" });
                } else {
                    // 3) no cache → fetch now
                    fetchStats(jobId);
                }
            } else {
                // same job id, refresh (will respect seq/job guards)
                const cached = getFromCache(jobId);
                if (cached) {
                    statsReadyForJob = jobId;
                    tryReplaceInDoc(cached.applies, cached.views, jobId);
                }
                fetchStats(jobId);
            }
        }, 0); // run ASAP
    }

    // SPA hooks
    try {
        const _push = history.pushState;
        history.pushState = function () {
            const ret = _push.apply(this, arguments);
            window.dispatchEvent(new Event("locationchange"));
            return ret;
        };
        const _replace = history.replaceState;
        history.replaceState = function () {
            const ret = _replace.apply(this, arguments);
            window.dispatchEvent(new Event("locationchange"));
            return ret;
        };
    } catch {}

    window.addEventListener("popstate", () =>
        window.dispatchEvent(new Event("locationchange"))
    );
    window.addEventListener("locationchange", onLocationChange);

    // First run
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            attachPrefetchListeners();
            onLocationChange();
        }, { once: true });
    } else {
        attachPrefetchListeners();
        onLocationChange();
    }

    console.log("✅ Job Stats ready (prefetch + cache)");
})();
