(() => {
  'use strict';

  const VIEW_KEY = 'codexWeb.workspaceView';
  const PROMPT_VIEW_KEY = 'codexWeb.imagePromptView';
  const FAVORITES_KEY = 'codexWeb.imagePromptFavorites';
  const PARAMS_KEY = 'codexWeb.imagePromptParams';
  const PAGE_SIZE = 24;
  const DEFAULT_PARAMS = {
    ratio: 'auto',
    quality: 'auto',
    format: 'png',
    count: 1,
    preserve: true,
  };
  const CATEGORY_FALLBACKS = {
    'UI & Interfaces': 'UI 与界面',
    'Charts & Infographics': '图表与信息可视化',
    'Posters & Typography': '海报与排版',
    'Products & E-commerce': '商品与电商',
    'Brand & Logos': '品牌与标志',
    'Architecture & Spaces': '建筑与空间',
    'Photography & Realism': '摄影与写实',
    'Illustration & Art': '插画与艺术',
    'Characters & People': '人物与角色',
    'Scenes & Storytelling': '场景与叙事',
    'History & Classical Themes': '历史与古风',
    'Documents & Publishing': '文档与出版物',
    'Other Use Cases': '其他',
  };

  const state = {
    activeView: 'codex',
    activePromptView: localStorage.getItem(PROMPT_VIEW_KEY) === 'playground' ? 'playground' : 'library',
    library: null,
    mode: 'cases',
    query: '',
    category: '',
    favoritesOnly: false,
    visible: PAGE_SIZE,
    favorites: readStringSet(FAVORITES_KEY),
    params: readParams(),
    selected: null,
    loading: false,
  };

  const elements = {};

  function init() {
    const top = document.querySelector('.top');
    const main = document.querySelector('.main');
    const chatPanel = document.getElementById('chat');
    const composerPanel = document.querySelector('.composer');
    if (!top || !main || !chatPanel || !composerPanel) return;

    elements.top = top;
    elements.main = main;
    elements.chat = chatPanel;
    elements.composer = composerPanel;
    createWorkspaceNavigation();
    createPromptWorkspace();
    createPromptDetail();
    bindWorkspaceEvents();

    const savedView = localStorage.getItem(VIEW_KEY);
    setWorkspaceView(savedView === 'image-prompts' ? 'image-prompts' : 'codex', { persist: false });
    refreshPromptIcons(document);
  }

  function createWorkspaceNavigation() {
    const nav = document.createElement('nav');
    nav.className = 'workspaceNav';
    nav.setAttribute('aria-label', '工作区');

    const codexButton = createNavButton('message-square', 'Codex', 'codex');
    const promptButton = createNavButton('images', 'Image Prompt', 'image-prompts');
    nav.appendChild(codexButton);
    nav.appendChild(promptButton);

    const context = [...elements.top.children].find((child) => child.querySelector?.('.title'));
    context?.classList.add('topConversationContext');
    elements.top.insertBefore(nav, context || elements.top.lastElementChild);
    elements.nav = nav;
    elements.codexNav = codexButton;
    elements.promptNav = promptButton;
  }

  function createNavButton(iconName, label, view) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspaceNavButton';
    button.dataset.workspaceView = view;
    button.appendChild(createIcon(iconName));
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    button.addEventListener('click', () => setWorkspaceView(view));
    return button;
  }

  function createPromptWorkspace() {
    const workspace = document.createElement('section');
    workspace.id = 'imagePromptWorkspace';
    workspace.className = 'imagePromptWorkspace hidden';
    workspace.setAttribute('aria-label', 'Image Prompt');
    workspace.innerHTML = `
      <div class="imagePromptViewBar">
        <div class="imagePromptViewTabs" role="tablist" aria-label="Image Prompt 视图">
          <button id="imagePromptLibraryView" class="imagePromptViewTab active" type="button" role="tab" aria-selected="true" aria-controls="imagePromptLibraryPanel">
            <i data-lucide="library" aria-hidden="true"></i><span>提示词库</span>
          </button>
          <button id="imagePromptPlaygroundView" class="imagePromptViewTab" type="button" role="tab" aria-selected="false" aria-controls="imagePromptPlaygroundPanel" tabindex="-1">
            <i data-lucide="wand-sparkles" aria-hidden="true"></i><span>生图工作台</span>
          </button>
        </div>
      </div>
      <div id="imagePromptLibraryPanel" class="imagePromptLibraryPanel" role="tabpanel" aria-labelledby="imagePromptLibraryView">
        <div class="imagePromptShell">
        <header class="imagePromptHeader">
          <div>
            <h1>Codex Image Prompt</h1>
            <p id="imagePromptStats">提示词库</p>
          </div>
          <div class="imagePromptSources" aria-label="提示词来源"></div>
        </header>
        <div class="imagePromptToolbar">
          <div class="imagePromptMode" role="group" aria-label="内容类型">
            <button id="imagePromptCasesMode" class="active" type="button">案例</button>
            <button id="imagePromptTemplatesMode" type="button">模板</button>
          </div>
          <label class="imagePromptSearch">
            <span class="imagePromptSearchIcon" aria-hidden="true"><i data-lucide="search"></i></span>
            <input id="imagePromptSearch" type="search" placeholder="搜索标题、提示词或标签" autocomplete="off">
          </label>
          <select id="imagePromptCategory" aria-label="筛选分类">
            <option value="">全部分类</option>
          </select>
          <button id="imagePromptFavorites" class="imagePromptIconCommand" type="button" aria-pressed="false">
            <i data-lucide="heart" aria-hidden="true"></i><span>收藏</span>
          </button>
        </div>
        <div class="imagePromptResultMeta">
          <span id="imagePromptResultCount">正在载入</span>
          <button id="imagePromptClearFilters" type="button">清除筛选</button>
        </div>
        <div id="imagePromptLoading" class="imagePromptLoading"><span class="spinner"></span> 载入提示词</div>
        <div id="imagePromptGrid" class="imagePromptGrid" aria-live="polite"></div>
        <div id="imagePromptEmpty" class="imagePromptEmpty hidden">没有匹配的提示词</div>
        <div class="imagePromptLoadRow">
          <button id="imagePromptLoadMore" class="imagePromptSecondary hidden" type="button">加载更多</button>
        </div>
        <footer class="imagePromptFooter">
          <span>MIT licensed sources</span>
          <span>生成任务通过 Codex App 执行</span>
        </footer>
        </div>
      </div>
      <div id="imagePromptPlaygroundPanel" class="imagePromptPlaygroundPanel hidden" role="tabpanel" aria-labelledby="imagePromptPlaygroundView">
        <div id="imagePromptPlaygroundLoading" class="imagePromptPlaygroundLoading"><span class="spinner"></span> 正在载入生图工作台</div>
        <iframe id="imagePromptPlaygroundFrame" class="imagePromptPlaygroundFrame" data-src="/playground/" title="GPT Image Playground 生图工作台" allow="clipboard-read; clipboard-write"></iframe>
      </div>
      <div id="imagePromptToast" class="imagePromptToast" role="status" aria-live="polite"></div>
    `;
    elements.main.insertBefore(workspace, elements.composer);
    elements.workspace = workspace;
    elements.libraryView = workspace.querySelector('#imagePromptLibraryView');
    elements.playgroundView = workspace.querySelector('#imagePromptPlaygroundView');
    elements.libraryPanel = workspace.querySelector('#imagePromptLibraryPanel');
    elements.playgroundPanel = workspace.querySelector('#imagePromptPlaygroundPanel');
    elements.playgroundLoading = workspace.querySelector('#imagePromptPlaygroundLoading');
    elements.playgroundFrame = workspace.querySelector('#imagePromptPlaygroundFrame');
    elements.stats = workspace.querySelector('#imagePromptStats');
    elements.sources = workspace.querySelector('.imagePromptSources');
    elements.casesMode = workspace.querySelector('#imagePromptCasesMode');
    elements.templatesMode = workspace.querySelector('#imagePromptTemplatesMode');
    elements.search = workspace.querySelector('#imagePromptSearch');
    elements.category = workspace.querySelector('#imagePromptCategory');
    elements.favorites = workspace.querySelector('#imagePromptFavorites');
    elements.clearFilters = workspace.querySelector('#imagePromptClearFilters');
    elements.resultCount = workspace.querySelector('#imagePromptResultCount');
    elements.loading = workspace.querySelector('#imagePromptLoading');
    elements.grid = workspace.querySelector('#imagePromptGrid');
    elements.empty = workspace.querySelector('#imagePromptEmpty');
    elements.loadMore = workspace.querySelector('#imagePromptLoadMore');
    elements.toast = workspace.querySelector('#imagePromptToast');
  }

  function createPromptDetail() {
    const overlay = document.createElement('div');
    overlay.id = 'imagePromptDetail';
    overlay.className = 'imagePromptDetailOverlay hidden';
    overlay.setAttribute('role', 'presentation');
    overlay.innerHTML = `
      <section class="imagePromptDetailDialog" role="dialog" aria-modal="true" aria-labelledby="imagePromptDetailTitle">
        <header class="imagePromptDetailHead">
          <div>
            <div id="imagePromptDetailCategory" class="imagePromptDetailCategory"></div>
            <h2 id="imagePromptDetailTitle"></h2>
          </div>
          <div class="imagePromptDetailHeadActions">
            <button id="imagePromptDetailFavorite" class="imagePromptIconButton" type="button" aria-label="收藏提示词" title="收藏提示词"><i data-lucide="heart"></i></button>
            <button id="imagePromptDetailClose" class="imagePromptIconButton" type="button" aria-label="关闭" title="关闭"><i data-lucide="x"></i></button>
          </div>
        </header>
        <div class="imagePromptDetailBody">
          <div class="imagePromptPreviewPane">
            <div class="imagePromptPreviewFrame"><img id="imagePromptDetailImage" alt=""></div>
            <div id="imagePromptDetailTags" class="imagePromptTags"></div>
            <div id="imagePromptExamples" class="imagePromptExamples hidden"></div>
            <a id="imagePromptSourceLink" class="imagePromptSourceLink" target="_blank" rel="noopener noreferrer">查看来源</a>
          </div>
          <div class="imagePromptEditorPane">
            <label class="imagePromptPromptField">
              <span>提示词</span>
              <textarea id="imagePromptEditor" rows="12"></textarea>
            </label>
            <div class="imagePromptParams">
              <label><span>比例</span><select id="imagePromptRatio"><option value="auto">自动</option><option value="1:1">1:1</option><option value="4:3">4:3</option><option value="3:4">3:4</option><option value="16:9">16:9</option><option value="9:16">9:16</option></select></label>
              <label><span>质量</span><select id="imagePromptQuality"><option value="auto">自动</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
              <label><span>格式</span><select id="imagePromptFormat"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label>
              <label><span>数量</span><input id="imagePromptCount" type="number" min="1" max="4" step="1"></label>
            </div>
            <label class="imagePromptToggle"><input id="imagePromptPreserve" type="checkbox"><span>保持提示词结构</span></label>
            <div class="imagePromptReferencesHead">
              <span>参考附件 <b id="imagePromptReferenceCount">0</b></span>
              <button id="imagePromptAddReference" class="imagePromptSecondary" type="button"><i data-lucide="paperclip"></i><span>添加参考图</span></button>
              <input id="imagePromptReferenceInput" class="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple>
            </div>
            <div id="imagePromptReferences" class="imagePromptReferences"></div>
          </div>
        </div>
        <footer class="imagePromptDetailActions">
          <button id="imagePromptCopy" class="imagePromptSecondary" type="button"><i data-lucide="copy"></i><span>复制</span></button>
          <span class="imagePromptActionSpacer"></span>
          <button id="imagePromptUse" class="imagePromptSecondary" type="button"><i data-lucide="message-square"></i><span>填入对话</span></button>
          <button id="imagePromptSend" class="imagePromptPrimary" type="button"><i data-lucide="sparkles"></i><span>发送到 Codex App</span></button>
        </footer>
      </section>
    `;
    document.body.appendChild(overlay);
    elements.detail = overlay;
    elements.detailDialog = overlay.querySelector('.imagePromptDetailDialog');
    elements.detailPreviewFrame = overlay.querySelector('.imagePromptPreviewFrame');
    elements.detailCategory = overlay.querySelector('#imagePromptDetailCategory');
    elements.detailTitle = overlay.querySelector('#imagePromptDetailTitle');
    elements.detailImage = overlay.querySelector('#imagePromptDetailImage');
    elements.detailTags = overlay.querySelector('#imagePromptDetailTags');
    elements.detailExamples = overlay.querySelector('#imagePromptExamples');
    elements.detailSource = overlay.querySelector('#imagePromptSourceLink');
    elements.detailEditor = overlay.querySelector('#imagePromptEditor');
    elements.detailFavorite = overlay.querySelector('#imagePromptDetailFavorite');
    elements.detailClose = overlay.querySelector('#imagePromptDetailClose');
    elements.ratio = overlay.querySelector('#imagePromptRatio');
    elements.quality = overlay.querySelector('#imagePromptQuality');
    elements.format = overlay.querySelector('#imagePromptFormat');
    elements.count = overlay.querySelector('#imagePromptCount');
    elements.preserve = overlay.querySelector('#imagePromptPreserve');
    elements.referenceCount = overlay.querySelector('#imagePromptReferenceCount');
    elements.addReference = overlay.querySelector('#imagePromptAddReference');
    elements.referenceInput = overlay.querySelector('#imagePromptReferenceInput');
    elements.references = overlay.querySelector('#imagePromptReferences');
    elements.copy = overlay.querySelector('#imagePromptCopy');
    elements.use = overlay.querySelector('#imagePromptUse');
    elements.send = overlay.querySelector('#imagePromptSend');
  }

  function bindWorkspaceEvents() {
    elements.libraryView.addEventListener('click', () => setImagePromptView('library'));
    elements.playgroundView.addEventListener('click', () => setImagePromptView('playground'));
    elements.playgroundFrame.addEventListener('load', () => {
      elements.playgroundLoading.classList.add('hidden');
      elements.playgroundFrame.classList.add('loaded');
    });
    elements.casesMode.addEventListener('click', () => setLibraryMode('cases'));
    elements.templatesMode.addEventListener('click', () => setLibraryMode('templates'));
    elements.search.addEventListener('input', () => {
      state.query = elements.search.value.trim();
      state.visible = PAGE_SIZE;
      renderLibrary();
    });
    elements.category.addEventListener('change', () => {
      state.category = elements.category.value;
      state.visible = PAGE_SIZE;
      renderLibrary();
    });
    elements.favorites.addEventListener('click', () => {
      state.favoritesOnly = !state.favoritesOnly;
      state.visible = PAGE_SIZE;
      elements.favorites.setAttribute('aria-pressed', String(state.favoritesOnly));
      elements.favorites.classList.toggle('active', state.favoritesOnly);
      renderLibrary();
    });
    elements.clearFilters.addEventListener('click', clearFilters);
    elements.loadMore.addEventListener('click', () => {
      state.visible += PAGE_SIZE;
      renderLibrary();
    });

    elements.detailClose.addEventListener('click', closePromptDetail);
    elements.detailImage.addEventListener('load', () => setDetailImageState('ready'));
    elements.detailImage.addEventListener('error', () => setDetailImageState('error'));
    elements.detail.addEventListener('click', (event) => {
      if (event.target === elements.detail) closePromptDetail();
    });
    elements.detailFavorite.addEventListener('click', () => {
      if (!state.selected) return;
      toggleFavorite(state.selected.type, state.selected.item);
      updateDetailFavorite();
    });
    elements.copy.addEventListener('click', () => copyText(elements.detailEditor.value));
    elements.use.addEventListener('click', () => useSelectedPrompt(false));
    elements.send.addEventListener('click', () => useSelectedPrompt(true));
    elements.addReference.addEventListener('click', () => elements.referenceInput.click());
    elements.referenceInput.addEventListener('change', addReferenceFiles);
    for (const control of [elements.ratio, elements.quality, elements.format, elements.count, elements.preserve]) {
      control.addEventListener('change', saveCurrentParams);
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !elements.detail.classList.contains('hidden')) closePromptDetail();
    });
    document.getElementById('newChat')?.addEventListener('click', () => setWorkspaceView('codex'));
    document.getElementById('history')?.addEventListener('click', (event) => {
      if (event.target.closest('.histOpen')) setWorkspaceView('codex');
    });
  }

  function setWorkspaceView(view, options = {}) {
    state.activeView = view === 'image-prompts' ? 'image-prompts' : 'codex';
    const promptActive = state.activeView === 'image-prompts';
    elements.workspace.classList.toggle('hidden', !promptActive);
    elements.chat.classList.toggle('hidden', promptActive);
    elements.composer.classList.toggle('hidden', promptActive);
    elements.codexNav.classList.toggle('active', !promptActive);
    elements.promptNav.classList.toggle('active', promptActive);
    elements.codexNav.setAttribute('aria-current', promptActive ? 'false' : 'page');
    elements.promptNav.setAttribute('aria-current', promptActive ? 'page' : 'false');
    const skipLink = document.querySelector('.skipLink');
    if (skipLink) skipLink.href = promptActive ? '#imagePromptWorkspace' : '#chat';
    if (options.persist !== false) localStorage.setItem(VIEW_KEY, state.activeView);
    if (promptActive) {
      if (typeof closeMenu === 'function') closeMenu();
      setImagePromptView(state.activePromptView, { persist: false });
    } else {
      document.getElementById('input')?.focus();
    }
  }

  function setImagePromptView(view, options = {}) {
    state.activePromptView = view === 'playground' ? 'playground' : 'library';
    const playgroundActive = state.activePromptView === 'playground';
    elements.libraryPanel.classList.toggle('hidden', playgroundActive);
    elements.playgroundPanel.classList.toggle('hidden', !playgroundActive);
    elements.libraryView.classList.toggle('active', !playgroundActive);
    elements.playgroundView.classList.toggle('active', playgroundActive);
    elements.libraryView.setAttribute('aria-selected', String(!playgroundActive));
    elements.playgroundView.setAttribute('aria-selected', String(playgroundActive));
    elements.libraryView.tabIndex = playgroundActive ? -1 : 0;
    elements.playgroundView.tabIndex = playgroundActive ? 0 : -1;
    if (options.persist !== false) localStorage.setItem(PROMPT_VIEW_KEY, state.activePromptView);
    if (!playgroundActive) {
      loadLibrary();
      return;
    }
    if (elements.playgroundFrame.dataset.loaded !== 'true') {
      elements.playgroundFrame.dataset.loaded = 'true';
      elements.playgroundFrame.src = elements.playgroundFrame.dataset.src;
    }
  }

  async function loadLibrary() {
    if (state.library || state.loading) return;
    state.loading = true;
    elements.loading.classList.remove('hidden');
    try {
      const response = await fetch('/api/image-prompts');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '提示词库载入失败');
      state.library = data;
      populateLibraryChrome();
      renderLibrary();
    } catch (error) {
      elements.loading.innerHTML = '';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'imagePromptSecondary';
      retry.textContent = '重新载入';
      retry.addEventListener('click', () => {
        state.loading = false;
        loadLibrary();
      });
      elements.loading.append(String(error.message || error), retry);
    } finally {
      state.loading = false;
    }
  }

  function populateLibraryChrome() {
    const library = state.library;
    elements.stats.textContent = `${library.totalCases} 个案例 · ${library.totalTemplates} 套模板`;
    elements.sources.replaceChildren();
    for (const source of library.sources || []) {
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.name;
      link.title = `${source.role} · ${source.license}`;
      elements.sources.appendChild(link);
    }
    const labels = categoryLabels();
    for (const category of library.categories || []) {
      const option = document.createElement('option');
      option.value = category.value;
      option.textContent = labels.get(category.value) || category.value;
      elements.category.appendChild(option);
    }
  }

  function setLibraryMode(mode) {
    state.mode = mode === 'templates' ? 'templates' : 'cases';
    state.visible = PAGE_SIZE;
    elements.casesMode.classList.toggle('active', state.mode === 'cases');
    elements.templatesMode.classList.toggle('active', state.mode === 'templates');
    renderLibrary();
  }

  function clearFilters() {
    state.query = '';
    state.category = '';
    state.favoritesOnly = false;
    state.visible = PAGE_SIZE;
    elements.search.value = '';
    elements.category.value = '';
    elements.favorites.classList.remove('active');
    elements.favorites.setAttribute('aria-pressed', 'false');
    renderLibrary();
  }

  function filteredItems() {
    if (!state.library) return [];
    const source = state.mode === 'templates' ? state.library.templates : state.library.cases;
    const query = state.query.toLocaleLowerCase();
    return source.filter((item) => {
      const type = state.mode === 'templates' ? 'template' : 'case';
      if (state.category && item.category !== state.category) return false;
      if (state.favoritesOnly && !state.favorites.has(itemKey(type, item))) return false;
      if (!query) return true;
      const searchable = [
        itemTitle(item),
        itemDescription(item),
        item.prompt,
        item.promptPreview,
        item.category,
        ...(item.styles || []),
        ...(item.scenes || []),
        ...(item.tags || []),
      ].filter(Boolean).join(' ').toLocaleLowerCase();
      return searchable.includes(query);
    });
  }

  function renderLibrary() {
    if (!state.library) return;
    elements.loading.classList.add('hidden');
    const items = filteredItems();
    const visible = items.slice(0, state.visible);
    elements.grid.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const item of visible) fragment.appendChild(createPromptCard(item));
    elements.grid.appendChild(fragment);
    elements.empty.classList.toggle('hidden', items.length > 0);
    elements.resultCount.textContent = `${items.length} 条${state.mode === 'templates' ? '模板' : '案例'}`;
    elements.loadMore.classList.toggle('hidden', visible.length >= items.length);
    elements.loadMore.textContent = `加载更多 · ${items.length - visible.length}`;
    refreshPromptIcons(elements.grid);
  }

  function createPromptCard(item) {
    const type = state.mode === 'templates' ? 'template' : 'case';
    const article = document.createElement('article');
    article.className = 'imagePromptCard';
    article.dataset.promptKey = itemKey(type, item);

    const media = document.createElement('button');
    media.type = 'button';
    media.className = 'imagePromptCardMedia';
    media.setAttribute('aria-label', `打开 ${itemTitle(item)}`);
    const image = document.createElement('img');
    image.src = promptImageUrl(item.image || item.cover);
    image.alt = item.imageAlt || itemTitle(item);
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      image.hidden = true;
      media.classList.add('imageError');
    });
    media.appendChild(image);
    const typeBadge = document.createElement('span');
    typeBadge.className = 'imagePromptTypeBadge';
    typeBadge.textContent = type === 'template' ? '模板' : `#${item.id}`;
    media.appendChild(typeBadge);
    media.addEventListener('click', () => openPromptDetail(type, item));

    const body = document.createElement('div');
    body.className = 'imagePromptCardBody';
    const category = document.createElement('div');
    category.className = 'imagePromptCardCategory';
    category.textContent = categoryLabel(item.category);
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'imagePromptCardTitle';
    title.textContent = itemTitle(item);
    title.addEventListener('click', () => openPromptDetail(type, item));
    const preview = document.createElement('p');
    preview.textContent = itemDescription(item);

    const actions = document.createElement('div');
    actions.className = 'imagePromptCardActions';
    const tags = document.createElement('div');
    tags.className = 'imagePromptCardTags';
    for (const tag of [...(item.styles || []), ...(item.tags || [])].slice(0, 2)) {
      const chip = document.createElement('span');
      chip.textContent = tag;
      tags.appendChild(chip);
    }
    const copy = createIconButton('copy', '复制提示词');
    copy.addEventListener('click', () => copyText(itemPrompt(type, item)));
    const favorite = createIconButton('heart', '收藏提示词');
    favorite.classList.toggle('active', state.favorites.has(itemKey(type, item)));
    favorite.addEventListener('click', () => toggleFavorite(type, item));
    actions.appendChild(tags);
    actions.appendChild(copy);
    actions.appendChild(favorite);

    body.appendChild(category);
    body.appendChild(title);
    body.appendChild(preview);
    body.appendChild(actions);
    article.appendChild(media);
    article.appendChild(body);
    return article;
  }

  function openPromptDetail(type, item) {
    state.selected = { type, item };
    elements.detailCategory.textContent = categoryLabel(item.category);
    elements.detailTitle.textContent = itemTitle(item);
    loadDetailImage(item);
    elements.detailEditor.value = itemPrompt(type, item);
    elements.ratio.value = state.params.ratio;
    elements.quality.value = state.params.quality;
    elements.format.value = state.params.format;
    elements.count.value = String(state.params.count);
    elements.preserve.checked = state.params.preserve;
    renderDetailTags(item);
    renderTemplateExamples(type, item);
    elements.detailSource.href = type === 'case'
      ? item.githubUrl || item.sourceUrl || state.library.sources[0].url
      : `${state.library.sources[0].url}#readme`;
    updateDetailFavorite();
    syncPromptReferences();
    elements.detail.classList.remove('hidden');
    document.body.classList.add('promptModalOpen');
    elements.detailEditor.focus();
    refreshPromptIcons(elements.detail);
  }

  function loadDetailImage(item) {
    const url = promptImageUrl(item.image || item.cover);
    elements.detailImage.alt = item.imageAlt || itemTitle(item);
    if (elements.detailImage.src === url && elements.detailImage.complete && elements.detailImage.naturalWidth > 0) {
      setDetailImageState('ready');
      return;
    }
    setDetailImageState('loading');
    elements.detailImage.src = url;
  }

  function setDetailImageState(status) {
    elements.detailPreviewFrame.classList.toggle('imageLoading', status === 'loading');
    elements.detailPreviewFrame.classList.toggle('imageError', status === 'error');
    elements.detailPreviewFrame.setAttribute('aria-busy', String(status === 'loading'));
  }

  function closePromptDetail() {
    elements.detail.classList.add('hidden');
    document.body.classList.remove('promptModalOpen');
    state.selected = null;
  }

  function renderDetailTags(item) {
    elements.detailTags.replaceChildren();
    for (const tag of [...(item.styles || []), ...(item.scenes || []), ...(item.tags || [])].slice(0, 8)) {
      const chip = document.createElement('span');
      chip.textContent = tag;
      elements.detailTags.appendChild(chip);
    }
  }

  function renderTemplateExamples(type, item) {
    elements.detailExamples.replaceChildren();
    elements.detailExamples.classList.toggle('hidden', type !== 'template' || !item.exampleCases?.length);
    if (type !== 'template') return;
    const label = document.createElement('span');
    label.textContent = '参考案例';
    elements.detailExamples.appendChild(label);
    for (const id of item.exampleCases || []) {
      const example = state.library.cases.find((entry) => entry.id === id);
      if (!example) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `#${id}`;
      button.title = itemTitle(example);
      button.addEventListener('click', () => openPromptDetail('case', example));
      elements.detailExamples.appendChild(button);
    }
  }

  function updateDetailFavorite() {
    if (!state.selected) return;
    const active = state.favorites.has(itemKey(state.selected.type, state.selected.item));
    elements.detailFavorite.classList.toggle('active', active);
    elements.detailFavorite.setAttribute('aria-pressed', String(active));
    elements.detailFavorite.title = active ? '取消收藏' : '收藏提示词';
  }

  function toggleFavorite(type, item) {
    const key = itemKey(type, item);
    if (state.favorites.has(key)) state.favorites.delete(key);
    else state.favorites.add(key);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites]));
    document.querySelectorAll(`[data-prompt-key="${cssEscape(key)}"] .imagePromptIconButton`).forEach((button) => {
      if (button.title.includes('收藏')) button.classList.toggle('active', state.favorites.has(key));
    });
    if (state.favoritesOnly) renderLibrary();
    showToast(state.favorites.has(key) ? '已收藏' : '已取消收藏');
  }

  async function addReferenceFiles() {
    const files = elements.referenceInput.files;
    if (!files?.length) return;
    elements.addReference.disabled = true;
    try {
      if (typeof handleAttachmentFiles !== 'function') throw new Error('附件上传功能不可用');
      await handleAttachmentFiles(files);
      syncPromptReferences();
    } catch (error) {
      showToast(error.message || '添加参考图失败', 'error');
    } finally {
      elements.referenceInput.value = '';
      elements.addReference.disabled = false;
    }
  }

  function syncPromptReferences() {
    const tray = document.getElementById('attachmentTray');
    const chips = [...(tray?.querySelectorAll('.attachmentChip') || [])];
    elements.referenceCount.textContent = String(chips.length);
    elements.references.replaceChildren();
    chips.forEach((chip, index) => {
      const item = document.createElement('div');
      item.className = 'imagePromptReference';
      const sourceImage = chip.querySelector('img');
      if (sourceImage) {
        const image = document.createElement('img');
        image.src = sourceImage.src;
        image.alt = sourceImage.alt || '参考图';
        item.appendChild(image);
      } else {
        const icon = document.createElement('span');
        icon.className = 'imagePromptReferenceIcon';
        icon.appendChild(createIcon('file'));
        item.appendChild(icon);
      }
      const name = document.createElement('span');
      name.textContent = chip.querySelector('.attachmentText span')?.textContent || `附件 ${index + 1}`;
      const remove = createIconButton('x', `移除 ${name.textContent}`);
      remove.addEventListener('click', () => {
        chip.querySelector('button')?.click();
        requestAnimationFrame(syncPromptReferences);
      });
      item.appendChild(name);
      item.appendChild(remove);
      elements.references.appendChild(item);
    });
    refreshPromptIcons(elements.references);
  }

  function saveCurrentParams() {
    state.params = {
      ratio: elements.ratio.value,
      quality: elements.quality.value,
      format: elements.format.value,
      count: clamp(Number(elements.count.value) || 1, 1, 4),
      preserve: elements.preserve.checked,
    };
    elements.count.value = String(state.params.count);
    localStorage.setItem(PARAMS_KEY, JSON.stringify(state.params));
  }

  function useSelectedPrompt(sendNow) {
    if (!state.selected) return;
    saveCurrentParams();
    const prompt = elements.detailEditor.value.trim();
    if (!prompt) {
      showToast('提示词不能为空', 'error');
      elements.detailEditor.focus();
      return;
    }
    if (prompt.includes('[请填写主题]')) {
      showToast('请先填写模板主题', 'error');
      elements.detailEditor.focus();
      return;
    }
    const composed = composeCodexImagePrompt(prompt);
    const chatInput = document.getElementById('input');
    chatInput.value = composed;
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    chatInput.style.height = 'auto';
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 180)}px`;
    closePromptDetail();
    setWorkspaceView('codex');
    if (!sendNow) {
      chatInput.focus();
      return;
    }
    requestAnimationFrame(() => {
      const button = document.getElementById('send');
      if (!button || button.disabled) {
        if (typeof statusEl !== 'undefined') statusEl.textContent = '当前暂不可发送';
        return;
      }
      button.click();
    });
  }

  function composeCodexImagePrompt(prompt) {
    const count = state.params.count;
    const qualityLabels = { auto: '自动', high: '高', medium: '中', low: '低' };
    const attachmentCount = document.querySelectorAll('#attachmentTray .attachmentChip').length;
    return [
      `请使用 Codex App 的图像生成能力生成 ${count} 张图片。`,
      state.params.ratio === 'auto' ? '' : `画面比例：${state.params.ratio}。`,
      state.params.quality === 'auto' ? '' : `质量：${qualityLabels[state.params.quality]}。`,
      `输出格式：${state.params.format.toUpperCase()}。`,
      state.params.preserve ? '保持提示词的主体、构图、文字与风格约束，不要擅自改成其他主题。' : '',
      attachmentCount ? `将已附加的 ${attachmentCount} 个文件作为参考素材，并保持其中需要延续的主体特征。` : '',
      '',
      '提示词：',
      prompt,
      '',
      '请直接调用图像生成能力并返回图片结果，不要只描述画面。',
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n').trim();
  }

  function itemPrompt(type, item) {
    if (type === 'case') return String(item.prompt || '').trim();
    const guidance = item.guidance?.zh || item.guidance?.en || [];
    const pitfalls = item.pitfalls?.zh || item.pitfalls?.en || [];
    return [
      '主题：[请填写主题]',
      `模板：${itemTitle(item)}`,
      item.useWhen?.zh || item.useWhen?.en || itemDescription(item),
      '',
      '构图与视觉要求：',
      ...guidance.map((entry) => `- ${entry}`),
      '',
      '避免：',
      ...pitfalls.map((entry) => `- ${entry}`),
    ].filter(Boolean).join('\n');
  }

  function itemTitle(item) {
    if (typeof item.title === 'string') return item.title;
    return item.title?.zh || item.title?.en || `Prompt ${item.id || ''}`;
  }

  function itemDescription(item) {
    if (typeof item.description === 'string') return item.description;
    return item.description?.zh || item.description?.en || item.promptPreview || item.prompt || '';
  }

  function categoryLabels() {
    const labels = new Map(Object.entries(CATEGORY_FALLBACKS));
    for (const category of state.library?.categories || []) {
      labels.set(category.value, category.title?.zh || category.title?.en || category.value);
    }
    return labels;
  }

  function categoryLabel(value) {
    return categoryLabels().get(value) || value || '未分类';
  }

  function promptImageUrl(value) {
    const source = String(value || '');
    if (/^https?:\/\//i.test(source)) return source;
    const suffix = source.startsWith('/') ? source : `/${source}`;
    return `${state.library?.imageBaseUrl || ''}${suffix}`;
  }

  function itemKey(type, item) {
    return `${type}:${item.id}`;
  }

  function readStringSet(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function readParams() {
    try {
      const value = JSON.parse(localStorage.getItem(PARAMS_KEY) || '{}');
      return {
        ratio: ['auto', '1:1', '4:3', '3:4', '16:9', '9:16'].includes(value.ratio) ? value.ratio : DEFAULT_PARAMS.ratio,
        quality: ['auto', 'high', 'medium', 'low'].includes(value.quality) ? value.quality : DEFAULT_PARAMS.quality,
        format: ['png', 'jpeg', 'webp'].includes(value.format) ? value.format : DEFAULT_PARAMS.format,
        count: clamp(Number(value.count) || DEFAULT_PARAMS.count, 1, 4),
        preserve: value.preserve !== false,
      };
    } catch {
      return { ...DEFAULT_PARAMS };
    }
  }

  function createIcon(name) {
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', name);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  function createIconButton(iconName, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'imagePromptIconButton';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(createIcon(iconName));
    return button;
  }

  function refreshPromptIcons(root) {
    if (typeof refreshIcons === 'function') refreshIcons(root);
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(String(value || ''));
      showToast('已复制提示词');
    } catch {
      const area = document.createElement('textarea');
      area.value = String(value || '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      showToast('已复制提示词');
    }
  }

  let toastTimer = null;
  function showToast(message, kind = '') {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `imagePromptToast show${kind ? ` ${kind}` : ''}`;
    toastTimer = setTimeout(() => {
      elements.toast.className = 'imagePromptToast';
    }, 1800);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  init();
})();
