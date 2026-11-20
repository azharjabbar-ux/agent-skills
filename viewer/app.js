/* Knowledge Galaxy - viewer logic. No framework, no build step. */
(function () {
  'use strict';

  /* =====================================================================
     FINISH_MS -- the most personal number in this build.

     Speech recognition finalises a phrase every time you pause, and people
     pause mid-sentence. This is how long a silence has to last before the
     galaxy decides you have actually finished talking. Fragments that land
     inside the window are glued together and sent as one question.

       too low   -> you get cut off mid-thought and ask half a question
       too high  -> the galaxy feels slow to answer

     Start at 900. After a day of real use, tune it here. You can also try
     values live from the console without editing this file:
         __galaxy.voice.setFinishMs(1200)
     ===================================================================== */
  var FINISH_MS = 900;

  // Said on their own, these never wait for the finish window -- they cut in
  // immediately and stop whatever is being spoken.
  var INTERRUPT_WORDS = ['stop', 'wait', 'cancel', 'quiet', 'shush', 'hold on', 'never mind'];

  /* An answer resting on this many notes or fewer earns a dive to its top
     source. Above it, flying to one note out of six would be a claim the
     answer cannot support, so the whole cluster lights and the camera holds. */
  var FLY_MAX_SOURCES = 3;

  /* The note is on screen to be read. The voice only ever gets the short
     answer, and never more than this much of it. */
  var SPEAK_MAX_CHARS = 420;

  var boot = document.getElementById('boot');
  var booterr = document.getElementById('booterr');

  function fail(msg) {
    boot.classList.remove('gone');
    booterr.innerHTML = msg;
    var b = boot.querySelector('.bar'); if (b) b.style.display = 'none';
    var h = boot.querySelector('h1'); if (h) h.textContent = 'Cannot render';
  }

  if (typeof ForceGraph3D === 'undefined') {
    return fail('The 3d-force-graph library did not load.<br>Check your connection, or make sure <code>viewer/vendor/3d-force-graph.min.js</code> exists.');
  }
  if (typeof GRAPH === 'undefined' || !GRAPH.nodes || !GRAPH.nodes.length) {
    return fail('No graph data found.<br>Run <code>python3 build.py</code> to generate <code>viewer/graph-data.js</code>, then reload.');
  }

  // ---------------------------------------------------------------- palette
  // Consecutive entries are far apart in hue, so neighbouring groups in the
  // sorted list never end up looking like each other.
  var PALETTE = ['#7dd3fc','#fbbf24','#34d399','#f472b6','#c4b5fd',
                 '#fb923c','#22d3ee','#a3e635','#f87171','#e879f9'];
  var groups = [];
  GRAPH.nodes.forEach(function (n) {
    if (groups.indexOf(n.group) === -1) groups.push(n.group);
  });
  groups.sort();
  var colorOf = {};
  groups.forEach(function (g, i) { colorOf[g] = PALETTE[i % PALETTE.length]; });
  function nodeColor(n) { return colorOf[n.group] || '#9aa4bd'; }

  // hex -> "r,g,b"
  var rgbCache = {};
  function rgb(hex) {
    if (rgbCache[hex]) return rgbCache[hex];
    var v = parseInt(hex.slice(1), 16);
    return (rgbCache[hex] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].join(','));
  }

  // ---------------------------------------------------------- adjacency map
  var byId = {};
  GRAPH.nodes.forEach(function (n) { byId[n.id] = n; });
  var neighbours = {};
  GRAPH.nodes.forEach(function (n) { neighbours[n.id] = []; });
  GRAPH.links.forEach(function (l) {
    var s = typeof l.source === 'object' ? l.source.id : l.source;
    var t = typeof l.target === 'object' ? l.target.id : l.target;
    if (neighbours[s] && neighbours[s].indexOf(t) === -1) neighbours[s].push(t);
    if (neighbours[t] && neighbours[t].indexOf(s) === -1) neighbours[t].push(s);
  });

  var focused = null;         // currently selected node id (or null)
  var lit = {};               // id -> true for focused node + neighbours
  var citedIds = [];          // node ids the brain cited

  function isLit(id) { return lit[id] === true; }
  function anyLit() { return focused !== null || citedIds.length > 0; }

  function recomputeLit() {
    lit = {};
    if (focused !== null) {
      lit[focused] = true;
      neighbours[focused].forEach(function (id) { lit[id] = true; });
    }
    citedIds.forEach(function (id) { lit[id] = true; });
  }

  // ------------------------------------------------------------------ graph
  var el = document.getElementById('graph');
  var graph = ForceGraph3D()(el)
    .graphData({
      nodes: GRAPH.nodes.map(function (n) { return Object.assign({}, n); }),
      links: GRAPH.links.map(function (l) { return Object.assign({}, l); })
    })
    .backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    .nodeId('id')
    .nodeLabel(function (n) { return n.label; })
    .nodeVal(function (n) { return 1.6 + (n.degree || 0) * 0.22; })
    .nodeRelSize(3.8)
    .nodeResolution(18)
    .nodeOpacity(0.96)
    .nodeColor(function (n) {
      var c = nodeColor(n);
      if (!anyLit()) return c;
      return isLit(n.id) ? c : 'rgba(' + rgb(c) + ',0.16)';
    })
    .linkColor(function (l) {
      var s = typeof l.source === 'object' ? l.source.id : l.source;
      var t = typeof l.target === 'object' ? l.target.id : l.target;
      if (!anyLit()) return 'rgba(150,175,225,0.17)';
      return (isLit(s) && isLit(t)) ? 'rgba(190,225,255,0.62)' : 'rgba(140,165,210,0.03)';
    })
    .linkWidth(function (l) {
      var s = typeof l.source === 'object' ? l.source.id : l.source;
      var t = typeof l.target === 'object' ? l.target.id : l.target;
      return (anyLit() && isLit(s) && isLit(t)) ? 0.9 : 0.28;
    })
    .linkOpacity(0.5)
    .warmupTicks(60)
    .cooldownTicks(220)
    .onNodeClick(function (n) { select(n.id, true); })
    .onBackgroundClick(function () { clearFocus(); });

  // Cap how far repulsion reaches, otherwise weakly-linked notes get flung out
  // and the dense core reads as a distant speck.
  graph.d3Force('charge').strength(-90).distanceMax(260);
  if (graph.d3Force('link')) graph.d3Force('link').distance(36);
  if (graph.d3Force('center') && graph.d3Force('center').strength) {
    graph.d3Force('center').strength(1);
  }

  function refresh() {
    graph.nodeColor(graph.nodeColor())
         .linkColor(graph.linkColor())
         .linkWidth(graph.linkWidth());
  }

  // --------------------------------------------------------------- controls
  var controls = graph.controls();
  var idle = true, idleTimer = null;

  function nudgeIdle() {
    idle = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { if (focused === null) idle = true; }, 4200);
  }
  ['mousedown', 'wheel', 'touchstart'].forEach(function (ev) {
    el.addEventListener(ev, nudgeIdle, { passive: true });
  });

  // -------------------------------------------------------------- starfield
  var starCv = document.getElementById('stars'), sctx = starCv.getContext('2d');
  var glowCv = document.getElementById('glow'), gctx = glowCv.getContext('2d');
  var W = 0, H = 0, DPR = Math.min(window.devicePixelRatio || 1, 2);
  var stars = [];

  function seedStars() {
    stars = [];
    var count = Math.round(Math.min(900, Math.max(340, (W * H) / 2600)));
    for (var i = 0; i < count; i++) {
      var layer = i % 3;
      stars.push({
        u: Math.random(), v: Math.random(), layer: layer,
        r: (layer === 0 ? 0.45 : layer === 1 ? 0.8 : 1.25) * (0.6 + Math.random() * 0.9),
        a: (layer === 0 ? 0.3 : layer === 1 ? 0.52 : 0.8) * (0.45 + Math.random() * 0.55),
        ph: Math.random() * Math.PI * 2,
        tw: 0.4 + Math.random() * 1.5
      });
    }
  }

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    [starCv, glowCv].forEach(function (c) {
      c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
      c.style.width = W + 'px'; c.style.height = H + 'px';
      c.getContext('2d').setTransform(DPR, 0, 0, DPR, 0, 0);
    });
    seedStars();
  }
  window.addEventListener('resize', resize);
  resize();

  function drawStars(t, cam) {
    sctx.clearRect(0, 0, W, H);
    // deep-space wash
    var g = sctx.createRadialGradient(W * 0.5, H * 0.48, 0, W * 0.5, H * 0.48, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(24,34,66,0.5)');
    g.addColorStop(0.45, 'rgba(10,14,32,0.32)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = g; sctx.fillRect(0, 0, W, H);

    var az = Math.atan2(cam.x, cam.z) / (Math.PI * 2);
    var elv = Math.atan2(cam.y, Math.hypot(cam.x, cam.z) || 1) / Math.PI;

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var depth = 0.25 + s.layer * 0.42;             // nearer layers move more
      var x = (((s.u - az * depth) % 1) + 1) % 1 * W;
      var y = (((s.v - elv * depth * 0.55) % 1) + 1) % 1 * H;
      var tw = 0.7 + 0.3 * Math.sin(t * 0.0012 * s.tw + s.ph);
      sctx.globalAlpha = s.a * tw;
      sctx.fillStyle = s.layer === 2 ? '#dce7ff' : '#aebbdd';
      sctx.beginPath(); sctx.arc(x, y, s.r, 0, 6.283); sctx.fill();
    }
    sctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ bloom
  function drawGlow(cam) {
    gctx.clearRect(0, 0, W, H);
    gctx.globalCompositeOperation = 'lighter';
    var data = graph.graphData().nodes;
    // camera forward ~ towards graph centre; used to cull nodes behind us
    var fx = -cam.x, fy = -cam.y, fz = -cam.z;
    // px per world-unit at distance 1, so bloom stays proportional at any zoom
    var c3 = graph.camera();
    var projK = (H / 2) / Math.tan(((c3 && c3.fov ? c3.fov : 50) * Math.PI / 180) / 2);

    for (var i = 0; i < data.length; i++) {
      var n = data[i];
      if (n.x === undefined) continue;
      var dx = n.x - cam.x, dy = n.y - cam.y, dz = n.z - cam.z;
      if (dx * fx + dy * fy + dz * fz <= 0) continue;      // behind camera
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      var p = graph.graph2ScreenCoords(n.x, n.y, n.z);
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      if (p.x < -220 || p.x > W + 220 || p.y < -220 || p.y > H + 220) continue;

      var strength = anyLit() ? (isLit(n.id) ? 1 : 0.08) : 0.62;
      if (strength < 0.02) continue;

      var worldR = 3.8 * Math.cbrt(1.6 + (n.degree || 0) * 0.22);
      var screenR = (worldR * projK) / Math.max(dist, 1);
      var radius = Math.max(5, Math.min(180, screenR * 3.0));
      var alpha = Math.min(0.34, 0.09 + screenR * 0.011) * strength;

      var c = rgb(nodeColor(n));
      var rg = gctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      rg.addColorStop(0, 'rgba(' + c + ',' + (alpha * 0.95).toFixed(3) + ')');
      rg.addColorStop(0.32, 'rgba(' + c + ',' + (alpha * 0.34).toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(' + c + ',0)');
      gctx.fillStyle = rg;
      gctx.beginPath(); gctx.arc(p.x, p.y, radius, 0, 6.283); gctx.fill();
    }
    gctx.globalCompositeOperation = 'source-over';
  }

  // -------------------------------------------------------- animation loop
  var angle = Math.PI * 0.25;
  var last = 0;
  var busyUntil = 0;        // idle rotation must not fight a camera tween
  var ORBIT_RATE = (Math.PI * 2) / 210000;   // one full orbit ~3.5 min, wall-clock

  function tick(t) {
    var dt = last ? Math.min(t - last, 100) : 16;   // clamp after tab-switches
    last = t;
    var cam = graph.cameraPosition();

    if (idle && focused === null && t > busyUntil) {
      var r = Math.hypot(cam.x, cam.z) || 520;
      angle += ORBIT_RATE * dt;
      graph.cameraPosition({ x: r * Math.sin(angle), y: cam.y, z: r * Math.cos(angle) });
      cam = graph.cameraPosition();
    } else {
      angle = Math.atan2(cam.x, cam.z);
    }

    drawStars(t, cam);
    drawGlow(cam);
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ side panel
  var panel = document.getElementById('panel');

  function select(id, fly) {
    var n = byId[id];
    if (!n) return;
    frameLocked = true;
    focused = id;
    idle = false;
    recomputeLit();
    refresh();

    if (fly !== false) {
      var live = graph.graphData().nodes.filter(function (d) { return d.id === id; })[0];
      if (live && live.x !== undefined) {
        var d = Math.hypot(live.x, live.y, live.z);
        var ratio = d > 0 ? 1 + 120 / d : 1;
        graph.cameraPosition(
          d > 0 ? { x: live.x * ratio, y: live.y * ratio, z: live.z * ratio }
                : { x: 0, y: 0, z: 130 },
          live, 1300
        );
      }
    }

    var c = nodeColor(n);
    document.getElementById('pgrp').textContent = n.group;
    panel.querySelector('.grp').style.color = c;
    document.getElementById('ptitle').textContent = n.label;
    document.getElementById('ppath').textContent = n.path;
    document.getElementById('pexcerpt').textContent = n.excerpt || '(no text)';

    var nb = neighbours[id].slice().sort(function (a, b) {
      return (byId[b].degree || 0) - (byId[a].degree || 0);
    });
    var wrap = document.getElementById('pnbwrap');
    var box = document.getElementById('pnb');
    box.innerHTML = '';
    wrap.hidden = nb.length === 0;
    var CHIP_CAP = 24;
    var shown = nb.slice(0, CHIP_CAP);
    shown.forEach(function (oid) {
      var b = document.createElement('button');
      b.textContent = byId[oid].label;
      b.style.borderColor = 'rgba(' + rgb(nodeColor(byId[oid])) + ',0.42)';
      b.onclick = function () { select(oid, true); };
      box.appendChild(b);
    });
    if (nb.length > CHIP_CAP) {
      var more = document.createElement('button');
      var rest = nb.slice(CHIP_CAP);
      more.textContent = '+' + rest.length + ' more';
      more.style.opacity = '.7';
      more.onclick = function () {
        more.remove();
        rest.forEach(function (oid) {
          var b = document.createElement('button');
          b.textContent = byId[oid].label;
          b.style.borderColor = 'rgba(' + rgb(nodeColor(byId[oid])) + ',0.42)';
          b.onclick = function () { select(oid, true); };
          box.appendChild(b);
        });
      };
      box.appendChild(more);
    }

    panel.classList.add('open');
  }

  function clearFocus() {
    focused = null; citedIds = [];
    recomputeLit(); refresh();
    panel.classList.remove('open');
    nudgeIdle();
  }
  document.getElementById('close').onclick = clearFocus;

  // ---------------------------------------------------------------- legend
  var legend = document.getElementById('legend');
  var counts = {};
  GRAPH.nodes.forEach(function (n) { counts[n.group] = (counts[n.group] || 0) + 1; });
  groups.forEach(function (g) {
    var b = document.createElement('button');
    b.innerHTML = '<span class="dot" style="color:' + colorOf[g] + ';background:' + colorOf[g] + '"></span>' +
                  '<span>' + g + '</span> <span class="n">' + counts[g] + '</span>';
    b.onclick = function () {
      // light the whole group
      focused = null;
      citedIds = GRAPH.nodes.filter(function (n) { return n.group === g; })
                            .map(function (n) { return n.id; });
      recomputeLit(); refresh();
      Array.prototype.forEach.call(legend.children, function (c) { c.classList.remove('on'); });
      b.classList.add('on');
    };
    legend.appendChild(b);
  });

  document.getElementById('hudsub').textContent =
    GRAPH.nodes.length + ' notes · ' + GRAPH.links.length + ' connections';

  // ------------------------------------------------------------------ chat
  var form = document.getElementById('bar');
  var input = document.getElementById('q');
  var sendBtn = document.getElementById('send');
  var answer = document.getElementById('answer');

  function showAnswer(html, isErr) {
    answer.className = isErr ? 'err show' : 'show';
    answer.innerHTML = html;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }

  // One path in. Typing and speaking both land here.
  function ask(q) {
    q = String(q || '').trim();
    if (!q || sendBtn.disabled) return;
    frameLocked = true;          // the camera is the answer's from here on
    input.value = q;
    sendBtn.disabled = true;
    setStatus('thinking');
    showAnswer('<span class="dots"><i></i><i></i><i></i></span>', false);

    return fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q })
    })
      .then(function (r) {
        return r.json().catch(function () { return { error: 'Server returned a non-JSON response (HTTP ' + r.status + ').' }; })
          .then(function (j) { return { ok: r.ok, body: j }; });
      })
      .then(function (res) {
        if (!res.ok || res.body.error) {
          var msg = res.body.error || 'Request failed.';
          showAnswer(esc(msg), true);
          speak(msg);          // silence would be worse than bad news, hands-free
          return;
        }
        var ids = (res.body.nodes || []).filter(function (i) { return byId[i]; });
        // The server decides whether this was a question about the notes. It
        // sends grounded:false with an empty nodes list for small talk, so the
        // camera cannot be moved by anything that was not really a question.
        var grounded = res.body.grounded === true && ids.length > 0;

        var html = esc(res.body.answer || '(empty answer)');
        if (grounded) {
          html += '<div class="cites"><span>From</span>' + ids.map(function (i) {
            return '<button data-id="' + i + '">' + esc(byId[i].label) + '</button>';
          }).join('') + '</div>';
        }
        showAnswer(html, false);

        if (grounded) {
          focused = null;
          citedIds = ids;
          if (ids.length <= FLY_MAX_SOURCES) {
            // Dive to the note the answer leans on hardest, light it and its
            // neighbours, open its panel -- all while the answer is spoken.
            idle = false;
            select(ids[0], true);
          } else {
            // Too many sources to point at one. Light the constellation and
            // leave the camera exactly where it is.
            recomputeLit(); refresh();
            panel.classList.remove('open');
          }
        }
        // Not grounded: the graph is not touched at all. It holds still.

        Array.prototype.forEach.call(answer.querySelectorAll('.cites button'), function (b) {
          b.onclick = function () { select(parseInt(b.dataset.id, 10), true); };
        });

        speak(res.body.answer || '');   // the answer only -- never the excerpt
      })
      .catch(function (err) {
        var msg = 'Could not reach the server: ' + err.message;
        showAnswer(esc(msg), true);
        speak(msg);
      })
      .then(function () {
        sendBtn.disabled = false;
        input.select();
        if (!speaking) setStatus(listening ? 'listening' : 'idle');
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    ask(input.value);
  });

  // ----------------------------------------------------------------- voice
  // ?mute=1 is read once, here, and enforced in exactly one place: speak().
  var MUTED = (function () {
    try { return new URLSearchParams(location.search).get('mute') === '1'; }
    catch (e) { return /[?&]mute=1(?:&|$)/.test(location.search); }
  })();

  var statusEl = document.getElementById('status');
  var statusText = document.getElementById('statustext');
  var micBtn = document.getElementById('mic');

  var synth = window.speechSynthesis || null;
  var voices = [], chosenVoice = null;
  var audioUnlocked = false;      // nothing speaks before the first gesture
  var speaking = false;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var recog = null;
  var listening = false;          // mic is actually running
  var wantListening = false;      // user wants the mic on
  var pausedForSpeech = false;    // we stopped the mic so it can't hear the voice

  var buffer = '';                // spoken fragments waiting on the finish window
  var finishTimer = null;

  function setStatus(state, detail) {
    if (!statusEl) return;
    statusEl.className = state === 'idle' ? (MUTED ? 'muted' : '') : state;
    var label = { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' }[state]
             || (MUTED ? 'Ready · muted' : 'Ready');
    statusText.innerHTML = detail
      ? label + ' <span class="heard">“' + detail.replace(/[<&]/g, '') + '”</span>'
      : label;
  }

  // ---- speaking --------------------------------------------------------
  function pickVoice(list) {
    if (!list || !list.length) return null;
    var gb = list.filter(function (v) { return /^en[-_]GB/i.test(v.lang); });
    if (gb.length) {
      // Prefer the natural-sounding British voices when the system has them.
      var liked = ['Daniel', 'Google UK English Female', 'Google UK English Male',
                   'Sonia', 'Libby', 'Ryan', 'Serena', 'Kate', 'Oliver', 'Arthur'];
      for (var i = 0; i < liked.length; i++) {
        var hit = gb.filter(function (v) { return v.name.indexOf(liked[i]) !== -1; })[0];
        if (hit) return hit;
      }
      return gb[0];
    }
    var en = list.filter(function (v) { return /^en/i.test(v.lang); });
    return en[0] || list[0] || null;
  }

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices() || [];
    if (voices.length) chosenVoice = pickVoice(voices);
  }
  if (synth) {
    loadVoices();
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', loadVoices);
    } else { synth.onvoiceschanged = loadVoices; }
  }

  // Browsers refuse speech until the user has interacted. Spend the very first
  // gesture on a silent utterance so the first real line speaks immediately.
  function unlockAudio() {
    if (audioUnlocked || !synth) return;
    audioUnlocked = true;
    loadVoices();
    try {
      var warm = new SpeechSynthesisUtterance(' ');
      warm.volume = 0;
      synth.speak(warm);
    } catch (e) { /* unlocked anyway; the next speak() will tell us */ }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, unlockAudio, { capture: true });
  });

  /* THE one function that ever produces sound. ?mute=1 stops here, so there is
     no other route to the speakers to forget about. */
  function speak(text) {
    if (MUTED) return;                       // <- the whole mute contract
    if (!synth || !audioUnlocked) return;    // never before the first gesture
    text = String(text || '').trim();
    if (!text) return;
    if (text.length > SPEAK_MAX_CHARS) {          // never recite, never ramble
      var cut = text.slice(0, SPEAK_MAX_CHARS);
      var stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      text = (stop > SPEAK_MAX_CHARS * 0.5 ? cut.slice(0, stop + 1) : cut).trim();
    }

    try { synth.cancel(); } catch (e) {}
    var u = new SpeechSynthesisUtterance(text);
    if (!chosenVoice) loadVoices();
    // A bad voice handle must never cost us the whole answer -- fall back to
    // asking for en-GB by language and let the browser choose.
    u.lang = (chosenVoice && chosenVoice.lang) || 'en-GB';
    if (chosenVoice) {
      try { u.voice = chosenVoice; } catch (e) { u.lang = 'en-GB'; }
    }
    u.rate = 1; u.pitch = 1; u.volume = 1;

    u.onstart = function () {
      speaking = true;
      setStatus('speaking');
      muteMicWhileSpeaking();
    };
    var done = function () {
      speaking = false;
      unmuteMicAfterSpeaking();
      setStatus(listening || wantListening ? 'listening' : 'idle');
    };
    u.onend = done;
    u.onerror = done;
    try { synth.speak(u); } catch (e) { done(); }
  }

  // ---- the finish window ----------------------------------------------
  function isInterrupt(text) {
    var t = String(text).toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    return INTERRUPT_WORDS.indexOf(t) !== -1;
  }

  function interrupt() {
    clearTimeout(finishTimer); finishTimer = null;
    buffer = '';
    try { if (synth) synth.cancel(); } catch (e) {}
    speaking = false;
    unmuteMicAfterSpeaking();
    setStatus(listening || wantListening ? 'listening' : 'idle', 'interrupted');
  }

  /* Every finalised phrase arrives here. A pause inside FINISH_MS is treated as
     a breath, not the end of a thought: the fragment is appended and the clock
     restarts. Only the pause that outlasts FINISH_MS sends the whole sentence. */
  function onFinal(text) {
    text = String(text || '').trim();
    if (!text) return;

    if (isInterrupt(text)) { interrupt(); return; }   // never buffered

    buffer = buffer ? buffer + ' ' + text : text;
    setStatus('listening', buffer);
    clearTimeout(finishTimer);
    finishTimer = setTimeout(flushBuffer, FINISH_MS);
  }

  function flushBuffer() {
    finishTimer = null;
    var q = buffer.trim();
    buffer = '';
    if (q) ask(q);
  }

  // ---- listening -------------------------------------------------------
  function muteMicWhileSpeaking() {
    if (listening && recog) {
      pausedForSpeech = true;
      try { recog.stop(); } catch (e) {}
    }
  }
  function unmuteMicAfterSpeaking() {
    if (!pausedForSpeech) return;
    pausedForSpeech = false;
    if (wantListening && recog) {
      try { recog.start(); } catch (e) {}
    }
  }

  function buildRecognition() {
    if (!SR) return null;
    var r = new SR();
    r.continuous = true;        // keep the session open across pauses
    r.interimResults = true;    // so the status line can show you being heard
    r.lang = 'en-GB';
    r.maxAlternatives = 1;

    r.onstart = function () {
      listening = true;
      micBtn.classList.add('on');
      if (!speaking) setStatus('listening', buffer || '');
    };

    r.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var res = ev.results[i];
        var txt = res[0] ? res[0].transcript : '';
        if (res.isFinal) onFinal(txt);
        else interim += txt;
      }
      if (interim.trim() && !speaking) {
        setStatus('listening', (buffer ? buffer + ' ' : '') + interim.trim());
      }
    };

    r.onerror = function (ev) {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        wantListening = false;
        micBtn.classList.remove('on');
        showAnswer('Microphone blocked. Allow mic access for this page, then click the mic again.', true);
      } else if (ev.error === 'no-speech') {
        return;   // harmless; onend restarts us
      }
    };

    r.onend = function () {
      listening = false;
      micBtn.classList.remove('on');
      if (wantListening && !pausedForSpeech) {
        // Chrome ends the session on its own; keep the mic alive.
        try { r.start(); } catch (e) {}
      } else if (!wantListening) {
        // Whatever was still buffered when you switched the mic off still counts.
        if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; flushBuffer(); }
        if (!speaking) setStatus('idle');
      }
    };
    return r;
  }

  function startListening() {
    if (!recog) recog = buildRecognition();
    if (!recog) return;
    wantListening = true;
    micBtn.classList.add('on');
    try { recog.start(); } catch (e) { /* already running */ }
  }

  function stopListening() {
    wantListening = false;
    micBtn.classList.remove('on');
    if (recog) { try { recog.stop(); } catch (e) {} }
    else if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; flushBuffer(); }
  }

  if (!SR) {
    micBtn.disabled = true;
    micBtn.title = 'This browser has no webkitSpeechRecognition - try Chrome or Edge';
  } else {
    micBtn.addEventListener('click', function () {
      if (speaking) { interrupt(); return; }      // click while talking = barge in
      if (wantListening) stopListening(); else startListening();
    });
  }

  setStatus('idle');

  // ------------------------------------------------------------------ boot
  // Frame the dense core rather than the full bounding sphere: a handful of
  // barely-linked notes drift far out, and fitting them shrinks everything else.
  var frameLocked = false;   // set the moment the user engages; see autoFrame()

  /* Auto-framing exists to settle the opening shot. Re-lighting the graph
     restarts the force engine, so onEngineStop can fire long after load --
     without this lock the camera would re-frame itself mid-answer and throw
     away a dive the user is watching. */
  function autoFrame() {
    if (!frameLocked) frame();
  }

  function frame(ms) {
    var ns = graph.graphData().nodes.filter(function (n) { return isFinite(n.x); });
    if (!ns.length) return;
    var cx = 0, cy = 0, cz = 0;
    ns.forEach(function (n) { cx += n.x; cy += n.y; cz += n.z; });
    cx /= ns.length; cy /= ns.length; cz /= ns.length;

    var rads = ns.map(function (n) {
      return Math.hypot(n.x - cx, n.y - cy, n.z - cz);
    }).sort(function (a, b) { return a - b; });
    var core = rads[Math.floor(rads.length * 0.85)] || 220;

    var c3 = graph.camera();
    var fov = ((c3 && c3.fov ? c3.fov : 50) * Math.PI) / 180;
    var dist = Math.max(180, (core * 1.6) / Math.tan(fov / 2));

    var cam = graph.cameraPosition();
    var d = Math.hypot(cam.x - cx, cam.y - cy, cam.z - cz) || 1;
    var k = dist / d;
    ms = ms === undefined ? 1200 : ms;
    busyUntil = performance.now() + ms + 260;
    graph.cameraPosition({
      x: cx + (cam.x - cx) * k,
      y: cy + (cam.y - cy) * k,
      z: cz + (cam.z - cz) * k
    }, { x: cx, y: cy, z: cz }, ms);
  }
  graph.onEngineStop(function () { boot.classList.add('gone'); autoFrame(); });
  setTimeout(function () { boot.classList.add('gone'); }, 4000);
  setTimeout(autoFrame, 3500);
  setTimeout(autoFrame, 7000);
  requestAnimationFrame(tick);

  window.__galaxy = {
    graph: graph, select: select, groups: groups,
    voice: {
      get FINISH_MS() { return FINISH_MS; },
      setFinishMs: function (ms) { FINISH_MS = Math.max(0, ms | 0); return FINISH_MS; },
      muted: MUTED,
      interruptWords: INTERRUPT_WORDS,
      feedFinal: onFinal,                                  // drive the buffer directly
      peekBuffer: function () { return buffer; },
      pending: function () { return finishTimer !== null; },
      speak: speak,
      unlock: unlockAudio,
      isUnlocked: function () { return audioUnlocked; },
      hasRecognition: !!SR,
      state: function () {
        return {
          focused: focused, cited: citedIds.slice(),
          panelOpen: document.getElementById('panel').classList.contains('open'),
          panelTitle: document.getElementById('ptitle').textContent,
          cam: graph.cameraPosition()
        };
      },
      FLY_MAX_SOURCES: FLY_MAX_SOURCES,
      voiceName: function () {
        return chosenVoice ? chosenVoice.name + ' (' + chosenVoice.lang + ')' : null;
      },
      listVoices: function () {
        return (voices || []).map(function (v) { return v.name + ' | ' + v.lang; });
      }
    }
  };
})();
