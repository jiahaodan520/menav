import type { NestedStructureNode } from '../types';

const { SELECTORS, byId, qs, qsa } =
  require('../dom/selectors.ts') as typeof import('../dom/selectors');

// 多层级嵌套书签功能
function getCollapsibleNestedContainers(root: ParentNode | null): HTMLElement[] {
  if (!root) return [];
  const headers = qsa(SELECTORS.nestedCollapsibleHeader, root);
  return Array.from(headers)
    .map((header) => header.parentElement)
    .filter((element: HTMLElement | null): element is HTMLElement => Boolean(element));
}

function isNestedContainerCollapsible(container: HTMLElement | null): container is HTMLElement {
  if (!container) return false;

  if (container.classList.contains('category')) {
    return Boolean(qs(SELECTORS.nestedCategoryHeader, container));
  }

  if (container.classList.contains('group')) {
    return Boolean(qs(SELECTORS.nestedGroupHeader, container));
  }

  return false;
}

// 更新分类切换按钮图标
function updateCategoryToggleIcon(state: 'up' | 'down'): void {
  const toggleBtn = byId(SELECTORS.categoryToggle);
  if (!toggleBtn) return;

  const icon = qs('i', toggleBtn);
  if (!icon) return;

  if (state === 'up') {
    icon.className = 'fas fa-angle-double-up';
    toggleBtn.setAttribute('aria-label', '收起分类');
  } else {
    icon.className = 'fas fa-angle-double-down';
    toggleBtn.setAttribute('aria-label', '展开分类');
  }
}

// 获取某个可折叠容器直属的内容节点
function getNestedContent(container: HTMLElement): HTMLElement | null {
  if (container.classList.contains('category')) {
    return qs(':scope > .category-content', container);
  }
  if (container.classList.contains('group')) {
    return qs(':scope > .group-content', container);
  }
  return null;
}

// 每个容器进行中的动画收尾（cleanup + 兜底 timer），避免打断时残留内联高度/裁剪类
const animationState = new WeakMap<HTMLElement, { timer: number; dispose: () => void }>();

function finalizeNestedAnimation(container: HTMLElement, content: HTMLElement | null): void {
  const pending = animationState.get(container);
  if (pending) {
    window.clearTimeout(pending.timer);
    animationState.delete(container);
    pending.dispose(); // 移除旧的 transitionend 监听并复位，避免打断动画时误伤下一次
  } else {
    if (content) content.style.maxHeight = '';
    container.classList.remove('animating');
  }
}

// 无动画地设置展开/收起（用于初始恢复与全部展开/收起，避免逐帧重排）
function setNestedStateInstant(container: HTMLElement, expand: boolean): void {
  const content = getNestedContent(container);
  finalizeNestedAnimation(container, content);
  container.classList.toggle('collapsed', !expand);
}

// 切换嵌套元素（基于 scrollHeight 的平滑高度动画）
function toggleNestedElement(container: HTMLElement | null): void {
  if (!isNestedContainerCollapsible(container)) return;

  const content = getNestedContent(container);
  const willExpand = container.classList.contains('collapsed');

  // 收尾上一次可能进行中的动画，从当前真实高度继续，保证快速连点不跳变
  finalizeNestedAnimation(container, content);

  if (!content) {
    // 无可测量内容（异常情况）：退化为纯类切换
    container.classList.toggle('collapsed', !willExpand);
  } else {
    const start = content.getBoundingClientRect().height;
    container.classList.add('animating');

    let target: number;
    if (willExpand) {
      container.classList.remove('collapsed'); // :not(.collapsed) → max-height:none，animating 期裁剪
      target = content.scrollHeight;
      content.style.maxHeight = `${start}px`;
      void content.offsetHeight; // 强制回流，锁定起始高度
      requestAnimationFrame(() => {
        content.style.maxHeight = `${target}px`;
      });
    } else {
      content.style.maxHeight = `${start}px`; // 从当前高度（原本 none）钉住
      void content.offsetHeight;
      container.classList.add('collapsed');
      requestAnimationFrame(() => {
        content.style.maxHeight = '0px';
      });
    }

    const dispose = () => {
      content.removeEventListener('transitionend', onTransitionEnd);
      content.style.maxHeight = '';
      container.classList.remove('animating');
    };
    const onTransitionEnd = (e: Event) => {
      const te = e as TransitionEvent;
      if (te.target === content && te.propertyName === 'max-height') {
        finalizeNestedAnimation(container, content);
      }
    };
    content.addEventListener('transitionend', onTransitionEnd);
    // 兜底：极端情况（如目标高度为 0）transitionend 可能不触发
    const timer = window.setTimeout(() => finalizeNestedAnimation(container, content), 400);
    animationState.set(container, { timer, dispose });
  }

  saveToggleState(container, willExpand ? 'expanded' : 'collapsed');

  // 触发自定义事件
  const event = new CustomEvent('nestedToggle', {
    detail: {
      element: container,
      type: container.dataset.type,
      name: container.dataset.name,
      isCollapsed: !willExpand,
    },
  });
  document.dispatchEvent(event);
}

