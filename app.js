// ============================================================
//  IPTV Collection — Frontend App
// ============================================================

const PAGE_SIZE = 48;

let allChannels  = [];
let filtered     = [];
let currentPage  = 1;
let activeView   = 'all';   // all | country | category | language
let activeFilter = null;    // { type, value }
let searchQuery  = '';
let isListView   = false;

// ── Bootstrap ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadChannels();
});

async function loadChannels() {
  try {
    const res  = await fetch('data/channels.json');
    if (!res.ok) throw new Error('channels.json not found');
    const data = await res.json();

    allChannels = (data.channels || data || []).map(normalizeChannel);
    renderStats(data);
    buildSidebarFilters();
    applyFilters();
  } catch (err) {
    console.error(err);
    renderError();
  }
}

function normalizeChannel(ch) {
  return {
    id:       ch.id       || crypto.randomUUID?.() || Math.random().toString(36).slice(2),
    name:     ch.name     || 'Unknown Channel',
    url:      ch.url      || ch.stream_url || '',
    logo:     ch.logo     || ch.logo_url   || '',
    country:  ch.country  || ch.country_code || '',
    country_name: ch.country_name || ch.country || '',
    language: Array.isArray(ch.languages) ? ch.languages.join(', ') : (ch.language || ''),
    category: ch.category || ch.group     || 'General',
    nsfw:     !!ch.nsfw,
    source:   ch.source   || '',
    status:   ch.status   || 'unknown',
  };
}

