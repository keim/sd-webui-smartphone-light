// 画面上部のInjectパネルの表示/非表示を切り替える
async function insertPanel() {
    await _initialize();
    await _bootstrapPWA();

    ssppUI.updateSizeLabel();
    sspp_clipSelector.refresh();
    sspp_candOps.updateCandidateButtons("__first__");

    // Standalone mode の場合、自動的に CSS Injection を有効にする
    if (_pwaState.standalone) {
        _sspp_toggleResponsiveCSS(true, true);
        ssppUI.togglePanel(true, true);
    }

    console.log("Mobile+: Responsive design CSS injector has been loaded.");
}

// グローバル変数
let ssppUI = null;
let sspp_sizeSelector = null;
let sspp_textSelector = null;
let sspp_clipSelector = null;
let sspp_candOps = null;
let sspp_wordOps = null;
let _moduleLoadPromise = null;
const _moduleCacheKey = `${Date.now()}`;
const _pwaManifestPath = "/mobile-plus.webmanifest";
const _pwaServiceWorkerPath = "/mobile-plus-sw.js";
const _faviconIcoPath = "/mobile-plus-favicon.ico";
const _favicon16Path = "/mobile-plus-favicon-16x16.png";
const _favicon32Path = "/mobile-plus-favicon-32x32.png";
const _appleTouchIconPath = "/mobile-plus-icon-192.png";
let _pwaBootstrapPromise = null;
let _pwaEventHandlersRegistered = false;
let _pwaInstallPrompt = null;
let _pwaState = _createPWAState();
let _panelVisibilityHandlersRegistered = false;
let _clientWidthThreshold = 768;

window.insertPanel = insertPanel;




// 初期化処理
async function _initialize() {
    await _loadModules();

    _clientWidthThreshold = _getClientWidthThreshold();
    _registerPanelVisibilityHandlers();
    _updatePanelVisibility();

    ssppUI.initialize();
    ssppUI.updatePWAStatus(_pwaState);
    sspp_sizeSelector.initialize();
    sspp_textSelector.initialize();
    sspp_clipSelector.initialize();

    ssppUI.addSafeEventListener("textarea", "keyup", () => sspp_candOps.show());

    _initWordDictionary();
    _setupMenuButtons();
    _setupFullscreenRestore();
    _insertInteractiveWidget();
}

// モジュールの動的インポートと初期化
async function _loadModules() {
    if (_moduleLoadPromise) return _moduleLoadPromise;

    const cachePath = (path) => `${path}?v=${encodeURIComponent(_moduleCacheKey)}`;

    _moduleLoadPromise = Promise.all([
        import(cachePath("./modules/sd_generated_image.js")),
        import(cachePath("./modules/file_info_api.js")),
        import(cachePath("./modules/ui_controller.js")),
        import(cachePath("./modules/size_selector.js")),
        import(cachePath("./modules/text_selector.js")),
        import(cachePath("./modules/clipboard_selector.js")),
        import(cachePath("./modules/candidate_operations.js")),
        import(cachePath("./modules/word_operations.js")),
    ]).then(([
            imageModule, 
            fileInfoModule, 
            uiModule, 
            sizeModule, 
            textModule, 
            clipboardModule, 
            candidateModule, 
            wordModule
        ]) => {
            const fileInfoAPI = fileInfoModule.FileInfoAPI;
            fileInfoAPI.setImageClass(imageModule.SDGeneratedImage);

            ssppUI = new uiModule.UIController(fileInfoAPI);
            sspp_wordOps = new wordModule.WordOperations(ssppUI);
            sspp_candOps = new candidateModule.CandidateOperations(ssppUI);
            sspp_sizeSelector = new sizeModule.SizeSelector(ssppUI);
            sspp_textSelector = new textModule.TextSelector(ssppUI);
            sspp_clipSelector = new clipboardModule.ClipboardSelector(ssppUI, fileInfoAPI);
        }
    ).catch((err) => {
        _moduleLoadPromise = null;
        console.error("[Mobile+] Failed to load modules:", err);
        throw err;
    });

    return _moduleLoadPromise;
}

// 辞書初期化
function _initWordDictionary() {
    const historyList = ssppUI.getPromptHistory();
    sspp_candOps._wordDictionary['__first__'] = {};
    historyList.reverse().forEach(([url, posi, nega]) => {
        sspp_candOps.appendWordDictionaryByPrompt(posi)
    });
}

