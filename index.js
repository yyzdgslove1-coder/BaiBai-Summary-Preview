export const VERSION = '0.1.2';

const ENDPOINT = '/api/backends/chat-completions/generate';
const CUSTOM_SUFFIX = '\n\n【主角当前档案(本轮之前,只读参考)】\n';
const HISTORY = '【前情提要(本轮之前的历史剧情摘要,只读参考,按时间先后)】';
const CONTENT = '\n【本轮对话】\n';
const CANCELLED = '已取消摘要生成';

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 对照实际保存的自定义模板定位宏展开范围。两种匹配结果不同即边界有歧义，放行。
function customRanges(text, template) {
    const tokens = [...template.matchAll(/\{\{(\w+)\}\}/g)];
    function match(greedy) {
        let pattern = '^';
        let cursor = 0;
        let count = 0;
        for (const token of tokens) {
            pattern += escapeRegex(template.slice(cursor, token.index));
            const wildcard = greedy ? '[\\s\\S]*' : '[\\s\\S]*?';
            pattern += token[1] === 'content' ? `(?<body${count++}>${wildcard})` : wildcard;
            cursor = token.index + token[0].length;
        }
        pattern += escapeRegex(template.slice(cursor)) + '$';
        const result = new RegExp(pattern, 'd').exec(text);
        if (!result) return null;
        return Object.values(result.indices.groups ?? {});
    }
    const lazy = match(false);
    const greedy = match(true);
    return lazy && JSON.stringify(lazy) === JSON.stringify(greedy) ? lazy : null;
}

function isSummaryRequest(body) {
    if (body?.tool_choice !== 'none' || !Array.isArray(body.messages)) return false;
    const checklist = body.messages.at(-1);
    return checklist?.role === 'system' && checklist.content?.startsWith('【输出前核查】\n') &&
        ((body.chat_completion_source === 'openai' && typeof body.reverse_proxy === 'string') ||
        (body.chat_completion_source === 'custom' && typeof body.custom_url === 'string'));
}

export function recognize(body, template = '') {
    if (!isSummaryRequest(body)) return null;
    const users = body.messages.map((message, index) => ({ ...message, index })).filter(m => m.role === 'user');
    if (users.length !== 1 || typeof users[0].content !== 'string') return null;
    const { content: text, index } = users[0];
    const suffix = text.lastIndexOf(CUSTOM_SUFFIX);
    if (suffix >= 0 && template.trim()) {
        const ranges = customRanges(text.slice(0, suffix), template.trim());
        return ranges === null ? null : { index, ranges, text: ranges.length ? text.slice(...ranges[0]) : null };
    }
    if (!text.startsWith('【主角】') || !text.includes(HISTORY)) return null;
    const start = text.indexOf(CONTENT);
    if (start < 0) return null;
    const offset = start + CONTENT.length;
    return { index, ranges: [[offset, text.length]], text: text.slice(offset) };
}

export function replaceContent(body, recognized, value) {
    let text = body.messages[recognized.index].content;
    for (const [start, end] of [...recognized.ranges].reverse()) {
        text = text.slice(0, start) + value + text.slice(end);
    }
    return { ...body, messages: body.messages.map((message, index) =>
        index === recognized.index ? { ...message, content: text } : message) };
}

export function summaryChannel(settings) {
    const book = settings?.baibai_book;
    const channels = settings?.baibai_api_channels?.channels ?? book?.channels ?? [];
    return channels.find(channel => channel.id === book?.assignments?.summary);
}

// 一个实例只服务一次手动操作。上游结束忙碌状态时整个实例丢弃。
export function createSession(preview, floor) {
    let key;
    let decision;
    return async (body, recognized) => {
        const nextKey = JSON.stringify(body.messages);
        if (key !== undefined && key !== nextKey) return body;
        key = nextKey;
        decision ??= Promise.resolve(preview(recognized.text, floor));
        const result = await decision;
        if (result === null) throw new Error(CANCELLED);
        return recognized.text === null ? body : replaceContent(body, recognized, result);
    };
}