// ── Stats ────────────────────────────────────────────────────
function renderStats(data) {
  const countries  = new Set(allChannels.map(c => c.country).filter(Boolean));
  const categories = new Set(allChannels.map(c => c.category).filter(Boolean));
  const languages  = new Set(allChannels.map(c => c.language).filter(Boolean));

  document.getElementById('stat-total').innerHTML =
    `<span class="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block"></span>
     <strong class="text-white">${allChannels.length.toLocaleString()}</strong> channels`;

  document.getElementById('stat-countries').innerHTML =
    `🌍 <strong class="text-white">${countries.size}</strong> countries`;

  document.getElementById('stat-categories').innerHTML =
    `📂 <strong class="text-white">${categories.size}</strong> categories`;

  document.getElementById('stat-languages').innerHTML =
    `💬 <strong class="text-white">${languages.size}</strong> languages`;

  if (data.updated_at) {
    const d = new Date(data.updated_at);
    document.getElementById('stat-updated').textContent =
      `Updated ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }
}

// ── Sidebar filters ──────────────────────────────────────────
function buildSidebarFilters() {
  buildFilterList('category-filter', 'category');
  buildFilterList('country-filter', 'country_name', 'country');
}

function buildFilterList(containerId, field, valueField) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const counts = {};
  allChannels.forEach(ch => {
    const key = ch[field] || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  container.innerHTML = sorted.map(([name, count]) => `
    <button class="filter-pill" data-field="${valueField || field}" data-value="${escape(name)}" onclick="setFilter('${valueField || field}', '${escape(name)}')">
      <span class="truncate">${name}</span>
      <span class="text-xs text-gray-600 shrink-0">${count}</span>
    </button>
  `).join('');
}

function escape(s) { return s.replace(/'/g, "\\'"); }

// ── Filtering ────────────────────────────────────────────────
function applyFilters() {
  let results = [...allChannels];

  // Remove NSFW
  results = results.filter(c => !c.nsfw);

  // Search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    results = results.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.country_name.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q) ||
      c.language.toLowerCase().includes(q)
    );
  }

  // Sidebar filter
  if (activeFilter) {
    const { type, value } = activeFilter;
    if (type === 'category') results = results.filter(c => c.category === value);
    if (type === 'country')  results = results.filter(c => c.country_name === value || c.country === value);
    if (type === 'language') results = results.filter(c => c.language === value);
  }

  filtered = results;
  currentPage = 1;

  renderActiveFilters();

  if (activeView !== 'all' && !activeFilter && !searchQuery) {
    renderGroupView(activeView);
  } else {
    hideGroupView();
    renderChannels();
  }
}

function setFilter(type, value) {
  activeFilter = { type, value };

  // Update pill styles
  document.querySelectorAll('.filter-pill').forEach(btn => {
    const match = btn.dataset.field === type && btn.dataset.value === value;
    btn.classList.toggle('active', match);
  });

  applyFilters();
}

function clearFilters() {
  activeFilter  = null;
  searchQuery   = '';
  activeView    = 'all';
  document.getElementById('search-input').value = '';

  document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
  updateViewTabs('all');
  applyFilters();
}

window.clearFilters = clearFilters;

function renderActiveFilters() {
  const bar = document.getElementById('active-filters');
  const tags = [];

  if (searchQuery)   tags.push({ label: `"${searchQuery}"`, onRemove: () => { searchQuery = ''; document.getElementById('search-input').value = ''; applyFilters(); } });
  if (activeFilter)  tags.push({ label: `${activeFilter.type}: ${activeFilter.value}`, onRemove: () => { activeFilter = null; document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active')); applyFilters(); } });

  if (tags.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  bar.classList.remove('hidden');
  bar.innerHTML = tags.map((t, i) => `
    <span class="filter-tag">
      ${t.label}
      <button onclick="window.__removeFilter(${i})" class="hover:text-red-300 ml-1">✕</button>
    </span>
  `).join('');

  window.__removeFilter = (i) => tags[i].onRemove();
}

// ── Group view (browse by country/category/language) ─────────
function renderGroupView(view) {
  document.getElementById('channel-grid').innerHTML = '';
  document.getElementById('pagination').classList.add('hidden');
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('empty-state').classList.add('hidden');

  const gv = document.getElementById('group-view');
  gv.classList.remove('hidden');

  const field     = view === 'country' ? 'country_name' : view === 'category' ? 'category' : 'language';
  const counts    = {};
  allChannels.filter(c => !c.nsfw).forEach(ch => {
    const key = ch[field] || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  const icons = {
    country:  '🌍',
    category: '📂',
    language: '💬',
  };

  gv.innerHTML = `
    <p class="text-sm text-gray-400 mb-4">${sorted.length} ${view === 'country' ? 'countries' : view+'s'} available</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
      ${sorted.map(([name, count]) => `
        <div class="group-card" onclick="drillDown('${field}', '${name.replace(/'/g, "\\'")}')">
          <span class="text-2xl">${icons[view]}</span>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm text-white truncate">${name}</div>
            <div class="text-xs text-gray-500">${count} channels</div>
          </div>
          <svg class="w-4 h-4 text-gray-600 group-hover:text-brand-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </div>
      `).join('')}
    </div>
  `;

  document.getElementById('section-title').textContent = view.charAt(0).toUpperCase() + view.slice(1) + 's';
  document.getElementById('result-count').textContent  = `${sorted.length} ${view === 'country' ? 'countries' : view+'s'}`;
}

function drillDown(field, value) {
  const filterType = field === 'country_name' ? 'country' : field;
  setFilter(filterType, value);
}

function hideGroupView() {
  document.getElementById('group-view').classList.add('hidden');
  document.getElementById('group-view').innerHTML = '';
}

// ── Channel rendering ────────────────────────────────────────
function renderChannels() {
  const loading    = document.getElementById('loading');
  const grid       = document.getElementById('channel-grid');
  const emptyState = document.getElementById('empty-state');
  const pagination = document.getElementById('pagination');

  loading.classList.add('hidden');

  if (filtered.length === 0) {
    grid.innerHTML  = '';
    emptyState.classList.remove('hidden');
    pagination.classList.add('hidden');
    document.getElementById('result-count').textContent = 'No results';
    document.getElementById('section-title').textContent = searchQuery ? `Search: "${searchQuery}"` : (activeFilter ? activeFilter.value : 'All Channels');
    return;
  }

  emptyState.classList.add('hidden');

  const start   = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);

  document.getElementById('result-count').textContent =
    `${filtered.length.toLocaleString()} channels` +
    (filtered.length < allChannels.length ? ` (filtered from ${allChannels.length.toLocaleString()})` : '');

  if (activeFilter) {
    document.getElementById('section-title').textContent = activeFilter.value;
  } else if (searchQuery) {
    document.getElementById('section-title').textContent = `"${searchQuery}"`;
  } else {
    document.getElementById('section-title').textContent = 'All Channels';
  }

  if (isListView) {
    grid.className = 'space-y-1';
  } else {
    grid.className = 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3';
  }

  grid.innerHTML = pageItems.map(ch => renderCard(ch)).join('');
  renderPagination();
}

function renderCard(ch) {
  const logo = ch.logo
    ? `<img src="${ch.logo}" alt="" class="channel-logo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="channel-logo-placeholder" style="display:none">📺</div>`
    : `<div class="channel-logo-placeholder">📺</div>`;

  const nsfw = ch.nsfw ? `<span class="badge badge-nsfw">18+</span>` : '';
  const cat  = ch.category ? `<span class="badge badge-category">${ch.category}</span>` : '';
  const ctry = ch.country  ? `<span class="badge badge-country">${ch.country}</span>` : '';

  if (isListView) {
    return `
      <div class="channel-card list-mode" onclick="openModal('${ch.id}')">
        ${logo}
        <div class="flex-1 min-w-0">
          <div class="font-medium text-sm text-white truncate">${ch.name}</div>
          <div class="flex flex-wrap gap-1 mt-0.5">${cat}${ctry}${nsfw}</div>
        </div>
        <div class="flex gap-1.5 shrink-0">
          ${ch.url ? `<button class="btn-action btn-copy" onclick="event.stopPropagation();copyUrl('${escUrl(ch.url)}')">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          </button>` : ''}
        </div>
      </div>`;
  }

  return `
    <div class="channel-card" onclick="openModal('${ch.id}')">
      <div class="flex items-start gap-3">
        ${logo}
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-sm text-white leading-tight line-clamp-2">${ch.name}</div>
          ${ch.language ? `<div class="text-xs text-gray-500 mt-0.5">${ch.language}</div>` : ''}
        </div>
      </div>
      <div class="flex flex-wrap gap-1">${cat}${ctry}${nsfw}</div>
      <div class="flex gap-2 mt-auto pt-1">
        ${ch.url ? `
          <button class="btn-action btn-copy flex-1 justify-center" onclick="event.stopPropagation();copyUrl('${escUrl(ch.url)}')">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            Copy URL
          </button>
          <button class="btn-action btn-play" onclick="event.stopPropagation();openModal('${ch.id}')">
            <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </button>
        ` : '<span class="text-xs text-gray-600">No stream URL</span>'}
      </div>
    </div>`;
}

function escUrl(url) { return url.replace(/'/g, '%27').replace(/"/g, '%22'); }

// ── Pagination ───────────────────────────────────────────────
function renderPagination() {
  const pagination = document.getElementById('pagination');
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  if (totalPages <= 1) {
    pagination.classList.add('hidden');
    return;
  }

  pagination.classList.remove('hidden');

  const pages = [];
  if (currentPage > 1)          pages.push({ label: '‹', page: currentPage - 1 });
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) {
      pages.push({ label: String(i), page: i, active: i === currentPage });
    } else if (pages[pages.length - 1]?.label !== '…') {
      pages.push({ label: '…', page: null });
    }
  }
  if (currentPage < totalPages)  pages.push({ label: '›', page: currentPage + 1 });

  pagination.innerHTML = pages.map(p =>
    p.page !== null
      ? `<button class="page-btn ${p.active ? 'active' : ''}" onclick="goToPage(${p.page})">${p.label}</button>`
      : `<span class="page-btn cursor-default opacity-50">…</span>`
  ).join('');
}

function goToPage(page) {
  currentPage = page;
  renderChannels();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.goToPage = goToPage;

// ── Modal ────────────────────────────────────────────────────
function openModal(id) {
  const ch = allChannels.find(c => c.id === id);
  if (!ch) return;

  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');

  const logo = ch.logo
    ? `<img src="${ch.logo}" alt="${ch.name}" class="w-16 h-16 object-contain rounded-lg bg-gray-800" onerror="this.src=''" />`
    : `<div class="w-16 h-16 rounded-lg bg-gray-800 flex items-center justify-center text-3xl">📺</div>`;

  content.innerHTML = `
    <div class="p-6">
      <div class="flex items-start gap-4 mb-5">
        ${logo}
        <div class="flex-1 min-w-0">
          <h2 class="text-xl font-bold text-white">${ch.name}</h2>
          <div class="flex flex-wrap gap-1.5 mt-2">
            ${ch.category  ? `<span class="badge badge-category">${ch.category}</span>`  : ''}
            ${ch.country   ? `<span class="badge badge-country">${ch.country}</span>`    : ''}
            ${ch.language  ? `<span class="badge">${ch.language}</span>`                 : ''}
            ${ch.nsfw      ? `<span class="badge badge-nsfw">18+</span>`                 : ''}
          </div>
        </div>
        <button onclick="closeModal()" class="text-gray-500 hover:text-white p-1">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>

      ${ch.url ? `
        <div class="bg-gray-800 rounded-lg p-3 mb-4">
          <p class="text-xs text-gray-500 mb-1 font-medium">STREAM URL</p>
          <p class="text-xs text-gray-300 break-all font-mono">${ch.url}</p>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <button class="btn-action btn-copy justify-center py-2.5" onclick="copyUrl('${escUrl(ch.url)}')">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            Copy Stream URL
          </button>
          <a href="${ch.url}" target="_blank" class="btn-action btn-play justify-center py-2.5 no-underline">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            Open in Player
          </a>
        </div>

        <div class="mt-3 grid grid-cols-2 gap-2">
          <a href="vlc://${ch.url}" class="btn-action btn-m3u justify-center py-2.5 no-underline text-center">
            Open in VLC
          </a>
          <button onclick="copyM3U('${ch.id}')" class="btn-action btn-m3u justify-center py-2.5">
            Copy as M3U
          </button>
        </div>
      ` : `<p class="text-gray-500 text-sm text-center py-4">No stream URL available</p>`}

      ${ch.source ? `<p class="text-xs text-gray-600 mt-4 text-center">Source: ${ch.source}</p>` : ''}
    </div>
  `;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  document.body.style.overflow = '';
}
window.closeModal = closeModal;
window.openModal  = openModal;

// ── Copy helpers ─────────────────────────────────────────────
function copyUrl(url) {
  navigator.clipboard.writeText(url).then(() => showToast('URL copied!'));
}
window.copyUrl = copyUrl;

function copyM3U(id) {
  const ch = allChannels.find(c => c.id === id);
  if (!ch) return;
  const m3u = `#EXTM3U\n#EXTINF:-1 tvg-logo="${ch.logo}" group-title="${ch.category}",${ch.name}\n${ch.url}`;
  navigator.clipboard.writeText(m3u).then(() => showToast('M3U copied!'));
}
window.copyM3U = copyM3U;

function showToast(msg) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2000);
}

