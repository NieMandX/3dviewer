function isEditableElement(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

let activeSelect = null;

export function createCustomSelectController(options = {}) {
    const root = options.root || (typeof document !== 'undefined' ? document : null);
    if (!root?.querySelectorAll) return Object.freeze({ refresh: () => {}, dispose: () => {} });

    const selector = options.selector || 'select';
    const selects = Array.from(root.querySelectorAll(selector));
    const controllers = selects.map((select) => createCustomSelect(select)).filter(Boolean);

    function closeActive() {
        if (activeSelect?.close) activeSelect.close();
        activeSelect = null;
    }

    function onDocClick(event) {
        if (!activeSelect) return;
        if (!event) return;
        const target = event.target;
        if (activeSelect.wrapper?.contains(target) || activeSelect.list?.contains(target)) return;
        closeActive();
    }

    function onKeyDown(event) {
        if (!activeSelect || !event) return;
        if (isEditableElement(event.target) && !activeSelect.wrapper?.contains(event.target)) return;
        if (event.key === 'Escape') {
            closeActive();
            event.preventDefault?.();
        }
    }

    function onScroll() {
        if (activeSelect) closeActive();
    }

    if (root.addEventListener) {
        root.addEventListener('click', onDocClick);
        root.addEventListener('keydown', onKeyDown);
    }
    if (typeof window !== 'undefined') {
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
    }

    function refresh() {
        controllers.forEach((ctrl) => ctrl.refresh());
    }

    function dispose() {
        if (root.removeEventListener) {
            root.removeEventListener('click', onDocClick);
            root.removeEventListener('keydown', onKeyDown);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        }
        controllers.forEach((ctrl) => ctrl.dispose());
    }

    return Object.freeze({ refresh, dispose });
}

function createCustomSelect(select) {
    if (!select || select.dataset.customSelectReady === 'true') return null;
    if (select.multiple) return null;
    select.dataset.customSelectReady = 'true';

    const parentRect = select.parentElement?.getBoundingClientRect?.() || null;
    const selectRect = select.getBoundingClientRect?.() || null;
    const isFullWidth =
        parentRect && selectRect
            ? Math.abs(parentRect.width - selectRect.width) <= 2
            : false;

    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    if (select.closest('.anno-toolbar')) wrapper.classList.add('custom-select-anno');
    if (select.classList.contains('prompt-input')) wrapper.classList.add('custom-select-prompt');
    if (isFullWidth) wrapper.classList.add('custom-select-block');

    select.parentNode?.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    select.classList.forEach((cls) => {
        if (cls === 'btn') return;
        trigger.classList.add(cls);
    });

    const label = document.createElement('span');
    label.className = 'custom-select-label';
    trigger.appendChild(label);

    const list = document.createElement('div');
    list.className = 'custom-select-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-hidden', 'true');

    wrapper.appendChild(trigger);

    document.body.appendChild(list);

    select.classList.add('custom-select-native');
    select.tabIndex = -1;

    let observer = null;

    function updateLabel() {
        const selected = select.selectedOptions?.[0] || select.options[select.selectedIndex];
        label.textContent = selected ? selected.textContent : '';
        trigger.disabled = !!select.disabled;
        trigger.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');
    }

    function buildOptions() {
        list.innerHTML = '';
        Array.from(select.options).forEach((option, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'custom-select-option';
            item.dataset.value = option.value;
            item.dataset.index = String(index);
            item.disabled = option.disabled;

            const labelEl = document.createElement('span');
            labelEl.className = 'custom-select-option-label';
            labelEl.textContent = option.textContent;
            item.appendChild(labelEl);

            const canDelete = option.dataset?.deletable === '1' && !option.disabled;
            if (canDelete) {
                const deleteBtn = document.createElement('span');
                deleteBtn.className = 'custom-select-option-delete';
                deleteBtn.setAttribute('role', 'button');
                deleteBtn.setAttribute('tabindex', '0');
                deleteBtn.setAttribute('aria-label', 'Удалить');
                deleteBtn.innerHTML =
                    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/></svg>';
                deleteBtn.addEventListener('click', (event) => {
                    event.preventDefault?.();
                    event.stopPropagation?.();
                    const detail = {
                        value: option.value,
                        index,
                        label: option.textContent,
                    };
                    select.dispatchEvent(new CustomEvent('customselect:delete', { detail, bubbles: true }));
                    close();
                });
                deleteBtn.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault?.();
                    event.stopPropagation?.();
                    const detail = {
                        value: option.value,
                        index,
                        label: option.textContent,
                    };
                    select.dispatchEvent(new CustomEvent('customselect:delete', { detail, bubbles: true }));
                    close();
                });
                item.appendChild(deleteBtn);
            }

            if (option.selected) item.classList.add('is-selected');
            item.addEventListener('click', (event) => {
                event.preventDefault?.();
                if (option.disabled) return;
                select.selectedIndex = index;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                updateLabel();
                close();
            });
            list.appendChild(item);
        });
    }

    function refresh() {
        buildOptions();
        updateLabel();
    }

    function positionList() {
        const rect = trigger.getBoundingClientRect();
        const margin = 6;
        const spaceBelow = window.innerHeight - rect.bottom - margin;
        const spaceAbove = rect.top - margin;
        const openAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
        list.style.minWidth = `${Math.round(rect.width)}px`;
        list.style.left = `${Math.round(rect.left)}px`;
        list.style.maxHeight = `${Math.max(120, Math.min(320, openAbove ? spaceAbove : spaceBelow))}px`;
        if (openAbove) {
            list.style.top = `${Math.max(8, Math.round(rect.top - list.offsetHeight - margin))}px`;
        } else {
            list.style.top = `${Math.round(rect.bottom + margin)}px`;
        }
    }

    function open() {
        if (trigger.disabled) return;
        if (activeSelect && activeSelect !== api) activeSelect.close();
        activeSelect = api;
        list.classList.add('is-open');
        list.setAttribute('aria-hidden', 'false');
        trigger.setAttribute('aria-expanded', 'true');
        buildOptions();
        positionList();
    }

    function close() {
        list.classList.remove('is-open');
        list.setAttribute('aria-hidden', 'true');
        trigger.setAttribute('aria-expanded', 'false');
        if (activeSelect === api) activeSelect = null;
    }

    function onTriggerClick(event) {
        event.preventDefault?.();
        if (list.classList.contains('is-open')) {
            close();
        } else {
            open();
        }
    }

    function onTriggerKeyDown(event) {
        if (!event || trigger.disabled) return;
        const key = event.key;
        if (key === 'Enter' || key === ' ') {
            event.preventDefault?.();
            if (list.classList.contains('is-open')) close();
            else open();
            return;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault?.();
            const dir = key === 'ArrowDown' ? 1 : -1;
            const next = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + dir));
            select.selectedIndex = next;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            refresh();
        }
    }

    trigger.addEventListener('click', onTriggerClick);
    trigger.addEventListener('keydown', onTriggerKeyDown);
    select.addEventListener('change', refresh);

    observer = new MutationObserver(refresh);
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    refresh();

    const api = Object.freeze({
        wrapper,
        list,
        refresh,
        close,
        dispose: () => {
            trigger.removeEventListener('click', onTriggerClick);
            trigger.removeEventListener('keydown', onTriggerKeyDown);
            select.removeEventListener('change', refresh);
            observer?.disconnect();
            list.remove();
            trigger.remove();
            select.classList.remove('custom-select-native');
            select.dataset.customSelectReady = 'false';
            if (select.parentNode === wrapper) {
                wrapper.parentNode?.insertBefore(select, wrapper);
                wrapper.remove();
            }
        },
    });

    return api;
}
