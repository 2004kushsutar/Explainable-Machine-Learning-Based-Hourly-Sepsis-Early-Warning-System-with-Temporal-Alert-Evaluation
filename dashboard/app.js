"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const VITALS = {
    HR: {name: "Heart rate", short: "Heart rate", unit: "bpm", digits: 0},
    O2Sat: {name: "Oxygen saturation", short: "Oxygen saturation", unit: "%", digits: 1},
    Temp: {name: "Temperature", short: "Temperature", unit: "°C", digits: 1},
    SBP: {name: "Systolic pressure", short: "Systolic BP", unit: "mmHg", digits: 0},
    MAP: {name: "Mean arterial pressure", short: "Mean arterial BP", unit: "mmHg", digits: 0},
    DBP: {name: "Diastolic pressure", short: "Diastolic BP", unit: "mmHg", digits: 0},
    Resp: {name: "Respiratory rate", short: "Respiratory rate", unit: "/min", digits: 0},
    EtCO2: {name: "End-tidal CO₂", short: "End-tidal CO₂", unit: "mmHg", digits: 1},
  };
  const state = {
    models: [], modelId: "baseline", policyId: "exp5", patient: null, snapshot: null, hour: null,
    patientId: "p006266", generation: 0, playing: false, playTimer: null,
    activeSnapshot: null, pendingSnapshot: null, patientController: null,
    searchController: null, reviewController: null, searchTimer: null,
    hourTimer: null, review: null, retry: null, patients: [], revealedPatients: new Set(),
    studyData: null, audioEnabled: false, audioCtx: null, lastAlertHour: null,
  };
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const fmt = (value, digits = 2) => finite(value) ? value.toLocaleString(undefined, {maximumFractionDigits: digits}) : "—";
  const fixed = (value, digits = 3) => finite(value) ? value.toFixed(digits) : "—";
  const signed = (value) => finite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(3)}` : "—";
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
  const featureName = (name) => String(name).replace(/__/g, " · ").replace(/_/g, " ");
  const abort = (controller) => { if (controller) controller.abort(); };
  const isAbort = (error) => error && error.name === "AbortError";

  async function api(path, signal) {
    const response = await fetch(path, {signal, headers: {Accept: "application/json"}, cache: "no-store"});
    let payload;
    try { payload = await response.json(); }
    catch (_) { throw new Error("The local server returned an unreadable response. Check that the dashboard server is running."); }
    if (!response.ok) {
      const detail = payload.error || payload.detail || payload.message;
      throw new Error(typeof detail === "string" ? detail : detail?.message || `Request failed (${response.status}).`);
    }
    return payload;
  }

  function showError(error, retry, title = "Unable to load this record") {
    $("error-title").textContent = title;
    $("error-message").textContent = error.message || String(error);
    $("error-panel").hidden = false;
    state.retry = retry;
    $("retry-button").hidden = !retry;
    $("load-status").classList.remove("loading-text");
    $("load-status").textContent = "Replay paused. The last loaded hour has not changed.";
    pause();
  }

  function clearError() { $("error-panel").hidden = true; state.retry = null; }

  // --- Clinical Alarm Sound ---
  const alarmAudio = new Audio("/alarm.wav");

  function playAlertChime() {
    if (!state.audioEnabled) return;
    try {
      alarmAudio.currentTime = 0;
      alarmAudio.play().catch((e) => {
        console.warn("Could not play alarm audio:", e);
      });
    } catch (e) {
      console.warn("Audio play exception:", e);
    }
  }

  function toggleAudio() {
    state.audioEnabled = !state.audioEnabled;
    const btn = $("audio-toggle-btn");
    const icon = $("audio-toggle-icon");
    const label = $("audio-toggle-label");
    if (!btn) return;

    btn.setAttribute("aria-pressed", String(state.audioEnabled));
    if (state.audioEnabled) {
      if (icon) icon.textContent = "🔊";
      if (label) label.textContent = "Alert Sound: On";
      btn.style.borderColor = "var(--teal)";
      // Initialize audio context on explicit user gesture
      playAlertChime();
    } else {
      if (icon) icon.textContent = "🔇";
      if (label) label.textContent = "Alert Sound: Off";
      btn.style.borderColor = "";
    }
  }

  function controls() {
    const ready = !!state.patient;
    const desired = state.pendingSnapshot?.hour ?? state.hour;
    $("reset-button").disabled = !ready;
    $("next-button").disabled = !ready || desired >= state.patient.last_hour;
    $("play-button").disabled = !ready || (!state.playing && desired >= state.patient.last_hour);
    $("hour-range").disabled = !ready;
    $("model-select").disabled = !state.models.length || !!state.patientController;
    $("reveal-review").disabled = !state.snapshot || !!state.activeSnapshot || !!state.reviewController;
    $("play-text").textContent = state.playing ? "Pause" : "Play";
    $("play-icon").textContent = state.playing ? "Ⅱ" : "▶";
    $("play-button").setAttribute("aria-label", state.playing ? "Pause replay" : "Play hourly replay");
  }

  function pause() {
    state.playing = false;
    clearTimeout(state.playTimer);
    state.playTimer = null;
    controls();
  }

  function armPlayback() {
    clearTimeout(state.playTimer);
    if (!state.playing || state.activeSnapshot || state.pendingSnapshot || !state.patient) return;
    if (state.hour >= state.patient.last_hour) { pause(); return; }
    state.playTimer = setTimeout(() => {
      if (state.playing) requestSnapshot(state.hour + 1);
    }, Number($("speed-select").value));
  }

  function closeReview() {
    abort(state.reviewController);
    state.reviewController = null;
    state.review = null;
    $("review-panel").hidden = true;
    $("review-summary").replaceChildren();
    $("review-chart").replaceChildren();
    $("reveal-review").innerHTML = 'Reveal retrospective outcome <span aria-hidden="true">↗</span>';
    controls();
  }

  function updateReviewBadge() {
    const revealed = state.revealedPatients.has(state.patientId);
    $("prefix-badge").textContent = revealed ? "FULL RECORD REVEALED THIS SESSION" : "PAST + CURRENT HOUR ONLY";
    $("prefix-badge").classList.toggle("reviewed", revealed);
    $("prefix-badge").title = revealed ? "The replay still uses only current and past inputs. This patient's future outcome has already been revealed in this browser session." : "Outcome labels are not requested by the replay.";
  }

  function emptyLiveView() {
    state.snapshot = null;
    $("model-score").textContent = "—";
    $("model-threshold").textContent = "—";
    $("alert-status").textContent = "Waiting";
    $("alert-status").className = "pill pill-neutral";
    $("score-meter-fill").style.width = "0%";
    $("score-chart").innerHTML = '<div class="chart-empty">Loading the selected hour…</div>';
    $("vital-chart").innerHTML = '<div class="chart-empty">Loading raw measurements…</div>';
    $("vital-cards").innerHTML = Object.entries(VITALS).map(([key, v]) => `<article class="vital-card missing"><div class="vital-top"><span>${esc(v.short)}</span><span class="measurement-dot"></span></div><div class="vital-number">—<small>${esc(v.unit)}</small></div><p class="vital-caption">Waiting for this hour</p></article>`).join("");
    $("freshness-badge").textContent = "— measured";
    $("alert-count").textContent = "0";
    $("suppressed-badge").hidden = true;
    $("active-policy-tag").textContent = state.policyId === "exp5" ? "Exp 5 (2-of-3h)" : "Baseline (1h)";
    $("policy-suppression-tag").textContent = "0 alarms filtered";
    $("policy-suppression-tag").className = "pill pill-neutral";
    $("alert-history").innerHTML = '<div class="empty-state"><span aria-hidden="true">◌</span><p>No replay hours loaded yet.</p></div>';
    ["shap-positive", "shap-negative"].forEach((id) => { $(id).innerHTML = '<p class="small muted">Waiting for an explanation…</p>'; });
    ["shap-base", "shap-total", "shap-margin"].forEach((id) => { $(id).textContent = "—"; });
    $("feature-table").replaceChildren();
    $("feature-filter-status").textContent = "";
    $("all-features-label").textContent = "View every feature contribution";
    $("download-shap").disabled = true;
    $("measurement-table").innerHTML = '<tr><td colspan="5" class="table-empty">Loading measurements…</td></tr>';
    $("replay-content").setAttribute("aria-busy", "true");
    updateReviewBadge();
    controls();
  }

  async function loadModels() {
    const result = await api("/api/models");
    if (!Array.isArray(result.models) || !result.models.length) throw new Error("No saved research models are available.");
    state.models = result.models;
    if (!state.models.some((model) => model.id === state.modelId)) state.modelId = state.models[0].id;
    $("model-select").replaceChildren(...state.models.map((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = `${model.name || model.label || model.id} · ${model.feature_count} features`;
      return option;
    }));
    $("model-select").value = state.modelId;
    updateModelDetails();
    controls();
  }

  function updateModelDetails() {
    const model = state.models.find((item) => item.id === state.modelId);
    $("model-details").textContent = model?.description || "Frozen model · uncalibrated score";
  }

  function renderPatientList() {
    $("patient-list").replaceChildren(...state.patients.map((patient) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `patient-item${patient.patient_id === state.patientId ? " active" : ""}`;
      button.setAttribute("aria-pressed", String(patient.patient_id === state.patientId));
      button.innerHTML = `<span><span class="patient-dot" aria-hidden="true"></span>${esc(patient.patient_id)}</span><span class="source-tag">SET ${esc(patient.dataset)}</span>`;
      button.addEventListener("click", () => loadPatient(patient.patient_id));
      return button;
    }));
  }

  async function searchPatients() {
    abort(state.searchController);
    const controller = new AbortController();
    state.searchController = controller;
    const query = $("patient-search").value.trim();
    $("patient-search-status").textContent = "Searching records…";
    try {
      const result = await api(`/api/patients?${new URLSearchParams({query, limit: "50"})}`, controller.signal);
      if (state.searchController !== controller) return;
      state.patients = Array.isArray(result.patients) ? result.patients : [];
      renderPatientList();
      $("patient-search-status").textContent = state.patients.length ? `${state.patients.length} records shown${state.patients.length === 50 ? " · refine search for more" : ""}` : "No matching patient IDs.";
    } catch (error) {
      if (!isAbort(error) && state.searchController === controller) {
        $("patient-search-status").textContent = `Patient search unavailable: ${error.message}`;
      }
    } finally { if (state.searchController === controller) state.searchController = null; }
  }

  async function loadPatient(patientId) {
    pause();
    clearTimeout(state.hourTimer);
    abort(state.patientController);
    abort(state.activeSnapshot?.controller);
    closeReview();
    const generation = ++state.generation;
    state.pendingSnapshot = null;
    state.patient = null;
    state.patientId = patientId;
    state.hour = null;
    clearError();
    emptyLiveView();
    renderPatientList();
    $("patient-title").textContent = patientId;
    $("patient-context").textContent = "Loading the recorded ICU timeline…";
    $("selected-hour").textContent = "—";
    $("replay-bounds").textContent = "—";
    $("load-status").classList.add("loading-text");
    $("load-status").textContent = "Loading the patient record…";
    const controller = new AbortController();
    state.patientController = controller;
    controls();
    try {
      const info = await api(`/api/patient?${new URLSearchParams({patient_id: patientId})}`, controller.signal);
      if (generation !== state.generation) return;
      if (info.patient_id !== patientId || !Number.isInteger(info.first_hour) || !Number.isInteger(info.last_hour) || info.last_hour < info.first_hour) throw new Error("The patient record has invalid replay bounds.");
      state.patient = info;
      state.hour = info.first_hour;
      const demographics = [`Dataset ${info.dataset}`];
      if (finite(info.age)) demographics.push(`Age ${fmt(info.age, 0)}`);
      if (info.gender === 0 || info.gender === 1) demographics.push(info.gender === 0 ? "Female" : "Male");
      $("patient-context").textContent = demographics.join("  ·  ");
      $("hour-range").min = info.first_hour;
      $("hour-range").max = info.last_hour;
      $("hour-range").value = info.first_hour;
      $("replay-bounds").textContent = `Recorded hours ${info.first_hour}–${info.last_hour}`;
      controls();
      requestSnapshot(info.first_hour);
    } catch (error) {
      if (!isAbort(error) && generation === state.generation) {
        $("patient-context").textContent = "Record unavailable";
        $("replay-content").setAttribute("aria-busy", "false");
        showError(error, () => loadPatient(patientId), "Patient record could not be opened");
      }
    } finally { if (state.patientController === controller) state.patientController = null; controls(); }
  }

  function requestSnapshot(hour, force = false) {
    if (!state.patient) return;
    const requested = Math.max(state.patient.first_hour, Math.min(state.patient.last_hour, Math.round(hour)));
    if (!force && state.snapshot?.hour === requested && state.snapshot?.comparison?.active_policy === state.policyId && !state.activeSnapshot && !state.pendingSnapshot) { armPlayback(); return; }
    if (state.snapshot && (force || requested < state.snapshot.hour)) emptyLiveView();
    if (state.activeSnapshot?.generation === state.generation && state.activeSnapshot.hour === requested && state.activeSnapshot.policyId === state.policyId && !force) {
      state.pendingSnapshot = null;
      $("hour-range").value = requested;
      $("selected-hour").textContent = requested;
      controls();
      return;
    }
    state.pendingSnapshot = {hour: requested, generation: state.generation, patientId: state.patientId, modelId: state.modelId, policyId: state.policyId};
    $("hour-range").value = requested;
    $("selected-hour").textContent = requested;
    controls();
    drainSnapshots();
  }

  function validateSnapshot(snapshot, request) {
    if (snapshot.patient_id !== request.patientId || snapshot.hour !== request.hour || snapshot.model?.id !== request.modelId) throw new Error("The replay response does not match the selected patient, model and hour.");
    if (!finite(snapshot.model_score) || snapshot.model_score < 0 || snapshot.model_score > 1 || !finite(snapshot.threshold)) throw new Error("The selected hour has an invalid model score or threshold.");
    for (const key of ["history", "score_history", "alerts"]) {
      if (!Array.isArray(snapshot[key]) || snapshot[key].some((row) => !finite(row.hour) || row.hour > snapshot.hour)) throw new Error("The replay response contains an invalid or future timeline entry.");
    }
    if (!Array.isArray(snapshot.measurements) || snapshot.measurements.some((item) => finite(item.last_observed_hour) && item.last_observed_hour > snapshot.hour)) throw new Error("The replay response contains invalid measurement timing.");
    if (!Array.isArray(snapshot.shap?.features)) throw new Error("The selected hour has no feature explanation.");
  }

  async function drainSnapshots() {
    if (state.activeSnapshot || !state.pendingSnapshot) return;
    const request = state.pendingSnapshot;
    state.pendingSnapshot = null;
    if (request.generation !== state.generation) { drainSnapshots(); return; }
    request.controller = new AbortController();
    state.activeSnapshot = request;
    $("replay-content").setAttribute("aria-busy", "true");
    $("load-status").textContent = `Loading hour ${request.hour}…${state.snapshot ? ` showing loaded hour ${state.snapshot.hour} until ready.` : ""}`;
    $("load-status").classList.add("loading-text");
    controls();
    try {
      const snapshot = await api(`/api/snapshot?${new URLSearchParams({patient_id: request.patientId, hour: String(request.hour), model: request.modelId, policy: state.policyId})}`, request.controller.signal);
      if (request.generation !== state.generation) return;
      validateSnapshot(snapshot, request);
      // A newer slider/button request replaces the display target. Complete
      // this request before starting it, but never paint a stale intermediate
      // response (especially a later hour while the user is rewinding).
      if (state.pendingSnapshot) return;
      state.snapshot = snapshot;
      state.hour = snapshot.hour;
      clearError();
      renderSnapshot();
      $("load-status").textContent = `Hour ${snapshot.hour} loaded · ${fmt(snapshot.prefix_rows, 0)} recorded hours available to the model`;
    } catch (error) {
      if (!isAbort(error) && request.generation === state.generation) {
        state.pendingSnapshot = null;
        showError(error, () => requestSnapshot(request.hour), "This replay hour could not be loaded");
      }
    } finally {
      if (state.activeSnapshot === request) state.activeSnapshot = null;
      if (request.generation === state.generation) {
        $("replay-content").setAttribute("aria-busy", "false");
        $("load-status").classList.remove("loading-text");
      }
      controls();
      if (state.pendingSnapshot) drainSnapshots(); else armPlayback();
    }
  }

  function renderSnapshot() {
    const s = state.snapshot;
    updateReviewBadge();
    $("selected-hour").textContent = state.pendingSnapshot?.hour ?? s.hour;
    $("hour-range").value = state.pendingSnapshot?.hour ?? s.hour;
    $("model-score").textContent = fixed(s.model_score);
    $("model-threshold").textContent = fixed(s.threshold);
    $("alert-status").textContent = s.alert ? "Above threshold" : "Below threshold";
    $("alert-status").className = `pill ${s.alert ? "pill-alert" : "pill-calm"}`;
    $("score-meter-fill").style.width = `${100 * s.model_score}%`;
    $("score-meter-fill").className = s.alert ? "above" : "";
    $("threshold-marker").style.left = `${100 * Math.max(0, Math.min(1, s.threshold))}%`;
    $("threshold-marker").title = `Frozen threshold ${fixed(s.threshold)}`;

    // Policy comparison updates
    const activePolicy = state.policyId === "exp5" ? "Exp 5 (2-of-3h Confirmation)" : "Baseline (1h Immediate)";
    const suppressed = s.comparison?.difference?.suppressed_alert_hours ?? s.comparison?.suppressed_alert_hours ?? 0;
    $("active-policy-tag").textContent = activePolicy;
    if (state.policyId === "exp5") {
      $("policy-suppression-tag").textContent = `${suppressed} alarm${suppressed === 1 ? "" : "s"} filtered`;
      $("policy-suppression-tag").className = `pill ${suppressed > 0 ? "pill-positive" : "pill-neutral"}`;
      $("policy-suppression-tag").title = `${suppressed} transient isolated threshold excursions suppressed by confirmation window`;
    } else {
      $("policy-suppression-tag").textContent = "Immediate 1h Alerting";
      $("policy-suppression-tag").className = "pill pill-neutral";
      $("policy-suppression-tag").title = "Alerts on any single-hour threshold excursion";
    }

    // Trigger clinical alarm chime if active alert occurs at this hour
    if (s.alert && state.lastAlertHour !== s.hour) {
      playAlertChime();
      state.lastAlertHour = s.hour;
    } else if (!s.alert) {
      state.lastAlertHour = null;
    }

    renderChart($("score-chart"), s.score_history, "model_score", {score: true, threshold: s.threshold, title: `Uncalibrated model scores through ICU hour ${s.hour}`});
    renderVitals();
    renderVitalChart();
    renderAlerts();
    renderShap();
    renderMeasurements();
    controls();
  }

  function renderVitals() {
    const s = state.snapshot;
    let observed = 0;
    $("vital-cards").innerHTML = Object.entries(VITALS).map(([key, v]) => {
      const value = s.current_vitals?.[key];
      const measured = finite(value);
      if (measured) observed++;
      const provenance = s.measurements.find((item) => item.feature === key);
      const caption = measured ? `Recorded at hour ${s.hour}` : finite(provenance?.last_observed_hour) ? `Last recorded: hour ${provenance.last_observed_hour}` : "No observation yet";
      return `<article class="vital-card${measured ? "" : " missing"}" aria-label="${esc(v.name)}: ${measured ? `${fmt(value, v.digits)} ${esc(v.unit)}, recorded this hour` : "not measured this hour"}"><div class="vital-top"><span>${esc(v.short)}</span><span class="measurement-dot" aria-hidden="true"></span></div><div class="vital-number">${measured ? fmt(value, v.digits) : "—"}<small>${esc(v.unit)}</small></div><p class="vital-caption" title="${esc(caption)}">${esc(caption)}</p></article>`;
    }).join("");
    $("freshness-badge").textContent = `${observed} / ${Object.keys(VITALS).length} measured this hour`;
    $("freshness-badge").className = `pill ${observed ? "pill-calm" : "pill-neutral"}`;
  }

  function renderVitalChart() {
    if (!state.snapshot) return;
    const key = $("vital-select").value;
    renderChart($("vital-chart"), state.snapshot.history, key, {unit: VITALS[key].unit, title: `${VITALS[key].name}, raw recorded measurements through ICU hour ${state.hour}`});
  }

  function renderChart(container, rows, key, options = {}) {
    if (!rows.length) { container.innerHTML = '<div class="chart-empty">No recorded history is available yet.</div>'; return; }
    const W = 720, H = 220, L = 51, R = 19, T = 19, B = 35;
    const data = rows.map((row) => ({hour: row.hour, value: row[key], label: row.label})).filter((row) => finite(row.hour));
    const available = data.filter((row) => finite(row.value));
    const hours = data.map((row) => row.hour);
    if (!available.length || !hours.length) { container.innerHTML = '<div class="chart-empty">No measurements recorded through this hour.</div>'; return; }
    const first = Math.min(...hours), last = Math.max(...hours);
    const values = available.map((row) => row.value);
    let low = options.score ? 0 : Math.min(...values), high = options.score ? 1 : Math.max(...values);
    if (!options.score) { const pad = high === low ? Math.max(1, Math.abs(high) * .04) : (high - low) * .17; low -= pad; high += pad; }
    const x = (hour) => first === last ? (L + W - R) / 2 : L + (hour - first) * (W - L - R) / (last - first);
    const y = (value) => H - B - (value - low) * (H - T - B) / (high - low);
    const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(options.title || "Hourly timeline")}"><title>${esc(options.title || "Hourly timeline")}</title>`];
    if (options.review) {
      data.filter((row) => row.label === 1).forEach((row) => {
        const width = first === last ? W - L - R : (W - L - R) / (last - first);
        const left = Math.max(L, x(row.hour) - width / 2);
        parts.push(`<rect x="${left}" y="${T}" width="${Math.max(0, Math.min(W - R, x(row.hour) + width / 2) - left)}" height="${H - T - B}" fill="#f6d8c6" opacity=".48"/>`);
      });
    }
    for (let i = 0; i <= 4; i++) {
      const value = low + (high - low) * i / 4, yy = y(value);
      parts.push(`<line x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}" stroke="#e9eff3" stroke-width="1"/><text class="chart-axis" x="${L - 10}" y="${yy + 3}" text-anchor="end">${esc(options.score ? value.toFixed(2) : fmt(value, 1))}</text>`);
    }
    const ticks = [...new Set(Array.from({length: first === last ? 1 : 5}, (_, i) => Math.round(first + (last - first) * i / 4)))];
    ticks.forEach((hour) => parts.push(`<text class="chart-axis" x="${x(hour)}" y="${H - B + 19}" text-anchor="middle">${hour}</text>`));
    parts.push(`<text class="chart-unit" x="${W - R}" y="${H - 1}" text-anchor="end">ICU hour</text>`);
    if (options.unit) parts.push(`<text class="chart-unit" x="${L}" y="10">${esc(options.unit)}</text>`);
    if (finite(options.threshold)) {
      parts.push(`<line x1="${L}" y1="${y(options.threshold)}" x2="${W - R}" y2="${y(options.threshold)}" stroke="#b88a7a" stroke-width="1.2" stroke-dasharray="5 4"/><text class="chart-unit" x="${W - R - 4}" y="${Math.max(T + 9, y(options.threshold) - 6)}" text-anchor="end" fill="#a97e6c">threshold ${fixed(options.threshold)}</text>`);
    }
    let path = "", segment = false, previousHour = null;
    data.forEach((row) => {
      if (!finite(row.value)) { segment = false; previousHour = row.hour; return; }
      if (previousHour !== null && row.hour - previousHour !== 1) segment = false;
      path += `${segment ? "L" : "M"}${x(row.hour).toFixed(2)},${y(row.value).toFixed(2)} `;
      segment = true;
      previousHour = row.hour;
    });
    if (options.score && available.length === data.length && first !== last) {
      parts.push(`<path d="${path} L${x(last)},${y(0)} L${x(first)},${y(0)} Z" fill="#e5f3ef" opacity=".65"/>`);
    }
    parts.push(`<path d="${path}" fill="none" stroke="#168d86" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`);
    available.forEach((row, index) => {
      const isLast = index === available.length - 1;
      parts.push(`<circle cx="${x(row.hour)}" cy="${y(row.value)}" r="${isLast ? 3.5 : options.score ? 1.6 : 2.2}" fill="#168d86"${isLast ? ' stroke="white" stroke-width="1.7"' : ""}><title>Hour ${row.hour}: ${esc(options.score ? fixed(row.value) : `${fmt(row.value, 2)} ${options.unit || ""}`)}</title></circle>`);
    });
    if (finite(options.onset) && options.onset >= first && options.onset <= last) {
      parts.push(`<line x1="${x(options.onset)}" y1="${T}" x2="${x(options.onset)}" y2="${H - B}" stroke="#a65d44" stroke-width="1.3" stroke-dasharray="3 3"/><text class="chart-unit" x="${Math.min(W - R - 75, x(options.onset) + 5)}" y="${T + 11}">inferred onset</text>`);
    }
    parts.push("</svg>");
    container.innerHTML = parts.join("");
  }

  function renderAlerts() {
    const alerts = [...state.snapshot.alerts].sort((a, b) => b.hour - a.hour);
    $("alert-count").textContent = String(alerts.length);
    const suppressed = state.snapshot.comparison?.difference?.suppressed_alert_hours ?? state.snapshot.comparison?.suppressed_alert_hours ?? 0;
    if (state.policyId === "exp5" && suppressed > 0) {
      $("suppressed-badge").hidden = false;
      $("suppressed-badge").textContent = `${suppressed} filtered`;
      $("suppressed-badge").title = `${suppressed} isolated transient spike${suppressed === 1 ? "" : "s"} filtered by Exp 5 confirmation policy`;
    } else {
      $("suppressed-badge").hidden = true;
    }
    $("alert-history").innerHTML = alerts.length ? alerts.map((item) => `<div class="alert-row"><div class="alert-row-main"><span class="alert-event-dot${item.episode_start ? " new" : ""}" aria-hidden="true"></span><div><strong>Hour ${fmt(item.hour, 0)}</strong><p>${item.episode_start ? "New alert episode" : "Continued threshold alert"}</p></div></div><span class="alert-row-score" title="Uncalibrated model score">${fixed(item.model_score)}</span></div>`).join("") : '<div class="empty-state"><span aria-hidden="true">◌</span><p>No threshold alerts through this hour.</p></div>';
  }

  function shapFeatures() {
    return [...(state.snapshot?.shap?.features || [])].sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value));
  }

  function renderShap() {
    const shap = state.snapshot.shap;
    const features = shapFeatures();
    const scale = Math.max(...features.map((item) => Math.abs(item.shap_value)), .000001);
    for (const direction of ["positive", "negative"]) {
      const selected = features.filter((item) => direction === "positive" ? item.shap_value > 0 : item.shap_value < 0).slice(0, 5);
      $(`shap-${direction}`).innerHTML = selected.length ? selected.map((item) => `<div class="shap-bar-row"><div class="shap-bar-caption"><span class="shap-feature" title="${esc(item.feature)}">${esc(featureName(item.feature))}</span><strong class="${direction}-text">${signed(item.shap_value)}</strong></div><div class="shap-bar-track ${direction}" aria-hidden="true"><span style="width:${100 * Math.abs(item.shap_value) / scale}%"></span></div></div>`).join("") : '<p class="small muted">No contributions in this direction.</p>';
    }
    $("shap-base").textContent = signed(shap.base_value);
    $("shap-total").textContent = signed(features.reduce((sum, item) => sum + item.shap_value, 0));
    $("shap-margin").textContent = signed(shap.margin);
    $("all-features-label").textContent = `View all ${features.length} feature contributions`;
    $("download-shap").disabled = false;
    renderFeatureTable();
  }

  function renderFeatureTable() {
    const all = shapFeatures();
    const query = $("feature-search").value.trim().toLowerCase();
    const features = all.filter((item) => item.feature.toLowerCase().includes(query));
    $("feature-table").innerHTML = features.length ? features.map((item) => {
      const direction = item.shap_value > 0 ? "positive" : item.shap_value < 0 ? "negative" : "neutral";
      return `<tr><td title="${esc(item.feature)}">${esc(item.feature)}</td><td class="numeric">${fmt(item.feature_value, 5)}</td><td class="numeric ${direction}-text">${signed(item.shap_value)}</td><td><span class="source-label">${direction === "positive" ? "Raises score" : direction === "negative" ? "Lowers score" : "Zero contribution"}</span></td></tr>`;
    }).join("") : '<tr><td colspan="4" class="table-empty">No matching features.</td></tr>';
    $("feature-filter-status").textContent = `${features.length} of ${all.length} features shown · download always includes every feature, including zeros.`;
  }

  function renderMeasurements() {
    if (!state.snapshot) return;
    const filter = $("measurement-filter").value;
    const labKeys = new Set(Object.keys(state.snapshot.current_labs || {}));
    const measurements = state.snapshot.measurements.filter((item) => filter === "all" || (filter === "vitals" && item.feature in VITALS) || (filter === "labs" && labKeys.has(item.feature)) || (filter === "missing" && !finite(item.raw_value)));
    $("measurement-table").innerHTML = measurements.length ? measurements.map((item) => {
      const source = item.source === "observed" ? ["Observed this hour", "observed"] : item.source === "forward_filled" ? ["Carried forward", "carried"] : item.source === "training_imputed" ? ["Training-data fill", "filled"] : ["Unavailable", ""];
      const excluded = item.included_in_model === false;
      const last = finite(item.last_observed_hour) ? `Hour ${fmt(item.last_observed_hour, 0)}${finite(item.hours_since_observed) && item.hours_since_observed > 0 ? ` · ${fmt(item.hours_since_observed, 0)}h ago` : ""}` : "Not yet observed";
      return `<tr><td class="measurement-name">${esc(item.feature)}<small>${esc(item.unit || "")}</small></td><td class="numeric">${fmt(item.raw_value, 3)}</td><td class="numeric">${excluded ? '<span class="muted">Excluded</span>' : fmt(item.model_value, 3)}</td><td><span class="source-label ${excluded ? "" : source[1]}">${excluded ? "Not a model input" : source[0]}</span></td><td>${esc(last)}</td></tr>`;
    }).join("") : '<tr><td colspan="5" class="table-empty">No measurements match this filter.</td></tr>';
  }

  function downloadShap() {
    if (!state.snapshot) return;
    const link = document.createElement("a");
    link.href = `/api/shap.csv?${new URLSearchParams({patient_id: state.patientId, hour: String(state.hour), model: state.modelId})}`;
    link.download = `${state.patientId}_hour_${state.hour}_${state.modelId}_all_SHAP.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function revealReview() {
    if (!state.snapshot || state.reviewController) return;
    if (state.review) { closeReview(); return; }
    pause();
    const generation = state.generation;
    const controller = new AbortController();
    state.reviewController = controller;
    $("reveal-review").textContent = "Loading full-record review…";
    controls();
    try {
      // Future labels are intentionally requested only in this explicit action.
      const review = await api(`/api/review?${new URLSearchParams({patient_id: state.patientId, model: state.modelId})}`, controller.signal);
      if (generation !== state.generation || state.reviewController !== controller) return;
      if (review.patient_id !== state.patientId || review.model_id !== state.modelId || review.mode !== "retrospective_review") throw new Error("The retrospective review does not match this patient and model.");
      state.review = review;
      state.revealedPatients.add(state.patientId);
      updateReviewBadge();
      renderReview(review);
      $("review-panel").hidden = false;
      $("reveal-review").textContent = "Hide retrospective outcome";
      $("review-panel").scrollIntoView({behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start"});
    } catch (error) {
      if (!isAbort(error) && generation === state.generation) {
        showError(error, revealReview, "Retrospective outcome could not be loaded");
        $("reveal-review").textContent = "Reveal retrospective outcome";
      }
    } finally { if (state.reviewController === controller) state.reviewController = null; controls(); }
  }

  function renderReview(review) {
    const s = review.summary;
    const known = s.onset_status === "known_transition";
    const leftCensored = s.onset_status === "left_censored";
    const outcome = known || leftCensored ? "Positive label recorded" : "No positive label recorded";
    const onset = known ? `Hour ${fmt(s.inferred_onset_hour, 0)}` : leftCensored ? "Unknown" : "Not applicable";
    const warning = s.primary_evaluable ? s.primary_detected ? "Qualifying warning" : "No qualifying warning" : "Not evaluable";
    const lead = s.primary_detected && finite(s.first_useful_alert_lead_hours) ? `${fmt(s.first_useful_alert_lead_hours, 0)} hours` : "—";
    const metrics = [
      ["RECORDED OUTCOME", outcome, "Saved dataset labels"],
      ["INFERRED ONSET", onset, leftCensored ? "Positive label at the first recorded hour" : known ? "First positive label + 6 hours" : "Within the recorded timeline"],
      ["6–12H WARNING WINDOW", warning, finite(s.warning_window_start) && finite(s.warning_window_end) ? `ICU hours ${s.warning_window_start}–${s.warning_window_end}` : "An observed label transition is required"],
      ["FIRST USEFUL WARNING LEAD", lead, "Within the defined warning window"],
    ];
    $("review-summary").innerHTML = metrics.map(([label, value, note]) => `<div class="review-metric"><div class="metric-label">${esc(label)}</div><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("");

    if (review.comparison) {
      const b = review.comparison.baseline;
      const e = review.comparison.exp5;
      $("rev-base-warning").textContent = b.primary_detected ? "Qualifying warning" : "No qualifying warning";
      $("rev-base-warning").className = b.primary_detected ? "text-positive" : "muted";
      $("rev-base-first").textContent = finite(b.first_alert_hour) ? `Hour ${b.first_alert_hour}` : "None";
      $("rev-base-lead").textContent = finite(b.useful_lead_hours) ? `${fmt(b.useful_lead_hours, 0)} hours` : "—";
      $("rev-base-alerts").textContent = `${b.total_alerts} hours`;
      $("rev-base-episodes").textContent = `${b.alert_episodes} episode${b.alert_episodes === 1 ? "" : "s"}`;

      $("rev-exp5-warning").textContent = e.primary_detected ? "Qualifying warning" : "No qualifying warning";
      $("rev-exp5-warning").className = e.primary_detected ? "text-positive" : "muted";
      $("rev-exp5-first").textContent = finite(e.first_alert_hour) ? `Hour ${e.first_alert_hour}` : "None";
      $("rev-exp5-lead").textContent = finite(e.useful_lead_hours) ? `${fmt(e.useful_lead_hours, 0)} hours` : "—";
      $("rev-exp5-alerts").textContent = `${e.total_alerts} hours`;
      $("rev-exp5-episodes").textContent = `${e.alert_episodes} episode${e.alert_episodes === 1 ? "" : "s"}`;

      const suppressedHours = Math.max(0, b.total_alerts - e.total_alerts);
      const suppressedEpisodes = Math.max(0, b.alert_episodes - e.alert_episodes);
      let takeaway = "";
      if (known || leftCensored) {
        if (e.primary_detected && b.primary_detected) {
          takeaway = `<strong>Clinical Agreement:</strong> Both policies captured the early warning window for this patient. Experiment 5 provided <strong>${fmt(e.useful_lead_hours, 0)}h lead time</strong> while filtering ${suppressedHours} redundant alert hour(s) and ${suppressedEpisodes} fragmented episode(s).`;
        } else if (b.primary_detected && !e.primary_detected) {
          takeaway = `<strong>Trade-off Observed:</strong> Baseline triggered at hour ${b.first_alert_hour}, but scores fluctuated before the 2-hour sustained threshold required by Experiment 5 could confirm.`;
        } else {
          takeaway = `Neither policy triggered an alert within the primary 6–12h warning window for this patient.`;
        }
      } else {
        if (suppressedHours > 0 || suppressedEpisodes > 0) {
          takeaway = `<strong>False Alarm Reduction:</strong> This is a non-sepsis patient. Baseline fired ${b.total_alerts} alert hour(s) across ${b.alert_episodes} episode(s). Experiment 5 successfully eliminated <strong>${suppressedHours} false alert hour(s)</strong> and <strong>${suppressedEpisodes} false alert episode(s)</strong>, sparing clinical staff from alarm fatigue.`;
        } else if (e.total_alerts === 0 && b.total_alerts === 0) {
          takeaway = `<strong>Clean Non-Sepsis Record:</strong> Neither Baseline nor Experiment 5 triggered any false alarms on this patient.`;
        } else {
          takeaway = `Both policies sustained alerts above threshold on this non-septic patient (${e.total_alerts} hours under Exp 5 vs ${b.total_alerts} under Baseline).`;
        }
      }
      $("rev-comparison-takeaway").innerHTML = takeaway;
    }

    renderChart($("review-chart"), review.timeline, "model_score", {score: true, threshold: review.threshold, review: true, onset: known ? s.inferred_onset_hour : null, title: "Full retrospective record: model scores and positive-label periods"});
    const notes = ["Shaded periods have SepsisLabel = 1. Dataset labels begin six hours before the inferred onset and remain positive afterward."];
    if (leftCensored) notes.push("Onset is unknown because the first recorded label is already positive; this patient is excluded from the primary early-warning calculation.");
    else if (s.primary_evaluable && !s.warning_window_complete) notes.push("Only part of the 6–12-hour warning window is recorded; the primary result uses the available portion.");
    if (s.onset_after_record_end) notes.push("The inferred onset is beyond the end of the available record.");
    notes.push("A qualifying warning is any alert within that window, even if an earlier alert also occurred. This is a retrospective research measure, not a clinical outcome assessment.");
    $("review-note").textContent = notes.join(" ");
  }

  function renderStudyTable(data) {
    const m = data?.bootstrap_results?.metrics;
    if (!m) return;
    const rows = [
      {
        name: "Non-Sepsis False Alarm Rate (fraction)",
        b: m.nonseptic_false_alarm_rate?.baseline,
        e: m.nonseptic_false_alarm_rate?.exp5,
        diff: m.nonseptic_false_alarm_rate?.difference,
        rel: "−42.2%",
        fmtVal: (v) => `${(v * 100).toFixed(2)}%`,
        highlight: "positive",
      },
      {
        name: "Non-Sepsis Alert Episodes (per 100 ICU hours)",
        b: m.nonseptic_alert_episodes_per_100_hours?.baseline,
        e: m.nonseptic_alert_episodes_per_100_hours?.exp5,
        diff: m.nonseptic_alert_episodes_per_100_hours?.difference,
        rel: "−57.5%",
        fmtVal: (v) => v.toFixed(3),
        highlight: "positive",
      },
      {
        name: "Primary Warning Sensitivity (6–12h Window)",
        b: m.primary_sensitivity_6_12h?.baseline,
        e: m.primary_sensitivity_6_12h?.exp5,
        diff: m.primary_sensitivity_6_12h?.difference,
        rel: "−14.8%",
        fmtVal: (v) => `${(v * 100).toFixed(2)}%`,
        highlight: "neutral",
      },
      {
        name: "Strict Early Sensitivity (6–12h Window)",
        b: m.strict_sensitivity_6_12h?.baseline,
        e: m.strict_sensitivity_6_12h?.exp5,
        diff: m.strict_sensitivity_6_12h?.difference,
        rel: "−14.9%",
        fmtVal: (v) => `${(v * 100).toFixed(2)}%`,
        highlight: "neutral",
      },
      {
        name: "Median Warning Lead Time (detected patients)",
        b: m.median_warning_lead_hours?.baseline,
        e: m.median_warning_lead_hours?.exp5,
        diff: m.median_warning_lead_hours?.difference,
        rel: "0.0% (Preserved)",
        fmtVal: (v) => `${v.toFixed(1)}h`,
        highlight: "positive",
      },
      {
        name: "PhysioNet CinC 2019 Utility Score",
        b: m.physionet_utility?.baseline,
        e: m.physionet_utility?.exp5,
        diff: m.physionet_utility?.difference,
        rel: "−4.7%",
        fmtVal: (v) => v.toFixed(3),
        highlight: "neutral",
      },
    ];

    $("study-table-body").innerHTML = rows.map((r) => {
      const bText = r.b ? `${r.fmtVal(r.b.point_estimate)} <small class="muted">[${r.fmtVal(r.b.ci_lower)}, ${r.fmtVal(r.b.ci_upper)}]</small>` : "—";
      const eText = r.e ? `${r.fmtVal(r.e.point_estimate)} <small class="muted">[${r.fmtVal(r.e.ci_lower)}, ${r.fmtVal(r.e.ci_upper)}]</small>` : "—";
      const dText = r.diff ? `${r.diff.point_estimate > 0 ? "+" : ""}${r.fmtVal(r.diff.point_estimate)} <small class="muted">[${r.fmtVal(r.diff.ci_lower)}, ${r.fmtVal(r.diff.ci_upper)}]</small>` : "—";
      const relClass = r.highlight === "positive" ? "text-positive" : "text-neutral";
      return `<tr>
        <td><strong>${esc(r.name)}</strong></td>
        <td>${bText}</td>
        <td><strong>${eText}</strong></td>
        <td>${dText}</td>
        <td><strong class="${relClass}">${esc(r.rel)}</strong></td>
      </tr>`;
    }).join("");
  }

  async function openStudyModal() {
    $("study-modal").hidden = false;
    if (!state.studyData) {
      try {
        const data = await api("/api/study");
        state.studyData = data;
        renderStudyTable(data);
      } catch (err) {
        $("study-table-body").innerHTML = `<tr><td colspan="5" class="table-empty">Failed to load comparative study metrics: ${esc(err.message)}</td></tr>`;
      }
    }
  }

  function closeStudyModal() {
    $("study-modal").hidden = true;
  }

  $("policy-select").addEventListener("change", () => {
    state.policyId = $("policy-select").value;
    $("policy-details").textContent = state.policyId === "exp5" ? "2 of 3h ≥ threshold" : "1h ≥ threshold";
    if (state.patient && state.hour !== null) {
      abort(state.activeSnapshot?.controller);
      state.activeSnapshot = null;
      requestSnapshot(state.hour, true);
    }
  });
  $("study-modal-btn").addEventListener("click", openStudyModal);
  $("audio-toggle-btn")?.addEventListener("click", toggleAudio);
  $("close-study-modal").addEventListener("click", closeStudyModal);
  $("dismiss-study-modal").addEventListener("click", closeStudyModal);
  $("study-modal").addEventListener("click", (e) => {
    if (e.target === $("study-modal")) closeStudyModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("study-modal").hidden) closeStudyModal();
  });

  $("patient-search").addEventListener("input", () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(searchPatients, 230); });
  $("model-select").addEventListener("change", () => {
    const hour = state.hour;
    pause();
    clearTimeout(state.hourTimer);
    abort(state.activeSnapshot?.controller);
    closeReview();
    state.generation++;
    state.pendingSnapshot = null;
    state.modelId = $("model-select").value;
    updateModelDetails();
    clearError();
    emptyLiveView();
    if (state.patient) requestSnapshot(hour ?? state.patient.first_hour);
  });
  $("play-button").addEventListener("click", () => {
    clearTimeout(state.hourTimer);
    if (state.playing) { pause(); return; }
    if (!state.patient || state.hour >= state.patient.last_hour) return;
    closeReview();
    state.playing = true;
    controls();
    if (!state.activeSnapshot && !state.pendingSnapshot) requestSnapshot(state.hour + 1);
  });
  $("next-button").addEventListener("click", () => { clearTimeout(state.hourTimer); pause(); requestSnapshot((state.pendingSnapshot?.hour ?? state.activeSnapshot?.hour ?? state.hour) + 1); });
  $("reset-button").addEventListener("click", () => { clearTimeout(state.hourTimer); pause(); closeReview(); requestSnapshot(state.patient.first_hour); });
  $("hour-range").addEventListener("input", () => {
    pause();
    const hour = Number($("hour-range").value);
    $("selected-hour").textContent = hour;
    clearTimeout(state.hourTimer);
    state.hourTimer = setTimeout(() => requestSnapshot(hour), 110);
  });
  $("speed-select").addEventListener("change", armPlayback);
  $("vital-select").addEventListener("change", renderVitalChart);
  $("feature-search").addEventListener("input", renderFeatureTable);
  $("measurement-filter").addEventListener("change", renderMeasurements);
  $("download-shap").addEventListener("click", downloadShap);
  $("reveal-review").addEventListener("click", revealReview);
  $("close-review").addEventListener("click", closeReview);
  $("retry-button").addEventListener("click", () => { const retry = state.retry; clearError(); if (retry) retry(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
  window.addEventListener("beforeunload", () => {
    pause(); abort(state.activeSnapshot?.controller); abort(state.patientController); abort(state.searchController); abort(state.reviewController);
  });

  /* ==========================================================================
     Manual Patient Assessment Feature Implementation
     ========================================================================== */
  const RANGES = {
    Age: [0, 120, "years"],
    Gender: [0, 1, "0=Female, 1=Male"],
    Unit1: [0, 1, "0 or 1"],
    Unit2: [0, 1, "0 or 1"],
    HospAdmTime: [-10000, 240, "hours"],
    ICULOS: [1, 2000, "hours"],
    HR: [20, 300, "bpm"],
    O2Sat: [20, 100, "%"],
    Temp: [20, 48, "°C"],
    SBP: [20, 300, "mmHg"],
    MAP: [10, 300, "mmHg"],
    DBP: [10, 250, "mmHg"],
    Resp: [1, 100, "breaths/min"],
    EtCO2: [5, 120, "mmHg"],
    BaseExcess: [-50, 100, "mEq/L"],
    HCO3: [0, 60, "mEq/L"],
    FiO2: [0, 1, "0.0–1.0"],
    pH: [6.5, 8.0, "pH"],
    PaCO2: [5, 150, "mmHg"],
    SaO2: [20, 100, "%"],
    AST: [1, 15000, "IU/L"],
    BUN: [1, 300, "mg/dL"],
    Alkalinephos: [1, 5000, "IU/L"],
    Calcium: [1, 30, "mg/dL"],
    Chloride: [20, 180, "mEq/L"],
    Creatinine: [0.1, 50, "mg/dL"],
    Bilirubin_direct: [0, 50, "mg/dL"],
    Glucose: [10, 1500, "mg/dL"],
    Lactate: [0.1, 40, "mmol/L"],
    Magnesium: [0.1, 15, "mg/dL"],
    Phosphate: [0.1, 30, "mg/dL"],
    Potassium: [1, 15, "mEq/L"],
    Bilirubin_total: [0.1, 60, "mg/dL"],
    TroponinI: [0, 500, "ng/mL"],
    Hct: [5, 75, "%"],
    Hgb: [1, 35, "g/dL"],
    PTT: [10, 300, "seconds"],
    WBC: [0.1, 500, "10^3/µL"],
    Fibrinogen: [10, 2000, "mg/dL"],
    Platelets: [1, 3000, "10^3/µL"],
  };

  const manualState = {
    hours: [
      { ICULOS: 1, HR: "", O2Sat: "", Temp: "", SBP: "", MAP: "", DBP: "", Resp: "", EtCO2: "", WBC: "", Lactate: "", Creatinine: "", Platelets: "", Glucose: "", BUN: "" },
      { ICULOS: 2, HR: "", O2Sat: "", Temp: "", SBP: "", MAP: "", DBP: "", Resp: "", EtCO2: "", WBC: "", Lactate: "", Creatinine: "", Platelets: "", Glucose: "", BUN: "" },
      { ICULOS: 3, HR: "", O2Sat: "", Temp: "", SBP: "", MAP: "", DBP: "", Resp: "", EtCO2: "", WBC: "", Lactate: "", Creatinine: "", Platelets: "", Glucose: "", BUN: "" },
    ],
    assessment: null,
  };

  const PRESET_SEPTIC = {
    demographics: { Age: 68, Gender: "1", Unit: "unit1", HospAdmTime: -14.0 },
    hours: [
      { ICULOS: 1, HR: 88, O2Sat: 97, Temp: 37.2, SBP: 122, MAP: 82, DBP: 64, Resp: 18, EtCO2: "", WBC: 10.5, Lactate: 1.4, Creatinine: 0.9, Platelets: 210, Glucose: 115, BUN: 16 },
      { ICULOS: 2, HR: 110, O2Sat: 94, Temp: 38.6, SBP: 102, MAP: 68, DBP: 52, Resp: 24, EtCO2: "", WBC: 15.2, Lactate: 2.5, Creatinine: 1.3, Platelets: 180, Glucose: 145, BUN: 22 },
      { ICULOS: 3, HR: 126, O2Sat: 91, Temp: 39.2, SBP: 88, MAP: 58, DBP: 46, Resp: 28, EtCO2: "", WBC: 21.0, Lactate: 3.8, Creatinine: 1.8, Platelets: 145, Glucose: 175, BUN: 28 },
    ],
  };

  const PRESET_STABLE = {
    demographics: { Age: 52, Gender: "0", Unit: "unit2", HospAdmTime: -3.5 },
    hours: [
      { ICULOS: 1, HR: 72, O2Sat: 99, Temp: 36.8, SBP: 124, MAP: 85, DBP: 66, Resp: 15, EtCO2: "", WBC: 7.8, Lactate: 1.1, Creatinine: 0.8, Platelets: 240, Glucose: 98, BUN: 14 },
      { ICULOS: 2, HR: 76, O2Sat: 98, Temp: 36.9, SBP: 120, MAP: 83, DBP: 65, Resp: 16, EtCO2: "", WBC: 8.0, Lactate: 1.2, Creatinine: 0.8, Platelets: 235, Glucose: 102, BUN: 14 },
      { ICULOS: 3, HR: 72, O2Sat: 99, Temp: 36.8, SBP: 122, MAP: 84, DBP: 65, Resp: 15, EtCO2: "", WBC: 7.9, Lactate: 1.1, Creatinine: 0.8, Platelets: 238, Glucose: 99, BUN: 15 },
    ],
  };

  function setMode(mode) {
    const navReplayBtn = $("nav-replay-btn");
    const navManualBtn = $("nav-manual-btn");
    const replayWorkspace = $("replay-workspace");
    const manualWorkspace = $("manual-workspace");

    if (mode === "manual") {
      navReplayBtn.classList.remove("active");
      navReplayBtn.setAttribute("aria-selected", "false");
      navManualBtn.classList.add("active");
      navManualBtn.setAttribute("aria-selected", "true");
      replayWorkspace.hidden = true;
      manualWorkspace.hidden = false;
      pause();
    } else {
      navManualBtn.classList.remove("active");
      navManualBtn.setAttribute("aria-selected", "false");
      navReplayBtn.classList.add("active");
      navReplayBtn.setAttribute("aria-selected", "true");
      manualWorkspace.hidden = true;
      replayWorkspace.hidden = false;
    }
  }

  function showManualError(message, title = "Validation Error") {
    $("man-error-title").textContent = title;
    $("man-error-message").textContent = message;
    $("man-error-panel").hidden = false;
    $("man-run-status").textContent = "Error occurred";
  }

  function clearManualError() {
    $("man-error-panel").hidden = true;
    $("man-run-status").textContent = "Ready to evaluate";
    document.querySelectorAll(".input-invalid").forEach(el => el.classList.remove("input-invalid"));
  }

  function renderManualHours() {
    const container = $("man-hours-container");
    container.innerHTML = "";

    manualState.hours.forEach((h, index) => {
      const card = document.createElement("div");
      card.className = "hour-observation-card";
      card.dataset.index = index;

      card.innerHTML = `
        <div class="hour-card-header">
          <span class="hour-badge">ICU Observation #${index + 1} (Hour ${h.ICULOS})</span>
          <button class="button-remove-hour" type="button" data-index="${index}" ${manualState.hours.length <= 1 ? "disabled" : ""}>
            ✕ Remove Hour
          </button>
        </div>
        <div class="vitals-form-grid">
          <div class="form-group">
            <label>HR <span class="field-unit">(bpm)</span></label>
            <input type="number" step="1" data-field="HR" data-index="${index}" value="${esc(h.HR)}" placeholder="80">
            <span class="field-hint">20–300</span>
          </div>
          <div class="form-group">
            <label>O2Sat <span class="field-unit">(%)</span></label>
            <input type="number" step="0.5" data-field="O2Sat" data-index="${index}" value="${esc(h.O2Sat)}" placeholder="98">
            <span class="field-hint">20–100</span>
          </div>
          <div class="form-group">
            <label>Temp <span class="field-unit">(°C)</span></label>
            <input type="number" step="0.1" data-field="Temp" data-index="${index}" value="${esc(h.Temp)}" placeholder="37.0">
            <span class="field-hint">20–48</span>
          </div>
          <div class="form-group">
            <label>SBP <span class="field-unit">(mmHg)</span></label>
            <input type="number" step="1" data-field="SBP" data-index="${index}" value="${esc(h.SBP)}" placeholder="120">
            <span class="field-hint">20–300</span>
          </div>
          <div class="form-group">
            <label>MAP <span class="field-unit">(mmHg)</span></label>
            <input type="number" step="1" data-field="MAP" data-index="${index}" value="${esc(h.MAP)}" placeholder="80">
            <span class="field-hint">10–300</span>
          </div>
          <div class="form-group">
            <label>DBP <span class="field-unit">(mmHg)</span></label>
            <input type="number" step="1" data-field="DBP" data-index="${index}" value="${esc(h.DBP)}" placeholder="65">
            <span class="field-hint">10–250</span>
          </div>
          <div class="form-group">
            <label>Resp <span class="field-unit">(/min)</span></label>
            <input type="number" step="1" data-field="Resp" data-index="${index}" value="${esc(h.Resp)}" placeholder="18">
            <span class="field-hint">1–100</span>
          </div>
          <div class="form-group">
            <label>EtCO2 <span class="field-unit">(mmHg)</span></label>
            <input type="number" step="1" data-field="EtCO2" data-index="${index}" value="${esc(h.EtCO2)}" placeholder="35">
            <span class="field-hint">5–120</span>
          </div>
        </div>
        <details class="labs-details">
          <summary>Laboratory Values (Optional · training median imputed if blank)</summary>
          <div class="labs-form-grid">
            <div class="form-group">
              <label>WBC <span class="field-unit">(10³/µL)</span></label>
              <input type="number" step="0.1" data-field="WBC" data-index="${index}" value="${esc(h.WBC)}" placeholder="10.0">
            </div>
            <div class="form-group">
              <label>Lactate <span class="field-unit">(mmol/L)</span></label>
              <input type="number" step="0.1" data-field="Lactate" data-index="${index}" value="${esc(h.Lactate)}" placeholder="1.8">
            </div>
            <div class="form-group">
              <label>Creatinine <span class="field-unit">(mg/dL)</span></label>
              <input type="number" step="0.1" data-field="Creatinine" data-index="${index}" value="${esc(h.Creatinine)}" placeholder="1.0">
            </div>
            <div class="form-group">
              <label>Platelets <span class="field-unit">(10³/µL)</span></label>
              <input type="number" step="1" data-field="Platelets" data-index="${index}" value="${esc(h.Platelets)}" placeholder="180">
            </div>
            <div class="form-group">
              <label>Glucose <span class="field-unit">(mg/dL)</span></label>
              <input type="number" step="1" data-field="Glucose" data-index="${index}" value="${esc(h.Glucose)}" placeholder="120">
            </div>
            <div class="form-group">
              <label>BUN <span class="field-unit">(mg/dL)</span></label>
              <input type="number" step="1" data-field="BUN" data-index="${index}" value="${esc(h.BUN)}" placeholder="18">
            </div>
            <div class="form-group">
              <label>pH</label>
              <input type="number" step="0.01" data-field="pH" data-index="${index}" value="${esc(h.pH)}" placeholder="7.40">
            </div>
            <div class="form-group">
              <label>FiO2 <span class="field-unit">(0.0–1.0)</span></label>
              <input type="number" step="0.05" data-field="FiO2" data-index="${index}" value="${esc(h.FiO2)}" placeholder="0.5">
            </div>
          </div>
        </details>
      `;

      container.appendChild(card);
    });

    // Attach input listeners
    container.querySelectorAll("input[data-field]").forEach(input => {
      input.addEventListener("input", e => {
        const idx = Number(e.target.dataset.index);
        const fld = e.target.dataset.field;
        manualState.hours[idx][fld] = e.target.value.trim();
        e.target.classList.remove("input-invalid");
      });
    });

    // Attach remove buttons
    container.querySelectorAll(".button-remove-hour").forEach(btn => {
      btn.addEventListener("click", e => {
        const idx = Number(e.target.dataset.index);
        if (manualState.hours.length > 1) {
          manualState.hours.splice(idx, 1);
          // Re-index ICULOS
          manualState.hours.forEach((h, i) => { h.ICULOS = i + 1; });
          renderManualHours();
          clearManualError();
        }
      });
    });
  }

  function applyPreset(preset) {
    clearManualError();
    $("man-age").value = preset.demographics.Age;
    $("man-gender").value = preset.demographics.Gender;
    $("man-unit").value = preset.demographics.Unit;
    $("man-hospadm").value = preset.demographics.HospAdmTime;

    manualState.hours = JSON.parse(JSON.stringify(preset.hours));
    renderManualHours();
    $("man-run-status").textContent = "Preset loaded. Click 'Run Risk Assessment' to evaluate.";
  }

  function resetManualPatient() {
    clearManualError();
    $("man-age").value = "";
    $("man-gender").value = "";
    $("man-unit").value = "none";
    $("man-hospadm").value = "";

    manualState.hours = [
      { ICULOS: 1, HR: "", O2Sat: "", Temp: "", SBP: "", MAP: "", DBP: "", Resp: "", EtCO2: "", WBC: "", Lactate: "", Creatinine: "", Platelets: "", Glucose: "", BUN: "" },
      { ICULOS: 2, HR: "", O2Sat: "", Temp: "", SBP: "", MAP: "", DBP: "", Resp: "", EtCO2: "", WBC: "", Lactate: "", Creatinine: "", Platelets: "", Glucose: "", BUN: "" },
      { ICULOS: 3, HR: "", O2Sat: "", Temp: "", SBP: "", MAP: "", DBP: "", Resp: "", EtCO2: "", WBC: "", Lactate: "", Creatinine: "", Platelets: "", Glucose: "", BUN: "" },
    ];
    renderManualHours();

    // Reset results card
    $("man-score-display").textContent = "—";
    $("man-meter-bar").style.width = "0%";
    $("man-meter-bar").className = "";
    $("man-badge-status").textContent = "Awaiting assessment";
    $("man-badge-status").className = "pill pill-neutral";
    $("man-single-status").textContent = "—";
    $("man-confirm-status").textContent = "—";
    $("man-final-alert").textContent = "—";
    $("man-final-alert").className = "final-alert-box";

    $("man-trajectory-tbody").innerHTML = `<tr><td colspan="6" class="table-empty">Add observations and run assessment to see trajectory.</td></tr>`;
    $("man-shap-negative").innerHTML = `<p class="small muted">Awaiting assessment…</p>`;
    $("man-shap-positive").innerHTML = `<p class="small muted">Awaiting assessment…</p>`;
    $("man-shap-base").textContent = "—";
    $("man-shap-margin").textContent = "—";
    $("man-shap-total").textContent = "—";
    $("man-shap-all-table").innerHTML = "";

    $("man-run-status").textContent = "Data reset. Enter patient information to evaluate.";
  }

  async function runManualAssessment() {
    clearManualError();

    // 1. Client-side input validation
    const ageVal = $("man-age").value.trim();
    if (ageVal !== "") {
      const num = Number(ageVal);
      if (isNaN(num) || num < RANGES.Age[0] || num > RANGES.Age[1]) {
        $("man-age").classList.add("input-invalid");
        showManualError(`Age must be between ${RANGES.Age[0]} and ${RANGES.Age[1]} years.`);
        return;
      }
    }

    const hospVal = $("man-hospadm").value.trim();
    if (hospVal !== "") {
      const num = Number(hospVal);
      if (isNaN(num) || num < RANGES.HospAdmTime[0] || num > RANGES.HospAdmTime[1]) {
        $("man-hospadm").classList.add("input-invalid");
        showManualError(`Hospital Admission Time must be between ${RANGES.HospAdmTime[0]} and ${RANGES.HospAdmTime[1]} hours.`);
        return;
      }
    }

    // Validate hourly vitals & labs
    for (let i = 0; i < manualState.hours.length; i++) {
      const h = manualState.hours[i];
      for (const [field, val] of Object.entries(h)) {
        if (field === "ICULOS") continue;
        if (val !== "" && val !== null && val !== undefined) {
          const num = Number(val);
          const range = RANGES[field];
          if (isNaN(num)) {
            const inputEl = document.querySelector(`input[data-field="${field}"][data-index="${i}"]`);
            if (inputEl) inputEl.classList.add("input-invalid");
            showManualError(`Observation #${i + 1}: ${field} must be a valid number.`);
            return;
          }
          if (range && (num < range[0] || num > range[1])) {
            const inputEl = document.querySelector(`input[data-field="${field}"][data-index="${i}"]`);
            if (inputEl) inputEl.classList.add("input-invalid");
            showManualError(`Observation #${i + 1}: ${field} (${num}) is outside plausible range [${range[0]}, ${range[1]}] ${range[2]}.`);
            return;
          }
        }
      }
    }

    // Build payload
    const payload = {
      model: "baseline",
      demographics: {
        Age: ageVal !== "" ? Number(ageVal) : null,
        Gender: $("man-gender").value !== "" ? Number($("man-gender").value) : null,
        Unit1: $("man-unit").value === "unit1" ? 1 : $("man-unit").value === "unit2" ? 0 : null,
        Unit2: $("man-unit").value === "unit2" ? 1 : $("man-unit").value === "unit1" ? 0 : null,
        HospAdmTime: hospVal !== "" ? Number(hospVal) : null,
      },
      hours: manualState.hours.map((h, i) => {
        const row = { ICULOS: Number(h.ICULOS || (i + 1)) };
        for (const [k, v] of Object.entries(h)) {
          if (k !== "ICULOS" && v !== "" && v !== null && v !== undefined) {
            row[k] = Number(v);
          }
        }
        return row;
      })
    };

    $("man-assess-btn").disabled = true;
    $("man-run-status").textContent = "Running feature engineering and XGBoost inference…";

    try {
      const response = await fetch("/api/manual-assessment", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
      });

      const res = await response.json();
      if (!response.ok) {
        throw new Error(res.error || `Server returned error status ${response.status}`);
      }

      renderManualResults(res);
      $("man-run-status").textContent = `Assessment complete at Hour ${res.latest_hour}.`;
    } catch (err) {
      showManualError(err.message || String(err), "Inference Error");
    } finally {
      $("man-assess-btn").disabled = false;
    }
  }

  function renderManualResults(res) {
    manualState.assessment = res;

    // 1. Executive Summary Card
    const score = res.latest_score;
    const threshold = res.threshold;
    $("man-score-display").textContent = score.toFixed(3);

    const fillPct = Math.min(100, Math.max(0, score * 100));
    const meterBar = $("man-meter-bar");
    meterBar.style.width = `${fillPct}%`;

    const isConfirmed = res.latest_confirmed_alert;
    const isPending = res.total_observations < 3;
    const isAboveThresh = score >= threshold;

    if (isConfirmed) {
      meterBar.className = "fill-critical";
      $("man-badge-status").textContent = "CONFIRMED ALERT";
      $("man-badge-status").className = "pill pill-danger";
    } else if (isPending) {
      meterBar.className = isAboveThresh ? "fill-warning" : "fill-normal";
      $("man-badge-status").textContent = "CONFIRMATION PENDING";
      $("man-badge-status").className = "pill pill-warning";
    } else {
      meterBar.className = isAboveThresh ? "fill-warning" : "fill-normal";
      $("man-badge-status").textContent = isAboveThresh ? "ELEVATED (UNCONFIRMED)" : "LOW RISK";
      $("man-badge-status").className = isAboveThresh ? "pill pill-warning" : "pill pill-positive";
    }

    $("man-single-status").textContent = res.latest_prediction_status;
    $("man-confirm-status").textContent = res.latest_confirmation_status;

    const alertBox = $("man-final-alert");
    if (isConfirmed) {
      alertBox.className = "final-alert-box alert-confirmed";
      alertBox.textContent = "🚨 CRITICAL ALERT: SEPSIS RISK CONFIRMED (Experiment 5 Policy)";
      playAlertChime();
    } else if (isPending) {
      alertBox.className = "final-alert-box alert-pending";
      alertBox.textContent = "⏳ TEMPORAL CONFIRMATION PENDING (< 3 hourly observations recorded)";
    } else {
      alertBox.className = "final-alert-box alert-unconfirmed";
      alertBox.textContent = "✅ MONITORING: NO CONFIRMED ALERT (Threshold not sustained)";
    }

    // 2. Trajectory Table
    const tbody = $("man-trajectory-tbody");
    tbody.innerHTML = "";

    res.hourly_assessments.forEach(item => {
      const tr = document.createElement("tr");

      const pillClass = item.confirmed_alert ? "pill-danger" : item.observations_available < 3 ? "pill-warning" : "pill-success";
      const alertTag = item.confirmed_alert
        ? `<span class="pill ${pillClass}">🚨 ALERT</span>`
        : item.observations_available < 3
        ? `<span class="pill ${pillClass}">⏳ Pending</span>`
        : `<span class="pill ${pillClass}">✓ Normal</span>`;

      tr.innerHTML = `
        <td><strong>Hour ${item.hour}</strong></td>
        <td class="numeric"><strong>${item.model_score.toFixed(3)}</strong></td>
        <td><span class="small ${item.raw_above_threshold ? "text-negative" : "muted"}">${item.single_hour_status}</span></td>
        <td>${item.observations_available >= 3 ? `${item.positives_in_window}/3 &ge; threshold` : `${item.positives_in_window}/${item.observations_available} &ge; threshold`}</td>
        <td><span class="small">${item.confirmation_status}</span></td>
        <td>${alertTag}</td>
      `;
      tbody.appendChild(tr);
    });

    // 3. SHAP Explanation
    const shap = res.shap;
    $("man-shap-base").textContent = signed(shap.base_value);
    $("man-shap-margin").textContent = signed(shap.margin);
    const sumShap = shap.features.reduce((acc, f) => acc + f.shap_value, 0);
    $("man-shap-total").textContent = signed(sumShap);

    function renderShapBars(containerId, list, direction) {
      const el = $(containerId);
      el.innerHTML = "";
      if (!list.length) {
        el.innerHTML = `<p class="small muted">No ${direction} contributions</p>`;
        return;
      }
      const topItems = list.slice(0, 5);
      const maxVal = Math.max(...topItems.map(item => Math.abs(item.shap_value)), 0.05);

      topItems.forEach(item => {
        const pct = Math.min(100, Math.max(5, (Math.abs(item.shap_value) / maxVal) * 100));
        const barRow = document.createElement("div");
        barRow.className = "shap-bar-row";
        barRow.innerHTML = `
          <div class="shap-bar-label">
            <span class="small" title="${esc(item.feature)}">${esc(featureName(item.feature))}</span>
            <span class="small muted">${item.feature_value !== null ? fixed(item.feature_value, 1) : "—"}</span>
          </div>
          <div class="shap-bar-track">
            <div class="shap-bar-fill ${direction}" style="width: ${pct}%;"></div>
          </div>
          <span class="shap-bar-value small">${signed(item.shap_value)}</span>
        `;
        el.appendChild(barRow);
      });
    }

    renderShapBars("man-shap-negative", shap.negative, "negative");
    renderShapBars("man-shap-positive", shap.positive, "positive");

    // All Features Table
    const tableBody = $("man-shap-all-table");
    tableBody.innerHTML = "";
    shap.features.forEach(f => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(featureName(f.feature))}</td>
        <td class="numeric">${f.feature_value !== null ? fixed(f.feature_value, 2) : "—"}</td>
        <td class="numeric">${signed(f.shap_value)}</td>
        <td><span class="direction-badge ${f.direction}">${f.direction}</span></td>
      `;
      tableBody.appendChild(tr);
    });
  }

  // Wire up Manual Assessment event listeners
  $("nav-replay-btn").addEventListener("click", () => setMode("replay"));
  $("nav-manual-btn").addEventListener("click", () => setMode("manual"));
  $("man-load-septic-btn").addEventListener("click", () => applyPreset(PRESET_SEPTIC));
  $("man-load-stable-btn").addEventListener("click", () => applyPreset(PRESET_STABLE));
  $("man-reset-btn").addEventListener("click", resetManualPatient);
  $("man-clear-btn").addEventListener("click", resetManualPatient);
  $("man-assess-btn").addEventListener("click", runManualAssessment);
  $("man-add-hour-btn").addEventListener("click", () => {
    const nextHour = manualState.hours.length + 1;
    manualState.hours.push({
      ICULOS: nextHour, HR: "", O2Sat: "", Temp: "", SBP: "", MAP: "", DBP: "", Resp: "", EtCO2: "",
      WBC: "", Lactate: "", Creatinine: "", Platelets: "", Glucose: "", BUN: ""
    });
    renderManualHours();
  });

  // Initialize manual hours table
  renderManualHours();

  async function init() {
    emptyLiveView();
    searchPatients();
    try { await loadModels(); await loadPatient(state.patientId); }
    catch (error) { showError(error, init, "The research workspace is unavailable"); }
  }
  init();
})();