// ── Event Listeners ──────────────────────────────────────────
function setupEventListeners() {
  // Search
  const searchInput = document.getElementById('search-input');
  let searchDebounce;
  searchInput.addEventListener('input', e => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = e.target.value.trim();
      if (searchQuery) {
        activeView = 'all';
        updateViewTabs('all');
      }
      applyFilters();
    }, 280);
  });

  // View tabs (sidebar)
  document.querySelectorAll('.view-tab, .view-tab-mobile').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      activeView   = view;
      activeFilter = null;
      document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
      updateViewTabs(view);
      applyFilters();
    });
  });

  // Grid / List toggle
  document.getElementById('view-grid').addEventListener('click', () => {
    isListView = false;
    document.getElementById('view-grid').classList.replace('text-gray-500', 'text-brand-400');
    document.getElementById('view-list').classList.replace('text-brand-400', 'text-gray-500');
    renderChannels();
  });
  document.getElementById('view-list').addEventListener('click', () => {
    isListView = true;
    document.getElementById('view-list').classList.replace('text-gray-500', 'text-brand-400');
    document.getElementById('view-grid').classList.replace('text-brand-400', 'text-gray-500');
    renderChannels();
  });

  // ESC closes modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });
}

function updateViewTabs(active) {
  document.querySelectorAll('.view-tab').forEach(btn => {
    const isActive = btn.dataset.view === active;
    btn.classList.toggle('bg-brand-600', isActive);
    btn.classList.toggle('text-white',   isActive);
    btn.classList.toggle('text-gray-400',!isActive);
    if (isActive) btn.classList.remove('hover:bg-gray-800');
    else          btn.classList.add('hover:bg-gray-800');
  });
  document.querySelectorAll('.view-tab-mobile').forEach(btn => {
    const isActive = btn.dataset.view === active;
    btn.classList.toggle('bg-brand-600', isActive);
    btn.classList.toggle('text-white',   isActive);
    btn.classList.toggle('bg-gray-800', !isActive);
    btn.classList.toggle('text-gray-400',!isActive);
  });
}

window.drillDown = drillDown;

// ── Error fallback ───────────────────────────────────────────
function renderError() {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('channel-grid').innerHTML = `
    <div class="col-span-full text-center py-20">
      <div class="text-5xl mb-4">⚠️</div>
      <p class="text-lg font-medium text-gray-300">Channel data not found</p>
      <p class="text-sm text-gray-500 mt-2">Run the aggregation script to generate <code class="bg-gray-800 px-1.5 py-0.5 rounded text-brand-400">data/channels.json</code></p>
      <pre class="mt-4 inline-block text-left bg-gray-800 rounded-lg p-4 text-xs text-gray-300">cd scripts
pip install -r requirements.txt
python aggregate.py</pre>
    </div>`;
}