function preview(text, floor) {
    return new Promise(resolve => {
        const previousFocus = document.activeElement;
        const dialog = document.createElement('dialog');
        dialog.className = 'bbsp-dialog';
        dialog.setAttribute('aria-labelledby', 'bbsp-title');
        const viewport = window.visualViewport;
        function fitViewport() {
            if (!viewport) return;
            dialog.style.maxHeight = `${viewport.height - 24}px`;
            dialog.style.top = `${viewport.offsetTop + 12}px`;
            dialog.style.marginTop = '0';
        }
        viewport?.addEventListener('resize', fitViewport);
        viewport?.addEventListener('scroll', fitViewport);
        const title = document.createElement('h2');
        title.id = 'bbsp-title';
        title.textContent = floor === undefined ? '摘要正文' : `摘要正文 · 楼层 #${floor}`;
        dialog.append(title);
        let textarea;
        const label = document.createElement('label');
        if (text === null) {
            label.textContent = '这次摘要请求里没有正文。你的自定义摘要提示词可能缺少 {{content}}，AI 只能凭其他材料写摘要。';
        } else {
            label.textContent = '本次发给 AI 的正文';
            textarea = document.createElement('textarea');
            textarea.id = 'bbsp-content';
            textarea.value = text;
            label.htmlFor = textarea.id;
        }
        dialog.append(label);
        if (textarea) dialog.append(textarea);
        const footer = document.createElement('div');
        footer.className = 'bbsp-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消';
        const send = document.createElement('button');
        send.type = 'button';
        send.textContent = text === null ? '照常发送' : '发送并生成';
        send.disabled = textarea ? !textarea.value.trim() : false;
        textarea?.addEventListener('input', () => { send.disabled = !textarea.value.trim(); });
        function finish(value) {
            viewport?.removeEventListener('resize', fitViewport);
            viewport?.removeEventListener('scroll', fitViewport);
            dialog.close();
            dialog.remove();
            previousFocus?.focus();
            resolve(value);
        }
        cancel.addEventListener('click', () => finish(null));
        send.addEventListener('click', () => finish(textarea?.value ?? ''));
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
        footer.append(cancel, send);
        dialog.append(footer);
        document.body.append(dialog);
        dialog.showModal();
        fitViewport();
        cancel.focus();
    });
}

// 原 signal 只属于柏宝书提前启动的计时器。独立计时覆盖真正 fetch 及响应体读取。
export function sendWithTimeout(fetchPrevious, receiver, input, init, timeoutSec) {
    const controller = new AbortController();
    const seconds = typeof timeoutSec === 'number' && Number.isFinite(timeoutSec) && timeoutSec > 0
        ? Math.floor(timeoutSec) : 180;
    const timer = setTimeout(() => controller.abort(new Error(`副 API 请求超时(>${seconds}秒)`)), Math.max(1000, seconds * 1000));
    return fetchPrevious.call(receiver, input, { ...init, signal: controller.signal }).then(response => {
        if (!response.body) {
            clearTimeout(timer);
            return response;
        }
        const reader = response.body.getReader();
        const stream = new ReadableStream({
            pull(destination) {
                return reader.read().then(({ done, value }) => {
                    if (done) {
                        clearTimeout(timer);
                        destination.close();
                    } else destination.enqueue(value);
                }, error => {
                    clearTimeout(timer);
                    destination.error(error);
                });
            },
            cancel(reason) {
                clearTimeout(timer);
                return reader.cancel(reason);
            },
        });
        return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    }, error => {
        clearTimeout(timer);
        throw error;
    });
}

