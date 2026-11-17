// 氣象儀表板：讀 data/ 裡的 JSON 並畫到頁面上。前端不呼叫任何氣象 API。
(function () {
  'use strict';
  const STALE_MINUTES = 150; // 排程每小時一次；超過這個時間沒更新就提示「資料已過時」
  const LEVEL_WORD = { good: '充足', fair: '普通', poor: '不足' };
  const SUN = 'var(--series-sun)', SKY = 'var(--series-sky)';
  const $ = function (id) { return document.getElementById(id); };

  // 建立元素。文字一律用 textContent 放進去，不組 HTML 字串
  function h(tag, props) {
    const e = document.createElement(tag);
    for (const k in props || {}) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'class') e.className = props[k];
      else e.setAttribute(k, props[k]);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  async function getJSON(path) {
    const r = await fetch(path + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  const ms = function (iso) { return iso ? new Date(iso).getTime() : NaN; };
  const pad = function (n) { return String(n).padStart(2, '0'); };
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(ms(iso) + 8 * 3600e3);
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function fmtDay(dateStr) {
    const c = Charts.tp(ms(dateStr + 'T00:00+08:00'));
    return c.m + '/' + c.d + '（' + c.wd + '）';
  }
  const val = function (v, unit, digits) { return v == null ? '—' : (digits == null ? v : v.toFixed(digits)) + (unit || ''); };
  const pct = function (ratio) { return ratio == null ? '—' : Math.round(ratio * 100) + '%'; };

  function weatherIcon(text) {
    if (!text) return '';
    if (text.indexOf('雷') >= 0) return '⛈️';
    if (text.indexOf('雨') >= 0) return '🌧️';
    if (text.indexOf('霧') >= 0) return '🌫️';
    if (text.indexOf('晴') >= 0) return text.indexOf('雲') >= 0 ? '⛅' : '☀️';
    if (text.indexOf('陰') >= 0) return '☁️';
    if (text.indexOf('雲') >= 0) return '🌥️';
    return '';
  }

  function notice(text) {
    const n = $('notice');
    n.textContent = text;
    n.hidden = false;
  }

  // 多個地點時顯示下拉選單；只有一個地點就不顯示
  function pickLocation(latest) {
    const list = latest.locations || [];
    let saved = null;
    try { saved = localStorage.getItem('weather-loc'); } catch (e) { /* 無痕模式可能不能用 */ }
    const want = new URLSearchParams(location.search).get('loc') || saved;
    const loc = list.find(function (l) { return l.id === want; }) || list[0];
    const box = $('loc-select');
    if (box && list.length > 1) {
      const sel = h('select', { 'aria-label': '選擇地點' });
      list.forEach(function (l) {
        const o = h('option', { value: l.id, text: l.name });
        if (l.id === loc.id) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () {
        try { localStorage.setItem('weather-loc', sel.value); } catch (e) { /* 同上 */ }
        location.search = '?loc=' + encodeURIComponent(sel.value);
      };
      box.appendChild(sel);
    }
    return loc;
  }

  // 某個來源這次沒抓到時的小字說明
  function sourceNote(loc, name) {
    const s = (loc.sources || {})[name];
    if (!s || s.ok) return null;
    return h('p', { class: 'small', text: s.fetched_at
      ? '這一項暫時抓不到新資料，顯示的是 ' + fmtTime(s.fetched_at) + ' 的內容。'
      : '這一項目前還沒有資料。' });
  }

  function lampCard(card, day, when, ask) {
    card.textContent = '';
    card.appendChild(h('p', { class: 'when', text: when }));
    card.appendChild(h('p', { class: 'ask', text: ask }));
    const level = day && day.level;
    card.appendChild(h('div', { class: 'lamp', 'data-level': level || '' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'word', text: level ? '日照' + LEVEL_WORD[level] : '尚無資料' })));
    if (!day) return;
    if (day.sun_ratio != null) {
      card.appendChild(h('p', { class: 'lamp-note', text: '預估約為理想晴天的 ' + pct(day.sun_ratio) + '（粗估）' }));
    }
    const facts = [];
    if (day.weather) facts.push(weatherIcon(day.weather) + ' ' + day.weather);
    if (day.pop_max != null) facts.push('白天降雨機率最高 ' + day.pop_max + '%');
    if (day.temp_min != null) facts.push(Math.round(day.temp_min) + '–' + Math.round(day.temp_max) + '°C');
    if (facts.length) card.appendChild(h('p', { class: 'facts', text: fmtDay(day.date) + '　' + facts.join(' · ') }));
  }

  function renderAlerts(loc, box, detailed) {
    box.textContent = '';
    const typhoons = loc.typhoons || [], warnings = loc.warnings || [];
    typhoons.forEach(function (t) {
      let line = '目前距離' + loc.name + '約 ' + t.distance_km.toLocaleString() + ' 公里';
      if (t.closest_km != null && t.closest_km < t.distance_km) {
        line += '；依預測路徑，' + fmtTime(t.closest_time) + ' 前後最接近，約 ' + t.closest_km.toLocaleString() + ' 公里';
      }
      if (detailed && t.max_wind != null) line += '。近中心最大風速每秒 ' + t.max_wind + ' 公尺（' + fmtTime(t.time) + ' 定位）';
      box.appendChild(h('div', { class: 'alert' }, h('span', { class: 'icon', text: '🌀', 'aria-hidden': 'true' }),
        h('div', null, h('strong', { text: '颱風／熱帶氣旋：' + t.name }), line + '。')));
    });
    warnings.forEach(function (w) {
      const until = w.end ? '有效至 ' + fmtTime(w.end) : '';
      box.appendChild(h('div', { class: 'alert' }, h('span', { class: 'icon', text: '⚠️', 'aria-hidden': 'true' }),
        h('div', null, h('strong', { text: w.phenomena + w.significance }), loc.county + '。' + until)));
    });
    if (!typhoons.length && !warnings.length) {
      const known = loc.typhoons && loc.warnings;
      box.appendChild(h('p', { class: 'calm', text: known ? '目前沒有颱風，' + loc.county + '也沒有天氣警特報。' : '颱風與警特報資料尚未取得。' }));
    }
  }

  function stat(label, value, unit, note) {
    return h('div', { class: 'card stat' }, h('p', { class: 'label', text: label }),
      h('p', { class: 'value' }, value, unit ? h('small', { text: unit }) : null),
      note ? h('p', { class: 'note', text: note }) : null);
  }

  function hourly(loc, key, count) {
    const hr = (loc.solar || {}).hourly;
    if (!hr || !hr[key]) return [];
    return hr.time.slice(0, count).map(function (t, i) { return { t: ms(t), v: hr[key][i] }; });
  }

  // ---------- 概況 ----------
  function overview(latest, loc) {
    const days = loc.days || [];
    lampCard($('card-today'), days[0], '清晨 05:30 的決策', '今天的太陽，夠把電池充飽嗎？');
    lampCard($('card-tomorrow'), days[1], '傍晚 17:00 的決策', '明天有太陽嗎？今晚要留多少電？');
    renderAlerts(loc, $('alerts'), false);

    const o = loc.observation, now = $('now');
    now.textContent = '';
    if (o) {
      now.appendChild(stat('氣溫', val(o.temp, '', 1), '°C', (weatherIcon(o.weather) + ' ' + (o.weather || '')).trim()));
      now.appendChild(stat('相對濕度', val(o.humidity), '%'));
      now.appendChild(stat('今天累積雨量', val(o.rain_today, '', 1), '毫米'));
      $('now-note').textContent = o.station + '測站（' + o.station_town + '，距區公所約 ' + o.distance_km + ' 公里）' + fmtTime(o.time) + ' 的觀測。';
    } else {
      $('now-note').textContent = '即時觀測資料尚未取得。';
    }
    const note = sourceNote(loc, 'observation');
    if (note && o) $('now-note').after(note);

    Charts.timeChart($('chart-sun'), {
      points: hourly(loc, 'radiation', 49), color: SUN, unit: 'W/m²', area: true, zeroBased: true,
      now: Date.now(), label: '今天與明天每小時的日照量',
    });
  }

  // ---------- 詳細預報 ----------
  function forecast(latest, loc) {
    Charts.timeChart($('chart-sun'), { points: hourly(loc, 'radiation', 72), color: SUN, unit: 'W/m²', area: true, zeroBased: true, now: Date.now(), label: '未來三天每小時日照量' });
    Charts.timeChart($('chart-cloud'), { points: hourly(loc, 'cloud', 72), color: SKY, unit: '%', area: true, zeroBased: true, yMax: 100, now: Date.now(), height: 200, label: '未來三天每小時雲量' });
    Charts.timeChart($('chart-temp'), { points: hourly(loc, 'temp', 72), color: SKY, unit: '°C', now: Date.now(), height: 200, label: '未來三天每小時氣溫' });

    const sunBody = $('sun-rows');
    (loc.days || []).forEach(function (d) {
      sunBody.appendChild(h('tr', null,
        h('td', { text: fmtDay(d.date) }),
        h('td', { text: d.level ? LEVEL_WORD[d.level] : '—' }),
        h('td', { class: 'num', text: pct(d.sun_ratio) }),
        h('td', { class: 'num', text: val(d.sun_kwh, '', 1) }),
        h('td', { class: 'num', text: val(d.clear_kwh, '', 1) }),
        h('td', { text: (d.sunrise || '').slice(11) + '–' + (d.sunset || '').slice(11) })));
    });

    const body = $('forecast-rows');
    let lastDay = '';
    ((loc.forecast || {}).periods || []).forEach(function (p) {
      const day = p.start.slice(0, 10);
      if (day !== lastDay) {
        body.appendChild(h('tr', { class: 'day' }, h('td', { colspan: '5', text: fmtDay(day) })));
        lastDay = day;
      }
      body.appendChild(h('tr', null,
        h('td', { text: p.start.slice(11, 16) + '–' + p.end.slice(11, 16) }),
        h('td', { text: (weatherIcon(p.weather) + ' ' + (p.weather || '—')).trim() }),
        h('td', { class: 'num', text: val(p.temp, '°C') }),
        h('td', { class: 'num', text: val(p.pop, '%') }),
        h('td', { class: 'num', text: val(p.humidity, '%') })));
    });
    if (!lastDay) body.appendChild(h('tr', null, h('td', { colspan: '5', text: '預報資料尚未取得。' })));
    const fNote = sourceNote(loc, 'forecast');
    if (fNote) $('forecast-note').appendChild(fNote);

    const o = loc.observation, obs = $('obs');
    if (o) {
      [['天氣', o.weather || '—'], ['氣溫', val(o.temp, ' °C')], ['相對濕度', val(o.humidity, '%')],
       ['今天累積雨量', val(o.rain_today, ' 毫米')], ['風速', val(o.wind_speed, ' 公尺／秒')],
       ['氣壓', val(o.pressure, ' 百帕')], ['紫外線指數', val(o.uv)]].forEach(function (row) {
        obs.appendChild(h('tr', null, h('td', { text: row[0] }), h('td', { text: String(row[1]) })));
      });
      $('obs-note').textContent = o.station + '測站（' + o.station_town + '，距區公所約 ' + o.distance_km + ' 公里），' + fmtTime(o.time) + ' 觀測。';
    } else {
      $('obs-note').textContent = '即時觀測資料尚未取得。';
    }
    renderAlerts(loc, $('alerts'), true);
  }

  // ---------- 歷史紀錄 ----------
  async function history(latest, loc) {
    let hist;
    try {
      hist = await getJSON('data/history/' + loc.id + '.json');
    } catch (e) {
      $('history-empty').hidden = false;
      return;
    }
    const daily = hist.daily_solar || [];
    Charts.barChart($('chart-daily'), {
      items: daily.map(function (d) {
        return { t: ms(d.date + 'T00:00+08:00'), v: d.sun_kwh, tip: d.level ? '日照' + LEVEL_WORD[d.level] + '，理想晴天的 ' + pct(d.sun_ratio) : '' };
      }),
      color: SUN, unit: 'kWh/m²', label: '過去 30 天每日日照量',
    });
    Charts.timeChart($('chart-temp'), {
      points: (hist.hourly || []).map(function (r) { return { t: ms(r.t), v: r.temp }; }),
      color: SKY, unit: '°C', height: 220, label: '過去 30 天測站氣溫',
    });

    // 當時的預報 vs. 後來的實際值
    const snaps = hist.snapshots || [];
    function predicted(date, slot, snapDate) {
      const s = snaps.find(function (x) { return x.slot === slot && x.date === snapDate; });
      const d = s && (s.days || []).find(function (x) { return x.date === date; });
      return d ? d.sun_kwh : null;
    }
    const body = $('compare-rows');
    let rows = 0;
    daily.slice().reverse().forEach(function (d) {
      const prev = new Date(ms(d.date + 'T00:00+08:00') - 24 * 3600e3 + 8 * 3600e3).toISOString().slice(0, 10);
      const evening = predicted(d.date, '1700', prev), morning = predicted(d.date, '0530', d.date);
      if (evening == null && morning == null) return;
      const ref = evening != null ? evening : morning;
      const diff = d.sun_kwh == null ? null : ref - d.sun_kwh;
      body.appendChild(h('tr', null,
        h('td', { text: fmtDay(d.date) }),
        h('td', { class: 'num', text: val(evening, '', 1) }),
        h('td', { class: 'num', text: val(morning, '', 1) }),
        h('td', { class: 'num', text: val(d.sun_kwh, '', 1) }),
        h('td', { class: 'num', text: diff == null ? '—' : (diff >= 0 ? '+' : '−') + Math.abs(diff).toFixed(1) })));
      rows++;
    });
    if (!rows) {
      const last = snaps[snaps.length - 1];
      const text = last
        ? '已經存了 ' + snaps.length + ' 份預報快照（最近一份：' + fmtTime(last.taken_at) + '）。要等被預報的那一天過完，才會出現第一筆對照。'
        : '還沒有存到預報快照。系統每天 05:30、17:00 前後各存一份，被預報的那一天過完後，就會出現第一筆對照。';
      body.appendChild(h('tr', null, h('td', { colspan: '5', text: text })));
    }
  }

  async function main() {
    let latest;
    try {
      latest = await getJSON('data/latest.json');
    } catch (e) {
      notice('暫時讀不到氣象資料，請稍後再重新整理。');
      return;
    }
    const loc = pickLocation(latest);
    if (!loc) { notice('目前沒有任何地點的資料。'); return; }

    document.querySelectorAll('[data-place]').forEach(function (e) { e.textContent = loc.name; });
    document.querySelectorAll('[data-updated]').forEach(function (e) { e.textContent = fmtTime(latest.generated_at); });
    if (Date.now() - ms(latest.generated_at) > STALE_MINUTES * 60e3) {
      notice('資料已過時：最後更新時間是 ' + fmtTime(latest.generated_at) + '（台灣時間）。目前顯示的是上一次成功取得的資料。');
    }

    const page = document.body.dataset.page;
    if (page === 'overview') overview(latest, loc);
    else if (page === 'forecast') forecast(latest, loc);
    else if (page === 'history') await history(latest, loc);
  }

  main();
})();
