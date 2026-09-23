const state = {
  cases: [],
  uploadedData: null,
  uploadedName: "",
  result: null,
  source: "",
  layer: "all",
  zoom: 1,
  pan: { x: 0, y: 0 },
  dragging: false,
  dragStart: null,
  agentFilter: null,
  animationFrame: null,
  animationStart: 0,
  hitAreas: [],
  selectedRoute: null,
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const caseSelect = $("#case-select");
const caseMeta = $("#case-meta");
const fileInput = $("#file-input");
const dropZone = $("#drop-zone");
const runButton = $("#run-button");
const alertBox = $("#alert");
const canvas = $("#route-canvas");
const context = canvas.getContext("2d");
const tooltip = $("#map-tooltip");

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const formatNumber = (value, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);

const friendlySource = (source) =>
  source === "base_case.json"
    ? "Base operation"
    : source
        .replace(".json", "")
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());

async function loadCases() {
  try {
    const response = await fetch("/api/cases");
    if (!response.ok) throw new Error("Operations are temporarily unavailable.");
    const data = await response.json();
    state.cases = data.cases;
    caseSelect.innerHTML = data.cases
      .map(
        (item) =>
          `<option value="${escapeHtml(item.name)}">${escapeHtml(
            item.name === "base_case.json" ? "Base operation" : item.label,
          )}</option>`,
      )
      .join("");
    updateCaseMeta();
    await runSimulation({ navigate: false });
  } catch (error) {
    showError(error.message);
  }
}

function updateCaseMeta() {
  const selected = state.cases.find((item) => item.name === caseSelect.value);
  if (!selected) {
    caseMeta.textContent = "";
    return;
  }
  state.uploadedData = null;
  state.uploadedName = "";
  fileInput.value = "";
  dropZone.querySelector("strong").textContent = "Import dispatch manifest";
  dropZone.querySelector("small").textContent = "Drop JSON or browse";
  caseMeta.textContent = `${selected.warehouses} hubs · ${selected.agents} agents · ${selected.packages} deliveries`;
}

async function readUpload(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".json")) {
    showError("Please choose a JSON dispatch manifest.");
    return;
  }
  try {
    state.uploadedData = JSON.parse(await file.text());
    state.uploadedName = file.name;
    dropZone.querySelector("strong").textContent = file.name;
    dropZone.querySelector("small").textContent =
      `${(file.size / 1024).toFixed(1)} KB · ready to launch`;
    caseMeta.textContent = "Custom dispatch manifest selected";
    hideError();
  } catch {
    showError("We could not read that manifest. Check the JSON and try again.");
  }
}

function simulationOptions() {
  const options = {
    random_delays: $("#delay-toggle").checked,
    seed: Number($("#delay-seed").value || 42),
    max_delay_minutes: Number($("#max-delay").value || 45),
  };
  if ($("#join-toggle").checked) {
    options.joining_agent = {
      id: $("#join-id").value.trim() || "AX",
      location: [
        Number($("#join-x").value || 0),
        Number($("#join-y").value || 0),
      ],
    };
    options.joins_after = Number($("#joins-after").value || 0);
  }
  return options;
}

async function runSimulation({ navigate = true } = {}) {
  setLoading(true);
  hideError();
  const payload = state.uploadedData
    ? { data: state.uploadedData, options: simulationOptions() }
    : {
        case: caseSelect.value || "base_case.json",
        options: simulationOptions(),
      };
  try {
    const response = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "The route plan could not be generated.");
    }
    state.result = data.result;
    state.source = state.uploadedName || data.source;
    state.zoom = 1;
    state.pan = { x: 0, y: 0 };
    state.agentFilter = null;
    state.selectedRoute =
      [...data.result.assignments].sort(
        (a, b) => b.total_distance - a.total_distance,
      )[0] || null;
    renderResults(data.result);
    if (navigate) {
      requestAnimationFrame(() => {
        document.documentElement.style.scrollBehavior = "smooth";
        $("#network").scrollIntoView({ behavior: "smooth", block: "start" });
        showToast(
          "Route plan ready",
          `${data.result.summary.packages_delivered} deliveries are now live on the map.`,
        );
      });
    }
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

