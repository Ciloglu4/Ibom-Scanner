/*
 * ibom-scanner: barcode / camera part finder for InteractiveHtmlBom pages.
 * Injected into an iBOM .html by ibom_scanner.py. Runs after iBOM has initialised and
 * builds its part list from the iBOM's own data, so it works for any board.
 * https://github.com/ (see README)
 */
(function () {
  "use strict";
  var CFG = window.__IBOM_SCANNER_CFG__ || {};
  var $ = function (id) { return document.getElementById(id); };
  var norm = function (s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ================= parts list from the iBOM itself =================
  if (typeof pcbdata === "undefined" || !pcbdata.bom || !pcbdata.bom.both) return;
  var groups = pcbdata.bom.both;
  if (!groups.length || !Array.isArray(groups[0]) || !Array.isArray(groups[0][0])) {
    alert("ibom-scanner: this iBOM was made with a very old InteractiveHtmlBom version. Regenerate it with v2.4 or newer.");
    return;
  }
  var fieldNames = (typeof config !== "undefined" && config.fields) || [];
  var FI = {
    mpn: CFG.mpnField, mfr: CFG.mfrField,
    value: fieldNames.indexOf("Value"), fp: fieldNames.indexOf("Footprint")
  };
  function fieldOf(fpIndex, i) {
    if (i == null || i < 0) return "";
    var f = pcbdata.bom.fields[fpIndex];
    return f && f[i] != null ? String(f[i]) : "";
  }
  var EXTRAS = {}; // normalized MPN -> {alts:[], note:""}
  (CFG.extras || []).forEach(function (e) { if (norm(e.mpn)) EXTRAS[norm(e.mpn)] = e; });

  var refIdx = {};
  pcbdata.footprints.forEach(function (f, i) { refIdx[f.ref] = i; });
  function layerOf(r) { return pcbdata.footprints[refIdx[r]].layer; }
  var SIDE = CFG.side || null; // "F", "B" or null (both)
  var SIDE_NAME = { F: "TOP", B: "BOTTOM" };

  var LINES = [], OTHER_SIDE = [], ROWLABEL = {};
  groups.forEach(function (g, gi) {
    var fpIndex = g[0][1];
    var refs = g.map(function (x) { return x[0]; });
    refs.forEach(function (r) { ROWLABEL[r] = gi + 1; });
    var mpn = fieldOf(fpIndex, FI.mpn).trim();
    var ex = EXTRAS[norm(mpn)] || {};
    var l = {
      id: gi, num: gi + 1, refs: refs, mpn: mpn, mfr: fieldOf(fpIndex, FI.mfr),
      value: fieldOf(fpIndex, FI.value), fp: fieldOf(fpIndex, FI.fp).split(":").pop(),
      alts: ex.alts || [], note: ex.note || ""
    };
    if (SIDE) {
      var mine = refs.filter(function (r) { return layerOf(r) === SIDE; });
      if (!mine.length) { if (mpn) OTHER_SIDE.push(mpn); return; }
      l.refs = mine;
    }
    l.qty = l.refs.length;
    LINES.push(l);
  });
  // keep the row numbers of the full (front + back) table when only one side is shown,
  // so numbers written on bags stay valid in both views
  if (SIDE) window.__ibomScannerRowLabel = function (entry) {
    return Array.isArray(entry) && Array.isArray(entry[0]) ? ROWLABEL[entry[0][0]] : undefined;
  };

  // MPN (and listed alternates) -> [{line, alt}]; one MPN can sit on several rows
  var index = {};
  LINES.forEach(function (l) {
    if (!l.mpn) return;
    var base = l.mpn.match(/^(.*),\s*\d{3}$/); // Nexperia/NXP packing code: "PESD5V0L5UF,115"
    [{ k: norm(l.mpn), alt: false }]
      .concat(base ? [{ k: norm(base[1]), alt: false }] : [])
      .concat(l.alts.map(function (a) { return { k: norm(a), alt: true }; }))
      .forEach(function (e) { if (e.k) (index[e.k] = index[e.k] || []).push({ line: l, alt: e.alt }); });
  });
  var KEYS = Object.keys(index).sort(function (a, b) { return b.length - a.length; });
  function linesFor(hits) { var ls = []; hits.forEach(function (h) { if (ls.indexOf(h.line) < 0) ls.push(h.line); }); return ls; }
  function groupId(k) { return linesFor(index[k]).map(function (l) { return l.id; }).sort().join(","); }

  function lookup(mpn) {
    var k = norm(mpn);
    if (!k) return null;
    if (index[k]) return { exact: true, key: k };
    var m0 = String(mpn).toUpperCase().match(/^(.*),\s*\d{3}$/);
    if (m0 && index[norm(m0[1])]) return { exact: true, key: norm(m0[1]) };
    // scanned = BOM MPN + ordering/packing suffix (-TR, RPWR, ...) or a truncated BOM MPN
    var seen = {}, cands = [];
    KEYS.forEach(function (c) {
      if (c.length >= 6 && (k.indexOf(c) === 0 || (k.length >= 6 && c.indexOf(k) === 0))) {
        var g = groupId(c); if (!seen[g]) { seen[g] = 1; cands.push(c); }
      }
    });
    if (cands.length === 1) return { exact: false, key: cands[0] };
    if (cands.length > 1) return { ambiguous: true, keys: cands };
    var m = String(mpn).match(/^\d{2,4}-(.+)$/); // Mouser P/N "595-TPS7A2033PDBVR"
    if (m) return lookup(m[1]);
    return null;
  }
  // last resort: a BOM part number appears somewhere inside the raw scan
  function findInRaw(raw) {
    var r = norm(raw);
    for (var i = 0; i < KEYS.length; i++) if (KEYS[i].length >= 7 && r.indexOf(KEYS[i]) >= 0) return KEYS[i];
    return null;
  }

  // ================= barcode parsing =================
  // ECIA / ANSI MH10.8.2 2D labels (Mouser, Digi-Key, ...): [)> RS 06 GS 1P<mpn> GS Q<qty> ... RS EOT
  function parseScan(text) {
    var t = String(text).replace(/^\s+|\s+$/g, "");
    var out = { raw: t, mpn: null, qty: null };
    if (/^\[\)>/.test(t) || /[\x1d\x1e]/.test(t)) {
      var body = t.replace(/^\[\)>\x1e?(06)?\x1d?/, "").replace(/[\x1e\x04]+$/, "");
      body.split(/[\x1d\x1e]/).forEach(function (f) {
        var m = f.match(/^(\d{0,3}[A-Z])(.*)$/);
        if (!m) return;
        if (m[1] === "1P") out.mpn = m[2];
        else if (m[1] === "Q") out.qty = parseInt(m[2], 10);
      });
      return out;
    }
    if (/^1P/.test(t)) { out.mpn = t.slice(2); return out; }
    if (/^Q\s*\d+$/i.test(t)) { out.qty = parseInt(t.replace(/\D/g, ""), 10); return out; }
    out.mpn = t;
    out.otherField = /^(K|1K|10K|11K|14K|4L|9D|10D|1T|11Z|12Z|13Z|20Z)[A-Z0-9]/.test(t);
    return out;
  }

  // ================= checked state =================
  // Uses one of the iBOM's own checkbox columns (default "Sourced") so ticks show in the
  // table and are included in the iBOM's settings export. Falls back to private storage.
  var boxes = (typeof settings !== "undefined" && settings.checkboxes) || [];
  var CHECKBOX = CFG.checkbox && boxes.indexOf(CFG.checkbox) >= 0 ? CFG.checkbox
    : boxes.indexOf("Sourced") >= 0 ? "Sourced" : (boxes[0] || null);
  function getChecked() {
    if (CHECKBOX) return getStoredCheckboxRefs(CHECKBOX);
    var s = readStorage("scanner_checked");
    return new Set(s ? s.split(",").filter(Boolean).map(Number) : []);
  }
  function setChecked(s) {
    var v = Array.from(s).join(",");
    if (CHECKBOX) {
      settings.checkboxStoredRefs[CHECKBOX] = v;
      writeStorage("checkbox_" + CHECKBOX, v);
      if (typeof updateCheckboxStats === "function") updateCheckboxStats(CHECKBOX);
    } else writeStorage("scanner_checked", v);
  }
  function lineDone(l) { var s = getChecked(); return l.refs.every(function (r) { return s.has(refIdx[r]); }); }
  function markLines(ls) {
    var s = getChecked();
    ls.forEach(function (l) { l.refs.forEach(function (r) { s.add(refIdx[r]); }); });
    setChecked(s);
  }
  function showOnBoard(ls) {
    var f = $("filter"), q = ls[0].mpn || ls[0].refs[0];
    f.value = q; updateFilter(q);
    var all = [];
    ls.forEach(function (l) { l.refs.forEach(function (r) { all.push(refIdx[r]); }); });
    highlightedFootprints = all;
    drawHighlights();
  }

  // ================= UI =================
  var st = document.createElement("style"); st.textContent = window.__IBOM_SCANNER_CSS__ || ""; document.head.appendChild(st);
  var p = document.createElement("div");
  p.id = "scanpanel";
  p.innerHTML =
    '<div class="sp-head"><b>Part scanner</b>' +
    (SIDE ? '<span class="sp-sidebadge sp-side' + SIDE + '">' + SIDE_NAME[SIDE] + " side</span>" : "") +
    '<span class="sp-prog" id="sp-prog"></span><button id="sp-min" title="Collapse">–</button></div>' +
    '<div class="sp-body">' +
    '<div class="sp-cam"><video id="sp-video" playsinline muted></video><div class="sp-camoff" id="sp-camoff">Camera off</div></div>' +
    '<div class="sp-row"><button id="sp-camtoggle">Start camera</button><select id="sp-camsel"></select>' +
    '<label class="sp-mirror"><input type="checkbox" id="sp-mirror" checked> mirror</label></div>' +
    '<div class="sp-row"><input id="sp-input" type="text" placeholder="Type MPN or use USB scanner, Enter" autocomplete="off"></div>' +
    '<div id="sp-result" class="sp-result sp-idle">Show the label to the camera: the square 2D code (Mouser / Digi-Key) or the P/N barcode.</div>' +
    '<div class="sp-row"><button id="sp-missing">Show unchecked lines</button><button id="sp-clear">Clear filter</button></div>' +
    '<div id="sp-list" class="sp-list" hidden></div></div>';
  document.body.appendChild(p);
  var video = $("sp-video"), resultEl = $("sp-result");

  // USB 2D scanners type the label like a keyboard; separators arrive as Ctrl+] (GS), Ctrl+^ (RS), Ctrl+D (EOT)
  var CTRL_MAP = { "]": "\x1d", "^": "\x1e", "6": "\x1e", "d": "\x04", "D": "\x04" };
  $("sp-input").addEventListener("keydown", function (e) {
    e.stopPropagation(); // keep iBOM's shortcuts (n, arrows) out of this box
    if (e.ctrlKey && !e.altKey && CTRL_MAP[e.key] !== undefined) {
      e.preventDefault();
      var t = e.target, a = t.selectionStart, b = t.selectionEnd;
      t.value = t.value.slice(0, a) + CTRL_MAP[e.key] + t.value.slice(b);
      t.selectionStart = t.selectionEnd = a + 1;
      return;
    }
    if (e.key === "Enter") { handleScan(e.target.value); e.target.value = ""; e.target.blur(); }
  });
  // scanner typing while focus is elsewhere: redirect fast key bursts to our box.
  // A single slow key is left to iBOM, so "n" and the arrow keys keep working.
  var lastKeyT = 0, pending = null;
  document.addEventListener("keydown", function (e) {
    var now = Date.now(), burst = now - lastKeyT < 40;
    lastKeyT = now;
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) { pending = null; return; }
    if (!burst) { pending = e.key; return; }
    e.preventDefault(); e.stopPropagation();
    var inp = $("sp-input");
    inp.focus();
    inp.value = (pending || "") + inp.value + e.key;
    pending = null;
  }, true);

  $("sp-min").onclick = function () { p.classList.toggle("sp-collapsed"); };
  $("sp-clear").onclick = function () { $("filter").value = ""; updateFilter(""); };
  $("sp-mirror").onchange = function () { video.classList.toggle("sp-nomirror", !this.checked); };

  function updateProgress() {
    $("sp-prog").textContent = LINES.filter(lineDone).length + " / " + LINES.length + " lines checked";
    if (!$("sp-list").hidden) renderMissing();
  }
  function beep(ok) {
    try {
      var a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
      o.frequency.value = ok ? 1320 : 330; g.gain.value = 0.08;
      o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? 0.08 : 0.25));
    } catch (e) {}
  }
  function render(state, html) { resultEl.className = "sp-result sp-" + state; resultEl.innerHTML = html; }

  var last = null; // last matched part, so a separate "Q" barcode can fill in the bag quantity

  function showLines(ls, scan, partial, altUsed) {
    var need = ls.reduce(function (s, l) { return s + l.qty; }, 0);
    var bag = scan.qty, enough = bag == null ? null : bag >= need;
    var h = "";
    if (partial) h += '<div class="sp-flag">Partial match: scanned <code>' + esc(scan.mpn) + "</code>, BOM has <code>" + esc(ls[0].mpn) + "</code>. Check it's the same part.</div>";
    if (altUsed) h += '<div class="sp-flag">Replacement <code>' + esc(scan.mpn) + "</code> for BOM <code>" + esc(ls[0].mpn) + "</code>.</div>";
    h += '<div class="sp-big"><span class="sp-val">' + esc(ls[0].value || ls[0].mpn) + '</span> <span class="sp-need">need <b>' + need + "</b>" +
      (bag != null ? " · bag <b>" + bag + "</b> " + (enough ? "✓" : "✗ not enough") : "") + "</span></div>";
    h += '<div class="sp-mpn"><code>' + esc(ls[0].mpn || "(no part number)") + "</code>" + (ls[0].mfr ? " · " + esc(ls[0].mfr) : "") +
      '</div><div class="sp-fp">' + esc(ls[0].fp) + "</div>";
    ls.forEach(function (l) {
      var top = l.refs.filter(function (r) { return layerOf(r) === "F"; }), bot = l.refs.filter(function (r) { return layerOf(r) !== "F"; });
      h += '<div class="sp-line">Row ' + l.num + "</div>";
      if (top.length) h += '<div class="sp-side"><span class="sp-tag">Top ' + top.length + '</span><span class="sp-refs">' + top.join(", ") + "</span></div>";
      if (bot.length) h += '<div class="sp-side"><span class="sp-tag sp-bot">Bottom ' + bot.length + '</span><span class="sp-refs">' + bot.join(", ") + "</span></div>";
      if (l.note) h += '<div class="sp-note">Note: ' + esc(l.note) + "</div>";
    });
    if (partial) h += '<button id="sp-accept">Same part, mark checked</button>';
    render(partial ? "warn" : (enough === false ? "bad" : "ok"), h);
    if (partial) $("sp-accept").onclick = function () { markLines(ls); showOnBoard(ls); updateProgress(); this.remove(); };
  }

  function select(key, scan, exact) {
    var hits = index[key], ls = linesFor(hits);
    var altUsed = exact && norm(scan.mpn) === key && hits.every(function (h) { return h.alt; });
    last = { lines: ls, scan: scan, partial: !exact, altUsed: altUsed };
    if (exact) markLines(ls);
    showOnBoard(ls);
    showLines(ls, scan, !exact, altUsed);
    updateProgress();
    beep(exact);
  }

  function otherSideHit(scan) {
    if (!SIDE || !scan.mpn) return null;
    var nn = norm(scan.mpn), raw = norm(scan.raw);
    return OTHER_SIDE.filter(function (m) { var k = norm(m); return k.length >= 6 && (nn === k || nn.indexOf(k) === 0 || raw.indexOf(k) >= 0); })[0] || null;
  }

  function handleScan(text) {
    var scan = parseScan(text);
    if (!scan.raw) return;
    if (!scan.mpn && scan.qty != null) {
      if (last) { last.scan.qty = scan.qty; showLines(last.lines, last.scan, last.partial, last.altUsed); beep(true); }
      return;
    }
    var res = lookup(scan.mpn);
    if (!res || res.ambiguous) {
      var hit = findInRaw(scan.raw);
      if (hit) { scan.mpn = hit; res = { exact: true, key: hit }; }
    }
    if (res && res.ambiguous) {
      var h = '<div class="sp-big">Several BOM parts fit</div><div class="sp-mpn">Scanned <code>' + esc(scan.mpn) + "</code>, pick one:</div>";
      res.keys.forEach(function (k) { var l = index[k][0].line; h += '<button class="sp-pick" data-k="' + k + '">' + esc(l.value) + " · " + esc(l.mpn) + "</button>"; });
      render("warn", h);
      Array.prototype.forEach.call(resultEl.querySelectorAll(".sp-pick"), function (b) {
        b.onclick = function () { select(this.getAttribute("data-k"), scan, false); };
      });
      beep(false);
      return;
    }
    if (!res) {
      var o = otherSideHit(scan);
      if (o) {
        last = null;
        render("warn", '<div class="sp-big">Not on this side</div><div class="sp-mpn"><code>' + esc(o) + "</code> only goes on the " +
          (SIDE === "F" ? "BOTTOM" : "TOP") + " side. Put the bag aside for that pass.</div>");
        beep(false);
        return;
      }
    }
    if (!res && scan.otherField) {
      render("idle", "Ignored a non-part barcode (<code>" + esc(scan.raw) + "</code>). Scan the 2D code or the MFG P/N barcode.");
      return;
    }
    if (!res) {
      last = null;
      render("bad", '<div class="sp-big">Not in this BOM</div><div class="sp-mpn"><code>' + esc(scan.mpn || scan.raw) + "</code>" +
        (scan.qty != null ? " · bag " + scan.qty : "") + '</div><div class="sp-note">Wrong bag, a part not fitted on this board, or a replacement that is not in the extras file.</div>');
      beep(false);
      return;
    }
    select(res.key, scan, res.exact);
  }

  function renderMissing() {
    var miss = LINES.filter(function (l) { return !lineDone(l); });
    var el = $("sp-list");
    el.innerHTML = miss.length ? "" : "<div style='padding:6px'>Everything checked.</div>";
    miss.forEach(function (l) {
      var d = document.createElement("div");
      d.className = "sp-mrow";
      d.innerHTML = "<span>" + l.num + "</span><span>" + esc(l.value) + "</span><code>" + esc(l.mpn || "–") + "</code><span>×" + l.qty + "</span>";
      d.title = "Click: show on board. Double-click: mark checked by hand.";
      d.onclick = function () { last = null; showOnBoard([l]); showLines([l], { mpn: l.mpn, qty: null }, false, false); };
      d.ondblclick = function () { markLines([l]); populateBomTable(); updateProgress(); };
      el.appendChild(d);
    });
  }
  $("sp-missing").onclick = function () {
    var el = $("sp-list");
    el.hidden = !el.hidden;
    this.textContent = el.hidden ? "Show unchecked lines" : "Hide unchecked lines";
    if (!el.hidden) renderMissing();
  };

  // ================= camera =================
  // zxing-cpp (WebAssembly, embedded in the page). 2D label codes are always used; 1D codes and
  // other QR codes are only used when they match the BOM, so PO / invoice / website codes on a
  // label are ignored silently.
  var stream = null, timer = null, lastText = "", lastTime = 0;
  var canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
  var READ_OPTS = { formats: ["DataMatrix", "QRCode", "Code128"], tryHarder: true, tryRotate: true, tryInvert: false,
                    tryDownscale: true, maxNumberOfSymbols: 8, textMode: "Plain" };
  function matchesBom(t) { var s = parseScan(t); var r = s.mpn && lookup(s.mpn); return !!((r && !r.ambiguous) || findInRaw(t) || otherSideHit(s)); }
  function pick(results) {
    var ok = results.filter(function (r) { return r.isValid && r.text; });
    for (var i = 0; i < ok.length; i++) if (/^\[\)>/.test(ok[i].text) || /[\x1d\x1e]/.test(ok[i].text)) return ok[i].text;
    for (i = 0; i < ok.length; i++) if (matchesBom(ok[i].text)) return ok[i].text;
    return null;
  }
  var decoderReady = (function () {
    try {
      var bin = Uint8Array.from(atob(window.__ZXING_WASM_B64__), function (c) { return c.charCodeAt(0); });
      return ZXingWASM.prepareZXingModule({ overrides: { wasmBinary: bin.buffer }, fireImmediately: true });
    } catch (e) { return Promise.reject(e); }
  })();
  decoderReady.catch(function (e) { render("bad", "Barcode decoder failed to load: " + esc(e)); });

  function gotText(t) {
    var now = Date.now();
    if (t === lastText && now - lastTime < 4000) return;
    lastText = t; lastTime = now;
    handleScan(t);
  }
  // also try a slightly blurred copy: thermal-printed labels (missing dots, glare through the bag)
  // often only decode once the print texture is smoothed out
  var bcanvas = document.createElement("canvas"), bctx = bcanvas.getContext("2d", { willReadFrequently: true });
  var pass = 0;
  function tick() {
    if (!stream || video.readyState < 2) return Promise.resolve();
    var w = video.videoWidth, h = video.videoHeight;
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0);
    var tries = [ctx.getImageData(0, 0, w, h)];
    var b = [1, 1.5][pass++ % 2];
    bcanvas.width = w; bcanvas.height = h;
    bctx.filter = "blur(" + b + "px)"; bctx.drawImage(canvas, 0, 0); bctx.filter = "none";
    tries.push(bctx.getImageData(0, 0, w, h));
    function next(i) {
      if (i >= tries.length) return Promise.resolve();
      return ZXingWASM.readBarcodes(tries[i], READ_OPTS).then(function (r) {
        var t = pick(r);
        if (t) gotText(t); else return next(i + 1);
      });
    }
    return next(0);
  }
  function loop() {
    if (!stream) return;
    decoderReady.then(tick).catch(function () {}).then(function () { if (stream) timer = setTimeout(loop, 80); });
  }
  function listCams() {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devs) {
      var sel = $("sp-camsel"), cur = sel.value;
      sel.innerHTML = "";
      devs.filter(function (d) { return d.kind === "videoinput"; }).forEach(function (d, i) {
        var o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || ("Camera " + (i + 1));
        sel.appendChild(o);
      });
      if (cur) sel.value = cur;
    });
  }
  function startCam() {
    if (!navigator.mediaDevices) { render("bad", "No camera access in this browser. Open the file in Chrome or Edge."); return; }
    var id = $("sp-camsel").value;
    var c = { video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };
    if (id) c.video.deviceId = { exact: id };
    navigator.mediaDevices.getUserMedia(c).then(function (s) {
      stream = s; video.srcObject = s; video.play();
      $("sp-camoff").hidden = true; $("sp-camtoggle").textContent = "Stop camera";
      loop(); listCams();
    }).catch(function (e) {
      render("bad", "Camera error: " + esc(e.name || e) + '.<div class="sp-note">If the browser blocks the camera for a local file, run <code>python -m http.server</code> in this folder and open localhost:8000.</div>');
    });
  }
  function stopCam() {
    clearTimeout(timer); timer = null;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; $("sp-camoff").hidden = false; $("sp-camtoggle").textContent = "Start camera";
  }
  $("sp-camtoggle").onclick = function () { stream ? stopCam() : startCam(); };
  $("sp-camsel").onchange = function () { if (stream) { stopCam(); startCam(); } };

  if (SIDE && typeof changeCanvasLayout === "function") { try { changeCanvasLayout(SIDE); } catch (e) {} }
  listCams();
  updateProgress();
  window.__scanTest = handleScan; // for testing from the browser console
})();
