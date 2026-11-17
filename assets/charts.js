// 輕量的 SVG 圖表：時間折線圖與長條圖。不依賴外部函式庫。
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const HOUR = 3600e3;
  const TPE = 8 * HOUR; // 一律用台灣時間顯示，不受瀏覽者所在時區影響

  function svgEl(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function tp(ms) {
    const d = new Date(ms + TPE);
    return { m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), wd: '日一二三四五六'[d.getUTCDay()] };
  }

  // 找一組好讀的刻度：回傳 [最小, 最大, 間距]
  function niceScale(min, max, zeroBased) {
    if (zeroBased) min = 0;
    if (!(max > min)) max = min + 1;
    const raw = (max - min) / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(function (m) { return m * pow; }).find(function (s) { return s >= raw; });
    return [Math.floor(min / step) * step, Math.ceil(max / step) * step, step];
  }

  function fmtNum(v) {
    return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  }

  // 共用骨架：SVG、提示框、隨寬度重畫
  function mount(container, height, draw) {
    container.classList.add('chart');
    container.textContent = '';
    const svg = svgEl('svg', { role: 'img', tabindex: '0' }, container);
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    container.appendChild(tip);
    let lastWidth = 0;
    function render() {
      const width = Math.floor(container.clientWidth);
      if (!width || width === lastWidth) return;
      lastWidth = width;
      svg.textContent = '';
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.setAttribute('height', height);
      tip.hidden = true;
      draw(svg, tip, width);
    }
    render();
    if (window.ResizeObserver) new ResizeObserver(render).observe(container);
    else window.addEventListener('resize', render);
  }

  function showTip(tip, container, x, value, label) {
    tip.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = value;
    tip.appendChild(strong);
    tip.appendChild(document.createTextNode(label));
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(container.clientWidth - w, x - w / 2)) + 'px';
  }

  function yAxis(svg, scale, y, left, right, unit) {
    for (let v = scale[0]; v <= scale[1] + scale[2] / 2; v += scale[2]) {
      svgEl('line', { x1: left, x2: right, y1: y(v), y2: y(v), stroke: v === scale[0] ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
      svgEl('text', { x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmtNum(v);
    }
    if (unit) svgEl('text', { x: left - 8, y: y(scale[1]) - 12, 'text-anchor': 'end' }, svg).textContent = unit;
  }

  /**
   * 時間折線圖（單一數列）。
   * opts: points [{t: 毫秒, v: 數值或 null}], color, unit, area, zeroBased, now, height, yMax, label
   */
  function timeChart(container, opts) {
    const pts = opts.points.filter(function (p) { return p.v != null; });
    if (pts.length < 2) { container.textContent = '尚無資料'; return; }
    const height = opts.height || 240;
    const t0 = opts.points[0].t, t1 = opts.points[opts.points.length - 1].t;
    const values = pts.map(function (p) { return p.v; });
    const scale = niceScale(Math.min.apply(null, values), Math.max(opts.yMax || -Infinity, Math.max.apply(null, values)), opts.zeroBased);
    const days = (t1 - t0) / (24 * HOUR);

    mount(container, height, function (svg, tip, width) {
      const left = 44, right = width - 12, top = 26, bottom = height - 30;
      const x = function (t) { return left + (t - t0) / (t1 - t0) * (right - left); };
      const y = function (v) { return bottom - (v - scale[0]) / (scale[1] - scale[0]) * (bottom - top); };
      svg.setAttribute('aria-label', opts.label || '');
      yAxis(svg, scale, y, left, right, opts.unit);

      // 橫軸：短期間每 6 小時一格，長期間每幾天一格
      const firstMidnight = Math.ceil((t0 + TPE) / (24 * HOUR)) * 24 * HOUR - TPE;
      if (days <= 4.5) {
        const narrow = (right - left) / (days * 4) < 90; // 太擠時只標 12 時，避免和日期重疊
        for (let t = Math.ceil((t0 + TPE) / (6 * HOUR)) * 6 * HOUR - TPE; t <= t1; t += 6 * HOUR) {
          const c = tp(t);
          if (c.h === 0) svgEl('line', { x1: x(t), x2: x(t), y1: top, y2: bottom, stroke: 'var(--axis)', 'stroke-width': 1 }, svg);
          if (narrow && c.h % 12 !== 0) continue;
          const atEnd = x(t) > right - 60;
          const anchor = c.h !== 0 ? 'middle' : atEnd ? 'end' : 'start';
          svgEl('text', { x: x(t) + (c.h !== 0 ? 0 : atEnd ? 0 : 4), y: bottom + 18, 'text-anchor': anchor }, svg).textContent =
            c.h === 0 ? c.m + '/' + c.d + '（' + c.wd + '）' : c.h + ' 時';
        }
      } else {
        const every = Math.max(1, Math.ceil(days / Math.max(2, Math.floor((right - left) / 64))));
        for (let t = firstMidnight, i = 0; t <= t1; t += 24 * HOUR, i++) {
          if (i % every) continue;
          const c = tp(t);
          svgEl('line', { x1: x(t), x2: x(t), y1: bottom, y2: bottom + 4, stroke: 'var(--axis)', 'stroke-width': 1 }, svg);
          svgEl('text', { x: x(t), y: bottom + 18, 'text-anchor': x(t) > right - 20 ? 'end' : 'middle' }, svg).textContent = c.m + '/' + c.d;
        }
      }

      // 資料有缺漏的地方斷開，不硬連
      const gap = 2.5 * (t1 - t0) / Math.max(1, opts.points.length - 1);
      const segments = [];
      pts.forEach(function (p, i) {
        if (i === 0 || p.t - pts[i - 1].t > gap) segments.push([]);
        segments[segments.length - 1].push(p);
      });
      segments.forEach(function (seg) {
        const line = seg.map(function (p, i) { return (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join('');
        if (opts.area && seg.length > 1) {
          svgEl('path', { d: line + 'L' + x(seg[seg.length - 1].t).toFixed(1) + ' ' + bottom + 'L' + x(seg[0].t).toFixed(1) + ' ' + bottom + 'Z', fill: opts.color, 'fill-opacity': 0.12 }, svg);
        }
        svgEl('path', { d: line, fill: 'none', stroke: opts.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      });

      if (opts.now && opts.now > t0 && opts.now < t1) {
        svgEl('line', { x1: x(opts.now), x2: x(opts.now), y1: top - 6, y2: bottom, stroke: 'var(--text-2)', 'stroke-width': 1 }, svg);
        svgEl('text', { x: x(opts.now), y: top - 12, 'text-anchor': 'middle' }, svg).textContent = '現在';
      }

      // 游標層：垂直線對齊最近的一筆，讀者只要瞄準時間
      const cross = svgEl('line', { y1: top, y2: bottom, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' }, svg);
      const dot = svgEl('circle', { r: 5, fill: opts.color, stroke: 'var(--card)', 'stroke-width': 2, visibility: 'hidden' }, svg);
      let index = -1;
      function select(i) {
        index = Math.max(0, Math.min(pts.length - 1, i));
        const p = pts[index], c = tp(p.t);
        cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t));
        dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.v));
        cross.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
        showTip(tip, container, x(p.t), fmtNum(p.v) + ' ' + (opts.unit || ''), c.m + '/' + c.d + '（' + c.wd + '）' + c.h + ' 時');
      }
      function hide() {
        cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true;
      }
      svg.onpointermove = svg.onpointerdown = function (ev) {
        const px = ev.clientX - svg.getBoundingClientRect().left;
        let best = 0;
        pts.forEach(function (p, i) { if (Math.abs(x(p.t) - px) < Math.abs(x(pts[best].t) - px)) best = i; });
        select(best);
      };
      svg.onpointerleave = svg.onblur = hide;
      svg.onkeydown = function (ev) {
        if (ev.key === 'ArrowRight') select(index + 1);
        else if (ev.key === 'ArrowLeft') select(index < 0 ? pts.length - 1 : index - 1);
        else return;
        ev.preventDefault();
      };
    });
  }

  /**
   * 長條圖（單一數列）。
   * opts: items [{t: 毫秒（該日）, v, tip}], color, unit, height, yMax, label
   */
  function barChart(container, opts) {
    const items = opts.items;
    if (!items.length) { container.textContent = '尚無資料'; return; }
    const height = opts.height || 220;
    const vals = items.map(function (d) { return d.v || 0; });
    const scale = niceScale(0, Math.max(opts.yMax || 0, Math.max.apply(null, vals)), true);

    mount(container, height, function (svg, tip, width) {
      const left = 44, right = width - 12, top = 26, bottom = height - 30;
      const slot = (right - left) / items.length;
      const bw = Math.max(2, Math.min(24, slot - 2));
      const y = function (v) { return bottom - (v - scale[0]) / (scale[1] - scale[0]) * (bottom - top); };
      svg.setAttribute('aria-label', opts.label || '');
      yAxis(svg, scale, y, left, right, opts.unit);
      const every = Math.max(1, Math.ceil(items.length / Math.max(2, Math.floor((right - left) / 56))));
      const bars = [];

      items.forEach(function (d, i) {
        const cx = left + slot * (i + 0.5);
        const c = tp(d.t);
        if ((items.length - 1 - i) % every === 0) {
          svgEl('text', { x: cx, y: bottom + 18, 'text-anchor': 'middle' }, svg).textContent = c.m + '/' + c.d;
        }
        const h = d.v == null ? 0 : bottom - y(d.v);
        const r = Math.min(4, bw / 2, h);
        const x0 = cx - bw / 2, yt = bottom - h;
        // 頂端圓角、底部貼齊基準線
        const bar = svgEl('path', {
          d: 'M' + x0 + ' ' + bottom + 'V' + (yt + r) + 'Q' + x0 + ' ' + yt + ' ' + (x0 + r) + ' ' + yt +
             'H' + (x0 + bw - r) + 'Q' + (x0 + bw) + ' ' + yt + ' ' + (x0 + bw) + ' ' + (yt + r) + 'V' + bottom + 'Z',
          fill: opts.color,
        }, svg);
        bars.push({ bar: bar, cx: cx, d: d, c: c });
      });

      let index = -1;
      function select(i) {
        index = Math.max(0, Math.min(bars.length - 1, i));
        bars.forEach(function (b, j) { b.bar.setAttribute('fill-opacity', j === index ? 1 : 0.45); });
        const b = bars[index];
        showTip(tip, container, b.cx, b.d.v == null ? '沒有資料' : fmtNum(b.d.v) + ' ' + (opts.unit || ''),
          b.c.m + '/' + b.c.d + '（' + b.c.wd + '）' + (b.d.tip ? ' · ' + b.d.tip : ''));
      }
      function hide() {
        bars.forEach(function (b) { b.bar.removeAttribute('fill-opacity'); });
        tip.hidden = true;
      }
      svg.onpointermove = svg.onpointerdown = function (ev) {
        const px = ev.clientX - svg.getBoundingClientRect().left;
        select(Math.floor((px - left) / slot));
      };
      svg.onpointerleave = svg.onblur = hide;
      svg.onkeydown = function (ev) {
        if (ev.key === 'ArrowRight') select(index + 1);
        else if (ev.key === 'ArrowLeft') select(index < 0 ? bars.length - 1 : index - 1);
        else return;
        ev.preventDefault();
      };
    });
  }

  window.Charts = { timeChart: timeChart, barChart: barChart, tp: tp };
})();