// 保存切换状态
function saveToggleState(element: HTMLElement, state: 'expanded' | 'collapsed'): void {
  const type = element.dataset.type;
  const name = element.dataset.name;
  const level = element.dataset.level || '1';
  const key = `menav-toggle-${type}-${level}-${name}`;
  localStorage.setItem(key, state);
}

// 恢复切换状态
function restoreToggleState(element: HTMLElement | null): void {
  if (!element) return;
  const type = element.dataset.type;
  const name = element.dataset.name;
  const level = element.dataset.level || '1';
  const key = `menav-toggle-${type}-${level}-${name}`;
  const savedState = localStorage.getItem(key);

  // 默认收起（SSR 已渲染 collapsed）。仅当用户显式展开过时才无动画地展开。
  if (savedState === 'expanded') {
    setNestedStateInstant(element, true);
  }
}

// 初始化嵌套分类
function initializeNestedCategories(): void {
  // 为所有可折叠元素添加切换功能
  qsa(SELECTORS.nestedToggleHeader).forEach((header: HTMLElement) => {
    header.addEventListener('click', function (this: HTMLElement, e: Event) {
      e.stopPropagation();
      const container = this.parentElement;
      toggleNestedElement(container);
    });

    // 恢复保存的状态
    restoreToggleState(header.parentElement);
  });
}

// 提取嵌套数据
function extractNestedData(element: HTMLElement): NestedStructureNode {
  const data: NestedStructureNode = {
    name: element.dataset.name,
    type: element.dataset.type,
    level: element.dataset.level,
    isCollapsed: element.classList.contains('collapsed'),
  };

  // 提取子元素数据
  const subcategories = qsa(SELECTORS.nestedSubcategories, element);
  if (subcategories.length > 0) {
    data.subcategories = Array.from(subcategories).map((sub) => extractNestedData(sub));
  }

  const groups = qsa(SELECTORS.nestedGroups, element);
  if (groups.length > 0) {
    data.groups = Array.from(groups).map((group) => extractNestedData(group));
  }

  const subgroups = qsa(SELECTORS.nestedSubgroups, element);
  if (subgroups.length > 0) {
    data.subgroups = Array.from(subgroups).map((subgroup) => extractNestedData(subgroup));
  }

  const sites = qsa(SELECTORS.nestedSites, element);
  if (sites.length > 0) {
    data.sites = Array.from(sites).map((site) => ({
      name: site.dataset.name,
      url: site.dataset.url,
      icon: site.dataset.icon,
      description: site.dataset.description,
    }));
  }

  return data;
}

function expandAll(): void {
  const activePage = qs(SELECTORS.pageActive);
  if (activePage) {
    // 批量瞬时展开：不做逐个高度动画，避免一次性重排导致的掉帧
    getCollapsibleNestedContainers(activePage).forEach((element) => {
      setNestedStateInstant(element, true);
      saveToggleState(element, 'expanded');
    });
  }
}

function collapseAll(): void {
  const activePage = qs(SELECTORS.pageActive);
  if (activePage) {
    getCollapsibleNestedContainers(activePage).forEach((element) => {
      setNestedStateInstant(element, false);
      saveToggleState(element, 'collapsed');
    });
  }
}

function toggleCategories(): void {
  const activePage = qs(SELECTORS.pageActive);
  if (!activePage) return;

  const allElements = getCollapsibleNestedContainers(activePage);
  const collapsedElements = allElements.filter((element) =>
    element.classList.contains('collapsed')
  );
  if (allElements.length === 0) return;

  if (collapsedElements.length >= allElements.length / 2) {
    expandAll();
    updateCategoryToggleIcon('up');
  } else {
    collapseAll();
    updateCategoryToggleIcon('down');
  }
}

function toggleCategory(
  categoryName: string,
  subcategoryName: string | null = null,
  groupName: string | null = null,
  subgroupName: string | null = null
): void {
  let selector = `[data-name="${categoryName}"]`;

  if (subcategoryName) selector += ` [data-name="${subcategoryName}"]`;
  if (groupName) selector += ` [data-name="${groupName}"]`;
  if (subgroupName) selector += ` [data-name="${subgroupName}"]`;

  const element = qs(selector);
  if (element) {
    toggleNestedElement(element);
  }
}

function getNestedStructure(): NestedStructureNode[] {
  const categories: NestedStructureNode[] = [];
  qsa(SELECTORS.categoryLevelOne).forEach((cat: HTMLElement) => {
    categories.push(extractNestedData(cat));
  });
  return categories;
}

module.exports = {
  collapseAll,
  expandAll,
  getNestedStructure,
  initializeNestedCategories,
  toggleCategories,
  toggleCategory,
  updateCategoryToggleIcon,
  extractNestedData,
};