// メニューボタンのセットアップ
function _setupMenuButtons() {
    // パネルにボタンを追加するユーティリティ関数
    const onclick = (id, onClick) => {
        document.getElementById(id).addEventListener('click', onClick);
    }

    const panel = ssppUI.panel();
    
    // CSS Injection ボタン
    onclick('sspp-inject-css', () => {
        ssppUI.togglePanel(_sspp_toggleResponsiveCSS(true));
    });
    onclick('sspp-install-pwa', async () => {
        await _installPWA();
    });
    onclick('sspp-inject-css-full', () => {
        ssppUI.togglePanel(_sspp_toggleResponsiveCSS(true));
        document.body.requestFullscreen();
    });
    // CSS Extraction ボタン
    onclick('sspp-extract-css', () => {
        ssppUI.togglePanel(_sspp_toggleResponsiveCSS(false));
        if (document.fullscreenElement) document.exitFullscreen();
    });

    // [Negative Prompt]
    onclick('sspp-switch-nega', e => {
        ssppUI.changePanelUIType("nega");
    });
    // [Rendering Props]
    onclick('sspp-switch-rendering', e => {
        ssppUI.changePanelUIType("rendering");
    });
    // [Sampling Props]
    onclick('sspp-switch-sampling', e => {
        ssppUI.changePanelUIType("sampling");
    });
    // [text snippet selector]
    onclick('sspp-textsnippet', e => {
        ssppUI.changePanelUIType("textsnippet");
        sspp_textSelector?.updateToggleStates();
    });
    // [Menu]
    onclick('sspp-submenu-open', e => {
        ssppUI.changePanelUIType("submenu");
        ssppUI.updateSizeLabel();
    });

    // [Checkpoint selector]
    onclick('sspp-checkpoints', e => {
        ssppUI.changePanelUIType("checkpoints");
    });
    // [Lora selector]
    onclick('sspp-lora', e => {
        ssppUI.changePanelUIType("lora");
    });
    // [Size selector]
    onclick('sspp-size', e => {
        ssppUI.changePanelUIType("size");
    });
    // [Batch Props]
    onclick('sspp-switch-batch', e => {
        ssppUI.changePanelUIType("batch");
    });
    // [txt2img Clipboard selector]
    onclick('sspp-clip-t2i', async e => {
        ssppUI.changePanelUIType("clip-t2i");
        await sspp_clipSelector?.loadBySubmenu("clip-t2i");
    });
    // [img2img Clipboard selector]
    onclick('sspp-clip-i2i', async e => {
        ssppUI.changePanelUIType("clip-i2i");
        await sspp_clipSelector?.loadBySubmenu("clip-i2i");
    });
    // [Output Clipboard selector]
    onclick('sspp-clip-out', async e => {
        ssppUI.changePanelUIType("clip-out");
        await sspp_clipSelector?.loadBySubmenu("clip-out");
    });

    // [Previous word]
    onclick('sspp-prevword', e => {
        sspp_wordOps.selectPrevWord(panel.classList.contains("word-select"));
        sspp_candOps.show();
    });
    // [Current word]
    onclick('sspp-currword', e => {
        sspp_wordOps.selectWord(panel.classList.contains("word-select"));
        panel.classList.toggle("word-select");
        sspp_candOps.show();
    });
    // [Next word]
    onclick('sspp-nextword', e => {
        sspp_wordOps.selectNextWord(panel.classList.contains("word-select"));
        sspp_candOps.show();
    });
    // [Emphasize]
    onclick('sspp-parentheses', e => {
        sspp_wordOps.emphasize();
    });
    // [rate down]
    onclick('sspp-ratedown', e => {
        sspp_wordOps.changeRate(-0.1);
    });
    // [rate up]
    onclick('sspp-rateup', e => {
        sspp_wordOps.changeRate(0.1);
    });
    
    // [Generate]
    onclick('sspp-generate', e => {
        ssppUI.generate();
        const textArea = ssppUI.promptArea();
        if (textArea) sspp_candOps.appendWordDictionaryByPrompt(textArea.value)
    });

    // Standalone mode の場合、フルスクリーンボタンを非表示にする
    if (_pwaState.standalone) {
        const fullscreenBtn = document.getElementById('sspp-inject-css-full');
        if (fullscreenBtn) fullscreenBtn.style.display = 'none';
    }

    ssppUI.root().appendChild(panel);
}

// ファイルダイアログ等でフルスクリーンが解除された場合、フォーカス復帰時にフルスクリーンに戻す
function _setupFullscreenRestore() {
    let _pendingRestore = false;

    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) {
            // フルスクリーン解除後、短時間内にblurが発生すれば復帰フラグを立てる
            const onBlur = () => {
                _pendingRestore = true;
                cleanup();
            };
            const cleanup = () => {
                clearTimeout(timer);
                window.removeEventListener('blur', onBlur);
            };
            const timer = setTimeout(cleanup, 300);
            window.addEventListener('blur', onBlur);
        } else {
            _pendingRestore = false;
        }
    });

    window.addEventListener('focus', () => {
        if (_pendingRestore && !document.fullscreenElement) {
            _pendingRestore = false;
            document.documentElement.requestFullscreen().catch(() => {});
        }
    });
}