function setLoading(loading) {
  runButton.disabled = loading;
  runButton.classList.toggle("loading", loading);
  runButton.querySelector("span").textContent = loading
    ? "Coordinating fleet…"
    : "Generate route plan";
}

function showError(message) {
  alertBox.hidden = false;
  alertBox.textContent = message;
}

function hideError() {
  alertBox.hidden = true;
  alertBox.textContent = "";
}

function renderResults(result) {
  const { summary } = result;
  const utilization = summary.total_agents
    ? Math.round((summary.active_agents / summary.total_agents) * 100)
    : 0;
  const completion = summary.total_packages
    ? Math.round((summary.packages_delivered / summary.total_packages) * 100)
    : 100;
  const leader = summary.best_agent ? result.agents[summary.best_agent] : null;

  $("#operation-name").textContent = friendlySource(state.source);
  $("#last-updated").textContent = `Updated ${new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
  $("#hero-agents").textContent = summary.total_agents;
  $("#kpi-delivered").textContent = summary.packages_delivered;
  $("#kpi-delivered-note").textContent =
    `${completion}% of ${summary.total_packages} packages coordinated`;
  $("#completion-fill").style.width = `${completion}%`;
  $("#kpi-distance").textContent = formatNumber(summary.total_distance);
  $("#kpi-utilization").textContent = utilization;
  $("#util-note").textContent =
    `${summary.active_agents} of ${summary.total_agents} agents currently active`;
  $("#kpi-best").textContent = summary.best_agent || "Standby";
  $("#leader-avatar").textContent = summary.best_agent || "—";
  $("#leader-rate").textContent = leader
    ? `${formatNumber(leader.efficiency)} units per delivery`
    : "No active deliveries";
  $("#map-caption").textContent =
    `${summary.packages_delivered} routes moving · ${formatNumber(
      summary.total_distance,
    )} total units`;
  $("#manifest-count").textContent =
    `${summary.packages_delivered} route${summary.packages_delivered === 1 ? "" : "s"}`;
  $("#active-agent-count").textContent = summary.active_agents;
  $("#capacity-packages").textContent =
    `${summary.packages_delivered} package${summary.packages_delivered === 1 ? "" : "s"}`;
  $("#route-visibility").textContent = summary.packages_delivered;
  $("#average-route").textContent = formatNumber(summary.average_distance);
  $("#health-score").textContent = Math.round(78 + completion * 0.14 + utilization * 0.08);

  const pickupTotal = result.assignments.reduce(
    (sum, route) => sum + route.pickup_distance,
    0,
  );
  const pickupShare = summary.total_distance
    ? (pickupTotal / summary.total_distance) * 100
    : 0;
  $("#pickup-share").textContent = `${formatNumber(pickupShare, 1)}%`;

  $("#util-dots").innerHTML = Array.from(
    { length: summary.total_agents },
    (_, index) => `<i class="${index < summary.active_agents ? "active" : ""}"></i>`,
  ).join("");

  $("#map-empty").hidden = true;
  $("#replay-button").disabled = false;
  $("#export-button").disabled = false;
  renderAgents(result);
  renderAssignments(result.assignments);
  renderInsights(result, pickupShare);
  renderLoadBalance(result);
  selectRoute(state.selectedRoute);
  playMap();
}

function renderAgents(result) {
  const maxPackages = Math.max(
    1,
    ...Object.values(result.agents).map((metrics) => metrics.packages_delivered),
  );
  $("#agent-grid").innerHTML = Object.entries(result.agents)
    .map(([agentId, metrics]) => {
      const isBest = agentId === result.summary.best_agent;
      const packageList = metrics.package_ids.length
        ? metrics.package_ids.map(escapeHtml).join(" · ")
        : "Available for dispatch";
      const load = Math.round((metrics.packages_delivered / maxPackages) * 100);
      return `
        <article class="agent-card ${isBest ? "best" : ""}" data-agent="${escapeHtml(
          agentId,
        )}" tabindex="0" role="button" aria-label="Focus routes for agent ${escapeHtml(
          agentId,
        )}">
          <header>
            <span class="agent-avatar">${escapeHtml(agentId)}</span>
            <div><h3>Agent ${escapeHtml(agentId)}</h3><small>${
              metrics.packages_delivered ? "On route" : "Available"
            }</small></div>
          </header>
          <div class="agent-ring"><span>${load}%</span></div>
          <div class="agent-stats">
            <div><strong>${metrics.packages_delivered}</strong><small>Drops</small></div>
            <div><strong>${formatNumber(metrics.total_distance, 1)}</strong><small>Distance</small></div>
            <div><strong>${
              metrics.efficiency === null
                ? "—"
                : formatNumber(metrics.efficiency, 1)
            }</strong><small>Avg route</small></div>
          </div>
          <p class="agent-packages">${packageList}</p>
        </article>`;
    })
    .join("");
}

function renderLoadBalance(result) {
  const entries = Object.entries(result.agents);
  const maxLoad = Math.max(
    1,
    ...entries.map(([, metrics]) => metrics.packages_delivered),
  );
  const loads = entries.map(([, metrics]) => metrics.packages_delivered);
  const spread = Math.max(...loads) - Math.min(...loads);
  const balanced = spread <= Math.max(1, Math.ceil(result.summary.total_packages * 0.2));
  $("#balance-label").textContent = balanced ? "Balanced" : "Monitor";
  $("#balance-label").className = balanced ? "balanced" : "";
  $("#load-bars").innerHTML = entries
    .map(
      ([agentId, metrics]) => `
        <div class="load-row ${metrics.packages_delivered === maxLoad ? "top" : ""}" data-agent="${escapeHtml(
          agentId,
        )}" tabindex="0" role="button">
          <span>${escapeHtml(agentId)}</span>
          <div class="load-track"><i style="width:${Math.round(
            (metrics.packages_delivered / maxLoad) * 100,
          )}%"></i></div>
          <b>${metrics.packages_delivered}</b>
        </div>`,
    )
    .join("");
}

function renderAssignments(assignments, query = "") {
  const normalized = query.trim().toLowerCase();
  const rows = assignments.filter((route) =>
    [route.package_id, route.agent_id, route.warehouse_id].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
  $("#assignment-table").innerHTML = rows.length
    ? rows
        .map(
          (route) => `
            <tr data-package="${escapeHtml(route.package_id)}">
              <td><span class="id-pill">${escapeHtml(route.package_id)}</span></td>
              <td><span class="agent-pill">${escapeHtml(route.agent_id)}</span></td>
              <td>${escapeHtml(route.warehouse_id)}</td>
              <td>${formatNumber(route.pickup_distance)}</td>
              <td>${formatNumber(route.delivery_distance)}</td>
              <td class="distance-total">${formatNumber(route.total_distance)}</td>
              <td><span class="status-pill">${
                route.delay_minutes
                  ? `Delayed +${route.delay_minutes}m`
                  : "On route"
              }</span></td>
            </tr>`,
        )
        .join("")
    : `<tr><td colspan="7" class="empty-cell">No matching deliveries</td></tr>`;
}

function renderInsights(result, pickupShare) {
  const entries = Object.entries(result.agents);
  const busiest = [...entries].sort(
    (a, b) =>
      b[1].packages_delivered - a[1].packages_delivered ||
      a[0].localeCompare(b[0]),
  )[0];
  const longest = [...result.assignments].sort(
    (a, b) => b.total_distance - a.total_distance,
  )[0];
  const idle = entries.filter(([, metrics]) => !metrics.packages_delivered).length;
  const signals = [
    {
      title: `${result.summary.best_agent || "Fleet"} sets the pace`,
      body: result.summary.best_agent
        ? `${formatNumber(
            result.agents[result.summary.best_agent].efficiency,
          )} units per delivery — the best efficiency in this operation.`
        : "The fleet is ready for its first dispatch.",
    },
    {
      title: `${busiest[0]} is carrying peak load`,
      body: `${busiest[1].packages_delivered} packages assigned, the highest active workload.`,
    },
    {
      title: longest ? `${longest.package_id} needs attention` : "Routes are clear",
      body: longest
        ? `Longest route at ${formatNumber(longest.total_distance)} units via ${
            longest.warehouse_id
          }.`
        : "No route exceptions detected.",
    },
    {
      title: result.summary.delayed_packages
        ? `${result.summary.delayed_packages} traffic delay${
            result.summary.delayed_packages === 1 ? "" : "s"
          } detected`
        : `${formatNumber(pickupShare, 1)}% pickup exposure`,
      body: result.summary.delayed_packages
        ? `${result.summary.total_delay_minutes} total delay minutes across the live operation.`
        : `${idle} standby agent${
            idle === 1 ? "" : "s"
          } available for demand changes.`,
    },
  ];
  $("#insights").innerHTML = signals
    .map(
      (signal, index) => `
        <div class="insight">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <div><strong>${escapeHtml(signal.title)}</strong><p>${escapeHtml(
            signal.body,
          )}</p></div>
        </div>`,
    )
    .join("");
}

function selectRoute(route) {
  if (!route) return;
  state.selectedRoute = route;
  $("#focus-package").textContent = route.package_id;
  $("#focus-agent").textContent = `Agent ${route.agent_id}`;
  $("#focus-warehouse").textContent = `Hub ${route.warehouse_id}`;
  $("#focus-total").textContent = formatNumber(route.total_distance);
  $("#focus-pickup").textContent = formatNumber(route.pickup_distance);
  $("#focus-delivery").textContent = formatNumber(route.delivery_distance);
  $$(".agent-card").forEach((card) =>
    card.classList.toggle("selected", card.dataset.agent === route.agent_id),
  );
}

function setupCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetWidth = Math.round(rect.width * dpr);
  const targetHeight = Math.round(rect.height * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: rect.width, height: rect.height };
}

function mapViewport(point, width, height) {
  return {
    x:
      width / 2 +
      (point.x - width / 2) * state.zoom +
      state.pan.x,
    y:
      height / 2 +
      (point.y - height / 2) * state.zoom +
      state.pan.y,
  };
}

function buildMapLayout(network, width, height) {
  const nodes = [
    ...network.warehouses.map((item) => ({
      key: `hub:${item.id}`,
      coordinate: item.location,
      weight: 2,
    })),
    ...network.agents.map((item) => ({
      key: `agent:${item.id}`,
      coordinate: item.location,
      weight: 1,
    })),
    ...network.packages.map((item) => ({
      key: `drop:${item.id}`,
      coordinate: item.destination,
      weight: 1,
    })),
  ];
  const xs = nodes.map((item) => item.coordinate[0]);
  const ys = nodes.map((item) => item.coordinate[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const padding = width < 600 ? 58 : 95;
  const scale = Math.min(
    (width - padding * 2) / rangeX,
    (height - padding * 2) / rangeY,
  );
  const contentWidth = rangeX * scale;
  const contentHeight = rangeY * scale;
  const left = (width - contentWidth) / 2;
  const top = (height - contentHeight) / 2;
  const positions = nodes.map((node, index) => ({
    ...node,
    index,
    x: left + (node.coordinate[0] - minX) * scale,
    y: top + contentHeight - (node.coordinate[1] - minY) * scale,
  }));

  // Resolve screen-space collisions while preserving the geographic shape.
  const minimumGap = width < 600 ? 29 : 42;
  for (let iteration = 0; iteration < 28; iteration += 1) {
    for (let first = 0; first < positions.length; first += 1) {
      for (let second = first + 1; second < positions.length; second += 1) {
        const a = positions[first];
        const b = positions[second];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= minimumGap) continue;
        if (distance < 0.1) {
          const angle = ((first * 37 + second * 19) % 360) * (Math.PI / 180);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const force = (minimumGap - distance) * 0.48;
        const unitX = dx / distance;
        const unitY = dy / distance;
        const aMove = b.weight / (a.weight + b.weight);
        const bMove = a.weight / (a.weight + b.weight);
        a.x -= unitX * force * aMove;
        a.y -= unitY * force * aMove;
        b.x += unitX * force * bMove;
        b.y += unitY * force * bMove;
      }
    }
    positions.forEach((point) => {
      point.x = Math.max(44, Math.min(width - 44, point.x));
      point.y = Math.max(50, Math.min(height - 50, point.y));
    });
  }

  return Object.fromEntries(
    positions.map((point) => [
      point.key,
      mapViewport(point, width, height),
    ]),
  );
}

function beginMapTransform(width, height) {
  context.translate(width / 2 + state.pan.x, height / 2 + state.pan.y);
  context.scale(state.zoom, state.zoom);
  context.translate(-width / 2, -height / 2);
}

function drawMapBase(width, height) {
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#121e23");
  gradient.addColorStop(1, "#0d171b");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.save();
  beginMapTransform(width, height);
  context.strokeStyle = "rgba(138, 158, 166, .08)";
  context.lineWidth = 1;
  for (let x = -height; x < width + height; x += 58) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x + height * 0.45, height);
    context.stroke();
  }
  for (let y = 28; y < height; y += 62) {
    context.beginPath();
    context.moveTo(0, y);
    context.bezierCurveTo(width * 0.3, y + 38, width * 0.68, y - 32, width, y + 16);
    context.stroke();
  }

  const roads = [
    [[-.05, .78], [.2, .58], [.47, .6], [.7, .34], [1.06, .28]],
    [[.1, -.05], [.23, .23], [.51, .4], [.68, .73], [.9, 1.05]],
    [[-.05, .27], [.24, .31], [.43, .18], [.75, .22], [1.04, .5]],
    [[.03, .95], [.32, .78], [.55, .83], [.87, .67], [1.02, .72]],
  ];
  roads.forEach((road, index) => {
    context.beginPath();
    road.forEach(([x, y], pointIndex) => {
      const px = x * width;
      const py = y * height;
      if (pointIndex === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.strokeStyle =
      index === 0 ? "rgba(154, 175, 183, .18)" : "rgba(154, 175, 183, .11)";
    context.lineWidth = index === 0 ? 5 : 3;
    context.stroke();
    context.strokeStyle = "rgba(12, 20, 23, .9)";
    context.lineWidth = index === 0 ? 2 : 1;
    context.stroke();
  });

  context.fillStyle = "rgba(130, 149, 156, .28)";
  context.font = '7px "DM Mono"';
  context.letterSpacing = "1px";
  [
    ["NORTH DISTRICT", width * .12, height * .13],
    ["CENTRAL GRID", width * .43, height * .52],
    ["SOUTH CORRIDOR", width * .72, height * .88],
    ["EAST LOOP", width * .77, height * .2],
  ].forEach(([label, x, y]) => context.fillText(label, x, y));
  context.restore();
}

function playMap() {
  cancelAnimationFrame(state.animationFrame);
  state.animationStart = performance.now();
  const frame = (now) => {
    const elapsed = now - state.animationStart;
    const reveal = state.reducedMotion ? 1 : Math.min(elapsed / 1450, 1);
    drawMap(reveal, now);
    if (!state.reducedMotion) state.animationFrame = requestAnimationFrame(frame);
  };
  state.animationFrame = requestAnimationFrame(frame);
}

function drawMap(progress = 1, now = performance.now()) {
  if (!state.result) return;
  const { width, height } = setupCanvas();
  context.clearRect(0, 0, width, height);
  drawMapBase(width, height);
  const { network, assignments } = state.result;
  const layout = buildMapLayout(network, width, height);
  const agents = Object.fromEntries(
    network.agents.map((item) => [item.id, layout[`agent:${item.id}`]]),
  );
  const warehouses = Object.fromEntries(
    network.warehouses.map((item) => [item.id, layout[`hub:${item.id}`]]),
  );
  state.hitAreas = [];
  state.labelRects = [];

  assignments.forEach((route, index) => {
    const stagger = (index / Math.max(assignments.length, 1)) * 0.3;
    const routeProgress = Math.max(0, Math.min((progress - stagger) / 0.7, 1));
    const start = agents[route.agent_id];
    const hub = warehouses[route.warehouse_id];
    const destination = layout[`drop:${route.package_id}`];
    const opacity =
      state.agentFilter && route.agent_id !== state.agentFilter ? 0.12 : 1;
    if (state.layer !== "delivery") {
      drawRouteSegment(
        start,
        hub,
        Math.min(routeProgress * 2, 1),
        "#56cbbb",
        true,
        opacity,
      );
    }
    if (state.layer !== "pickup") {
      drawRouteSegment(
        hub,
        destination,
        Math.max(routeProgress * 2 - 1, 0),
        route.package_id === state.selectedRoute?.package_id ? "#d9ff65" : "#ff6a3f",
        false,
        opacity,
      );
    }
    if (routeProgress === 1) {
      if (opacity === 1) drawDistanceLabel(hub, destination, route);
      if (opacity === 1) {
        drawMovingCourier(start, hub, destination, now, index, route);
      }
    }
  });

  network.packages.forEach((item) =>
    drawNode(
      layout[`drop:${item.id}`],
      item.id,
      "#ffc63d",
      "#101518",
      "drop",
      9,
    ),
  );
  network.warehouses.forEach((item) =>
    drawNode(layout[`hub:${item.id}`], item.id, "#ff5426", "#fff", "hub", 14),
  );
  network.agents.forEach((item) =>
    drawNode(layout[`agent:${item.id}`], item.id, "#36a394", "#fff", "agent", 11),
  );
}

function drawRouteSegment(from, to, progress, color, dashed, opacity = 1) {
  if (!from || !to || progress <= 0) return;
  const end = {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
  context.save();
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(end.x, end.y);
  context.strokeStyle = color;
  context.lineWidth = 7;
  context.globalAlpha = .07 * opacity;
  context.stroke();
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(end.x, end.y);
  context.strokeStyle = color;
  context.lineWidth = dashed ? 1.2 : 1.7;
  context.globalAlpha = (dashed ? .5 : .72) * opacity;
  if (dashed) context.setLineDash([4, 5]);
  context.stroke();
  context.restore();
}

function drawDistanceLabel(from, to, route) {
  if (state.layer === "pickup") return;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const offset = 11 + (route.package_id.charCodeAt(route.package_id.length - 1) % 3) * 5;
  const x = from.x + dx * .56 - (dy / length) * offset;
  const y = from.y + dy * .56 + (dx / length) * offset;
  context.save();
  const fontSize = Math.max(7, Math.min(9, 7 * Math.sqrt(state.zoom)));
  context.font = `500 ${fontSize}px "DM Mono"`;
  const label = `${route.package_id} · ${formatNumber(route.total_distance, 1)}`;
  const width = context.measureText(label).width + 12;
  const rect = { left: x - width / 2, right: x + width / 2, top: y - 11, bottom: y + 8 };
  const selected = route.package_id === state.selectedRoute?.package_id;
  const overlaps = state.labelRects.some(
    (other) =>
      rect.left < other.right &&
      rect.right > other.left &&
      rect.top < other.bottom &&
      rect.bottom > other.top,
  );
  if (overlaps && !selected) {
    context.restore();
    return;
  }
  state.labelRects.push(rect);
  context.fillStyle = "rgba(10,17,20,.82)";
  context.strokeStyle = selected ? "#d9ff65" : "rgba(255,255,255,.11)";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x - width / 2, y - 10, width, 17, 3);
  context.fill();
  context.stroke();
  context.fillStyle = "#dbe2e4";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, x, y - 1);
  context.restore();
  state.hitAreas.push({
    x,
    y,
    radius: Math.max(14, width / 2),
    label: `${route.package_id} · ${formatNumber(route.total_distance)} units`,
    type: "route",
    route,
  });
}

function drawMovingCourier(start, hub, destination, now, index, route) {
  const phase = state.reducedMotion ? .7 : (now / 4300 + index * .17) % 1;
  let point;
  if (phase < .3) {
    const t = phase / .3;
    point = { x: start.x + (hub.x - start.x) * t, y: start.y + (hub.y - start.y) * t };
  } else {
    const t = (phase - .3) / .7;
    point = {
      x: hub.x + (destination.x - hub.x) * t,
      y: hub.y + (destination.y - hub.y) * t,
    };
  }
  if (
    (state.layer === "pickup" && phase >= .3) ||
    (state.layer === "delivery" && phase < .3)
  ) return;
  context.save();
  context.shadowColor =
    route.package_id === state.selectedRoute?.package_id ? "#d9ff65" : "#fff";
  context.shadowBlur = 10;
  context.fillStyle =
    route.package_id === state.selectedRoute?.package_id ? "#d9ff65" : "#fff";
  context.beginPath();
  context.arc(point.x, point.y, 3.3, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawNode(point, label, fill, textColor, type, radius) {
  const markerScale = Math.max(.9, Math.min(1.45, Math.sqrt(state.zoom)));
  const scaledRadius = radius * markerScale;
  context.save();
  context.shadowColor = fill;
  context.shadowBlur = type === "hub" ? 16 : 9;
  context.fillStyle = fill;
  context.beginPath();
  context.arc(point.x, point.y, scaledRadius, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
  if (type === "hub") {
    context.strokeStyle = "rgba(255,255,255,.45)";
    context.lineWidth = 1;
    context.beginPath();
    context.arc(point.x, point.y, scaledRadius + 5, 0, Math.PI * 2);
    context.stroke();
  }
  context.fillStyle = textColor;
  context.font = `600 ${type === "hub" ? 7 : 6}px "DM Mono"`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, point.x, point.y + .5);
  context.restore();
  let route = null;
  if (type === "drop") {
    route = state.result.assignments.find((item) => item.package_id === label);
  } else if (type === "agent") {
    route = state.result.assignments.find((item) => item.agent_id === label);
  } else if (type === "hub") {
    route = [...state.result.assignments]
      .filter((item) => item.warehouse_id === label)
      .sort((a, b) => b.total_distance - a.total_distance)[0];
  }
  state.hitAreas.push({
    ...point,
    radius: scaledRadius + 9,
    label,
    type,
    route,
  });
}

function downloadReport() {
  if (!state.result) return;
  const report = {
    operation: friendlySource(state.source),
    generated_at: new Date().toISOString(),
    ...state.result,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `fastbox-operation-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function showToast(title, message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<i></i><span><strong>${escapeHtml(
    title,
  )}</strong><small>${escapeHtml(message)}</small></span>`;
  $("#toast-region").appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function setMapZoom(nextZoom, anchor = null) {
  const rect = canvas.getBoundingClientRect();
  const previous = state.zoom;
  const zoom = Math.max(.75, Math.min(2.4, nextZoom));
  const point = anchor || { x: rect.width / 2, y: rect.height / 2 };
  const center = { x: rect.width / 2, y: rect.height / 2 };
  const world = {
    x: (point.x - center.x - state.pan.x) / previous + center.x,
    y: (point.y - center.y - state.pan.y) / previous + center.y,
  };
  state.pan.x = point.x - center.x - (world.x - center.x) * zoom;
  state.pan.y = point.y - center.y - (world.y - center.y) * zoom;
  state.zoom = zoom;
}

function fitMap() {
  state.zoom = 1;
  state.pan = { x: 0, y: 0 };
  state.agentFilter = null;
  $$(".agent-card").forEach((card) => card.classList.remove("selected"));
  showToast("Map fitted", "All agents, hubs and destinations are visible.");
}

function focusAgent(agentId) {
  if (!state.result) return;
  state.agentFilter = state.agentFilter === agentId ? null : agentId;
  const route = state.result.assignments.find(
    (item) => item.agent_id === agentId,
  );
  if (route) selectRoute(route);
  $$(".agent-card").forEach((card) =>
    card.classList.toggle(
      "selected",
      Boolean(state.agentFilter && card.dataset.agent === state.agentFilter),
    ),
  );
  showToast(
    state.agentFilter ? `Agent ${agentId} focused` : "Fleet view restored",
    state.agentFilter
      ? "Other routes are dimmed. Click the agent again to clear."
      : "Every live route is visible.",
  );
}

caseSelect.addEventListener("change", updateCaseMeta);
runButton.addEventListener("click", () => runSimulation({ navigate: true }));
$("#load-demo").addEventListener("click", async () => {
  state.uploadedData = null;
  state.uploadedName = "";
  caseSelect.value = "base_case.json";
  updateCaseMeta();
  await runSimulation({ navigate: true });
});
$("#advanced-toggle").addEventListener("click", () => {
  const panel = $("#advanced-panel");
  panel.hidden = !panel.hidden;
  $("#advanced-toggle").setAttribute("aria-expanded", String(!panel.hidden));
});
$("#notification-button").addEventListener("click", () => {
  const summary = state.result?.summary;
  showToast(
    summary?.delayed_packages ? "Operational attention" : "Network healthy",
    summary?.delayed_packages
      ? `${summary.delayed_packages} delayed packages need monitoring.`
      : "No critical exceptions. Every package is coordinated.",
  );
});
fileInput.addEventListener("change", (event) => readUpload(event.target.files[0]));
["dragenter", "dragover"].forEach((eventName) =>
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  }),
);
["dragleave", "drop"].forEach((eventName) =>
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  }),
);
dropZone.addEventListener("drop", (event) => readUpload(event.dataTransfer.files[0]));
$("#replay-button").addEventListener("click", playMap);
$("#export-button").addEventListener("click", downloadReport);
$("#table-search").addEventListener("input", (event) => {
  if (state.result) renderAssignments(state.result.assignments, event.target.value);
});
$("#assignment-table").addEventListener("click", (event) => {
  const row = event.target.closest("[data-package]");
  if (!row || !state.result) return;
  const route = state.result.assignments.find(
    (item) => item.package_id === row.dataset.package,
  );
  selectRoute(route);
  $("#network").scrollIntoView({ behavior: "smooth", block: "center" });
});
document.addEventListener("click", (event) => {
  const agentElement = event.target.closest("[data-agent]");
  if (agentElement) focusAgent(agentElement.dataset.agent);
});
document.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const clickable = event.target.closest(".clickable, [data-agent]");
  if (!clickable) return;
  event.preventDefault();
  clickable.click();
});
$$(".clickable[data-target]").forEach((card) =>
  card.addEventListener("click", () => {
    $(card.dataset.target)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }),
);
$$(".layer-tabs button").forEach((button) =>
  button.addEventListener("click", () => {
    $$(".layer-tabs button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.layer = button.dataset.layer;
    showToast(`${button.textContent.trim()} shown`, "The map layer changed instantly.");
  }),
);
$("#zoom-in").addEventListener("click", () => {
  setMapZoom(state.zoom + .22);
});
$("#zoom-out").addEventListener("click", () => {
  setMapZoom(state.zoom - .22);
});
$("#zoom-fit").addEventListener("click", fitMap);
window.addEventListener("resize", () => {
  state.pan = { x: 0, y: 0 };
  if (state.result && state.reducedMotion) drawMap(1);
});
canvas.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (state.dragging) {
    const dx = event.clientX - state.dragStart.x;
    const dy = event.clientY - state.dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) state.didDrag = true;
    state.pan.x = state.dragStart.panX + dx;
    state.pan.y = state.dragStart.panY + dy;
    canvas.style.cursor = "grabbing";
    tooltip.hidden = true;
    return;
  }
  const match = [...state.hitAreas]
    .reverse()
    .find((item) => Math.hypot(item.x - x, item.y - y) <= item.radius);
  if (!match) {
    tooltip.hidden = true;
    canvas.style.cursor = "grab";
    return;
  }
  canvas.style.cursor = match.route ? "pointer" : "grab";
  tooltip.hidden = false;
  tooltip.textContent = `${match.type.toUpperCase()} · ${match.label}`;
  tooltip.style.left = `${Math.min(x + 13, rect.width - 145)}px`;
  tooltip.style.top = `${Math.max(y - 34, 8)}px`;
});
canvas.addEventListener("click", (event) => {
  if (state.didDrag) {
    state.didDrag = false;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const match = [...state.hitAreas]
    .reverse()
    .find((item) => item.route && Math.hypot(item.x - x, item.y - y) <= item.radius);
  if (match?.route) {
    selectRoute(match.route);
    showToast(
      `${match.route.package_id} selected`,
      `${formatNumber(match.route.total_distance)} total route units.`,
    );
  }
});
canvas.addEventListener("mousedown", (event) => {
  state.dragging = true;
  state.didDrag = false;
  state.dragStart = {
    x: event.clientX,
    y: event.clientY,
    panX: state.pan.x,
    panY: state.pan.y,
  };
  canvas.style.cursor = "grabbing";
});
window.addEventListener("mouseup", () => {
  state.dragging = false;
  canvas.style.cursor = "grab";
});
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    setMapZoom(state.zoom * (event.deltaY < 0 ? 1.12 : .89), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  },
  { passive: false },
);
canvas.addEventListener("mouseleave", () => {
  tooltip.hidden = true;
});

loadCases();
