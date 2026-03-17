let ws = null;
let requests = {};
let stats = { total: 0, ok: 0, err: 0, failed: 0, durations: [], bytes: 0 };
let activeFilter = 'all';
let isCapturing = false;

const saved = localStorage.getItem('nw_server');
if (saved) document.getElementById('serverInput').value = saved;
document.getElementById('serverInput').addEventListener('change', e => {
    localStorage.setItem('nw_server', e.target.value.trim());
});
const savedApiKey = localStorage.getItem('nw_api_key');
if (savedApiKey) document.getElementById('apiKeyInput').value = savedApiKey;
    document.getElementById('apiKeyInput').addEventListener('change', e => {
    localStorage.setItem('nw_api_key', e.target.value.trim());
});

function toggleFilter(btn) {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.type;
    rerenderAll();
}

function passesFilter(req) {
    if (activeFilter === 'all') return true;
    return req.resource_type === activeFilter;
}

function startInspection() {
    if (isCapturing) { stopCapture(); return; }

    let server = document.getElementById('serverInput').value.trim().replace(/\/$/, '');
    const target = document.getElementById('targetUrl').value.trim();
    const apiKey = document.getElementById('apiKeyInput').value.trim();

    if (!server || !target) {
        alert('Please enter both the backend URL and a target URL.');
        return;
    }

    if (!target.match(/^https?:\/\//)) {
        document.getElementById('targetUrl').value = 'https://' + target;
    }

    localStorage.setItem('nw_server', server);
    localStorage.setItem('nw_api_key', apiKey);

    const filterTypes = activeFilter === 'all' ? null : [activeFilter];

    const wsBase = server.replace(/^http/, 'ws') + '/ws/inspect';
    const wsUrl = apiKey ? wsBase + '?api_key=' + encodeURIComponent(apiKey) : wsBase;

    setConnState('loading', 'CONNECTING');
    clearStatusLog();
    addVisibleClass('statusLog');

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        setConnState('connected', 'LIVE');
        isCapturing = true;
        document.getElementById('inspectBtn').textContent = 'STOP';
        document.getElementById('inspectBtn').classList.replace('btn-primary', 'btn-danger');
        ws.send(JSON.stringify({
            url: document.getElementById('targetUrl').value.trim(),
            capture_responses: true,
            capture_headers: true,
            capture_body: true,
            filter_types: filterTypes
        }));
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
    };

    ws.onerror = () => {
        addLog('WebSocket error — is the backend running?', 'error');
        setConnState('error', 'ERROR');
        stopCapture();
    };

    ws.onclose = () => {
        if (isCapturing) stopCapture();
    };
}

function stopCapture() {
    isCapturing = false;
    if (ws) { ws.close(); ws = null; }
    setConnState('idle', 'IDLE');
    document.getElementById('inspectBtn').textContent = 'INSPECT';
    document.getElementById('inspectBtn').classList.replace('btn-danger', 'btn-primary');
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'status':
            addLog(msg.message, 'info');
            break;
        case 'error':
            addLog('⚠ ' + msg.message, 'error');
            break;
        case 'done':
            addLog('✓ ' + msg.message, 'done');
            stopCapture();
            break;
        case 'request':
            handleRequestEvent(msg.data);
            break;
        case 'response':
            handleResponseEvent(msg.data);
            break;
        case 'request_failed':
            handleFailedEvent(msg.data);
            break;
    }
}

function handleRequestEvent(data) {
    requests[data.id] = { ...data, resolved: false };
    stats.total++;
    updateStats();
    if (passesFilter(data)) renderCard(data.id, true);
}

function handleResponseEvent(data) {
    const existing = requests[data.id] || {};
    requests[data.id] = { ...existing, ...data, resolved: true };
    const req = requests[data.id];

    if (data.status >= 200 && data.status < 400) stats.ok++;
    else stats.err++;
    if (data.duration_ms) stats.durations.push(data.duration_ms);

    if (data.body) stats.bytes += new Blob([data.body]).size;

    updateStats();
    if (passesFilter(req)) {
        const card = document.getElementById('card-' + data.id);
        if (card) updateCard(data.id);
        else renderCard(data.id, false);
    }
}

