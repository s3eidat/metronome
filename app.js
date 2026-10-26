/* Metronome — "two clocks" lookahead scheduling: a JS timer wakes often, WebAudio places each click at an exact sample time. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var MIN = 20, MAX = 300, LOOKAHEAD_MS = 25;

  // ---------- pure logic (tested in S3_SELFTEST) ----------
  function clampBpm(v) { v = Math.round(+v); return isFinite(v) ? Math.min(MAX, Math.max(MIN, v)) : 120; }
  // Advance the scheduler state {next, i} up to `until` seconds; returns the ticks to play.
  function advance(st, until, cfg) {
    var ev = [], per = cfg.beats * cfg.sub;
    while (st.next < until) {
      var beat = Math.floor(st.i / cfg.sub) % cfg.beats, s = st.i % cfg.sub;
      ev.push({ time: st.next, beat: beat, sub: s, bar: Math.floor(st.i / per), level: s ? "sub" : (cfg.pattern[beat] || "beat") });
      st.next += 60 / cfg.bpm / cfg.sub;
      st.i++;
    }
    return ev;
  }
  function tapBpm(times) {
    if (times.length < 2) return null;
    var t = times.slice(-8), sum = 0;
    for (var i = 1; i < t.length; i++) sum += t[i] - t[i - 1];
    return clampBpm(60000 / (sum / (t.length - 1)));
  }
  function tempoName(b) {
    return b < 40 ? "Grave" : b < 60 ? "Largo" : b < 66 ? "Larghetto" : b < 76 ? "Adagio" : b < 108 ? "Andante" : b < 120 ? "Moderato" : b < 156 ? "Allegro" : b < 176 ? "Vivace" : b < 200 ? "Presto" : "Prestissimo";
  }
  var VOICES = {
    click: { type: "triangle", f: { accent: 2400, beat: 1600, sub: 1100 }, dec: 0.035 },
    wood: { type: "sine", f: { accent: 1250, beat: 900, sub: 650 }, dec: 0.07, drop: 0.55 },
    beep: { type: "sine", f: { accent: 1320, beat: 880, sub: 660 }, dec: 0.1 }
  };
  var LEVEL_GAIN = { accent: 1, beat: 0.62, sub: 0.32 };
  function playTick(ctx, dest, time, level, sound, vol) {
    if (level === "mute" || vol <= 0) return;
    var v = VOICES[sound] || VOICES.click, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = v.type; o.frequency.setValueAtTime(v.f[level], time);
    if (v.drop) o.frequency.exponentialRampToValueAtTime(v.f[level] * v.drop, time + v.dec);
    g.gain.setValueAtTime(LEVEL_GAIN[level] * vol, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + v.dec);
    o.connect(g); g.connect(dest);
    o.start(time); o.stop(time + v.dec + 0.01);
  }

  // ---------- state ----------
  var S = Object.assign({ bpm: 120, beats: 4, unit: "4", sub: 1, sound: "click", vol: 80, pattern: null, accent1: true }, S3.store("metronome") || {});
  S.bpm = clampBpm(S.bpm);
  if (!Array.isArray(S.pattern) || S.pattern.length !== S.beats) S.pattern = makePattern(S.beats, S.pattern);
  var ctx = null, master = null, run = null, taps = [], queue = [], dots = [];
  function save() { S3.store("metronome", S); }
  function makePattern(n, old) {
    var p = []; for (var i = 0; i < n; i++) p.push(old && old[i] || (i === 0 && S.accent1 ? "accent" : "beat"));
    return p;
  }

  // ---------- UI ----------
  for (var b = 1; b <= 12; b++) $("#beatsPer").appendChild(S3.h("option", { value: b, text: b }));
  $("#beatsPer").value = S.beats; $("#unit").value = S.unit; $("#vol").value = S.vol; $("#accent1").checked = S.pattern[0] === "accent";
  [60, 80, 100, 120, 140, 160].forEach(function (q) { $("#quick").appendChild(S3.h("button", { "class": "btn small", text: q, onclick: function () { setBpm(q); } })); });
  function seg(el, value, onPick) {
    $$("button", el).forEach(function (bt) {
      bt.setAttribute("aria-pressed", String(bt.dataset.v === String(value)));
      bt.addEventListener("click", function () { $$("button", el).forEach(function (x) { x.setAttribute("aria-pressed", String(x === bt)); }); onPick(bt.dataset.v); });
    });
  }
  seg($("#sub"), S.sub, function (v) { S.sub = +v; save(); resync(); });
  seg($("#sound"), S.sound, function (v) { S.sound = v; save(); if (!run) preview(); });

  function renderDots() {
    var box = $("#beats"); box.innerHTML = ""; dots = [];
    S.pattern.forEach(function (lv, i) {
      var d = S3.h("button", { "class": "dot " + (lv === "beat" ? "" : lv), "aria-label": "Beat " + (i + 1) + ": " + (lv === "beat" ? "normal" : lv), text: i + 1 });
      d.addEventListener("click", function () {
        S.pattern[i] = { accent: "beat", beat: "mute", mute: "accent" }[S.pattern[i]];
        if (i === 0) $("#accent1").checked = S.pattern[0] === "accent";
        save(); renderDots();
      });
      box.appendChild(d); dots.push(d);
    });
  }
  function setBpm(v) {
    S.bpm = clampBpm(v);
    if (document.activeElement !== $("#bpm")) $("#bpm").value = S.bpm;
    $("#slider").value = S.bpm; $("#tname").textContent = tempoName(S.bpm);
    save();
  }

  $("#bpm").addEventListener("input", function () { var v = +this.value; if (v >= MIN && v <= MAX) setBpm(v); });
  $("#bpm").addEventListener("change", function () { setBpm(this.value); this.value = S.bpm; });
  $("#bpm").addEventListener("keydown", function (e) { if (e.key === "Enter") this.blur(); });
  $("#slider").addEventListener("input", function () { setBpm(this.value); });
  $("#minus").addEventListener("click", function () { setBpm(S.bpm - 1); });
  $("#plus").addEventListener("click", function () { setBpm(S.bpm + 1); });
  $("#beatsPer").addEventListener("change", function () { S.beats = +this.value; S.pattern = makePattern(S.beats, S.pattern); save(); renderDots(); resync(); });
  $("#unit").addEventListener("change", function () { S.unit = this.value; save(); });
  $("#vol").addEventListener("input", function () { S.vol = +this.value; save(); });
  $("#accent1").addEventListener("change", function () { S.accent1 = this.checked; S.pattern[0] = this.checked ? "accent" : "beat"; save(); renderDots(); });

  function tap() {
    var now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    var bpm = tapBpm(taps);
    $("#tap").textContent = bpm ? "Tap · " + bpm : "Tap again…";
    if (bpm) setBpm(bpm);
    clearTimeout(tap.t); tap.t = setTimeout(function () { $("#tap").textContent = "Tap tempo"; }, 2200);
  }
  $("#tap").addEventListener("click", tap);

  // ---------- audio engine ----------
  function ensureCtx() {
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" }); master = ctx.createGain(); master.connect(ctx.destination); }
    return ctx.resume();
  }
  function preview() { ensureCtx().then(function () { playTick(ctx, master, ctx.currentTime + 0.02, "accent", S.sound, S.vol / 100); }); }
  function cfg() { return { bpm: S.bpm, beats: S.beats, sub: S.sub, pattern: S.pattern }; }
  function resync() { if (run) run.st.i = 0; } // rhythm changed: restart the bar at the next tick
  function pump() {
    if (!run) return;
    var ahead = document.hidden ? 1.2 : 0.12; // background tabs throttle timers to ~1 s
    advance(run.st, ctx.currentTime + ahead, cfg()).forEach(function (e) {
      playTick(ctx, master, e.time, e.level, S.sound, S.vol / 100);
      queue.push(e);
    });
  }
  function draw() {
    if (!run) return;
    var now = ctx.currentTime;
    while (queue.length && queue[0].time <= now) {
      var e = queue.shift();
      dots.forEach(function (d, i) { d.classList.toggle("on", i === e.beat && e.sub === 0); d.classList.toggle("sub", i === e.beat && e.sub > 0); });
      if (e.sub === 0) {
        $("#pos").textContent = "Bar " + (e.bar + 1) + " · Beat " + (e.beat + 1);
        var bp = $("#bpm"); bp.classList.add("pulse"); setTimeout(function () { bp.classList.remove("pulse"); }, 90);
      }
    }
    var t = Math.max(0, now - run.t0);
    $("#elapsed").textContent = Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
    requestAnimationFrame(draw);
  }
  async function start() {
    await ensureCtx();
    var t0 = ctx.currentTime + 0.06;
    run = { st: { next: t0, i: 0 }, t0: t0, timer: setInterval(pump, LOOKAHEAD_MS) };
    queue = []; pump(); requestAnimationFrame(draw);
    $("#toggle span").textContent = "Stop"; $("#toggle use").setAttribute("href", "#i-pause");
    S3.done();
  }
  function stop() {
    if (!run) return;
    clearInterval(run.timer); run = null; queue = [];
    master.disconnect(); master = ctx.createGain(); master.connect(ctx.destination); // cut already-scheduled clicks
    dots.forEach(function (d) { d.classList.remove("on", "sub"); });
    $("#toggle span").textContent = "Start"; $("#toggle use").setAttribute("href", "#i-play");
  }
  $("#toggle").addEventListener("click", function () { if (run) stop(); else start(); });
  document.addEventListener("visibilitychange", pump);

  document.addEventListener("keydown", function (e) {
    var tag = e.target.tagName;
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(tag) && e.target.type !== "checkbox") return;
    if (e.key === " " && tag !== "BUTTON") { e.preventDefault(); $("#toggle").click(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); setBpm(S.bpm + (e.shiftKey ? 5 : 1)); }
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); setBpm(S.bpm - (e.shiftKey ? 5 : 1)); }
    else if (e.key === "t" || e.key === "T") { e.preventDefault(); tap(); }
  });

  renderDots(); setBpm(S.bpm);

  // ---------- demo + self-test ----------
  window.S3_DEMO = function () {
    setBpm(96);
    $$("#sub button")[1].click();
    S.pattern = ["accent", "beat", "beat", "beat"]; renderDots();
    dots[2].classList.add("on"); $("#pos").textContent = "Bar 9 · Beat 3"; $("#elapsed").textContent = "0:20";
    $("#toggle span").textContent = "Stop"; $("#toggle use").setAttribute("href", "#i-pause");
  };

  window.S3_SELFTEST = async function () {
    function near(a, b, e) { return Math.abs(a - b) < (e || 1e-9); }
    var st = { next: 0, i: 0 }, ev = advance(st, 2, { bpm: 120, beats: 4, sub: 1, pattern: ["accent", "beat", "mute", "beat"] });
    var ok = ev.length === 4 && ev.every(function (e, k) { return near(e.time, k * 0.5); }) &&
      ev.map(function (e) { return e.level; }).join() === "accent,beat,mute,beat" && near(st.next, 2);
    var more = advance(st, 2.6, { bpm: 120, beats: 4, sub: 1, pattern: ["accent", "beat", "beat", "beat"] });
    ok = ok && more.length === 2 && more[0].bar === 1 && more[0].beat === 0 && more[0].level === "accent";
    var tri = advance({ next: 0, i: 0 }, 1.34, { bpm: 90, beats: 3, sub: 3, pattern: ["accent", "beat", "beat"] });
    ok = ok && tri.length === 7 && near(tri[1].time, 60 / 90 / 3) && tri[1].level === "sub" && tri[3].beat === 1 && tri[3].level === "beat" && tri[6].beat === 2;
    // 1000 beats at 300 BPM: no drift beyond float noise
    var long = { next: 0, i: 0 }; advance(long, 199.9, { bpm: 300, beats: 4, sub: 1, pattern: [] });
    ok = ok && long.i === 1000 && near(long.next, 200, 1e-9);
    ok = ok && tapBpm([0, 500, 1000, 1500]) === 120 && tapBpm([0, 1000]) === 60 && tapBpm([5]) === null && tapBpm([0, 10]) === 300;
    ok = ok && clampBpm(5) === 20 && clampBpm(999) === 300 && clampBpm("abc") === 120 && tempoName(120) === "Allegro" && tempoName(70) === "Adagio";
    // Render 2 s offline and find each click onset: must land on the scheduled sample.
    var rate = 22050, off = new OfflineAudioContext(1, rate * 2, rate);
    advance({ next: 0, i: 0 }, 2, { bpm: 120, beats: 4, sub: 1, pattern: ["accent", "beat", "beat", "beat"] })
      .forEach(function (e) { playTick(off, off.destination, e.time, e.level, "click", 0.8); });
    var x = (await off.startRendering()).getChannelData(0), onsets = [], quiet = 0;
    for (var i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) > 0.01) { if (quiet > 200 || !onsets.length && i < 50) onsets.push(i); quiet = 0; } else quiet++;
    }
    ok = ok && onsets.length === 4 && onsets.every(function (s, k) { return Math.abs(s - k * rate / 2) <= 3; });
    return ok;
  };
})();
