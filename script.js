    // ── PUNCTUATION MAP ──────────────────────────────────────────────────────────
    const PUNCT_MAP = {
      '.': 'full stop.',
      ',': 'comma.',
    };

    // ── CORE STATE ───────────────────────────────────────────────────────────────
    const synth = window.speechSynthesis;
    let allVoices = [];
    let isPlaying = false, isPaused = false;
    let rate = 0.8, pitch = 1.0, chunkSize = 5, pauseDur = 1.2;
    let useChunks = true;
    let repeatCount = 1;
    let soundEnabled = true;
    let sayPunctuation = true;
    let focusMode = false;
    let editMode = false;
    let sessionStart = null;
    let stopRequested = false;
    let jumpToChunk = -1;  // for click-to-start

    // Word/chunk model
    // Each token: { text, display, paraBreakBefore, globalIdx, chunkIdx }
    let tokens = [];       // flat list of word tokens
    let chunks = [];       // array of arrays of token indices
    let chunkIdx = 0;
    let totalWords = 0;
    let spokenWords = 0;
    let wordEls = [];      // parallel to tokens

    // ── THEME ────────────────────────────────────────────────────────────────────
    const root = document.documentElement;
    let theme = 'dark';
    document.getElementById('themeBtn').addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
      document.getElementById('themeBtn').innerHTML = theme === 'dark'
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
    });

    // ── TOAST ─────────────────────────────────────────────────────────────────────
    function toast(msg, ms = 2000) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), ms);
    }

    // ── VOICE LOADING ─────────────────────────────────────────────────────────────
    function loadVoices() {
      allVoices = synth.getVoices();
      const sel = document.getElementById('voiceSel');
      sel.innerHTML = '';
      const groups = {
        '🇮🇳 Indian English': allVoices.filter(v => v.lang === 'en-IN'),
        '🇬🇧 British English': allVoices.filter(v => v.lang === 'en-GB'),
        '🇺🇸 American English': allVoices.filter(v => v.lang === 'en-US'),
        '🇦🇺 Australian English': allVoices.filter(v => v.lang === 'en-AU'),
        '🌍 Other English': allVoices.filter(v => v.lang.startsWith('en') && !['en-IN', 'en-GB', 'en-US', 'en-AU'].includes(v.lang)),
        '🌐 Other Languages': allVoices.filter(v => !v.lang.startsWith('en')),
      };
      let hasVoice = false;
      for (const [label, voices] of Object.entries(groups)) {
        if (!voices.length) continue;
        const g = document.createElement('optgroup');
        g.label = label;
        voices.forEach(v => {
          const o = document.createElement('option');
          const isGoogle = v.name.toLowerCase().includes('google');
          o.value = v.name;
          o.textContent = (isGoogle ? '⭐ ' : '') + v.name;
          if (!hasVoice) { o.selected = true; hasVoice = true; }
          g.appendChild(o);
        });
        sel.appendChild(g);
      }
      if (!hasVoice) sel.innerHTML = '<option>No voices found</option>';
    }
    loadVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = loadVoices;

    function getVoice() {
      const n = document.getElementById('voiceSel').value;
      return allVoices.find(v => v.name === n) || null;
    }

    // ── AUDIO CUE ─────────────────────────────────────────────────────────────────
    function playBeep(freq = 660, dur = 0.08) {
      if (!soundEnabled) return;
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = freq; o.type = 'sine';
        g.gain.setValueAtTime(0.18, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
        o.start(ctx.currentTime); o.stop(ctx.currentTime + dur);
      } catch (e) { }
    }

    // ── SPEAK HELPER ─────────────────────────────────────────────────────────────
    function speak(text, r, p) {
      return new Promise(resolve => {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = r; u.pitch = p;
        const v = getVoice();
        if (v) u.voice = v;
        u.onend = resolve;
        u.onerror = resolve;
        synth.speak(u);
      });
    }

    // ── SLEEP HELPER ─────────────────────────────────────────────────────────────
    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ── EXPAND PUNCTUATION for TTS ────────────────────────────────────────────────
    // Takes a word token's text and returns TTS-ready string
    function ttsText(rawWord) {
      if (!sayPunctuation) {
        // Strip trailing punctuation for TTS only
        return rawWord.replace(/[.,?!:;—\-(){}"'"'…]+$/, '').trim() || rawWord;
      }
      // Expand trailing/leading punctuation into spoken words
      let result = rawWord;
      // Replace commas and full stops with their spoken form, leaving other punctuation for natural TTS pauses
      result = result.replace(/[.,]/g, ch => {
        return PUNCT_MAP[ch] ? ' ' + PUNCT_MAP[ch] + ' ' : ' ';
      });
      return result.trim().replace(/\s+/g, ' ') || rawWord;
    }

    // ── BUILD SPOKEN TEXT FOR A CHUNK ────────────────────────────────────────────
    function chunkToSpeech(chunkTokenIndices) {
      return chunkTokenIndices.map(i => ttsText(tokens[i].text)).join(' ');
    }

    // ── PARSE TEXT → TOKENS WITH PARAGRAPH INFO ───────────────────────────────────
    // Splits text by blank lines (paragraphs), then by whitespace within each para.
    // Preserves paragraph structure in the token list.
    function parseText(rawText) {
      tokens = [];
      chunks = [];
      wordEls = [];

      // Split into paragraphs (one or more blank lines)
      const paras = rawText.split(/\n\s*\n+/);
      let globalIdx = 0;

      paras.forEach((para, pIdx) => {
        const trimmed = para.trim();
        if (!trimmed) return;
        // Split paragraph into words (preserve spaces/newlines within para as single space)
        const words = trimmed.split(/\s+/).filter(w => w.length > 0);
        words.forEach((w, wIdx) => {
          tokens.push({
            text: w,
            paraBreakBefore: (wIdx === 0 && pIdx > 0),
            globalIdx,
            chunkIdx: -1,   // filled below
          });
          globalIdx++;
        });
      });

      totalWords = tokens.length;

      // Build chunks
      if (useChunks) {
        let i = 0;
        while (i < tokens.length) {
          const group = [];
          for (let j = 0; j < chunkSize && i < tokens.length; j++, i++) {
            group.push(i);
          }
          const cIdx = chunks.length;
          group.forEach(ti => tokens[ti].chunkIdx = cIdx);
          chunks.push(group);
        }
      } else {
        // One big chunk
        const group = tokens.map((_, i) => i);
        group.forEach(ti => tokens[ti].chunkIdx = 0);
        chunks.push(group);
      }
    }

    // ── RENDER DICT DISPLAY ───────────────────────────────────────────────────────
    // Renders tokens as paragraph blocks, preserving paragraph breaks
    function renderDictDisplay(startChunkIdx = 0) {
      const dd = document.getElementById('dictDisplay');
      dd.innerHTML = '';
      wordEls = new Array(tokens.length).fill(null);

      let currentPara = null;

      tokens.forEach((tok, i) => {
        // Start new paragraph block?
        if (tok.paraBreakBefore || currentPara === null) {
          currentPara = document.createElement('div');
          currentPara.className = 'dict-para';
          dd.appendChild(currentPara);
        }

        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = tok.text + ' ';
        span.dataset.idx = i;
        span.dataset.chunk = tok.chunkIdx;

        // Mark already-done words
        if (tok.chunkIdx < startChunkIdx) {
          span.classList.add('done');
        }

        // Click-to-start handler
        span.addEventListener('click', () => {
          const clickedChunk = parseInt(span.dataset.chunk);
          if (!isPlaying && !isPaused) {
            // Not playing: set jump point and start
            jumpToChunk = clickedChunk;
            document.getElementById('btnPlay').click();
          } else if (isPlaying || isPaused) {
            // Playing: jump to that chunk
            jumpToChunk = clickedChunk;
            stopRequested = true;
            synth.cancel();
            toast('⏭ Jumping to selected word…');
          }
        });

        wordEls[i] = span;
        currentPara.appendChild(span);
      });

      document.getElementById('dictDisplay').classList.add('on');
      document.getElementById('textInput').style.display = 'none';
      document.getElementById('clickInfo').classList.add('on');
    }

    // ── HIGHLIGHT HELPERS ─────────────────────────────────────────────────────────
    function highlightChunk(cIdx, isRepeat = false) {
      wordEls.forEach((el, i) => {
        if (!el) return;
        const ti = tokens[i];
        el.classList.remove('now', 'repeat-now', 'start-here');
        if (ti.chunkIdx < cIdx) el.classList.add('done');
        else if (ti.chunkIdx === cIdx) {
          el.classList.remove('done');
          el.classList.add(isRepeat ? 'repeat-now' : 'now');
        }
      });
      // Scroll active chunk into view
      const firstOfChunk = wordEls[chunks[cIdx][0]];
      if (firstOfChunk) firstOfChunk.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function clearHighlight() {
      wordEls.forEach(el => { if (el) el.classList.remove('now', 'repeat-now', 'start-here', 'done'); });
    }

    // ── CHUNK COUNTER ─────────────────────────────────────────────────────────────
    function updateCounter(ci) {
      document.getElementById('ccNow').textContent = ci + 1;
      document.getElementById('ccTotal').textContent = chunks.length;
      document.getElementById('chunkCounter').classList.add('on');
    }

    // ── PROGRESS BAR ─────────────────────────────────────────────────────────────
    function updateProgress(ci) {
      spokenWords = chunks.slice(0, ci).reduce((s, c) => s + c.length, 0);
      const pct = totalWords > 0 ? (spokenWords / totalWords) * 100 : 0;
      document.getElementById('progFill').style.width = pct + '%';
      document.getElementById('metaSpoken').textContent = spokenWords + ' spoken';
      document.getElementById('metaLeft').textContent = (totalWords - spokenWords) + ' left';
      document.getElementById('svTotal').textContent = totalWords;
      document.getElementById('svChunk').textContent = chunkSize;

      // Estimate remaining time
      const wordsLeft = totalWords - spokenWords;
      const avgWPS = rate * 2.2;
      const secs = Math.round(wordsLeft / avgWPS);
      const m = Math.floor(secs / 60), s = secs % 60;
      document.getElementById('svTime').textContent = m + ':' + String(s).padStart(2, '0');
    }

    // ── STATUS ────────────────────────────────────────────────────────────────────
    function setStatus(cls, txt) {
      const dot = document.getElementById('dot');
      dot.className = 'dot ' + cls;
      document.getElementById('statusTxt').textContent = txt;
    }

    // ── CHUNK BANNER ─────────────────────────────────────────────────────────────
    function showBanner(txt, ms = 900) {
      const b = document.getElementById('chunkBanner');
      b.textContent = txt;
      b.classList.add('pop');
      setTimeout(() => b.classList.remove('pop'), ms);
    }

    // ── START ANIMATION ───────────────────────────────────────────────────────────
    function showStartAnim(txt = 'Start!') {
      return new Promise(resolve => {
        const el = document.getElementById('startAnim');
        document.getElementById('saText').textContent = txt;
        el.classList.add('on');
        setTimeout(() => { el.classList.remove('on'); resolve(); }, 900);
      });
    }

    // ── STATS MODAL ───────────────────────────────────────────────────────────────
    function showStats() {
      const elapsed = sessionStart ? Math.round((Date.now() - sessionStart) / 1000) : 0;
      const m = Math.floor(elapsed / 60), s = elapsed % 60;
      const wpm = elapsed > 0 ? Math.round((spokenWords / elapsed) * 60) : 0;
      document.getElementById('stWords').textContent = totalWords;
      document.getElementById('stChunks').textContent = chunks.length;
      document.getElementById('stTime').textContent = m + ':' + String(s).padStart(2, '0');
      document.getElementById('stWPM').textContent = wpm;
      document.getElementById('statsModal').classList.add('on');
    }
    document.getElementById('statsCloseBtn').addEventListener('click', () => {
      document.getElementById('statsModal').classList.remove('on');
    });

    // ── TERMS MODAL ───────────────────────────────────────────────────────────────
    document.getElementById('btnTerms').addEventListener('click', () => {
      document.getElementById('termsModal').classList.add('on');
    });
    document.getElementById('termsCloseBtn').addEventListener('click', () => {
      document.getElementById('termsModal').classList.remove('on');
    });

    // ── PRIVACY MODAL ─────────────────────────────────────────────────────────────
    document.getElementById('btnPrivacy').addEventListener('click', () => {
      document.getElementById('privacyModal').classList.add('on');
    });
    document.getElementById('privacyCloseBtn').addEventListener('click', () => {
      document.getElementById('privacyModal').classList.remove('on');
    });

    // ── MAIN DICTATION LOOP ───────────────────────────────────────────────────────
    async function runDictation(startFrom = 0) {
      // iOS Safari: fire a silent utterance inside click handler to unlock audio
      const unlock = new SpeechSynthesisUtterance('');
      unlock.volume = 0;
      synth.speak(unlock);

      isPlaying = true;
      isPaused = false;
      stopRequested = false;
      sessionStart = sessionStart || Date.now();

      const btnPlay = document.getElementById('btnPlay');
      const btnPause = document.getElementById('btnPause');
      const btnRepeat = document.getElementById('btnRepeat');
      const btnPrev = document.getElementById('btnPrev');
      const btnNext = document.getElementById('btnNext');

      btnPlay.classList.add('stop-mode');
      btnPlay.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> Stop';
      btnPause.disabled = false;
      btnRepeat.disabled = false;
      btnPrev.disabled = false;
      btnNext.disabled = false;

      chunkIdx = startFrom;

      while (chunkIdx < chunks.length) {
        if (stopRequested) break;

        // Handle jump request
        if (jumpToChunk >= 0) {
          chunkIdx = jumpToChunk;
          jumpToChunk = -1;
          stopRequested = false;
        }

        // Pause check
        while (isPaused && !stopRequested) await sleep(100);
        if (stopRequested) break;

        updateCounter(chunkIdx);
        updateProgress(chunkIdx);
        highlightChunk(chunkIdx, false);
        setStatus('playing', 'Dictating chunk ' + (chunkIdx + 1) + '…');

        const chunkText = chunkToSpeech(chunks[chunkIdx]);

        // ── First read ──
        await speak(chunkText, rate, pitch);
        if (stopRequested) break;

        // ── Pause between first read and repeat ──
        await sleep(pauseDur * 1000);
        if (stopRequested) break;

        playBeep(660, 0.07);

        // ── Repeat N times ──
        for (let r = 1; r < repeatCount; r++) {
          while (isPaused && !stopRequested) await sleep(100);
          if (stopRequested) break;

          highlightChunk(chunkIdx, true);
          showBanner('▶ Repeat ' + r + (repeatCount > 2 ? '/' + (repeatCount - 1) : '') + '…');
          await speak(chunkText, rate * 0.9, pitch);
          if (stopRequested) break;
          if (r < repeatCount - 1) {
            await sleep(pauseDur * 700);
            playBeep(520, 0.06);
          }
        }
        if (stopRequested) break;

        // Mark done
        chunks[chunkIdx].forEach(ti => {
          if (wordEls[ti]) { wordEls[ti].classList.remove('now', 'repeat-now'); wordEls[ti].classList.add('done'); }
        });

        await sleep(pauseDur * 1000);
        if (stopRequested) break;

        chunkIdx++;
      }

      // Handle jump-after-stop (mid-loop cancellation for chunk jump)
      if (jumpToChunk >= 0 && !stopRequested) {
        const jmp = jumpToChunk;
        jumpToChunk = -1;
        stopRequested = false;
        resetControls(false);
        await runDictation(jmp);
        return;
      }

      const completed = !stopRequested && chunkIdx >= chunks.length;
      resetControls(true);

      if (completed) {
        setStatus('done', 'Dictation complete!');
        playBeep(880, 0.2);
        await showStartAnim('Done! 🎉');
        updateProgress(chunks.length);
        showStats();
      } else {
        setStatus('ready', 'Stopped');
      }
    }

    function resetControls(clearDisplay) {
      isPlaying = false; isPaused = false; stopRequested = false;
      synth.cancel();
      const btnPlay = document.getElementById('btnPlay');
      const btnPause = document.getElementById('btnPause');
      const btnRepeat = document.getElementById('btnRepeat');
      const btnPrev = document.getElementById('btnPrev');
      const btnNext = document.getElementById('btnNext');
      btnPlay.classList.remove('stop-mode');
      btnPlay.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Dictation';
      btnPause.disabled = true; btnRepeat.disabled = true;
      btnPrev.disabled = true; btnNext.disabled = true;
      document.getElementById('chunkCounter').classList.remove('on');
      if (clearDisplay) {
        clearHighlight();
        document.getElementById('clickInfo').classList.remove('on');
      }
    }

    // ── PLAY BUTTON ───────────────────────────────────────────────────────────────
    document.getElementById('btnPlay').addEventListener('click', async () => {
      if (isPlaying) {
        stopRequested = true;
        synth.cancel();
        return;
      }
      const raw = document.getElementById('textInput').value.trim();
      if (!raw) { toast('⚠️ Please enter or paste some text first!'); return; }

      parseText(raw);
      if (tokens.length === 0) { toast('⚠️ No words found in text.'); return; }

      const startFrom = jumpToChunk >= 0 ? jumpToChunk : 0;
      jumpToChunk = -1;

      renderDictDisplay(startFrom);
      await showStartAnim('Start!');
      await runDictation(startFrom);
    });

    // ── PAUSE ─────────────────────────────────────────────────────────────────────
    document.getElementById('btnPause').addEventListener('click', () => {
      if (!isPlaying) return;
      if (!isPaused) {
        isPaused = true;
        synth.cancel();
        setStatus('paused', 'Paused');
        document.getElementById('btnPause').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume';
        toast('⏸ Paused');
      } else {
        isPaused = false;
        setStatus('playing', 'Resumed…');
        document.getElementById('btnPause').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause';
        toast('▶ Resumed');
      }
    });

    // ── REPEAT ────────────────────────────────────────────────────────────────────
    document.getElementById('btnRepeat').addEventListener('click', () => {
      if (!isPlaying) return;
      jumpToChunk = chunkIdx;
      stopRequested = true;
      synth.cancel();
      toast('🔁 Repeating chunk…');
    });

    // ── NEXT ─────────────────────────────────────────────────────────────────────
    document.getElementById('btnNext').addEventListener('click', () => {
      if (!isPlaying) return;
      const target = Math.min(chunkIdx + 1, chunks.length - 1);
      jumpToChunk = target;
      stopRequested = true;
      synth.cancel();
      toast('⏭ Next chunk');
    });

    // ── PREV ─────────────────────────────────────────────────────────────────────
    document.getElementById('btnPrev').addEventListener('click', () => {
      if (!isPlaying) return;
      const target = Math.max(chunkIdx - 1, 0);
      jumpToChunk = target;
      stopRequested = true;
      synth.cancel();
      toast('⏮ Previous chunk');
    });

    // ── KEYBOARD SHORTCUTS ────────────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
      const tag = document.activeElement.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); document.getElementById('btnPause').click(); }
      if (e.key === 'r' || e.key === 'R') document.getElementById('btnRepeat').click();
      if (e.key === 'ArrowRight') document.getElementById('btnNext').click();
      if (e.key === 'ArrowLeft') document.getElementById('btnPrev').click();
      if (e.key === 'Escape') { stopRequested = true; synth.cancel(); }
    });

    // ── CHUNK SIZE ────────────────────────────────────────────────────────────────
    document.getElementById('chunkSize').addEventListener('change', e => {
      chunkSize = Math.max(2, Math.min(20, parseInt(e.target.value) || 5));
      e.target.value = chunkSize;
    });
    document.getElementById('chunkToggle').addEventListener('change', e => {
      useChunks = e.target.checked;
    });

    // ── PAUSE SLIDER ──────────────────────────────────────────────────────────────
    document.getElementById('pauseSlider').addEventListener('input', e => {
      pauseDur = parseFloat(e.target.value);
      document.getElementById('pauseVal').textContent = pauseDur.toFixed(1) + 's';
    });

    // ── REPEAT BUTTONS ────────────────────────────────────────────────────────────
    document.querySelectorAll('.rep-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.rep-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        repeatCount = parseInt(btn.dataset.rep);
      });
    });

    // ── SPEED BUTTONS ─────────────────────────────────────────────────────────────
    document.querySelectorAll('.sp-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sp-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        rate = parseFloat(btn.dataset.r);
        document.getElementById('rateSlider').value = rate;
        document.getElementById('rateVal').textContent = rate.toFixed(2) + '×';
      });
    });
    document.getElementById('rateSlider').addEventListener('input', e => {
      rate = parseFloat(e.target.value);
      document.getElementById('rateVal').textContent = rate.toFixed(2) + '×';
      document.querySelectorAll('.sp-btn').forEach(b => b.classList.remove('on'));
    });

    // ── PITCH ─────────────────────────────────────────────────────────────────────
    document.getElementById('pitchSlider').addEventListener('input', e => {
      pitch = parseFloat(e.target.value);
      document.getElementById('pitchVal').textContent = pitch.toFixed(2);
    });

    // ── SOUND TOGGLE ──────────────────────────────────────────────────────────────
    document.getElementById('soundToggle').addEventListener('change', e => { soundEnabled = e.target.checked; });
    document.getElementById('btnSound').addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      document.getElementById('soundToggle').checked = soundEnabled;
      toast(soundEnabled ? '🔔 Sound cues ON' : '🔕 Sound cues OFF');
      document.getElementById('btnSound').style.opacity = soundEnabled ? '1' : '0.4';
    });

    // ── PUNCTUATION TOGGLE ────────────────────────────────────────────────────────
    document.getElementById('punctToggle').addEventListener('change', e => {
      sayPunctuation = e.target.checked;
      toast(sayPunctuation ? '📍 Punctuation will be spoken' : '📍 Punctuation muted');
    });

    // ── PRESETS ───────────────────────────────────────────────────────────────────
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const p = btn.dataset.preset;
        if (p === 'exam') {
          chunkSize = 3; rate = 0.55; repeatCount = 3;
          document.getElementById('chunkSize').value = 3;
          document.getElementById('rateSlider').value = 0.55;
          document.getElementById('rateVal').textContent = '0.55×';
          document.querySelectorAll('.sp-btn').forEach(b => b.classList.remove('on'));
          document.querySelector('.sp-btn[data-r="0.55"]').classList.add('on');
          document.querySelectorAll('.rep-btn').forEach(b => b.classList.remove('on'));
          document.querySelector('.rep-btn[data-rep="3"]').classList.add('on');
        } else if (p === 'normal') {
          chunkSize = 5; rate = 0.8; repeatCount = 1;
          document.getElementById('chunkSize').value = 5;
          document.getElementById('rateSlider').value = 0.8;
          document.getElementById('rateVal').textContent = '0.80×';
          document.querySelectorAll('.sp-btn').forEach(b => b.classList.remove('on'));
          document.querySelector('.sp-btn[data-r="0.8"]').classList.add('on');
          document.querySelectorAll('.rep-btn').forEach(b => b.classList.remove('on'));
          document.querySelector('.rep-btn[data-rep="1"]').classList.add('on');
        } else if (p === 'review') {
          chunkSize = 8; rate = 1.1; repeatCount = 1;
          document.getElementById('chunkSize').value = 8;
          document.getElementById('rateSlider').value = 1.1;
          document.getElementById('rateVal').textContent = '1.10×';
          document.querySelectorAll('.sp-btn').forEach(b => b.classList.remove('on'));
          document.querySelectorAll('.rep-btn').forEach(b => b.classList.remove('on'));
          document.querySelector('.rep-btn[data-rep="1"]').classList.add('on');
        }
        toast('✅ Preset applied: ' + p);
      });
    });

    // ── PASTE ─────────────────────────────────────────────────────────────────────
    document.getElementById('btnPaste').addEventListener('click', async () => {
      try {
        const txt = await navigator.clipboard.readText();
        document.getElementById('textInput').value = txt;
        toast('📋 Text pasted!');
      } catch { toast('⚠️ Clipboard access denied. Paste manually (Ctrl+V).'); }
    });

    // ── SAMPLE TEXT ───────────────────────────────────────────────────────────────
    document.getElementById('btnSample').addEventListener('click', () => {
      document.getElementById('textInput').value =
        `The water cycle, also known as the hydrological cycle, describes the continuous movement of water on, above, and below the surface of the Earth.

Water evaporates from the surface of the ocean, rises into the atmosphere, cools and condenses into clouds, and falls back to the surface as precipitation.

The cycle has no beginning or end, and it keeps our planet's water supply in constant motion. Energy from the Sun drives the cycle, causing water to evaporate.

Transpiration from plants also adds water vapour to the atmosphere. Together, evaporation and transpiration are called evapotranspiration.

When precipitation falls over land, some of it seeps into the ground to form groundwater. The rest flows as runoff into rivers and lakes, eventually returning to the ocean.`;
      toast('📄 Sample text loaded!');
    });

    // ── CLEAR ─────────────────────────────────────────────────────────────────────
    document.getElementById('btnClear').addEventListener('click', () => {
      document.getElementById('textInput').value = '';
      document.getElementById('dictDisplay').classList.remove('on');
      document.getElementById('dictDisplay').innerHTML = '';
      document.getElementById('textInput').style.display = '';
      document.getElementById('clickInfo').classList.remove('on');
      document.getElementById('chunkCounter').classList.remove('on');
      stopRequested = true; synth.cancel();
      resetControls(true);
      setStatus('', 'Ready to dictate');
      tokens = []; chunks = []; wordEls = [];
      document.getElementById('progFill').style.width = '0%';
      document.getElementById('metaSpoken').textContent = '0 spoken';
      document.getElementById('metaLeft').textContent = '0 left';
      document.getElementById('svTotal').textContent = '0';
      toast('🗑 Cleared');
    });

    // ── UPLOAD FILE ───────────────────────────────────────────────────────────────
    document.getElementById('btnUpload').addEventListener('click', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.name.endsWith('.txt')) {
        const reader = new FileReader();
        reader.onload = ev => { document.getElementById('textInput').value = ev.target.result; toast('📄 File loaded!'); };
        reader.readAsText(file);
      } else if (file.name.endsWith('.pdf') || file.type === 'application/pdf') {
        loadPDF(file);
      }
      e.target.value = '';
    });

    async function loadPDF(file) {
      toast('⏳ Reading PDF…');
      try {
        const ab = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
        let out = '';
        let prevY = null;
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const tc = await page.getTextContent();
          let pageText = '';
          let lastY = null;
          tc.items.forEach(item => {
            const y = item.transform[5];
            if (lastY !== null && Math.abs(y - lastY) > 12) {
              // Significant y-gap = new line
              pageText += '\n';
            }
            pageText += item.str;
            lastY = y;
          });
          // Detect paragraph breaks: two+ newlines
          out += pageText.replace(/\n{2,}/g, '\n\n') + '\n\n';
        }
        document.getElementById('textInput').value = out.trim();
        toast('✅ PDF loaded (' + pdf.numPages + ' pages)');
      } catch (err) {
        toast('❌ Could not read PDF: ' + err.message);
      }
    }

    // ── DRAG AND DROP ─────────────────────────────────────────────────────────────
    const textZone = document.getElementById('textZone');
    const dropOverlay = document.getElementById('dropOverlay');
    textZone.addEventListener('dragover', e => { e.preventDefault(); dropOverlay.classList.add('on'); });
    textZone.addEventListener('dragleave', e => { if (!textZone.contains(e.relatedTarget)) dropOverlay.classList.remove('on'); });
    textZone.addEventListener('drop', e => {
      e.preventDefault(); dropOverlay.classList.remove('on');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.name.endsWith('.txt')) {
        const r = new FileReader();
        r.onload = ev => { document.getElementById('textInput').value = ev.target.result; toast('📄 File dropped!'); };
        r.readAsText(file);
      } else if (file.name.endsWith('.pdf') || file.type === 'application/pdf') {
        loadPDF(file);
      } else { toast('⚠️ Only .txt and .pdf files supported'); }
    });

    // ── EXPORT ────────────────────────────────────────────────────────────────────
    document.getElementById('btnExport').addEventListener('click', () => {
      const notes = document.getElementById('writeArea').value.trim();
      const src = document.getElementById('textInput').value.trim();
      const content = notes || src;
      if (!content) { toast('⚠️ Nothing to export!'); return; }
      const now = new Date();
      const fname = 'notes-' + now.toISOString().slice(0, 10) + '.txt';
      const blob = new Blob([content], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
      toast('💾 Exported as ' + fname);
    });

    // ── FOCUS MODE ────────────────────────────────────────────────────────────────
    document.getElementById('btnFocus').addEventListener('click', () => {
      focusMode = !focusMode;
      document.body.classList.toggle('focus-mode', focusMode);
      toast(focusMode ? '🎯 Focus mode ON' : '🎯 Focus mode OFF');
    });

    // ── WRITING PAD ───────────────────────────────────────────────────────────────
    document.getElementById('btnWritePad').addEventListener('click', () => {
      const pad = document.getElementById('writePad');
      pad.classList.toggle('on');
      toast(pad.classList.contains('on') ? '✍️ Writing pad opened' : '✍️ Writing pad closed');
    });
    document.getElementById('btnClearWrite').addEventListener('click', () => {
      document.getElementById('writeArea').value = '';
      toast('🗑 Notes cleared');
    });

    // ── SESSION AUTO-SAVE (localStorage guarded) ─────────────────────────────────
    function trySave() {
      try {
        const data = {
          text: document.getElementById('textInput').value,
          notes: document.getElementById('writeArea').value,
          ts: Date.now()
        };
        localStorage.setItem('ai_dictator_session', JSON.stringify(data));
      } catch (e) { }
    }
    function tryRestore() {
      try {
        const raw = localStorage.getItem('ai_dictator_session');
        if (!raw) return;
        const data = JSON.parse(raw);
        const age = Date.now() - (data.ts || 0);
        if (age > 86400000) return;
        if (data.text && data.text.trim()) {
          if (confirm('Resume previous session?')) {
            document.getElementById('textInput').value = data.text || '';
            document.getElementById('writeArea').value = data.notes || '';
            toast('✅ Session restored!');
          }
        }
      } catch (e) { }
    }
    setInterval(trySave, 5000);
    window.addEventListener('beforeunload', trySave);
    tryRestore();

    // ── EDIT MODE ─────────────────────────────────────────────────────────────────
    function toggleEditMode() {
      if (!isPlaying && !isPaused) {
        toast('⚠️ Start dictation first to enable edit mode');
        return;
      }

      editMode = !editMode;
      const dictDisplay = document.getElementById('dictDisplay');
      const editBtn = document.getElementById('btnEdit');
      const editInfo = document.getElementById('editInfo');
      const clickInfo = document.getElementById('clickInfo');

      if (editMode) {
        // Enter edit mode
        dictDisplay.classList.add('edit-mode');
        editBtn.classList.add('edit-mode');
        editInfo.classList.add('on');
        clickInfo.classList.remove('on');
        
        // Make content editable
        dictDisplay.contentEditable = true;
        
        // Save current position and pause dictation
        if (isPlaying && !isPaused) {
          document.getElementById('btnPause').click();
        }
        
        toast('✏️ Edit mode ON - You can now edit the text');
      } else {
        // Exit edit mode
        dictDisplay.classList.remove('edit-mode');
        editBtn.classList.remove('edit-mode');
        editInfo.classList.remove('on');
        clickInfo.classList.add('on');
        
        // Make content non-editable
        dictDisplay.contentEditable = false;
        
        // Update text from edited content
        updateTextFromDisplay();
        
        // Re-attach click handlers to word spans after editing
        setTimeout(() => {
          attachWordClickHandlers();
        }, 100);
        
        toast('🔊 Edit mode OFF - Dictation text updated');
      }
    }

    function updateTextFromDisplay() {
      const dictDisplay = document.getElementById('dictDisplay');
      const editedText = dictDisplay.innerText || dictDisplay.textContent;
      
      if (editedText.trim()) {
        // Update the hidden textarea
        document.getElementById('textInput').value = editedText.trim();
        
        // Reparse the text to update tokens and chunks
        const currentChunk = chunkIdx; // Remember current position
        parseText(editedText.trim());
        
        // Adjust chunk position if needed
        if (currentChunk < chunks.length) {
          chunkIdx = currentChunk;
        } else {
          chunkIdx = Math.max(0, chunks.length - 1);
        }
        
        // Update progress without re-rendering (to preserve edited content)
        updateProgress(chunkIdx);
        
        // Update word highlighting without full re-render
        if (!editMode && tokens.length > 0) {
          updateWordHighlighting();
        }
      }
    }

    function updateWordHighlighting() {
      const dictDisplay = document.getElementById('dictDisplay');
      const wordSpans = dictDisplay.querySelectorAll('.w');
      
      wordSpans.forEach((span, index) => {
        if (index < tokens.length) {
          const token = tokens[index];
          span.className = 'w';
          span.dataset.idx = index;
          span.dataset.chunk = token.chunkIdx;
          
          // Apply appropriate styling based on chunk position
          if (token.chunkIdx < chunkIdx) {
            span.classList.add('done');
          } else if (token.chunkIdx === chunkIdx) {
            span.classList.add('now');
          }
        }
      });
    }

    function attachWordClickHandlers() {
      const dictDisplay = document.getElementById('dictDisplay');
      const wordSpans = dictDisplay.querySelectorAll('.w');
      
      wordSpans.forEach((span) => {
        // Remove existing listeners to avoid duplicates
        span.replaceWith(span.cloneNode(true));
      });
      
      // Re-add click handlers to fresh spans
      const freshSpans = dictDisplay.querySelectorAll('.w');
      freshSpans.forEach((span) => {
        span.addEventListener('click', () => {
          const clickedChunk = parseInt(span.dataset.chunk);
          if (!isPlaying && !isPaused) {
            // Not playing: set jump point and start
            jumpToChunk = clickedChunk;
            document.getElementById('btnPlay').click();
          } else if (isPlaying || isPaused) {
            // Playing: jump to that chunk
            jumpToChunk = clickedChunk;
            stopRequested = true;
            synth.cancel();
            toast('⏭ Jumping to selected word…');
          }
        });
      });
    }

    // Add edit button event listener
    document.getElementById('btnEdit').addEventListener('click', toggleEditMode);

    // Handle Enter key in edit mode to continue dictation
    document.getElementById('dictDisplay').addEventListener('keydown', (e) => {
      if (editMode && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        toggleEditMode();
        // Resume dictation if it was paused
        if (isPaused) {
          document.getElementById('btnPause').click();
        }
      }
    });

