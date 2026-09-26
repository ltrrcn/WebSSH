// 前端外壳：hash 路由 + 页面占位（各页面在 US1/US2/US4/US6 接入）

const PAGES = {
  terminal: () => '终端页在此加载（US1：点击主机打开远程终端）',
  hosts: () => '主机管理页在此加载（US2：主机与凭据管理）',
  audit: () => '审计页在此加载（US4：连接行为留痕与导出）',
  tokens: () => '令牌管理页在此加载（US6：MCP 令牌）',
};

function currentPage() {
  const hash = location.hash.replace(/^#\//, '');
  return PAGES[hash] ? hash : 'terminal';
}

function render() {
  const page = currentPage();
  const app = document.getElementById('app');
  app.innerHTML = `<div class="placeholder">${PAGES[page]()}</div>`;
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.dataset.page === page);
  }
}

window.addEventListener('hashchange', render);
render();
