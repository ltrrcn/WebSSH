// 图标 helper（宪法 IX）：统一从 web/assets/icons.svg sprite 引用
// 禁止在 UI 中使用 emoji / Unicode 符号做图标（渲染不一致、无障碍语义差）
export function icon(name, size = 14) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><use href="assets/icons.svg#${name}"/></svg>`;
}