export function install(win, showPreview = preview) {
    const fetchPrevious = win.fetch;
    let operation;
    function arm(root, floor, busySelector) {
        operation?.observer.disconnect();
        const current = { started: false, sawRequest: false, previewed: false };
        current.session = createSession((text, number) => {
            current.previewed = true;
            return showPreview(text, number);
        }, floor);
        function finish() {
            current.observer.disconnect();
            if (operation !== current) return;
            operation = undefined;
            if (current.started && !current.previewed &&
                (current.sawRequest || !summaryChannel(win.SillyTavern?.getContext()?.extensionSettings))) {
                win.toastr?.warning(current.sawRequest
                    ? '柏宝书摘要预览：这次认不出正文在哪里，已按原样发送。'
                    : '柏宝书摘要预览：这次没有拦到摘要请求。如果柏宝书的摘要设成了跟随主 API，预览框拦不到，请在柏宝书设置里给摘要指派一个副 API 渠道。');
            }
        }
        function observe() {
            const busy = !!root.querySelector(busySelector);
            if (busy) current.started = true;
            if (current.started && !busy) finish();
        }
        current.observer = new win.MutationObserver(observe);
        current.observer.observe(root, { subtree: true, childList: true });
        operation = current;
        // 入口早退时不留下手动意图，异步准备期间上游已同步标记 busy。
        setTimeout(() => {
            observe();
            if (!current.started) finish();
        }, 0);
    }
    win.document.addEventListener('click', event => {
        const path = event.composedPath();
        const button = path.find(node => node instanceof win.Element && node.matches('button'));
        if (!button || button.disabled) return;
        if (button.matches('.bbs-fp-summarybtn') && /^生成楼层 #\d+ 的摘要$/.test(button.title)) {
            const host = path.find(node => node instanceof win.Element && node.hasAttribute('data-bbs-fp-floor'));
            const mes = path.find(node => node instanceof win.Element && node.matches('.mes[mesid]'));
            if (host && mes) arm(host.shadowRoot, mes.getAttribute('mesid'), '.bbs-fp-spinner');
        }
        if (button.matches('.bbs-pending-chip')) {
            const pendingFloor = button.title.match(/^对楼层 #(\d+) 生成摘要$/);
            const root = button.getRootNode();
            if (pendingFloor && root.host?.id === 'bbs-app-host') {
                arm(root, pendingFloor[1], `.bbs-pending-chip[title="${button.title}"] .bbs-pending-spin`);
            }
        }
        const modal = button.closest('.bbs-modal-confirm');
        const match = modal?.getAttribute('aria-label')?.match(/^重新摘要楼层 #(\d+)$/);
        if (match && button.matches('.bbs-btn-primary')) {
            const host = win.document.querySelector(`[data-bbs-fp-floor="${match[1]}"]`);
            if (host) arm(host.shadowRoot, match[1], '.bbs-fp-spinner');
        }
    }, true);
    win.fetch = async function (input, init) {
        // 不读取 Request 流。上游 1.3.5 的副 API 使用字符串 URL 和字符串 JSON body。
        if (!operation || typeof input !== 'string' || input !== ENDPOINT ||
            typeof init?.body !== 'string' || init.method !== 'POST') {
            return fetchPrevious.call(this, input, init);
        }
        const current = operation;
        const body = await new Response(init.body).json().then(value => value, () => null);
        if (isSummaryRequest(body)) current.sawRequest = true;
        const settings = win.SillyTavern?.getContext()?.extensionSettings;
        const recognized = recognize(body, settings?.baibai_book?.prompts?.summary);
        if (!recognized) return fetchPrevious.call(this, input, init);
        const timeoutSec = summaryChannel(settings)?.timeoutSec;
        const replacement = await current.session(body, recognized);
        if (replacement === body && recognized.text !== null) return fetchPrevious.call(this, input, init);
        return sendWithTimeout(fetchPrevious, this, input,
            { ...init, body: JSON.stringify(replacement) }, timeoutSec);
    };
}

export function readBookVersion(doc) {
    // 柏宝书主界面的样式表与脚本同在 dist，以其目录关联脚本，文件夹可任意命名。
    const stylesheet = doc.getElementById('bbs-app-host')?.shadowRoot?.querySelector('link[rel="stylesheet"][href]');
    if (!stylesheet) return null;
    const scriptUrl = new URL('index.js', stylesheet.href);
    const script = [...doc.querySelectorAll('script[src]')].find(element => {
        const url = new URL(element.src, doc.baseURI);
        return url.origin === scriptUrl.origin && url.pathname === scriptUrl.pathname &&
            url.pathname.endsWith('/dist/index.js');
    });
    return script ? new URL(script.src, doc.baseURI).searchParams.get('ver') || null : null;
}

export function summaryChannelText(settings) {
    if (!settings?.baibai_book) return '没读到柏宝书设置';
    const channel = summaryChannel(settings);
    return channel
        ? `摘要渠道：${channel.name}（${channel.model}）`
        : '摘要跟随主 API，预览框拦不到。请在柏宝书设置里给摘要指派一个副 API 渠道';
}

export function installStatusPanel(win) {
    const doc = win.document;
    function mount() {
        if (doc.getElementById('bbsp-settings')) return true;
        const target = doc.getElementById('extensions_settings2') || doc.getElementById('extensions_settings');
        if (!target) return false;
        const container = doc.createElement('div');
        container.id = 'bbsp-settings';
        container.className = 'extension_container';
        const drawer = doc.createElement('div');
        drawer.className = 'inline-drawer';
        const header = doc.createElement('div');
        header.className = 'inline-drawer-toggle inline-drawer-header';
        const title = doc.createElement('b');
        title.textContent = '柏宝书摘要预览';
        const icon = doc.createElement('div');
        icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
        header.append(title, icon);
        const content = doc.createElement('div');
        content.className = 'inline-drawer-content';
        content.style.display = 'none';
        const loaded = doc.createElement('p');
        const book = doc.createElement('p');
        const channel = doc.createElement('p');
        const summaryPrompt = doc.createElement('p');
        const usage = doc.createElement('p');
        usage.textContent = '在柏宝书「摘要」页点「未摘要楼层」的楼层号，或点聊天楼层面板的摘要按钮，发送前会先弹出预览框。';
        function refresh() {
            loaded.textContent = `已加载 ${VERSION}`;
            const version = readBookVersion(doc);
            book.textContent = `柏宝书版本：${version || '未识别'}`;
            if (version && version !== '1.3.5') book.textContent += '。本扩展按 1.3.5 适配，版本不同可能拦不到';
            const settings = win.SillyTavern?.getContext()?.extensionSettings;
            channel.textContent = summaryChannelText(settings);
            summaryPrompt.hidden = !settings?.baibai_book;
            const template = settings?.baibai_book?.prompts?.summary?.trim() ?? '';
            if (summaryPrompt.hidden) {
                summaryPrompt.textContent = '';
            } else if (!template) {
                summaryPrompt.textContent = '摘要提示词：柏宝书内置';
            } else if (template.includes('{{content}}')) {
                summaryPrompt.textContent = '摘要提示词：自定义，含 {{content}}';
            } else {
                summaryPrompt.textContent = '摘要提示词：自定义，但缺少 {{content}}。柏宝书这时不会把这一楼的正文发给 AI，摘要会对不上原文。请在柏宝书的摘要提示词里加上 {{content}}。';
            }
        }
        header.addEventListener('click', refresh);
        refresh();
        content.append(loaded, book, channel, summaryPrompt, usage);
        drawer.append(header, content);
        container.append(drawer);
        target.append(container);
        return true;
    }
    if (mount()) return;
    const observer = new win.MutationObserver(() => {
        if (mount()) observer.disconnect();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
}

if (typeof window !== 'undefined') {
    install(window);
    installStatusPanel(window);
}