// ソフトウェアキーボードの表示に伴うレイアウト崩れを抑制
function _insertInteractiveWidget() {
    const viewportMeta = document.querySelector('meta[name="viewport"]');
    if (viewportMeta) {
        let content = viewportMeta.getAttribute('content');
        if (!content.includes('interactive-widget')) {
            viewportMeta.setAttribute('content', content + ', interactive-widget=resizes-content');
        }
    }
}


function _getClientWidthThreshold() {
    const thresholdBox = document.getElementById('sspp_client_width_threshold');
    const rawValue = thresholdBox?.querySelector('textarea, input')?.value;
    const parsed = Number.parseInt(rawValue ?? '768', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 768;
}


function _updatePanelVisibility() {
    const shouldShowPanel = _pwaState.standalone || window.innerWidth <= _clientWidthThreshold;
    document.documentElement.setAttribute('sspp-mobile-panel', shouldShowPanel ? 'true' : 'false');
}


function _registerPanelVisibilityHandlers() {
    if (_panelVisibilityHandlersRegistered) return;
    _panelVisibilityHandlersRegistered = true;

    window.addEventListener('resize', _updatePanelVisibility);
    window.visualViewport?.addEventListener?.('resize', _updatePanelVisibility);
}


function _createPWAState() {
    return {
        supported: false,
        serviceWorkerReady: false,
        installAvailable: false,
        standalone: _isStandaloneMode(),
        reason: "idle",
    };
}


function _isStandaloneMode() {
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}


function _isPWASecureContext() {
    return window.isSecureContext || ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}


function _updatePWAState(patch = {}) {
    _pwaState = {
        ..._pwaState,
        ...patch,
        standalone: patch.standalone ?? _isStandaloneMode(),
    };
    _updatePanelVisibility();
    ssppUI?.updatePWAStatus(_pwaState);
    return _pwaState;
}


function _shouldReplaceFavicon() {
    const replaceFaviconBox = document.getElementById('sspp_replace_favicon');
    const replaceFaviconValue = replaceFaviconBox?.querySelector('textarea, input')?.value?.trim().toLowerCase();
    return replaceFaviconValue === 'true' || replaceFaviconValue === '1' || replaceFaviconValue === 'yes';
}


function _removeHeadTag(selector) {
    document.head.querySelector(selector)?.remove();
}


function _ensurePWAHeadTags() {
    const ensureTag = (selector, factory) => {
        let element = document.head.querySelector(selector);
        if (!element) {
            element = factory();
            document.head.appendChild(element);
        }
        return element;
    };

    const manifest = ensureTag('link[data-sspp-pwa="manifest"]', () => {
        const link = document.createElement('link');
        link.setAttribute('data-sspp-pwa', 'manifest');
        link.rel = 'manifest';
        return link;
    });
    manifest.href = `${_pwaManifestPath}?v=${encodeURIComponent(_moduleCacheKey)}`;

    if (!_shouldReplaceFavicon()) {
        _removeHeadTag('link[data-sspp-pwa="favicon"]');
        _removeHeadTag('link[data-sspp-pwa="favicon-32"]');
        _removeHeadTag('link[data-sspp-pwa="favicon-16"]');
        _removeHeadTag('link[data-sspp-pwa="shortcut-icon"]');
    } else {
        const favicon = ensureTag('link[data-sspp-pwa="favicon"]', () => {
            const link = document.createElement('link');
            link.setAttribute('data-sspp-pwa', 'favicon');
            link.rel = 'icon';
            return link;
        });
        favicon.type = 'image/x-icon';
        favicon.href = `${_faviconIcoPath}?v=${encodeURIComponent(_moduleCacheKey)}`;

        const favicon32 = ensureTag('link[data-sspp-pwa="favicon-32"]', () => {
            const link = document.createElement('link');
            link.setAttribute('data-sspp-pwa', 'favicon-32');
            link.rel = 'icon';
            return link;
        });
        favicon32.type = 'image/png';
        favicon32.sizes = '32x32';
        favicon32.href = `${_favicon32Path}?v=${encodeURIComponent(_moduleCacheKey)}`;

        const favicon16 = ensureTag('link[data-sspp-pwa="favicon-16"]', () => {
            const link = document.createElement('link');
            link.setAttribute('data-sspp-pwa', 'favicon-16');
            link.rel = 'icon';
            return link;
        });
        favicon16.type = 'image/png';
        favicon16.sizes = '16x16';
        favicon16.href = `${_favicon16Path}?v=${encodeURIComponent(_moduleCacheKey)}`;

        const shortcutIcon = ensureTag('link[data-sspp-pwa="shortcut-icon"]', () => {
            const link = document.createElement('link');
            link.setAttribute('data-sspp-pwa', 'shortcut-icon');
            link.rel = 'shortcut icon';
            return link;
        });
        shortcutIcon.href = `${_faviconIcoPath}?v=${encodeURIComponent(_moduleCacheKey)}`;
    }

    const themeColor = ensureTag('meta[name="theme-color"]', () => {
        const meta = document.createElement('meta');
        meta.name = 'theme-color';
        return meta;
    });
    themeColor.content = '#111827';

    const mobileCapable = ensureTag('meta[name="mobile-web-app-capable"]', () => {
        const meta = document.createElement('meta');
        meta.name = 'mobile-web-app-capable';
        return meta;
    });
    mobileCapable.content = 'yes';

    const appleCapable = ensureTag('meta[name="apple-mobile-web-app-capable"]', () => {
        const meta = document.createElement('meta');
        meta.name = 'apple-mobile-web-app-capable';
        return meta;
    });
    appleCapable.content = 'yes';

    const appleTitle = ensureTag('meta[name="apple-mobile-web-app-title"]', () => {
        const meta = document.createElement('meta');
        meta.name = 'apple-mobile-web-app-title';
        return meta;
    });
    appleTitle.content = 'SD Mobile+';

    const appleTouchIcon = ensureTag('link[data-sspp-pwa="apple-touch-icon"]', () => {
        const link = document.createElement('link');
        link.setAttribute('data-sspp-pwa', 'apple-touch-icon');
        link.rel = 'apple-touch-icon';
        return link;
    });
    appleTouchIcon.href = `${_appleTouchIconPath}?v=${encodeURIComponent(_moduleCacheKey)}`;
}


function _registerPWAEventHandlers() {
    if (_pwaEventHandlersRegistered) return;
    _pwaEventHandlersRegistered = true;

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        _pwaInstallPrompt = event;
        _updatePWAState({
            supported: true,
            installAvailable: true,
            reason: 'install-prompt-ready',
        });
    });

    window.addEventListener('appinstalled', () => {
        _pwaInstallPrompt = null;
        _updatePWAState({
            supported: true,
            installAvailable: false,
            standalone: true,
            reason: 'installed',
        });
    });

    window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', (event) => {
        _updatePWAState({
            standalone: event.matches,
            supported: true,
            reason: event.matches ? 'standalone' : _pwaState.reason,
        });
    });
}


