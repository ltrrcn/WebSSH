// 前端外壳：hash 路由 + 页面懒加载
// terminal（US1 已实现）｜hosts（US2）｜audit（US4）｜tokens（US6）

const PLACEHOLDER = {
  audit: '审计页在此加载（US4：连接行为留痕与导出）',
  tokens: '令牌管理页在此加载（US6：MCP 令牌）',
};

let cleanup = null;

async function render() {
  const hash = location.hash.replace(/^#\//, '');
  const page = ['terminal', 'hosts', 'audit', 'tokens'].includes(hash) ? hash : 'terminal';
  const app = document.getElementById('app');

  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.dataset.page === page);
  }

  if (page === 'terminal') {
    const mod = await import('./terminal.js');
    await mod.render(app);
    // 切换页面时释放终端资源
    cleanup = () => mod.disposeActive?.();
  } else if (page === 'hosts') {
    const mod = await import('./hosts.js');
    await mod.render(app);
  } else {
    app.innerHTML = `<div class="placeholder">${PLACEHOLDER[page]}</div>`;
  }
}

window.addEventListener('hashchange', render);
render();
