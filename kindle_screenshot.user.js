// ==UserScript==
// @name         Kindle Page Screenshotter
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Screenshots every page of a Kindle book and saves them to a folder
// @author       KindleDL
// @match        https://leer.amazon.es/*
// @match        https://read.amazon.com/*
// @match        https://read.amazon.co.uk/*
// @match        https://read.amazon.de/*
// @match        https://read.amazon.fr/*
// @match        https://read.amazon.it/*
// @match        https://read.amazon.es/*
// @grant        GM_download
// @grant        GM_notification
// ==/UserScript==

(function () {
    'use strict';

    // ─── CONFIGURATION ──────────────────────────────────────────────────
    let DELAY_BETWEEN_PAGES_MS = 2500;   // Time to wait after clicking next page (for render)
    let CAPTURE_DELAY_MS = 500;          // Extra delay before capturing screenshot
    const IMAGE_FORMAT = 'image/png';      // 'image/png' or 'image/jpeg'
    const JPEG_QUALITY = 0.95;             // Only used if format is jpeg

    // ─── STATE ──────────────────────────────────────────────────────────
    let isRunning = false;
    let isPaused = false;
    let currentPage = 0;
    let totalPages = 0;
    let folderName = '';
    let capturedCount = 0;
    let logMessages = []; // Plain-text log for clipboard copy

    // ─── HELPERS ────────────────────────────────────────────────────────

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Extracts the book title from the top chrome bar.
     * Looks for <ion-title class="top-chrome__book-title ...">Title</ion-title>
     */
    function getBookTitle() {
        // Try the top chrome title first
        const titleEl = document.querySelector('ion-title.top-chrome__book-title');
        if (titleEl) {
            return titleEl.textContent.trim();
        }
        // Fallback: the fixed-book-title span
        const fixedTitle = document.querySelector('.fixed-book-title span');
        if (fixedTitle) {
            return fixedTitle.textContent.trim();
        }
        return 'Kindle_Book';
    }

    /**
     * Sanitizes a string for use as a folder/file name.
     */
    function sanitizeFilename(name) {
        return name
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 100);
    }

    /**
     * Parses the footer label to extract current page and total pages.
     * Expected format: "Página X de Y ● Z%"
     */
    function getPageInfo() {
        try {
            // Check light DOM selectors
            const selectors = [
                'ion-title[item-i-d="reader-footer-title"] .text-div',
                'ion-title[item-i-d="reader-footer-title"]',
                'ion-title.footer-label.position .text-div',
                '.footer-label.position .text-div',
                'ion-footer .footer-label .text-div',
                '.reader-footer .text-div',
                '.footer-label .text-div'
            ];

            let text = '';
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent) {
                    const t = el.textContent.trim();
                    if (/(?:Página|Page|Pagina)/i.test(t)) {
                        text = t;
                        break;
                    }
                }
            }

            // If not found, check all text divs
            if (!text) {
                const allTextDivs = document.querySelectorAll('.text-div, ion-title, span, div');
                for (const div of allTextDivs) {
                    const t = div.textContent ? div.textContent.trim() : '';
                    if (/(?:Página|Page|Pagina)\s+\d+\s+(?:de|of)\s+\d+/i.test(t)) {
                        text = t;
                        break;
                    }
                }
            }

            // Check aria-label on scrubber bar
            if (!text) {
                const scrubber = document.getElementById('kr-scrubber-bar');
                if (scrubber) {
                    const aria = scrubber.getAttribute('aria-label') || '';
                    if (/(?:Página|Page|Pagina)\s+\d+/i.test(aria)) {
                        text = aria;
                    }
                }
            }

            if (!text) return null;

            // Match full format: "Página 4 de 305"
            const matchFull = text.match(/(?:Página|Page|Pagina)\s+(\d+)\s+(?:de|of)\s+(\d+)/i);
            if (matchFull) {
                return {
                    current: parseInt(matchFull[1], 10),
                    total: parseInt(matchFull[2], 10),
                    raw: text
                };
            }

            // Match single format: "Página 4"
            const matchSingle = text.match(/(?:Página|Page|Pagina)\s+(\d+)/i);
            if (matchSingle) {
                return {
                    current: parseInt(matchSingle[1], 10),
                    total: totalPages || 0,
                    raw: text
                };
            }
        } catch (e) {
            console.error('getPageInfo error:', e);
        }
        return null;
    }

    /**
     * Dispatches full mouse and pointer sequence to an element with realistic tap duration.
     */
    async function simulateFullClick(element, clientX, clientY) {
        if (!element) return;
        try {
            const rect = element.getBoundingClientRect();
            const x = clientX !== undefined ? clientX : Math.round(rect.left + rect.width / 2);
            const y = clientY !== undefined ? clientY : Math.round(rect.top + rect.height / 2);

            const pointerOpts = {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                clientX: x,
                clientY: y,
                screenX: x,
                screenY: y,
                pageX: x,
                pageY: y,
                isPrimary: true,
                pointerId: 1,
                pointerType: 'mouse',
                button: 0,
                buttons: 1
            };

            const mouseOpts = {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                clientX: x,
                clientY: y,
                screenX: x,
                screenY: y,
                pageX: x,
                pageY: y,
                button: 0,
                buttons: 1
            };

            element.dispatchEvent(new PointerEvent('pointerover', pointerOpts));
            element.dispatchEvent(new PointerEvent('pointerenter', pointerOpts));
            element.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
            element.dispatchEvent(new MouseEvent('mouseenter', mouseOpts));
            element.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
            element.dispatchEvent(new MouseEvent('mousedown', mouseOpts));

            // Touch start
            try {
                const touch = new Touch({
                    identifier: Date.now(),
                    target: element,
                    clientX: x,
                    clientY: y,
                    pageX: x,
                    pageY: y,
                    radiusX: 5,
                    radiusY: 5,
                    force: 1
                });
                element.dispatchEvent(new TouchEvent('touchstart', {
                    touches: [touch], targetTouches: [touch], changedTouches: [touch],
                    bubbles: true, cancelable: true, composed: true
                }));
            } catch (te) {}

            // Real tap duration (required by gesture recognizers)
            await sleep(60);

            pointerOpts.buttons = 0;
            mouseOpts.buttons = 0;
            element.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
            element.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
            element.dispatchEvent(new MouseEvent('click', mouseOpts));

            // Touch end
            try {
                element.dispatchEvent(new TouchEvent('touchend', {
                    touches: [], targetTouches: [], changedTouches: [],
                    bubbles: true, cancelable: true, composed: true
                }));
            } catch (te) {}

            // Native click ONLY for actual <button> elements
            if (element.tagName === 'BUTTON' && typeof element.click === 'function') {
                element.click();
            }
        } catch (e) {
            console.error('simulateFullClick error:', e);
        }
    }

    /**
     * Dispatches complete keyboard events to all potential targets.
     */
    function dispatchKeyToAll(key, code, keyCode) {
        const keyOpts = {
            key: key,
            code: code,
            keyCode: keyCode,
            which: keyCode,
            charCode: 0,
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window
        };

        const targets = [
            document.activeElement,
            window,
            document,
            document.body,
            document.getElementById('root'),
            document.getElementById('kr-renderer'),
            document.querySelector('.kr-interaction-layer-fullpage'),
            document.getElementById('kr-chevron-right'),
            document.querySelector('ion-app')
        ].filter(Boolean);

        for (const target of targets) {
            try {
                if (typeof target.focus === 'function') target.focus();
                target.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
                target.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
            } catch (e) {}
        }
    }

    /**
     * Walks up the React Fiber hierarchy of an element to find and invoke navigation functions.
     */
    function tryInvokeReactFiberHandlers(startElement, clientX, clientY) {
        if (!startElement) return 0;
        let invokedCount = 0;
        const x = clientX !== undefined ? clientX : Math.round(window.innerWidth - 60);
        const y = clientY !== undefined ? clientY : Math.round(window.innerHeight / 2);

        try {
            const keys = Object.keys(startElement);
            const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
            const propsKey = keys.find(k => k.startsWith('__reactProps$'));

            // Check props directly on the element
            if (propsKey && startElement[propsKey]) {
                const props = startElement[propsKey];
                const fakeClick = {
                    preventDefault: () => {}, stopPropagation: () => {},
                    nativeEvent: new MouseEvent('click', { clientX: x, clientY: y }),
                    clientX: x, clientY: y, pageX: x, pageY: y,
                    target: startElement, currentTarget: startElement,
                    isTrusted: true, type: 'click'
                };

                for (const handler of ['onClick', 'onClickCapture', 'onMouseDown', 'onPointerDown']) {
                    if (typeof props[handler] === 'function') {
                        try {
                            props[handler](fakeClick);
                            invokedCount++;
                            updateStatus(`🔍 [${startElement.id || startElement.className}] props.${handler} invoked`);
                        } catch (e) {}
                    }
                }

                // Try Enter, Space, and ArrowRight on onKeyDown
                if (typeof props.onKeyDown === 'function') {
                    for (const [k, c, code] of [['Enter', 'Enter', 13], [' ', 'Space', 32], ['ArrowRight', 'ArrowRight', 39]]) {
                        try {
                            props.onKeyDown({
                                key: k, code: c, keyCode: code, which: code,
                                preventDefault: () => {}, stopPropagation: () => {},
                                target: startElement, currentTarget: startElement,
                                isTrusted: true, type: 'keydown'
                            });
                            invokedCount++;
                        } catch (e) {}
                    }
                    updateStatus(`🔍 [${startElement.id || startElement.className}] props.onKeyDown(Enter/Space/ArrowRight) invoked`);
                }
            }

            // Walk up Fiber tree
            if (fiberKey && startElement[fiberKey]) {
                let fiber = startElement[fiberKey];
                let depth = 0;

                while (fiber && depth < 20) {
                    try {
                        const props = fiber.memoizedProps || fiber.pendingProps;
                        if (props && typeof props === 'object') {
                            const fnKeys = Object.keys(props).filter(k => typeof props[k] === 'function');
                            for (const fnKey of fnKeys) {
                                if (/next|turn|forward|advance/i.test(fnKey) || (depth <= 3 && /click|down/i.test(fnKey))) {
                                    try {
                                        props[fnKey]({
                                            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                                            clientX: x, clientY: y, pageX: x, pageY: y,
                                            preventDefault: () => {}, stopPropagation: () => {},
                                            isTrusted: true, type: fnKey.includes('Key') ? 'keydown' : 'click',
                                            target: startElement, currentTarget: startElement
                                        });
                                        invokedCount++;
                                        const compName = fiber.type?.displayName || fiber.type?.name || (typeof fiber.type === 'string' ? fiber.type : 'Fiber');
                                        updateStatus(`🔍 Fiber[${depth}] <${compName}> ${fnKey}() invoked`);
                                    } catch (err) {}
                                }
                            }
                        }

                        // Check class component stateNode methods
                        if (fiber.stateNode && typeof fiber.stateNode === 'object' && !(fiber.stateNode instanceof Node)) {
                            const proto = Object.getPrototypeOf(fiber.stateNode);
                            if (proto) {
                                const methodNames = Object.getOwnPropertyNames(proto).filter(
                                    n => typeof proto[n] === 'function' && n !== 'constructor'
                                );
                                for (const m of methodNames) {
                                    if (/next|forward|turn|advance/i.test(m)) {
                                        try {
                                            fiber.stateNode[m]();
                                            invokedCount++;
                                            updateStatus(`🔍 Class ${fiber.stateNode.constructor?.name || 'Instance'}.${m}() invoked`);
                                        } catch (err) {}
                                    }
                                }
                            }
                        }
                    } catch (fe) {}

                    fiber = fiber.return;
                    depth++;
                }
            }
        } catch (e) {
            console.error('tryInvokeReactFiberHandlers error:', e);
        }

        return invokedCount;
    }

    /**
     * Executes targeted actions on the Next Page chevron button and right-hand tap zone.
     */
    async function clickNextPage() {
        updateStatus('🔄 Advancing to next page...');

        const btn = document.getElementById('kr-chevron-right');
        const chevronContainer = document.querySelector('.kr-chevron-container-right');
        const interactionLayer = document.querySelector('.kr-interaction-layer-fullpage');

        // Target coordinates for next page (right side of reader)
        let clickX = Math.round(window.innerWidth - 60);
        let clickY = Math.round(window.innerHeight / 2);

        if (btn) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                clickX = Math.round(rect.left + rect.width / 2);
                clickY = Math.round(rect.top + rect.height / 2);
            }
        }

        // 1. Hover chevron container to reveal button if hidden
        if (chevronContainer) {
            chevronContainer.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: clickX, clientY: clickY }));
            chevronContainer.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: clickX, clientY: clickY }));
        }

        // 2. Click the chevron button directly with realistic duration
        if (btn) {
            await simulateFullClick(btn, clickX, clickY);
            tryInvokeReactFiberHandlers(btn, clickX, clickY);
        }

        // 3. Click right chevron container
        if (chevronContainer) {
            await simulateFullClick(chevronContainer, clickX, clickY);
            tryInvokeReactFiberHandlers(chevronContainer, clickX, clickY);
        }

        // 4. Tap the right 10% zone of the interaction layer (Kindle click-to-advance)
        if (interactionLayer) {
            const tapX = Math.round(window.innerWidth - 50);
            const tapY = Math.round(window.innerHeight / 2);
            await simulateFullClick(interactionLayer, tapX, tapY);
        }

        // 5. Send Keyboard ArrowRight & Enter
        dispatchKeyToAll('ArrowRight', 'ArrowRight', 39);
        if (btn) {
            btn.focus();
            dispatchKeyToAll('Enter', 'Enter', 13);
        }

        return true;
    }

    /**
     * Captures the book page by grabbing the <img> element directly from the renderer.
     * The Kindle reader renders each page as an <img> with a blob: URL inside .kg-full-page-img.
     * Since blob: URLs are same-origin, we can draw the image onto a canvas.
     */
    async function captureScreenshot() {
        // Strategy 1: Grab the rendered page image directly
        const pageImgs = document.querySelectorAll('#kr-renderer .kg-full-page-img img');
        if (pageImgs.length > 0) {
            // There may be multiple images (for multi-column layout), stitch them together
            const images = Array.from(pageImgs).filter(img => img.naturalWidth > 0);
            if (images.length > 0) {
                return await imagesToCanvas(images);
            }
        }

        // Strategy 2: Look for any img inside the renderer view
        const viewImgs = document.querySelectorAll('#kr-renderer .kg-view img');
        if (viewImgs.length > 0) {
            const images = Array.from(viewImgs).filter(img => img.naturalWidth > 0);
            if (images.length > 0) {
                return await imagesToCanvas(images);
            }
        }

        // Strategy 3: Try to find canvas elements (some books use canvas rendering)
        const canvasEls = document.querySelectorAll('#kr-renderer canvas');
        if (canvasEls.length > 0) {
            return canvasEls[0]; // Return the canvas directly
        }

        throw new Error('No renderable book content found. The page may not have loaded yet.');
    }

    /**
     * Draws one or more <img> elements onto a single canvas.
     */
    async function imagesToCanvas(images) {
        // Calculate total dimensions
        let totalWidth = 0;
        let maxHeight = 0;
        for (const img of images) {
            // Use the displayed size (which may differ from natural size)
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            totalWidth += w;
            if (h > maxHeight) maxHeight = h;
        }

        const canvas = document.createElement('canvas');
        canvas.width = totalWidth;
        canvas.height = maxHeight;
        const ctx = canvas.getContext('2d');

        // Fill with black background (matches Kindle dark mode)
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, totalWidth, maxHeight);

        // Draw each image side by side
        let offsetX = 0;
        for (const img of images) {
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            ctx.drawImage(img, offsetX, 0, w, h);
            offsetX += w;
        }

        return canvas;
    }

    /**
     * Converts canvas to blob and triggers a download via GM_download or fallback.
     */
    async function saveScreenshot(canvas, pageNum) {
        const paddedNum = String(pageNum).padStart(4, '0');
        const ext = IMAGE_FORMAT === 'image/jpeg' ? 'jpg' : 'png';
        const filename = `${folderName}/page_${paddedNum}.${ext}`;

        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('Failed to create blob'));
                    return;
                }

                const url = URL.createObjectURL(blob);

                // Use GM_download if available (saves to Downloads folder)
                if (typeof GM_download !== 'undefined') {
                    GM_download({
                        url: url,
                        name: filename,
                        saveAs: false,
                        onerror: (err) => {
                            console.error('GM_download error:', err);
                            // Fallback to <a> download
                            fallbackDownload(url, filename);
                            resolve();
                        },
                        onload: () => {
                            URL.revokeObjectURL(url);
                            resolve();
                        }
                    });
                } else {
                    fallbackDownload(url, filename);
                    resolve();
                }
            }, IMAGE_FORMAT, JPEG_QUALITY);
        });
    }

    function fallbackDownload(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ─── MAIN LOOP ──────────────────────────────────────────────────────

    async function startCapture() {
        if (isRunning) {
            updateStatus('Already running!');
            return;
        }
        isRunning = true;
        isPaused = false;
        capturedCount = 0;
        updateButtonState();

        // Read delay settings from UI
        const delayInput = document.getElementById('ss-delay');
        const captureDelayInput = document.getElementById('ss-capture-delay');
        if (delayInput) DELAY_BETWEEN_PAGES_MS = parseInt(delayInput.value, 10) || 2500;
        if (captureDelayInput) CAPTURE_DELAY_MS = parseInt(captureDelayInput.value, 10) || 500;

        // Get book title for folder name
        const title = getBookTitle();
        folderName = sanitizeFilename(title);
        updateStatus(`📚 Book: ${title}`);
        updateStatus(`📁 Saving to: Downloads/${folderName}/`);

        // Get initial page info
        const startInfo = getPageInfo();
        if (startInfo) {
            currentPage = startInfo.current;
            totalPages = startInfo.total;
            updateStatus(`📖 Starting from page ${currentPage} of ${totalPages}`);
        } else {
            updateStatus('⚠️ Could not detect page info. Will capture until next-page button is gone.');
            totalPages = Infinity;
        }

        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 5;

        // Main capture loop
        while (isRunning && !isPaused) {
            const pageInfo = getPageInfo();
            if (pageInfo) {
                currentPage = pageInfo.current;
                totalPages = pageInfo.total;
            } else {
                // Use capturedCount as page number when detection fails
                currentPage = capturedCount + 1;
            }

            updateStatus(`📸 Capturing page ${currentPage}/${totalPages}...`);
            updateProgress(currentPage, totalPages);

            // Wait a moment for the page to fully render
            await sleep(CAPTURE_DELAY_MS);

            try {
                const canvas = await captureScreenshot();
                await saveScreenshot(canvas, currentPage);
                capturedCount++;
                consecutiveFailures = 0; // Reset on successful capture
                updateStatus(`✅ Saved page ${currentPage} (${capturedCount} total)`);
            } catch (err) {
                console.error('Screenshot error:', err);
                updateStatus(`❌ Error on page ${currentPage}: ${err.message}`);
            }

            // Check if we've reached the last page
            if (pageInfo && pageInfo.current >= pageInfo.total) {
                updateStatus(`🎉 Done! All ${totalPages} pages captured (${capturedCount} screenshots saved).`);
                isRunning = false;
                updateButtonState();

                if (typeof GM_notification !== 'undefined') {
                    GM_notification({
                        title: 'Kindle Screenshotter',
                        text: `Finished! ${capturedCount} pages saved to ${folderName}/`,
                        timeout: 5000
                    });
                }
                break;
            }

            // Click next page
            const clicked = await clickNextPage();
            if (!clicked) {
                consecutiveFailures++;
                updateStatus(`⚠️ Navigation may have failed (attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    updateStatus(`🛑 Too many consecutive failures. Stopping.`);
                    isRunning = false;
                    updateButtonState();
                    break;
                }
            } else {
                consecutiveFailures = 0;
            }

            // Wait for page transition/render
            await sleep(DELAY_BETWEEN_PAGES_MS);

            // If page detection works, wait for the page number to change
            if (pageInfo) {
                let waited = 0;
                const maxWait = 5000;
                while (waited < maxWait) {
                    const newInfo = getPageInfo();
                    if (newInfo && newInfo.current !== pageInfo.current) {
                        break;
                    }
                    await sleep(300);
                    waited += 300;
                }
            }
        }
    }

    function stopCapture() {
        isRunning = false;
        isPaused = false;
        updateStatus(`🛑 Stopped. ${capturedCount} pages captured.`);
        updateButtonState();
    }

    function pauseCapture() {
        if (!isRunning) return;
        isPaused = !isPaused;
        if (isPaused) {
            updateStatus(`⏸️ Paused at page ${currentPage}`);
        } else {
            updateStatus(`▶️ Resuming from page ${currentPage}`);
            // Re-enter the main loop
            isRunning = false; // reset so startCapture can re-enter
            setTimeout(() => startCapture(), 100);
        }
        updateButtonState();
    }

    // ─── UI PANEL ───────────────────────────────────────────────────────

    function createUI() {
        const panel = document.createElement('div');
        panel.id = 'kindle-ss-panel';
        panel.innerHTML = `
            <style>
                #kindle-ss-panel {
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    z-index: 999999;
                    background: rgba(20, 20, 30, 0.95);
                    border: 1px solid rgba(100, 100, 255, 0.3);
                    border-radius: 12px;
                    padding: 16px;
                    color: #e0e0e0;
                    font-family: 'Segoe UI', Arial, sans-serif;
                    font-size: 13px;
                    min-width: 300px;
                    max-width: 400px;
                    backdrop-filter: blur(10px);
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                    transition: opacity 0.3s ease;
                    user-select: none;
                }
                #kindle-ss-panel.minimized {
                    min-width: auto;
                    max-width: auto;
                    padding: 8px 12px;
                }
                #kindle-ss-panel.minimized .ss-body { display: none; }
                #kindle-ss-panel .ss-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 10px;
                    cursor: move;
                }
                #kindle-ss-panel .ss-title {
                    font-weight: 600;
                    font-size: 14px;
                    color: #8b9cf7;
                }
                #kindle-ss-panel .ss-minimize {
                    cursor: pointer;
                    font-size: 16px;
                    color: #888;
                    background: none;
                    border: none;
                    padding: 0 4px;
                }
                #kindle-ss-panel .ss-minimize:hover { color: #fff; }
                #kindle-ss-panel .ss-buttons {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 10px;
                }
                #kindle-ss-panel .ss-btn {
                    flex: 1;
                    padding: 8px 12px;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 600;
                    transition: all 0.2s ease;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                #kindle-ss-panel .ss-btn:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                }
                #kindle-ss-panel .ss-btn.start {
                    background: linear-gradient(135deg, #4CAF50, #45a049);
                    color: white;
                }
                #kindle-ss-panel .ss-btn.pause {
                    background: linear-gradient(135deg, #FF9800, #F57C00);
                    color: white;
                }
                #kindle-ss-panel .ss-btn.stop {
                    background: linear-gradient(135deg, #f44336, #d32f2f);
                    color: white;
                }
                #kindle-ss-panel .ss-btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                    transform: none;
                }
                #kindle-ss-panel .ss-progress {
                    width: 100%;
                    height: 6px;
                    background: rgba(255,255,255,0.1);
                    border-radius: 3px;
                    overflow: hidden;
                    margin-bottom: 8px;
                }
                #kindle-ss-panel .ss-progress-bar {
                    height: 100%;
                    background: linear-gradient(90deg, #4CAF50, #8BC34A);
                    border-radius: 3px;
                    transition: width 0.3s ease;
                    width: 0%;
                }
                #kindle-ss-panel .ss-log {
                    max-height: 120px;
                    overflow-y: auto;
                    font-size: 11px;
                    color: #aaa;
                    line-height: 1.6;
                    padding: 8px;
                    background: rgba(0,0,0,0.3);
                    border-radius: 6px;
                }
                #kindle-ss-panel .ss-log::-webkit-scrollbar {
                    width: 4px;
                }
                #kindle-ss-panel .ss-log::-webkit-scrollbar-thumb {
                    background: rgba(255,255,255,0.2);
                    border-radius: 2px;
                }
                #kindle-ss-panel .ss-settings {
                    margin-bottom: 10px;
                    padding: 8px;
                    background: rgba(0,0,0,0.2);
                    border-radius: 6px;
                }
                #kindle-ss-panel .ss-settings label {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 4px;
                    font-size: 11px;
                    color: #999;
                }
                #kindle-ss-panel .ss-settings input {
                    width: 70px;
                    padding: 3px 6px;
                    background: rgba(255,255,255,0.1);
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 4px;
                    color: #fff;
                    font-size: 11px;
                    text-align: right;
                }
                #kindle-ss-panel .ss-page-info {
                    text-align: center;
                    font-size: 12px;
                    color: #8b9cf7;
                    margin-bottom: 6px;
                    font-weight: 600;
                }
            </style>
            <div class="ss-header">
                <span class="ss-title">📷 Kindle Screenshotter</span>
                <button class="ss-minimize" id="ss-toggle-min" title="Minimize">─</button>
            </div>
            <div class="ss-body">
                <div class="ss-settings">
                    <label>
                        Page delay (ms):
                        <input type="number" id="ss-delay" value="${DELAY_BETWEEN_PAGES_MS}" min="500" max="10000" step="100">
                    </label>
                    <label>
                        Capture delay (ms):
                        <input type="number" id="ss-capture-delay" value="${CAPTURE_DELAY_MS}" min="100" max="5000" step="100">
                    </label>
                </div>
                <div class="ss-buttons">
                    <button class="ss-btn start" id="ss-start">▶ Start</button>
                    <button class="ss-btn pause" id="ss-pause" disabled>⏸ Pause</button>
                    <button class="ss-btn stop" id="ss-stop" disabled>■ Stop</button>
                </div>
                <div class="ss-page-info" id="ss-page-info">Ready</div>
                <div class="ss-progress">
                    <div class="ss-progress-bar" id="ss-progress-bar"></div>
                </div>
                <div class="ss-log" id="ss-log"></div>
                <button class="ss-btn" id="ss-copy-logs" style="background: linear-gradient(135deg, #607D8B, #455A64); color: white; margin-top: 8px; width: 100%;">📋 Copy Logs to Clipboard</button>
            </div>
        `;
        document.body.appendChild(panel);

        // Event listeners
        document.getElementById('ss-start').addEventListener('click', () => startCapture());
        document.getElementById('ss-pause').addEventListener('click', pauseCapture);
        document.getElementById('ss-stop').addEventListener('click', stopCapture);
        document.getElementById('ss-toggle-min').addEventListener('click', () => {
            panel.classList.toggle('minimized');
            const btn = document.getElementById('ss-toggle-min');
            btn.textContent = panel.classList.contains('minimized') ? '☐' : '─';
        });
        document.getElementById('ss-copy-logs').addEventListener('click', () => {
            const text = logMessages.join('\n');
            navigator.clipboard.writeText(text).then(() => {
                const copyBtn = document.getElementById('ss-copy-logs');
                copyBtn.textContent = '✅ Copied!';
                setTimeout(() => { copyBtn.textContent = '📋 Copy Logs to Clipboard'; }, 2000);
            }).catch(() => {
                // Fallback: select from a textarea
                const ta = document.createElement('textarea');
                ta.value = logMessages.join('\n');
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                const copyBtn = document.getElementById('ss-copy-logs');
                copyBtn.textContent = '✅ Copied!';
                setTimeout(() => { copyBtn.textContent = '📋 Copy Logs to Clipboard'; }, 2000);
            });
        });

        // Make draggable
        makeDraggable(panel);
    }

    function updateStatus(msg) {
        const time = new Date().toLocaleTimeString();
        const plainMsg = `[${time}] ${msg}`;
        logMessages.push(plainMsg);
        console.log(`[KindleSS] ${msg}`);
        const log = document.getElementById('ss-log');
        if (!log) return;
        log.innerHTML += `<div>${plainMsg}</div>`;
        log.scrollTop = log.scrollHeight;
    }

    function updateProgress(current, total) {
        const bar = document.getElementById('ss-progress-bar');
        const info = document.getElementById('ss-page-info');
        if (bar && total > 0 && total !== Infinity) {
            const pct = Math.min((current / total) * 100, 100);
            bar.style.width = pct + '%';
        }
        if (info) {
            info.textContent = `Page ${current} / ${total} · ${capturedCount} captured`;
        }
    }

    function updateButtonState() {
        const startBtn = document.getElementById('ss-start');
        const pauseBtn = document.getElementById('ss-pause');
        const stopBtn = document.getElementById('ss-stop');
        if (startBtn) startBtn.disabled = isRunning && !isPaused;
        if (pauseBtn) {
            pauseBtn.disabled = !isRunning;
            pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
        }
        if (stopBtn) stopBtn.disabled = !isRunning && !isPaused;
    }

    function makeDraggable(el) {
        const header = el.querySelector('.ss-header');
        let isDragging = false;
        let startX, startY, origX, origY;

        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = el.getBoundingClientRect();
            origX = rect.left;
            origY = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            el.style.left = (origX + dx) + 'px';
            el.style.top = (origY + dy) + 'px';
            el.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    // ─── INIT ───────────────────────────────────────────────────────────

    let uiCreated = false;

    function showUI() {
        if (uiCreated) return;
        uiCreated = true;
        createUI();
        updateStatus('🟢 Ready. Click Start to begin capturing.');

        const pageInfo = getPageInfo();
        if (pageInfo) {
            updateStatus(`📖 Detected: Page ${pageInfo.current} of ${pageInfo.total}`);
        }

        const title = getBookTitle();
        if (title && title !== 'Kindle_Book') {
            updateStatus(`📚 Book: ${title}`);
        }
    }

    function init() {
        // Wait until any Kindle reader element is present
        const checkReady = setInterval(() => {
            const renderer = document.getElementById('kr-renderer') ||
                             document.querySelector('.kr-renderer-container-fullpage');
            const kindleApp = document.querySelector('ion-app.kr-fullpage-app');
            const footer = document.querySelector('ion-title[item-i-d="reader-footer-title"]');
            const fixedTitle = document.querySelector('.fixed-book-title');

            // Only need ONE of these to confirm we're on a Kindle reader page
            if (renderer || kindleApp || footer || fixedTitle) {
                clearInterval(checkReady);
                showUI();
            }
        }, 500);

        // Force-create the UI after 5 seconds even if we can't find elements
        // (the URL match already guarantees we're on a Kindle page)
        setTimeout(() => {
            clearInterval(checkReady);
            if (!uiCreated) {
                console.log('[KindleSS] Timeout reached, creating UI anyway.');
                showUI();
                updateStatus('⚠️ Some reader elements not detected yet. The page may still be loading.');
            }
        }, 5000);
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
    } else {
        // Give the Kindle app a moment to initialize
        setTimeout(init, 1500);
    }

})();