async function _bootstrapPWA() {
    if (_pwaBootstrapPromise) return _pwaBootstrapPromise;

    _pwaBootstrapPromise = (async () => {
        _ensurePWAHeadTags();
        _registerPWAEventHandlers();
        _updatePWAState({ standalone: _isStandaloneMode() });

        if (!_isPWASecureContext()) {
            return _updatePWAState({ reason: 'insecure-context' });
        }

        if (!('serviceWorker' in navigator)) {
            return _updatePWAState({ reason: 'service-worker-unsupported' });
        }

        try {
            await navigator.serviceWorker.register(`${_pwaServiceWorkerPath}?v=${encodeURIComponent(_moduleCacheKey)}`);
            await navigator.serviceWorker.ready;
            return _updatePWAState({
                supported: true,
                serviceWorkerReady: true,
                reason: _pwaState.installAvailable ? _pwaState.reason : 'service-worker-ready',
            });
        } catch (err) {
            console.error('[Mobile+] Failed to register PWA service worker:', err);
            return _updatePWAState({ reason: 'service-worker-registration-failed' });
        }
    })();

    return _pwaBootstrapPromise;
}


async function _installPWA() {
    if (_pwaState.standalone) {
        _updatePWAState({ reason: 'already-installed' });
        return;
    }

    if (!_pwaInstallPrompt) {
        _updatePWAState({ reason: _pwaState.supported ? 'install-prompt-unavailable' : _pwaState.reason });
        return;
    }

    const promptEvent = _pwaInstallPrompt;
    _pwaInstallPrompt = null;
    promptEvent.prompt();
    const choice = await promptEvent.userChoice;

    _updatePWAState({
        installAvailable: false,
        reason: choice.outcome === 'accepted' ? 'install-accepted' : 'install-dismissed',
    });
}


// CSSのインジェクション/解除を切り替える
function _sspp_toggleResponsiveCSS(enabled, isStandalone = false) {
    const cssID = 'responsive-design-css';
    const existingLink = document.getElementById(cssID);
    
    if (enabled && !existingLink) {
        // 既にインジェクションされていなければCSSを追加
        const link = document.createElement('link');
        link.id = cssID;
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.href = `file=extensions/sd-webui-mobile-plus/responsive.css?n=${(Math.random()*10000)>>0}`;
        document.head.appendChild(link);
    } else 
    if (!enabled && existingLink) {
        // インジェクションされていればCSSを削除
        existingLink.remove();
    }

    return enabled
}