function handleFailedEvent(data) {
    requests[data.id] = { ...data, resolved: true, failed: true };
    stats.failed++;
    updateStats();
    if (passesFilter(data)) {
        const card = document.getElementById('card-' + data.id);
        if (card) updateCard(data.id);
        else renderCard(data.id, false);
    }
}

function renderCard(id, prepend) {
    removeVisibleClass('emptyState');

    const req = requests[id];
    if (!req) return;

    const existing = document.getElementById('card-' + id);
    if (existing) { updateCard(id); return; }

    const card = document.createElement('div');
    card.className = 'request-card';
    card.id = 'card-' + id;
    card.innerHTML = buildCardHTML(id);

    const list = document.getElementById('listWrap');
    const log = document.getElementById('statusLog');
    if (prepend) {
        list.insertBefore(card, log ? log.nextSibling : list.firstChild);
    } else {
        list.appendChild(card);
    }
}

function updateCard(id) {
    const card = document.getElementById('card-' + id);
    if (!card) return;
    const wasExpanded = card.classList.contains('expanded');
    card.innerHTML = buildCardHTML(id);
    if (wasExpanded) card.classList.add('expanded');
}

function rerenderAll() {
    removeAllCards();
    const filtered = Object.values(requests).filter(passesFilter);
    if (filtered.length === 0 && Object.keys(requests).length > 0) {
    } else if (Object.keys(requests).length === 0) {
    }
    Object.keys(requests).forEach(id => {
        if (passesFilter(requests[id])) renderCard(id, false);
    });
}

function buildCardHTML(id) {
    const req = requests[id];
    const method = (req.method || 'GET').toUpperCase();
    const mClass = ['GET','POST','PUT','DELETE','PATCH'].includes(method) ? method : 'OTHER';

    let urlDisplay = req.url || '';
    try {
        const u = new URL(req.url);
        urlDisplay = `<span class="host">${u.hostname}</span><span class="path">${u.pathname}${u.search}</span>`;
    } catch {}

    let statusHTML = '';
    if (!req.resolved) {
        statusHTML = `<span class="status-badge s-pending"><span class="spinner"></span></span>`;
    } else if (req.failed) {
        statusHTML = `<span class="status-badge s-err">FAIL</span>`;
    } else {
        const s = req.status || 0;
        const sc = s >= 500 ? 's-5xx' : s >= 400 ? 's-4xx' : s >= 300 ? 's-3xx' : 's-2xx';
        statusHTML = `<span class="status-badge ${sc}">${s}</span>`;
    }

    const duration = req.duration_ms ? `<span class="duration">${req.duration_ms}ms</span>` : '';
    const resourceType = req.resource_type ? `<span class="type-badge">${req.resource_type}</span>` : '';

    return `
        <div class="req-header" onclick="toggleCard('${id}')">
            <div class="req-badge">
                <span class="method-badge m-${mClass}">${method}</span>
                ${resourceType}
            </div>
            <div class="req-meta">
                ${statusHTML}${duration}
            </div>
            <span class="req-url">${urlDisplay}</span>
        </div>
        <div class="req-detail">
            <div class="detail-tabs">
                <button class="tab-btn active" onclick="switchTab('${id}','response')">RESPONSE</button>
                <button class="tab-btn" onclick="switchTab('${id}','req-info')">REQUEST</button>
                <button class="tab-btn" onclick="switchTab('${id}','res-headers')">RES HEADERS</button>
                <button class="tab-btn" onclick="switchTab('${id}','req-headers')">REQ HEADERS</button>
            </div>
            <div class="tab-pane active" data-pane="response">${buildResponsePane(req)}</div>
            <div class="tab-pane" data-pane="req-info">${buildReqInfoPane(req)}</div>
            <div class="tab-pane" data-pane="res-headers">${buildHeaderPane(req.headers)}</div>
            <div class="tab-pane" data-pane="req-headers">${buildHeaderPane(req.req_headers || req.headers_sent)}</div>
        </div>
    `;
}

