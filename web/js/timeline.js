// The time bar. The left part of the slider covers the measured period, the
// right part the projection, so one year of radar passes is not squeezed into
// a sliver next to 24 years of projection.

import { END_YEAR, fmtDate, fmtMonth } from './config.js';

const MAX = 1000;
const SPLIT = 350;            // slider units given to the measured period
const PLAY_UNITS_PER_S = 48;

export class Timeline {
  constructor(onChange) {
    this.onChange = onChange;
    this.slider = document.getElementById('slider');
    this.playBtn = document.getElementById('play');
    this.dateEl = document.getElementById('time-date');
    this.modeEl = document.getElementById('time-mode');
    this.ticksEl = document.getElementById('ticks');
    document.getElementById('track-meas').style.width = (SPLIT / MAX) * 100 + '%';
    this.end = Date.UTC(END_YEAR, 11, 31);
    this.start = this.now = this.time = 0;
    this.playing = false;
    this.slider.addEventListener('input', () => { this.pause(); this._set(this.fromPos(+this.slider.value), false); });
    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    window.addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      if (e.key === ' ' && e.target === document.body) { e.preventDefault(); this.playing ? this.pause() : this.play(); }
    });
  }

  /** start: first radar pass, now: latest radar pass. A date in the projection
   *  is kept; a date in the measured part moves to the new latest pass. */
  setRange(start, now) {
    const wasProjected = this.time > this.now + 45 * 86400000;
    this.start = start; this.now = now;
    this._ticks();
    this._set(wasProjected ? Math.min(this.end, Math.max(now, this.time)) : now, true);
  }

  fromPos(p) {
    return p <= SPLIT
      ? this.start + (p / SPLIT) * (this.now - this.start)
      : this.now + ((p - SPLIT) / (MAX - SPLIT)) * (this.end - this.now);
  }

  toPos(ms) {
    return ms <= this.now
      ? (SPLIT * (ms - this.start)) / (this.now - this.start)
      : SPLIT + ((MAX - SPLIT) * (ms - this.now)) / (this.end - this.now);
  }

  /** 0..1 along the bar, shared with the chart so both line up. */
  frac(ms) { return Math.max(0, Math.min(1, this.toPos(ms) / MAX)); }
  get projected() { return this.time > this.now + 1; }

  setTime(ms) { this._set(Math.min(this.end, Math.max(this.start, ms)), true); }

  _set(ms, moveSlider) {
    this.time = ms;
    if (moveSlider) this.slider.value = String(Math.round(this.toPos(ms)));
    const proj = this.projected;
    this.dateEl.textContent = proj ? fmtMonth(ms) : fmtDate(ms);
    this.modeEl.innerHTML = proj
      ? 'Projected<span class="wide">, if the current rate continues</span>'
      : 'Measured<span class="wide"> by NISAR</span>';
    this.modeEl.classList.toggle('proj', proj);
    this.slider.setAttribute('aria-valuetext', this.dateEl.textContent + ', ' + (proj ? 'projected' : 'measured'));
    this.onChange(ms);
  }

  _ticks() {
    const mk = (ms, text, cls) => `<span class="${cls || ''}" style="left:${this.frac(ms) * 100}%">${text}</span>`;
    let html = mk(this.start, fmtMonth(this.start));
    html += mk(this.now, 'Latest pass', 'now');
    for (const y of [2030, 2035, 2040, 2045]) html += mk(Date.UTC(y, 0, 1), y, y === 2040 ? '' : 'minor');
    html += mk(this.end, END_YEAR);
    this.ticksEl.innerHTML = html;
  }

  play() {
    if (+this.slider.value >= MAX) this.slider.value = '0';
    this.playing = true;
    this.playBtn.textContent = '❚❚';
    this.playBtn.classList.add('on');
    this.playBtn.setAttribute('aria-label', 'Pause');
    let last = performance.now(), pos = +this.slider.value;
    const step = now => {
      if (!this.playing) return;
      pos += ((now - last) / 1000) * PLAY_UNITS_PER_S;
      last = now;
      if (pos >= MAX) { pos = MAX; this._set(this.fromPos(pos), true); this.pause(); return; }
      this._set(this.fromPos(pos), true);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  pause() {
    this.playing = false;
    this.playBtn.textContent = '▶';
    this.playBtn.classList.remove('on');
    this.playBtn.setAttribute('aria-label', 'Play');
  }
}
