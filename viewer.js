// viewer.js - Logic for the view-only page with optional player

const resultsPre = document.getElementById('results');
const timestampCardsContainer = document.getElementById('timestampCards');
const summaryEl = document.getElementById('summary');
const metaBody = document.getElementById('metaBody');
const metaTableWrap = document.getElementById('meta');
const sharedPlayer = document.getElementById('sharedPlayer');
const ytWrap = document.getElementById('ytWrap');
const ytFrame = document.getElementById('ytFrame');
const videoNotice = document.getElementById('videoNotice');

function escapeHTML(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Match main UI formatting: bolds and list items to pills/tags
function parseAndPill(text) {
  const safe = escapeHTML(text || '');
  let out = safe.replace(/\*\*(.+?)\*\*/g, (_m, p1) => `<strong class="pill-strong">${p1}</strong>`);
  out = out.replace(/^\*\s+(.+)$/gm, (_m, p1) => `<div class="pill-item">${p1}</div>`);
  out = out.replace(/\r?\n/g, '<br>');
  return out;
}

function categoryClass(category) {
  const c = (category || '').toLowerCase();
  if (/911/.test(c)) return 'cat-911';
  if (/investigation/.test(c)) return 'cat-investigation';
  if (/interrogation/.test(c)) return 'cat-interrogation';
  if (/cctv|footage/.test(c)) return 'cat-cctv';
  if (/body\s*cam/.test(c)) return 'cat-bodycam';
  return '';
}

function parseGeminiOutput(text) {
    if (!text) return { metadata: {}, timestamps: [], summary: '' };
    const lines = text.split(/\r?\n/);
    let metadata = {};
    let timestamps = [];
    let summary = '';
    let currentSection = '';
    let currentCategory = 'General';

    // Strip leading/trailing asterisks and whitespace (prevents raw * in output)
    const clean = (s) => (s || '').trim().replace(/^[\*\s]+|[\*\s]+$/g, '');

    for (const line of lines) {
        const trimmedLine = line.trim();
        const upperLine = trimmedLine.toUpperCase();
        if (trimmedLine.length === 0) continue;

        if (upperLine.includes('METADATA') && !upperLine.includes('EXTRACTION')) { currentSection = 'METADATA'; continue; }
        if (upperLine.includes('TIMESTAMPS')) { currentSection = 'TIMESTAMPS'; continue; }
        if (upperLine.includes('SUMMARY') || upperLine.includes('STORYLINE')) {
            currentSection = 'SUMMARY';
            let summaryPart = line.split(/AND STORYLINE|SUMMARY/i).pop() || '';
            summaryPart = summaryPart.replace(/^[\*\s:]+/g, '');
            if (summaryPart.trim()) { summary += summaryPart.trim() + '\n'; }
            continue;
        }

        switch (currentSection) {
            case 'METADATA': {
                const metaMatch = trimmedLine.match(/^[\*\-\s]*([^:]+?)\s*:\s*(.*)/);
                if (metaMatch && metaMatch[2] && metaMatch[2].trim()) {
                    const key = clean(metaMatch[1]);
                    const value = clean(metaMatch[2]);
                    if (key && value && !/\[extracted.*\]/i.test(value)) { metadata[key] = value; }
                }
                break;
            }
            case 'TIMESTAMPS': {
                const categoryMatch = trimmedLine.match(/^\s*(?:\*{1,3}|#{1,3})\s*(?:\d+\.?\s*)?([A-Z0-9\s/&-]+)\s*(?:\*{1,3}|:)?\s*$/i);
                if (categoryMatch && !trimmedLine.includes('[')) { currentCategory = categoryMatch[1].trim(); continue; }
                const tsMatch = trimmedLine.match(/\[([^\]]+)\]\s*-\s*(.+)/);
                if (tsMatch) {
                    let description = clean(tsMatch[2]);
                    let finalCategory = clean(currentCategory);
                    const descParts = description.split(/\s*-\s*/);
                    if (descParts.length > 1) {
                        if (descParts[0].trim().toUpperCase() === finalCategory.toUpperCase()) { description = descParts.slice(1).join(' - ').trim(); }
                        else { finalCategory = descParts[0].trim(); description = descParts.slice(1).join(' - ').trim(); }
                    }
                    timestamps.push({ time: clean(tsMatch[1]), category: finalCategory, description: clean(description) });
                }
                break;
            }
            case 'SUMMARY': {
                summary += line + '\n';
                break;
            }
        }
    }
    const finalSummary = summary.trim().replace(/^[\*\s]+|[\*\s]+$/g, '');
    return { metadata, timestamps, summary: finalSummary };
}

function buildStructuredOutput(text) {
  const { metadata, timestamps, summary } = parseGeminiOutput(text);
  summaryEl.innerHTML = parseAndPill(summary || '—');
  if (Object.keys(metadata).length > 0) {
    metaTableWrap.classList.remove('hidden');
    let metaHtml = '';
    for (const [key, value] of Object.entries(metadata)) {
      metaHtml += `<tr><td><span class="pill-key">${escapeHTML(key)}</span></td><td>${parseAndPill(value)}</td></tr>`;
    }
    metaBody.innerHTML = metaHtml;
  } else { metaTableWrap.classList.add('hidden'); metaBody.innerHTML = ''; }
  
  // Normalize ranges: if only a start time is present, use next start as end
  const normalized = (() => {
    const withStart = timestamps.map((t, i) => ({ ...t, __idx: i, __start: timeToSeconds(t.time) }));
    const sorted = [...withStart].sort((a, b) => a.__start - b.__start);
    const idxToDisplay = new Map();
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const raw = String(cur.time || '');
      if (/\s-\s/.test(raw)) { idxToDisplay.set(cur.__idx, raw); continue; }
      const next = sorted[i + 1];
      if (next && isFinite(next.__start) && next.__start > cur.__start) {
        const toLabel = (secs) => {
          const h = Math.floor(secs / 3600); const m = Math.floor((secs % 3600) / 60); const s = Math.floor(secs % 60);
          if (h > 0) return `${String(h).padStart(1,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
          return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        };
        idxToDisplay.set(cur.__idx, `${raw} - ${toLabel(next.__start)}`);
      } else {
        idxToDisplay.set(cur.__idx, raw);
      }
    }
    return withStart.map(t => ({ ...t, displayTime: idxToDisplay.get(t.__idx) || t.time }));
  })();

  const grouped = normalized.reduce((acc, ts) => {
    const cat = ts.category.trim();
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(ts);
    return acc;
  }, {});
  let cardsHtml = '';
  for (const [category, items] of Object.entries(grouped)) {
    const catClass = categoryClass(category);
    
    const rows = items.map(it => {
        const label = escapeHTML(it.displayTime || it.time);
        return `<div class="timestamp-card ${catClass}"><h3><button class="link ts-jump" data-ts="${label}"><span class="pill-time">${label}</span></button></h3><p class="ts-desc">${escapeHTML(it.description || '')}</p></div>`;
    }).join('');
    cardsHtml += `<div class="timestamp-card-group"><h2 class="panel-title">${escapeHTML(category)}</h2><div class="timestamp-card-list">${rows}</div></div>`;
  }
  timestampCardsContainer.innerHTML = cardsHtml || `<div class="muted">No timestamps found.</div>`;
}

function timeToSeconds(ts) {
  const startTime = (ts || '').split(' - ')[0].trim();
  const parts = (startTime || '').split(':').map(x => parseInt(x, 10));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

timestampCardsContainer?.addEventListener('click', (e) => {
  const btn = e.target.closest('.ts-jump');
  if (!btn) return;
  const ts = btn.getAttribute('data-ts') || '';
  const secs = timeToSeconds(ts);
  if (!isNaN(secs)) {
    if (sharedPlayer && !sharedPlayer.classList.contains('hidden')) {
      try { sharedPlayer.currentTime = secs; sharedPlayer.play(); } catch {}
    } else if (ytFrame && !ytWrap.classList.contains('hidden')) {
      const cur = ytFrame.getAttribute('src') || '';
      if (cur) {
        const url = new URL(cur.split('?')[0]);
        url.searchParams.set('start', String(secs));
        url.searchParams.set('autoplay', '1');
        ytFrame.src = url.toString();
      }
    }
  }
});

// Tab functionality
const tabs = Array.from(document.querySelectorAll('.tab'));
const tabContents = Array.from(document.querySelectorAll('.tab-content'));
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    tabContents.forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// Main logic on page load
window.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1. Get the ID from the URL (e.g., ?id=12345)
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');

    if (!id) {
      throw new Error("No analysis ID found in URL.");
    }

    // 2. Fetch the job data from the server
    const res = await fetch(`/api/job/status/${id}`);
    if (!res.ok) {
      throw new Error(`Could not load analysis (Error ${res.status}).`);
    }

    const data = await res.json(); // 'data' is the job object

    if (!data.analysisText || data.status !== 'COMPLETE') {
      if (data.status === 'FAILED') {
        throw new Error(`Analysis failed: ${data.analysisText}`);
      }
      if (data.status !== 'COMPLETE') {
        throw new Error("This analysis is still processing. Please try again later.");
      }
      throw new Error("Analysis data is empty.");
    }

    // 3. Set the raw text and build the structured output
    resultsPre.textContent = data.analysisText;
    buildStructuredOutput(data.analysisText);

    // 4. Render the shared video
    if (data.videoUrl) {
      // Check if it's a YouTube URL
      const embed = toYouTubeEmbed(data.videoUrl);
      if (embed) {
        ytFrame.src = embed;
        ytWrap.classList.remove('hidden');
        videoNotice.classList.add('hidden');
      } else if (data.videoUrl.startsWith('/shared/')) {
        // It's a self-hosted file
        sharedPlayer.src = data.videoUrl;
        sharedPlayer.classList.remove('hidden');
        ytWrap.classList.add('hidden');
        videoNotice.classList.add('hidden');
      }
    } else {
      // No video URL was saved with the job
      videoNotice.classList.remove('hidden');
    }

  } catch (err) {
    summaryEl.textContent = `Error: Could not load shared analysis. ${err.message}`;
    summaryEl.style.color = 'var(--err)';
  }
});

// Helper function to check/build YouTube embeds
function toYouTubeEmbed(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/embed/${v}`;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
  } catch {}
  return '';
}