function buildResponsePane(req) {
    if (!req.resolved) return '<p class="response-pane__waiting">Waiting for response...</p>';
    if (req.failed) return `<div class="response-pane__failed">${escHtml(req.failure || 'Request failed')}</div>`;

    const body = req.body || '(empty or binary body)';
    const bid = 'b-' + req.id;
    const formatted = tryJson(body);
    return `
        <div class="response-pane__success">${req.content_type||''} ${req.body ? '· ~'+fmtSize(new Blob([req.body]).size) : ''}</div>
        <div class="code-block" id="${bid}">${escHtml(formatted)}</div>
        <button class="copy-btn" onclick="copyTxt(document.getElementById('${bid}').textContent,this)">⎘ COPY</button>
    `;
}

function buildReqInfoPane(req) {
    const rows = [
        ['URL', req.url],
        ['Method', req.method],
        ['Resource type', req.resource_type],
        ['Status', req.status ? req.status + ' ' + (req.status_text||'') : 'N/A'],
        ['Duration', req.duration_ms ? req.duration_ms + 'ms' : 'N/A'],
        ['Post data', req.post_data || '(none)'],
    ];
    return `<table class="kv-table">${rows.map(([k,v])=>`<tr><td>${k}</td><td>${escHtml(String(v||''))}</td></tr>`).join('')}</table>`;
}

function buildHeaderPane(headers) {
    if (!headers || (typeof headers === 'object' && Object.keys(headers).length === 0))
        return '<p class="header-pane">No headers captured.</p>';
    const entries = typeof headers === 'object' && !Array.isArray(headers)
        ? Object.entries(headers) : headers || [];
    return `<table class="kv-table">${entries.map(([k,v])=>`<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`).join('')}</table>`;
}

function toggleCard(id) {
    document.getElementById('card-' + id)?.classList.toggle('expanded');
}

function switchTab(id, pane) {
    const card = document.getElementById('card-' + id);
    if (!card) return;
    card.querySelectorAll('.tab-btn').forEach((b,i) => {
        const panes = ['response','req-info','res-headers','req-headers'];
        b.classList.toggle('active', panes[i] === pane);
    });
    card.querySelectorAll('.tab-pane').forEach(p => {
        p.classList.toggle('active', p.dataset.pane === pane);
    });
}

function updateStats() {
    document.getElementById('sTotal').textContent = stats.total;
    document.getElementById('sOk').textContent = stats.ok;
    document.getElementById('sErr').textContent = stats.err;
    document.getElementById('sFailed').textContent = stats.failed;
    const avg = stats.durations.length ? Math.round(stats.durations.reduce((a,b)=>a+b,0)/stats.durations.length) : null;
    document.getElementById('sAvg').textContent = avg ? avg+'ms' : '—';
    document.getElementById('sSize').textContent = stats.bytes ? fmtSize(stats.bytes) : '—';
}

function addLog(msg, type='info') {
    const log = document.getElementById('statusLog');
    const line = document.createElement('div');
    line.className = 'log-line ' + type;
    line.textContent = '› ' + msg;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

function clearStatusLog() {
    document.getElementById('statusLog').innerHTML = '';
}

function setConnState(state, label) {
    const dot = document.getElementById('connDot');
    const lbl = document.getElementById('connLabel');
    dot.className = 'conn-dot ' + state;
    lbl.textContent = label;
    lbl.style.color = state === 'connected' ? 'var(--accent3)' : state === 'error' ? 'var(--error)' : state === 'loading' ? 'var(--warning)' : 'var(--text-dim)';
}

function clearAll() {
    stopCapture();
    requests = {};
    stats = { total: 0, ok: 0, err: 0, failed: 0, durations: [], bytes: 0 };
    updateStats();
    clearStatusLog();
    removeVisibleClass('statusLog');
    removeAllCards();
    addVisibleClass('emptyState');
}

function tryJson(str) {
    try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(1) + ' MB';
}

function copyTxt(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        const o = btn.textContent;
        btn.textContent = '✓ COPIED';
        setTimeout(() => btn.textContent = o, 1500);
    });
}

function addVisibleClass(elementId) {
    document.getElementById(elementId).classList.add('visible');
}

function removeVisibleClass(elementId) {
    document.getElementById(elementId).classList.remove('visible');
}

function removeAllCards() {
    document.querySelectorAll('.request-card').forEach(c => c.remove());
}
